# Ship Studio

[![CI](https://github.com/ship-studio/ship-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/ship-studio/ship-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> A desktop app for shipping web projects with AI coding agents.

Ship Studio gives you an integrated AI terminal (Claude Code or Codex), a live
preview, branch + PR management, and Vercel deploys — all wrapped around the
Git workflow you already know. It's a native Tauri app written in Rust and
React, built for developers who want to move fast without leaving their
editor mindset behind.

## Features

- **AI-Powered Development** — Built-in terminal for Claude Code or Codex, with multi-tab and side-by-side agent panes.
- **Live Preview** — Real-time preview with responsive breakpoints (Desktop, Tablet, Mobile) and 50–150% zoom.
- **Project Management** — Visual project cards with automatic screenshot thumbnails.
- **GitHub Integration** — One-click repo creation, publishing, PR submission with AI-generated titles/descriptions, and merge-conflict resolution UI.
- **Vercel Integration** — Deploy to staging or production with one click; auto-deploys on push.
- **Branch & PR Management** — Branch picker, PR list, post-merge cleanup flow.
- **Monorepo Support** — Workspace picker for `pnpm`/`yarn`/`npm` workspaces.
- **Environment Variables** — Built-in `.env` editor with syntax validation.
- **IDE Launcher** — Open projects directly in VS Code or Cursor.
- **Plugins** — Extend the app with first-party and community plugins.
- **Auto-Updates** — In-app update banner with one-click apply + restart.

## Install

Pre-built binaries for the latest stable release live at
[ship-studio/releases](https://github.com/ship-studio/releases/releases/latest):

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | `Ship.Studio_<version>_aarch64.dmg` |
| macOS (Intel)         | `Ship.Studio_<version>_x64.dmg` |
| Windows (x64)         | `Ship.Studio_<version>_x64-setup.exe` |

After installing, launch the app — Ship Studio's onboarding wizard walks you
through installing the system prerequisites (Node, Git, GitHub CLI, an AI
agent CLI) automatically. See [docs/INSTALLATION.md](docs/INSTALLATION.md)
for the full guide and screenshots.

## Prerequisites

Before running Ship Studio, make sure you have the following installed:

| Tool | Required | Installation |
|------|----------|--------------|
| **Node.js** | Yes | [nodejs.org](https://nodejs.org/) |
| **npm** | Yes | Comes with Node.js |
| **Git** | Yes | [git-scm.com](https://git-scm.com/) |
| **Claude Code CLI** | Yes | `npm install -g @anthropic-ai/claude-code` |
| **GitHub CLI** | Optional | [cli.github.com](https://cli.github.com/) |
| **Vercel CLI** | Optional | `npm install -g vercel` |
| **Chrome/Chromium/Edge** | For thumbnails | Any Chromium-based browser |
| **Rust** | For development | [rustup.rs](https://rustup.rs/) |

## Quick Start

### Running the App

```bash
# Clone the repository
git clone https://github.com/ship-studio/ship-studio.git
cd ship-studio

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

### Building for Production

```bash
# Build the app
pnpm tauri build

# The built app will be in src-tauri/target/release/bundle/
```

## Auto-updates

The official builds check for updates on launch and every hour. When a new
version is available, a banner appears with an in-app update + restart flow.
The most recent changes are in [RELEASE_NOTES.md](RELEASE_NOTES.md).

**Publishing your own builds?** See [docs/FORKING.md](docs/FORKING.md) for the
full release pipeline — signing certificates, Tauri updater keypair, GitHub
Actions secrets, telemetry replacement, and how to repoint the updater
endpoint at your own releases repo.

## Development Setup

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### 2. Install Node Dependencies

```bash
pnpm install
```

### 3. Run Development Server

```bash
pnpm tauri dev
```

This will start both the Vite dev server and the Tauri application.

## Project Structure

```
ship-studio/
├── src/                          # React frontend
│   ├── components/               # UI components (~55 files)
│   │   ├── Terminal.tsx          # Claude Code terminal with PTY
│   │   ├── Preview.tsx          # Live preview with native webview
│   │   ├── WorkspaceView.tsx    # Main workspace layout
│   │   ├── ProjectList.tsx      # Project dashboard
│   │   ├── BranchesTab.tsx      # Branch management UI
│   │   ├── PluginManager.tsx    # Plugin install/manage UI
│   │   ├── setup/               # Onboarding wizard components
│   │   └── ...
│   ├── lib/                      # Tauri command wrappers & utilities
│   │   ├── git.ts               # Git operations (status, commits, branches)
│   │   ├── github.ts            # GitHub CLI helpers (auth, push, clone)
│   │   ├── project.ts           # Project metadata and file operations
│   │   ├── setup.ts             # Setup wizard and integration status
│   │   ├── branches.ts          # Branch operations and PR status
│   │   ├── polling.ts           # Exponential backoff utilities
│   │   ├── logger.ts            # Structured frontend logging
│   │   ├── plugins.ts           # Plugin system helpers
│   │   ├── analytics.ts         # PostHog analytics
│   │   └── ...                  # ~30 modules total
│   ├── hooks/                    # Custom React hooks
│   ├── styles/                   # CSS files (base.css, etc.)
│   └── App.tsx                   # Main application & state management
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── lib.rs               # App setup & command registration
│   │   ├── state.rs             # Shared application state
│   │   ├── types.rs             # Shared type definitions
│   │   ├── utils.rs             # Path validation, helpers
│   │   ├── cache.rs             # TTL-based git caching
│   │   ├── commands/            # Modular command handlers
│   │   │   ├── git/             # Git operations (branches, status, stash, sync)
│   │   │   ├── projects/        # Project CRUD (detection, metadata, templates)
│   │   │   ├── setup/           # Onboarding (auth, install, status checks)
│   │   │   ├── plugins/         # Plugin lifecycle & storage
│   │   │   ├── ide/             # IDE launch & screenshot capture
│   │   │   ├── github.rs        # GitHub CLI integration
│   │   │   ├── pty.rs           # Pseudo-terminal for embedded terminal
│   │   │   ├── publishing.rs    # Vercel deployment workflow
│   │   │   ├── pull_requests.rs # PR listing and creation
│   │   │   ├── conflicts.rs     # Merge conflict resolution
│   │   │   ├── ai.rs            # AI-powered PR generation via Claude CLI
│   │   │   ├── assets.rs        # /public folder file management
│   │   │   ├── env.rs           # Environment variable management
│   │   │   ├── claude.rs        # Claude Code binary detection
│   │   │   ├── skills.rs        # Skill/workflow management
│   │   │   ├── mcp.rs           # MCP server configuration
│   │   │   ├── health.rs        # Code health analysis
│   │   │   ├── analytics.rs     # Analytics event tracking
│   │   │   └── ...
│   │   └── ...
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri configuration & CSP
└── package.json
```

## How It Works

### Creating a Project

1. Click **"+ New Project"** on the home screen
2. Enter a project name
3. Ship Studio clones the Next.js template and installs dependencies
4. You're dropped into the workspace with Claude Code ready to go

### GitHub Integration

Ship Studio integrates with GitHub CLI for seamless version control:

1. **No Repo** → Shows "Create Repo" button
2. **Create Repo** → Opens modal to name your repo (public/private)
3. **Connected** → Shows "Publish" button
   - Greyed out when up-to-date
   - Active when changes detected (polls every 5s)
4. **Publish** → Confirmation modal → Commits & pushes

### Vercel Integration

Deploy your projects to production with one click:

1. **No GitHub repo** → Vercel button hidden (create repo first)
2. **Deploy** → Opens modal to configure and deploy to Vercel
3. **Deploying...** → Shows progress while deployment runs
4. **Live** → Opens your live site at `https://your-project.vercel.app`

Auto-deploys are enabled when connected to GitHub—every push triggers a new deployment.

### Environment Variables

Manage your `.env` files directly in the app:

1. Click the **gear icon** in the project header
2. Create new env files (`.env`, `.env.local`, `.env.production`)
3. Add, edit, or delete environment variables
4. Changes are saved automatically

Supports validation for variable names (alphanumeric + underscore only).

### IDE Integration

Open projects in your preferred code editor:

1. Click the **code icon** in the project header
2. Choose **VS Code** or **Cursor**
3. The project opens in a new editor window

### Project Thumbnails

When you open a project, Ship Studio automatically captures a screenshot of your site using Chrome/Chromium/Edge in headless mode. Thumbnails are:
- Captured once the dev server is ready
- Standardized to 640px wide with 16:10 aspect ratio
- Updated every 5 minutes while the project is open
- Stored in `.shipstudio/thumbnail.png` in each project

**Note:** Requires Chrome, Chromium, or Edge installed for thumbnail capture.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Rust + Tauri 2
- **Terminal**: xterm.js with PTY support
- **Styling**: CSS Variables (dark theme)
- **Fonts**: JetBrains Mono Nerd Font

## Backend commands

The Rust backend exposes its functionality through Tauri commands organised
by domain under [`src-tauri/src/commands/`](src-tauri/src/commands/) and
registered in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs). Read those
files for the authoritative list.

## Project templates

When you create a new project, Ship Studio clones one of the starter
templates declared in [`src/hooks/useProjectCreation.ts`](src/hooks/useProjectCreation.ts)
(Next.js, SvelteKit, Astro, Nuxt — all under the
[`ship-studio`](https://github.com/orgs/ship-studio/repositories?q=starter)
GitHub org). To add a new template, append to that constant.

## Known Limitations

### Page Selector Navigation

The page selector dropdown shows available routes and lets you navigate to them. However, if you click links inside the preview iframe, the selector won't update to reflect the new page. This is due to browser cross-origin security restrictions (the preview runs on a different port).

**Workaround:** Use the page selector dropdown to navigate between pages.

### Vercel Detection for External Deployments

Projects deployed to Vercel outside of Ship Studio (e.g., via CLI directly) may show "Deploy" instead of "Live" until redeployed through the app. This is because Ship Studio uses a marker file to track deployment status.

## Troubleshooting

### Terminal not responding after modal

Click on the terminal area to refocus it.

### GitHub CLI not detected

Make sure `gh` is installed and in your PATH:
```bash
gh --version
gh auth login
```

### Build errors on macOS

Ensure Xcode Command Line Tools are installed:
```bash
xcode-select --install
```

## Privacy & telemetry

The official Ship Studio builds send anonymous usage events to a
Memberstack-hosted [PostHog](https://posthog.com/) project and crash reports
to [Sentry](https://sentry.io/). What's collected is documented in
[docs/analytics.md](docs/analytics.md).

You can disable analytics at any time from inside the app
(**Settings → Usage analytics** toggle). The setting persists across launches
and the Rust backend short-circuits all sends when disabled. Crash reports
follow the same toggle.

If you're building your own distribution and don't want events flowing to
Memberstack's analytics — or want them flowing to your own project — see
[docs/FORKING.md → Telemetry](docs/FORKING.md#telemetry) for how to swap the
keys or strip telemetry entirely.

## Security

Found a vulnerability? **Do not file a public issue.** See
[SECURITY.md](SECURITY.md) for the private-reporting process.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and
the pull-request process.

**Before writing code**, read
[docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md) — it captures
the design-system primitives (`<ModalFrame>`, `<Button>`, `useInvoke`,
`useAsyncState`, `useCopyToClipboard`, `usePolling`, `ModalContext`,
`ToastContext`, design tokens, `CommandError`) that keep the codebase
consistent. New contributors and AI assistants should skim it first.

Then:

1. Fork the repository
2. Create a feature branch
3. Make your changes (see [Code of Conduct](CODE_OF_CONDUCT.md))
4. Submit a pull request

## Community

- [GitHub Discussions](https://github.com/ship-studio/ship-studio/discussions) — questions, ideas, show-and-tell.
- [Community Slack](https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-3ommmu2w4-jtYZzzc9T~9lsEeKQ4E2AQ) — real-time chat with maintainers and users.
- [Issues](https://github.com/ship-studio/ship-studio/issues) — bug reports and feature requests.

## License

[MIT](LICENSE) © Memberstack and Ship Studio contributors.
