/**
 * Vercel Deployments Extension
 *
 * Shows latest Vercel deployment statuses via the Vercel CLI.
 * - `/deployments` command — interactive TUI list
 * - `vercel_deployments` tool — agent-callable
 * - Status bar indicator — shows latest deploy state
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  listDeployments,
  inspectDeployment,
  cancelDeployment,
  invalidateCache,
  isCancellable,
  type VercelDeployment,
} from "./vercel-cli.js";
import {
  stateIcon,
  stateColorKey,
  timeAgo,
  truncateCommitMsg,
  DeploymentListComponent,
  DeploymentOverlayComponent,
} from "./ui.js";

export default function (pi: ExtensionAPI) {
  // Only activate in projects linked to Vercel
  if (!existsSync(join(process.cwd(), ".vercel", "project.json"))) {
    return;
  }
  let statusInterval: ReturnType<typeof setInterval> | undefined;

  // --- Verify CLI availability ---
  async function checkVercelCli(): Promise<boolean> {
    const result = await pi.exec("which", ["vercel"], { timeout: 5_000 });
    return result.code === 0;
  }

  // --- Status bar indicator (dim, in footer alongside Pi's native info) ---
  async function updateStatus(ctx: { hasUI: boolean; ui: any }) {
    if (!ctx.hasUI) return;
    try {
      const theme = ctx.ui.theme;
      const deployments = await listDeployments(pi, { limit: 1 });
      const latest = deployments[0];
      if (latest) {
        const branch = latest.meta.githubCommitRef ?? "?";
        const time = timeAgo(latest.createdAt);
        const commit = truncateCommitMsg(latest.meta.githubCommitMessage ?? "", 40);
        ctx.ui.setStatus(
          "vercel",
          theme.fg("dim", `▲ Vercel · ${latest.state.toLowerCase()} · ${branch} · ${commit} · ${time}`)
        );
      }
    } catch {
      // Silently skip status updates on error
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const hasVercel = await checkVercelCli();
    if (!hasVercel) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Vercel CLI not found. Install with `npm i -g vercel`.",
          "warning"
        );
      }
      return;
    }

    // Initial status update
    await updateStatus(ctx);

    // Refresh status every 60s
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => updateStatus(ctx), 60_000);
  });

  pi.on("session_shutdown", async () => {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = undefined;
    }
  });

  // --- Ctrl+Shift+V shortcut — overlay panel ---
  pi.registerShortcut("ctrl+shift+v", {
    description: "Show Vercel deployments overlay",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
          const overlay = new DeploymentOverlayComponent(
            null, // null = loading state
            theme,
            () => done(),
            (url) => cancelDeployment(pi, url),
            (url) => { pi.exec("open", [url]); }
          );

          // Fetch in background, update when ready
          invalidateCache();
          listDeployments(pi, { limit: 10 })
            .then((deployments) => overlay.setDeployments(deployments))
            .catch(() => overlay.setDeployments([]));

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" },
        }
      );
    },
  });

  // --- /deployments command ---
  pi.registerCommand("deployments", {
    description: "Show latest Vercel deployments",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/deployments requires interactive mode", "error");
        return;
      }

      // Parse filter arg
      const filter = args?.trim().toLowerCase();
      let opts: { status?: string; environment?: string; limit?: number } = {
        limit: 15,
      };

      if (filter === "production" || filter === "prod") {
        opts.environment = "production";
      } else if (filter === "building") {
        opts.status = "BUILDING,QUEUED";
      } else if (filter === "error" || filter === "errors") {
        opts.status = "ERROR";
      }

      try {
        invalidateCache();
        const deployments = await listDeployments(pi, opts);

        await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          return new DeploymentListComponent(
            deployments,
            theme,
            () => done(),
            (url) => cancelDeployment(pi, url)
          );
        });
      } catch (err: any) {
        ctx.ui.notify(err.message ?? "Failed to fetch deployments", "error");
      }
    },
  });

  // --- vercel_deployments tool ---
  pi.registerTool({
    name: "vercel_deployments",
    label: "Vercel Deployments",
    description:
      "List recent Vercel deployments with status, URL, branch, commit message, and timing. Use inspect action to get detailed info about a specific deployment. Use cancel action to cancel a building/queued deployment by URL.",
    promptSnippet:
      "List, inspect, or cancel Vercel deployments (status, branch, commit, URL)",
    promptGuidelines: [
      "Use vercel_deployments to check deployment status when the user asks about deploys, builds, or production state.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "inspect", "cancel"] as const),
      status: Type.Optional(
        Type.String({
          description:
            "Filter by status: READY, BUILDING, ERROR, QUEUED, CANCELED (comma-separated)",
        })
      ),
      environment: Type.Optional(StringEnum(["production"] as const)),
      url: Type.Optional(
        Type.String({
          description: "Deployment URL for inspect or cancel action",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.action === "cancel") {
        if (!params.url) {
          throw new Error("url parameter is required for cancel action");
        }
        const result = await cancelDeployment(pi, params.url);
        if (!result.success) {
          throw new Error(result.message);
        }
        return {
          content: [{ type: "text", text: result.message }],
          details: { canceled: true, url: params.url },
        };
      }

      if (params.action === "inspect") {
        if (!params.url) {
          throw new Error("url parameter is required for inspect action");
        }
        const result = await inspectDeployment(pi, params.url);
        const lines = [
          `Deployment: ${result.url}`,
          `ID: ${result.id}`,
          `State: ${result.readyState}`,
          `Target: ${result.target ?? "preview"}`,
          `Created: ${new Date(result.createdAt).toISOString()}`,
          `Aliases: ${result.aliases.join(", ") || "none"}`,
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      }

      // list action
      invalidateCache();
      const deployments = await listDeployments(pi, {
        status: params.status,
        environment: params.environment,
        limit: 10,
      });

      if (deployments.length === 0) {
        return {
          content: [{ type: "text", text: "No deployments found." }],
          details: { deployments: [] },
        };
      }

      const lines = deployments.map((d) => {
        const icon = stateIcon(d.state);
        const target = d.target ? "production" : "preview";
        const branch = d.meta.githubCommitRef ?? "—";
        const commit = truncateCommitMsg(
          d.meta.githubCommitMessage ?? "—",
          60
        );
        const time = timeAgo(d.createdAt);
        return `${icon} ${d.state.padEnd(12)} ${target.padEnd(12)} ${branch.padEnd(20)} ${commit.padEnd(62)} ${time}`;
      });

      const header = `${"STATUS".padEnd(14)} ${"TARGET".padEnd(12)} ${"BRANCH".padEnd(20)} ${"COMMIT".padEnd(62)} TIME`;
      const text = [header, "─".repeat(120), ...lines].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { deployments },
      };
    },

    renderCall(args, theme, _context) {
      let text =
        theme.fg("toolTitle", theme.bold("vercel_deployments ")) +
        theme.fg("muted", args.action);
      if (args.status) {
        text += " " + theme.fg("dim", `status=${args.status}`);
      }
      if (args.environment) {
        text += " " + theme.fg("dim", `env=${args.environment}`);
      }
      if (args.url) {
        text += " " + theme.fg("dim", args.url);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as
        | { deployments?: VercelDeployment[] }
        | undefined;

      if (!details?.deployments) {
        // Inspect/cancel result or empty
        const content = result.content[0];
        return new Text(
          content?.type === "text" ? content.text : "No data",
          0,
          0
        );
      }

      const deployments = details.deployments;
      if (deployments.length === 0) {
        return new Text(theme.fg("dim", "No deployments found."), 0, 0);
      }

      // Compact view: latest deploy only
      const latest = deployments[0];
      const icon = stateIcon(latest.state);
      const colorKey = stateColorKey(latest.state);
      let output = `${icon} ${theme.fg(colorKey, latest.state)} · ${theme.fg("accent", latest.meta.githubCommitRef ?? "—")} · ${theme.fg("muted", truncateCommitMsg(latest.meta.githubCommitMessage ?? "—", 50))} · ${theme.fg("dim", timeAgo(latest.createdAt))}`;

      if (deployments.length > 1) {
        output += theme.fg("dim", `  (${deployments.length} total)`);
      }

      // Expanded view: all deployments
      if (expanded && deployments.length > 1) {
        for (let i = 1; i < deployments.length; i++) {
          const d = deployments[i];
          const dIcon = stateIcon(d.state);
          const dColor = stateColorKey(d.state);
          const target = d.target
            ? theme.fg("success", "prod")
            : theme.fg("dim", "prev");
          output += `\n${dIcon} ${theme.fg(dColor, d.state.padEnd(12))} ${target.padEnd(6)} ${theme.fg("accent", (d.meta.githubCommitRef ?? "—").padEnd(18))} ${theme.fg("muted", truncateCommitMsg(d.meta.githubCommitMessage ?? "—", 40))} ${theme.fg("dim", timeAgo(d.createdAt))}`;
        }
      }

      return new Text(output, 0, 0);
    },
  });
}
