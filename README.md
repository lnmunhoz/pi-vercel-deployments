# pi-vercel-deployments

A [Pi](https://github.com/nichochar/pi-coding-agent) extension that brings Vercel deployment visibility directly into your terminal. List, inspect, and cancel deployments without leaving your workflow.

Supports **monorepos** — automatically discovers multiple Vercel-linked projects and aggregates their deployments in a single view.

## Features

### Monorepo Support

The extension scans your working directory and its immediate subdirectories for `.vercel/project.json` files. When multiple projects are found:

- Deployments from **all projects are merged** and sorted by time
- A **PROJECT column** appears in all views
- You can **filter by project name** in the tool and command
- The **status bar** shows a compact per-project summary

```
▲ Vercel · 🟢 admin · 🔴 rentabus-customer
```

For single-project repos, everything works as before — no PROJECT column, no extra noise.

### Status Bar Indicator

A persistent footer line shows the latest deployment state at a glance. Refreshes automatically every 60 seconds.

**Single project:**
```
▲ Vercel · ready · main · fix: update auth redirect · 12m ago
```

**Monorepo** (tree-style widget with per-project details):
```
▲ Vercel
├─ ready · admin · main · fix: update auth redirect · 12m ago
└─ building · customer-app · feat/checkout · add payment flow · 2m ago
```

### `/deployments` Command

An interactive TUI list of recent deployments with keyboard navigation.

| Key | Action |
| --- | --- |
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `b` | Open selected deployment's build page in the Vercel dashboard |
| `x` | Cancel selected deployment (building/queued/initializing only) |
| `Escape` | Close |

Supports filtering by passing an argument:

```
/deployments              # all recent deployments (all projects)
/deployments production   # production only
/deployments building     # building and queued
/deployments errors       # failed deployments
/deployments admin        # filter by project name (monorepo)
```

### `Ctrl+Shift+V` Overlay

A floating panel you can open from anywhere. Same navigation as the command, plus:

| Key | Action |
| --- | --- |
| `Enter` | Open the selected deployment URL in your browser |
| `b` | Open the selected deployment's build page in the Vercel dashboard |

The overlay shows the full deployment URL for the currently selected item. In monorepo mode, it also displays the project name in the detail row.

### `vercel_deployments` Tool

An agent-callable tool so the AI can check deployment status on your behalf.

**Actions:**

| Action | Description | Required params |
| --- | --- | --- |
| `list` | List recent deployments with optional filters | `status?`, `environment?`, `project?` |
| `inspect` | Get detailed info for a specific deployment | `url` |
| `cancel` | Cancel a building, queued, or initializing deployment | `url` |

The `project` parameter is available in monorepos and lets the agent filter to a specific project by name.

Tool results include rich rendering in the terminal:
- **Compact view** — shows the latest deployment with status icon, branch, commit, and time
- **Expanded view** — shows all returned deployments in a formatted table (click to expand in Pi)

Example prompts:

- *"What's the status of my latest deploy?"*
- *"Show me the admin deployments"*
- *"Cancel the deployment that's currently building"*
- *"Show me all failed deployments across all projects"*

## Prerequisites

- [Pi](https://github.com/nichochar/pi-coding-agent) coding agent
- [Vercel CLI](https://vercel.com/docs/cli) installed and authenticated (`npm i -g vercel && vercel login`)
- At least one Vercel-linked project (`.vercel/project.json` in the working directory or a subdirectory)

## Installation

Clone or copy this extension into your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone <repo-url> vercel-deployments
cd vercel-deployments
pnpm install
```

The extension auto-activates when Pi detects one or more `.vercel/project.json` files in the current working directory or its immediate subdirectories. No additional configuration is needed.

### Linking Vercel projects

For each project in your monorepo, run `vercel link` in its directory:

```bash
cd my-monorepo/admin
vercel link --scope my-team -p admin

cd ../customer-app
vercel link --scope my-team -p customer-app
```

## Project Structure

```
├── index.ts        # Extension entry — discovery, status bar, command, shortcut, tool
├── vercel-cli.ts   # Vercel CLI wrapper — multi-project list, inspect, cancel with per-project caching
├── ui.ts           # TUI components — icons, colors, list and overlay renderers with project column
├── package.json
├── tsconfig.json
└── .gitignore
```

## How It Works

1. **Project discovery** — on activation, scans `cwd` and immediate subdirectories for `.vercel/project.json` files
2. **Per-project queries** — shells out to `vercel list --cwd <dir>` for each discovered project
3. **Aggregation** — merges deployments from all projects, sorted by creation time
4. **Caching** — results are cached per-project for 30 seconds to avoid excessive CLI calls
5. **Dashboard URLs** — resolves Vercel dashboard links via `vercel inspect`, using `--scope` with the org ID for correct team context

The extension gracefully handles missing prerequisites:

- **No `.vercel/project.json` found** → extension silently skips activation
- **No `vercel` CLI** → shows a warning notification on session start
- **CLI auth/link errors** → surfaces specific error messages per project

## License

MIT
