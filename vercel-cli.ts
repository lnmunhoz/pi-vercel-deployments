/**
 * Vercel CLI wrapper — executes `vercel list` and `vercel inspect` via pi.exec()
 * with JSON parsing, types, and 30s result caching.
 *
 * Supports monorepos: discovers multiple `.vercel/project.json` files and
 * can query each project independently via --cwd, or aggregate all.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";

export interface VercelDeployment {
  url: string | null;
  name: string;
  state: "READY" | "BUILDING" | "ERROR" | "INITIALIZING" | "QUEUED" | "CANCELED";
  target: "production" | null;
  createdAt: number;
  buildingAt: number;
  ready: number;
  creator: { uid: string; username: string };
  meta: {
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitSha?: string;
    githubCommitAuthorLogin?: string;
  };
  /** Added by the extension for monorepo support — identifies which project this belongs to */
  projectName?: string;
  /** The directory containing the .vercel config for this project */
  projectDir?: string;
}

export interface VercelProject {
  /** Name from .vercel/project.json or directory name */
  name: string;
  /** Absolute path to the project directory (contains .vercel/) */
  dir: string;
  /** Relative path from repo root */
  relativeDir: string;
  /** Project ID from .vercel/project.json */
  projectId: string;
  /** Org ID from .vercel/project.json */
  orgId: string;
}

export interface VercelInspectResult {
  id: string;
  name: string;
  url: string;
  target: "production" | null;
  readyState: string;
  createdAt: number;
  aliases: string[];
}

export interface ListOptions {
  status?: string;
  environment?: string;
  limit?: number;
  /** Filter to a specific project by name */
  project?: string;
}

// --- Project discovery ---

/**
 * Discover all Vercel-linked projects by scanning for .vercel/project.json files.
 * Searches cwd and immediate subdirectories (one level deep, like a typical monorepo).
 */
export function discoverProjects(rootDir: string): VercelProject[] {
  const projects: VercelProject[] = [];

  function tryAdd(dir: string) {
    const configPath = join(dir, ".vercel", "project.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        const relDir = relative(rootDir, dir) || ".";
        projects.push({
          name: config.projectName ?? basename(dir),
          dir,
          relativeDir: relDir,
          projectId: config.projectId ?? "",
          orgId: config.orgId ?? "",
        });
      } catch {
        // Malformed project.json, skip
      }
    }
  }

  // Check root
  tryAdd(rootDir);

  // Check immediate subdirectories
  try {
    for (const entry of readdirSync(rootDir)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const fullPath = join(rootDir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          tryAdd(fullPath);
        }
      } catch {
        // Permission error or broken symlink, skip
      }
    }
  } catch {
    // Can't read root dir
  }

  return projects;
}

// --- Cache (per-project) ---

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS = 30_000;
const listCacheByProject = new Map<string, CacheEntry<VercelDeployment[]>>();

function isCacheValid<T>(cache: CacheEntry<T> | null | undefined): cache is CacheEntry<T> {
  return cache != null && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

// --- Single-project operations ---

export async function listDeployments(
  pi: ExtensionAPI,
  project: VercelProject,
  opts?: Omit<ListOptions, "project">
): Promise<VercelDeployment[]> {
  const cacheKey = project.dir;

  // Return cached result for unfiltered requests
  if (!opts?.status && !opts?.environment) {
    const cached = listCacheByProject.get(cacheKey);
    if (isCacheValid(cached)) {
      const limit = opts?.limit ?? 20;
      return cached.data.slice(0, limit);
    }
  }

  const args = ["list", "--format", "json", "--yes", "--cwd", project.dir];
  if (opts?.status) {
    args.push("--status", opts.status);
  }
  if (opts?.environment) {
    args.push("--environment", opts.environment);
  }

  const result = await pi.exec("vercel", args, { timeout: 15_000 });

  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes("not logged in")) {
      throw new Error("Vercel CLI not logged in. Run `vercel login` first.");
    }
    if (stderr.includes("not linked")) {
      throw new Error(`Project "${project.name}" not linked. Run \`vercel link\` in ${project.relativeDir}.`);
    }
    throw new Error(`vercel list failed for "${project.name}" (exit ${result.code}): ${stderr}`);
  }

  const parsed = JSON.parse(result.stdout);
  const deployments: VercelDeployment[] = (parsed.deployments ?? []).map(
    (d: VercelDeployment) => ({
      ...d,
      projectName: project.name,
      projectDir: project.dir,
    })
  );

  // Cache unfiltered results
  if (!opts?.status && !opts?.environment) {
    listCacheByProject.set(cacheKey, { data: deployments, timestamp: Date.now() });
  }

  const limit = opts?.limit ?? 20;
  return deployments.slice(0, limit);
}

// --- Multi-project aggregation ---

/**
 * List deployments across all discovered projects, merged and sorted by createdAt.
 */
export async function listAllDeployments(
  pi: ExtensionAPI,
  projects: VercelProject[],
  opts?: ListOptions
): Promise<VercelDeployment[]> {
  // If filtering by project name, only query that project
  if (opts?.project) {
    const match = projects.find(
      (p) => p.name.toLowerCase() === opts.project!.toLowerCase()
    );
    if (!match) {
      throw new Error(
        `Project "${opts.project}" not found. Available: ${projects.map((p) => p.name).join(", ")}`
      );
    }
    return listDeployments(pi, match, opts);
  }

  // Query all projects in parallel
  const perProject = Math.max(5, Math.ceil((opts?.limit ?? 10) / projects.length));
  const results = await Promise.allSettled(
    projects.map((p) =>
      listDeployments(pi, p, { ...opts, limit: perProject })
    )
  );

  const all: VercelDeployment[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      all.push(...r.value);
    }
  }

  // Sort by creation time descending
  all.sort((a, b) => b.createdAt - a.createdAt);

  const limit = opts?.limit ?? 10;
  return all.slice(0, limit);
}

// --- Inspect & cancel (unchanged, just pass --cwd if needed) ---

export async function inspectDeployment(
  pi: ExtensionAPI,
  url: string,
  project?: VercelProject
): Promise<VercelInspectResult> {
  const args = ["inspect", url, "--format=json"];
  if (project) {
    args.push("--cwd", project.dir);
  }

  const result = await pi.exec("vercel", args, { timeout: 15_000 });

  if (result.code !== 0) {
    throw new Error(
      `vercel inspect failed (exit ${result.code}): ${result.stderr.trim()}`
    );
  }

  return JSON.parse(result.stdout);
}

export async function cancelDeployment(
  pi: ExtensionAPI,
  urlOrId: string,
  project?: VercelProject
): Promise<{ success: boolean; message: string }> {
  const args = ["remove", urlOrId, "--yes"];
  if (project) {
    args.push("--cwd", project.dir);
  }

  const result = await pi.exec("vercel", args, { timeout: 15_000 });

  // Invalidate all caches after cancel
  invalidateCache();

  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    return { success: false, message: `Failed to cancel: ${stderr}` };
  }

  return { success: true, message: `Deployment ${urlOrId} canceled.` };
}

export function isCancellable(state: VercelDeployment["state"]): boolean {
  return state === "BUILDING" || state === "QUEUED" || state === "INITIALIZING";
}

export function invalidateCache(): void {
  listCacheByProject.clear();
}

/**
 * Build the Vercel dashboard URL for a deployment.
 * Format: https://vercel.com/{team}/{project}/{deployment-url}
 * The team slug is extracted from the deployment URL: {name}-{hash}-{team}.vercel.app
 */
export function getDashboardUrl(deployment: VercelDeployment): string | null {
  if (!deployment.url) return null;

  const withoutSuffix = deployment.url.replace(".vercel.app", "");
  const parts = withoutSuffix.split("-");
  const team = parts[parts.length - 1];
  const project = deployment.projectName ?? deployment.name;

  return `https://vercel.com/${team}/${project}/${deployment.url}`;
}
