/**
 * TUI rendering helpers — icons, colors, time formatting, deployment list component
 * Supports monorepo multi-project display with project name column.
 */
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Focusable } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type VercelDeployment, type VercelProject, isCancellable } from "./vercel-cli.js";

type DeployState = VercelDeployment["state"];

export function stateIcon(state: DeployState): string {
  switch (state) {
    case "READY":
      return "🟢";
    case "BUILDING":
    case "INITIALIZING":
      return "🟡";
    case "ERROR":
      return "🔴";
    case "QUEUED":
      return "⚪";
    case "CANCELED":
      return "⚫";
    default:
      return "❓";
  }
}

export function stateColorKey(
  state: DeployState
): "success" | "warning" | "error" | "muted" | "dim" {
  switch (state) {
    case "READY":
      return "success";
    case "BUILDING":
    case "INITIALIZING":
      return "warning";
    case "ERROR":
      return "error";
    case "QUEUED":
      return "muted";
    case "CANCELED":
      return "dim";
    default:
      return "dim";
  }
}

export function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncateCommitMsg(msg: string, maxLen: number = 50): string {
  if (msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen - 1) + "…";
}

/** Check if deployments span multiple projects */
function isMultiProject(deployments: VercelDeployment[]): boolean {
  const names = new Set(deployments.map((d) => d.projectName ?? d.name));
  return names.size > 1;
}

export function formatDeploymentLine(
  d: VercelDeployment,
  theme: Theme,
  width: number,
  showProject: boolean
): string {
  const icon = stateIcon(d.state);
  const colorKey = stateColorKey(d.state);
  const state = theme.fg(colorKey, d.state.padEnd(12));
  const project = showProject
    ? theme.fg("accent", truncateCommitMsg(d.projectName ?? d.name, 18).padEnd(20))
    : "";
  const branch = theme.fg("accent", (d.meta.githubCommitRef ?? "—").padEnd(20));
  const commit = theme.fg(
    "muted",
    truncateCommitMsg(d.meta.githubCommitMessage ?? "—", 40).padEnd(42)
  );
  const time = theme.fg("dim", timeAgo(d.createdAt).padEnd(10));
  const target = d.target
    ? theme.fg("success", "production")
    : theme.fg("dim", "preview");

  const line = `${icon} ${state} ${project}${branch} ${commit} ${time} ${target}`;
  return truncateToWidth(line, width);
}

export type CancelRequest = (url: string) => Promise<{ success: boolean; message: string }>;
export type OpenUrlRequest = (url: string) => void;
export type OpenBuildRequest = (deployment: VercelDeployment) => Promise<string | null>;

/**
 * Deployment list UI component for /deployments command
 */
export class DeploymentListComponent {
  private deployments: VercelDeployment[];
  private theme: Theme;
  private onClose: () => void;
  private onCancel?: CancelRequest;
  private onOpenUrl?: OpenUrlRequest;
  private onOpenBuild?: OpenBuildRequest;
  private selectedIndex = 0;
  private statusMessage?: { text: string; type: "info" | "success" | "error" };
  private cancelling = false;
  private opening = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private multiProject: boolean;

  constructor(
    deployments: VercelDeployment[],
    theme: Theme,
    onClose: () => void,
    onCancel?: CancelRequest,
    onOpenUrl?: OpenUrlRequest,
    onOpenBuild?: OpenBuildRequest
  ) {
    this.deployments = deployments;
    this.theme = theme;
    this.onClose = onClose;
    this.onCancel = onCancel;
    this.onOpenUrl = onOpenUrl;
    this.onOpenBuild = onOpenBuild;
    this.multiProject = isMultiProject(deployments);
  }

  handleInput(data: string): void {
    if (this.cancelling) return;

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.statusMessage = undefined;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(
        this.deployments.length - 1,
        this.selectedIndex + 1
      );
      this.statusMessage = undefined;
      this.invalidate();
      return;
    }

    // Open build page with 'b'
    if (data === "b" && this.onOpenBuild && !this.opening) {
      const selected = this.deployments[this.selectedIndex];
      if (!selected) return;

      this.opening = true;
      this.statusMessage = { text: "Opening build page...", type: "info" };
      this.invalidate();

      this.onOpenBuild(selected).then((url) => {
        this.opening = false;
        if (url) {
          this.statusMessage = { text: `Opened ${url}`, type: "success" };
        } else {
          this.statusMessage = { text: "Failed to resolve build page URL", type: "error" };
        }
        this.invalidate();
      });
      return;
    }

    // Cancel selected deployment with 'x'
    if (data === "x" && this.onCancel) {
      const selected = this.deployments[this.selectedIndex];
      if (!selected || !selected.url) return;

      if (!isCancellable(selected.state)) {
        this.statusMessage = {
          text: `Can only cancel building/queued deployments (current: ${selected.state.toLowerCase()})`,
          type: "error",
        };
        this.invalidate();
        return;
      }

      this.cancelling = true;
      this.statusMessage = {
        text: `Canceling ${selected.url}...`,
        type: "info",
      };
      this.invalidate();

      this.onCancel(selected.url).then((result) => {
        this.cancelling = false;
        if (result.success) {
          selected.state = "CANCELED";
          this.statusMessage = { text: result.message, type: "success" };
        } else {
          this.statusMessage = { text: result.message, type: "error" };
        }
        this.invalidate();
      });
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const mp = this.multiProject;

    lines.push("");
    const title = th.fg("accent", " Vercel Deployments ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 24)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (this.deployments.length === 0) {
      lines.push(
        `  ${th.fg("dim", "No deployments found.")}`
      );
    } else {
      // Column headers
      const projectCol = mp ? th.fg("dim", "PROJECT".padEnd(20)) : "";
      const header = `   ${th.fg("dim", "STATUS".padEnd(14))}${projectCol}${th.fg("dim", "BRANCH".padEnd(22))}${th.fg("dim", "COMMIT".padEnd(44))}${th.fg("dim", "TIME".padEnd(12))}${th.fg("dim", "TARGET")}`;
      lines.push(truncateToWidth(header, width));
      lines.push(
        `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`
      );

      for (let i = 0; i < this.deployments.length; i++) {
        const d = this.deployments[i];
        const prefix = i === this.selectedIndex ? th.fg("accent", "▸ ") : "  ";
        const icon = stateIcon(d.state);
        const colorKey = stateColorKey(d.state);
        const state = th.fg(colorKey, d.state.padEnd(12));
        const project = mp
          ? th.fg("accent", truncateCommitMsg(d.projectName ?? d.name, 18).padEnd(20))
          : "";
        const branch = th.fg(
          "accent",
          (d.meta.githubCommitRef ?? "—").padEnd(20)
        );
        const commit = th.fg(
          "muted",
          truncateCommitMsg(d.meta.githubCommitMessage ?? "—", 40).padEnd(42)
        );
        const time = th.fg("dim", timeAgo(d.createdAt).padEnd(10));
        const target = d.target
          ? th.fg("success", "production")
          : th.fg("dim", "preview");

        const line = `${prefix}${icon} ${state} ${project}${branch} ${commit} ${time} ${target}`;
        lines.push(truncateToWidth(line, width));
      }
    }

    // Status message (cancel feedback)
    if (this.statusMessage) {
      lines.push("");
      const colorKey =
        this.statusMessage.type === "success"
          ? "success"
          : this.statusMessage.type === "error"
            ? "error"
            : "warning";
      lines.push(
        truncateToWidth(
          `  ${th.fg(colorKey as any, this.statusMessage.text)}`,
          width
        )
      );
    }

    lines.push("");
    const hints = ["↑/↓ navigate", "b open build", "x cancel deploy", "Escape to close"];
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", hints.join(" · "))}`,
        width
      )
    );
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/**
 * Overlay component for Ctrl+Shift+V shortcut — floating deployment panel
 */
export class DeploymentOverlayComponent implements Focusable {
  focused = false;

  private deployments: VercelDeployment[];
  private theme: Theme;
  private done: (result: void) => void;
  private onCancel?: CancelRequest;
  private onOpenUrl?: OpenUrlRequest;
  private onOpenBuild?: OpenBuildRequest;
  private selectedIndex = 0;
  private statusMessage?: { text: string; type: "info" | "success" | "error" };
  private cancelling = false;
  private opening = false;
  private loading: boolean;
  private multiProject = false;

  constructor(
    deployments: VercelDeployment[] | null,
    theme: Theme,
    done: (result: void) => void,
    onCancel?: CancelRequest,
    onOpenUrl?: OpenUrlRequest,
    onOpenBuild?: OpenBuildRequest
  ) {
    this.deployments = deployments ?? [];
    this.theme = theme;
    this.done = done;
    this.onCancel = onCancel;
    this.onOpenUrl = onOpenUrl;
    this.onOpenBuild = onOpenBuild;
    this.loading = deployments === null;
    if (deployments) {
      this.multiProject = isMultiProject(deployments);
    }
  }

  setDeployments(deployments: VercelDeployment[]): void {
    this.deployments = deployments;
    this.loading = false;
    this.multiProject = isMultiProject(deployments);
  }

  handleInput(data: string): void {
    if (this.cancelling || this.opening) return;

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }

    if (this.loading || this.deployments.length === 0) return;

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.statusMessage = undefined;
      return;
    }

    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(
        this.deployments.length - 1,
        this.selectedIndex + 1
      );
      this.statusMessage = undefined;
      return;
    }

    // Open deployment URL with Enter
    if (matchesKey(data, "return")) {
      const selected = this.deployments[this.selectedIndex];
      if (selected?.url && this.onOpenUrl) {
        this.onOpenUrl(`https://${selected.url}`);
        this.statusMessage = {
          text: `Opened https://${selected.url}`,
          type: "success",
        };
      }
      return;
    }

    // Open build page with 'b'
    if (data === "b" && this.onOpenBuild) {
      const selected = this.deployments[this.selectedIndex];
      if (!selected) return;

      this.opening = true;
      this.statusMessage = { text: "Opening build page...", type: "info" };

      this.onOpenBuild(selected).then((url) => {
        this.opening = false;
        if (url) {
          this.statusMessage = { text: `Opened ${url}`, type: "success" };
        } else {
          this.statusMessage = { text: "Failed to resolve build page URL", type: "error" };
        }
      });
      return;
    }

    if (data === "x" && this.onCancel) {
      const selected = this.deployments[this.selectedIndex];
      if (!selected || !selected.url) return;

      if (!isCancellable(selected.state)) {
        this.statusMessage = {
          text: `Can only cancel building/queued (current: ${selected.state.toLowerCase()})`,
          type: "error",
        };
        return;
      }

      this.cancelling = true;
      this.statusMessage = { text: "Canceling...", type: "info" };

      this.onCancel(selected.url).then((result) => {
        this.cancelling = false;
        if (result.success) {
          selected.state = "CANCELED";
          this.statusMessage = { text: result.message, type: "success" };
        } else {
          this.statusMessage = { text: result.message, type: "error" };
        }
      });
    }
  }

  render(width: number): string[] {
    const w = Math.max(40, width);
    const th = this.theme;
    const innerW = w - 2;
    const lines: string[] = [];
    const mp = this.multiProject;

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const row = (content: string) =>
      th.fg("border", "│") + pad(" " + content, innerW) + th.fg("border", "│");

    const emptyRow = () =>
      th.fg("border", "│") + " ".repeat(innerW) + th.fg("border", "│");

    // Header
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    lines.push(row(`${th.fg("accent", "▲ Vercel Deployments")}`));
    lines.push(emptyRow());

    if (this.loading) {
      lines.push(row(th.fg("dim", "Loading deployments...")));
    } else if (this.deployments.length === 0) {
      lines.push(row(th.fg("dim", "No deployments found.")));
    } else {
      // Column header
      const projectCol = mp ? th.fg("dim", "PROJECT".padEnd(18)) : "";
      lines.push(
        row(
          `${th.fg("dim", "STATUS".padEnd(14))}${projectCol}${th.fg("dim", "BRANCH".padEnd(mp ? 22 : 30))}${th.fg("dim", "COMMIT".padEnd(mp ? 28 : 36))}${th.fg("dim", "TIME".padEnd(10))}${th.fg("dim", "TARGET")}`
        )
      );
      lines.push(
        th.fg("border", "│") +
          th.fg("borderMuted", " " + "─".repeat(innerW - 1)) +
          th.fg("border", "│")
      );

      for (let i = 0; i < this.deployments.length; i++) {
        const d = this.deployments[i];
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? th.fg("accent", "▸") : " ";
        const icon = stateIcon(d.state);
        const colorKey = stateColorKey(d.state);
        const state = th.fg(colorKey, d.state.padEnd(12));
        const project = mp
          ? th.fg("accent", truncateCommitMsg(d.projectName ?? d.name, 16).padEnd(18))
          : "";
        const branchLen = mp ? 20 : 28;
        const commitLen = mp ? 26 : 34;
        const branch = th.fg(
          "accent",
          truncateCommitMsg(d.meta.githubCommitRef ?? "—", branchLen).padEnd(branchLen)
        );
        const commit = th.fg(
          "muted",
          truncateCommitMsg(d.meta.githubCommitMessage ?? "—", commitLen).padEnd(commitLen)
        );
        const time = th.fg("dim", timeAgo(d.createdAt).padEnd(10));
        const target = d.target
          ? th.fg("success", "prod")
          : th.fg("dim", "prev");

        lines.push(row(`${prefix} ${icon} ${state}${project}${branch}${commit}${time}${target}`));
      }

      // Show URL for selected deployment
      const selected = this.deployments[this.selectedIndex];
      if (selected?.url) {
        lines.push(emptyRow());
        const projectInfo = selected.projectName
          ? `${th.fg("dim", "Project:")} ${th.fg("accent", selected.projectName)}  `
          : "";
        lines.push(
          row(
            `${projectInfo}${th.fg("dim", "URL:")} ${th.fg("accent", `https://${selected.url}`)}`
          )
        );
      }
    }

    // Status message
    if (this.statusMessage) {
      lines.push(emptyRow());
      const colorKey =
        this.statusMessage.type === "success"
          ? "success"
          : this.statusMessage.type === "error"
            ? "error"
            : "warning";
      lines.push(row(th.fg(colorKey as any, this.statusMessage.text)));
    }

    // Footer
    lines.push(emptyRow());
    lines.push(
      row(th.fg("dim", "↑/↓ navigate · Enter open URL · b open build · x cancel · Esc close"))
    );
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}
