# pi-vercel-deployments

A [Pi](https://github.com/nichochar/pi-coding-agent) extension that brings Vercel deployment visibility directly into your terminal. List, inspect, and cancel deployments without leaving your workflow.

## Features

### Status Bar Indicator

A persistent footer line shows the latest deployment state at a glance — status, branch, commit message, and how long ago it was created. Refreshes automatically every 60 seconds.

```
▲ Vercel · ready · main · fix: update auth redirect · 12m ago
```

### `/deployments` Command

An interactive TUI list of recent deployments with keyboard navigation.

| Key | Action |
| --- | --- |
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `x` | Cancel selected deployment (building/queued only) |
| `Escape` | Close |

Supports filtering by passing an argument:

```
/deployments              # all recent deployments
/deployments production   # production only
/deployments building     # building and queued
/deployments errors       # failed deployments
```

### `Ctrl+Shift+V` Overlay

A floating panel you can open from anywhere. Same navigation as the command, plus:

| Key | Action |
| --- | --- |
| `Enter` | Open the selected deployment URL in your browser |

### `vercel_deployments` Tool

An agent-callable tool so the AI can check deployment status on your behalf.

**Actions:**

| Action | Description | Required params |
| --- | --- | --- |
| `list` | List recent deployments with optional filters | `status?`, `environment?` |
| `inspect` | Get detailed info for a specific deployment | `url` |
| `cancel` | Cancel a building or queued deployment | `url` |

Example prompts:

- *"What's the status of my latest deploy?"*
- *"Cancel the deployment that's currently building"*
- *"Show me all failed deployments"*

## Prerequisites

- [Pi](https://github.com/nichochar/pi-coding-agent) coding agent
- [Vercel CLI](https://vercel.com/docs/cli) installed and authenticated (`npm i -g vercel && vercel login`)
- A Vercel-linked project (`.vercel/project.json` must exist in the working directory)

## Installation

Clone or copy this extension into your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone <repo-url> vercel-deployments
cd vercel-deployments
pnpm install
```

The extension auto-activates when Pi detects a `.vercel/project.json` in the current working directory. No additional configuration is needed.

## Project Structure

```
├── index.ts        # Extension entry point — wires up status bar, command, shortcut, and tool
├── vercel-cli.ts   # Vercel CLI wrapper — list, inspect, cancel with typed responses and 30s caching
├── ui.ts           # TUI components — icons, colors, time formatting, list and overlay renderers
├── package.json
├── tsconfig.json
└── .gitignore
```

## How It Works

The extension shells out to the Vercel CLI (`vercel list`, `vercel inspect`, `vercel remove`) via `pi.exec()` and parses the JSON output. Results from `vercel list` are cached for 30 seconds to avoid excessive CLI calls during status bar refreshes.

The extension gracefully handles missing prerequisites:

- **No `.vercel/project.json`** → extension silently skips activation
- **No `vercel` CLI** → shows a warning notification on session start
- **CLI auth/link errors** → surfaces specific error messages

## License

MIT
