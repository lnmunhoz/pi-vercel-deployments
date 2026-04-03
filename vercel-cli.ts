/**
 * Vercel CLI wrapper — executes `vercel list` and `vercel inspect` via pi.exec()
 * with JSON parsing, types, and 30s result caching.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
}

// Simple cache with TTL
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS = 30_000;
let listCache: CacheEntry<VercelDeployment[]> | null = null;

function isCacheValid<T>(cache: CacheEntry<T> | null): cache is CacheEntry<T> {
  return cache !== null && Date.now() - cache.timestamp < CACHE_TTL_MS;
}

export async function listDeployments(
  pi: ExtensionAPI,
  opts?: ListOptions
): Promise<VercelDeployment[]> {
  // Return cached result for unfiltered requests
  if (!opts?.status && !opts?.environment && isCacheValid(listCache)) {
    const limit = opts?.limit ?? 20;
    return listCache.data.slice(0, limit);
  }

  const args = ["list", "--format", "json", "--yes"];
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
      throw new Error("Project not linked. Run `vercel link` first.");
    }
    throw new Error(`vercel list failed (exit ${result.code}): ${stderr}`);
  }

  const parsed = JSON.parse(result.stdout);
  const deployments: VercelDeployment[] = parsed.deployments ?? [];

  // Cache unfiltered results
  if (!opts?.status && !opts?.environment) {
    listCache = { data: deployments, timestamp: Date.now() };
  }

  const limit = opts?.limit ?? 20;
  return deployments.slice(0, limit);
}

export async function inspectDeployment(
  pi: ExtensionAPI,
  url: string
): Promise<VercelInspectResult> {
  const result = await pi.exec("vercel", ["inspect", url, "--format=json"], {
    timeout: 15_000,
  });

  if (result.code !== 0) {
    throw new Error(
      `vercel inspect failed (exit ${result.code}): ${result.stderr.trim()}`
    );
  }

  return JSON.parse(result.stdout);
}

export async function cancelDeployment(
  pi: ExtensionAPI,
  urlOrId: string
): Promise<{ success: boolean; message: string }> {
  const result = await pi.exec("vercel", ["remove", urlOrId, "--yes"], {
    timeout: 15_000,
  });

  // Invalidate cache after cancel
  listCache = null;

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
  listCache = null;
}
