# Ship Studio

Build AI-native marketing sites easily with SOTA technology.

Ship Studio is a desktop application that combines Claude Code's AI capabilities with a streamlined development environment for creating Next.js marketing websites. It provides an integrated terminal, live preview, and seamless GitHub integration—all in one native app.

## Features

- **AI-Powered Development** - Built-in Claude Code terminal for AI-assisted coding
- **Live Preview** - Real-time preview with responsive breakpoints (Desktop, Tablet, Mobile)
- **Preview Zoom** - Zoom out (50-150%) to see larger layouts on smaller screens
- **Project Management** - Visual project cards with automatic screenshot thumbnails
- **GitHub Integration** - One-click repo creation and publishing with smart change detection
- **Vercel Integration** - Deploy to production with one click, auto-deploys on push
- **Page Navigation** - Quick switcher for all your Next.js routes
- **Sanity CMS Integration** - Native webview for Sanity Studio with full OAuth support
- **Environment Variables** - Built-in `.env` file editor with syntax validation
- **IDE Launcher** - Open projects directly in VS Code or Cursor

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

## Releases and Auto-Updates

Ship Studio includes built-in auto-update functionality. When a new version is available, users see a banner at the top of the app with the option to update and restart.

### Setting Up GitHub Secrets

Before creating releases, add these secrets to your GitHub repository (Settings → Secrets → Actions):

1. **`TAURI_SIGNING_PRIVATE_KEY`** - The private key for signing update artifacts. Located at `~/.tauri/ship-studio.key`
2. **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** - Password for the key (can be empty if none was set)

### Creating a Release

1. Update the version in `src-tauri/tauri.conf.json`:
   ```json
   {
     "version": "1.0.0"
   }
   ```

2. Commit and push the version bump:
   ```bash
   git add src-tauri/tauri.conf.json
   git commit -m "Bump version to 1.0.0"
   git push
   ```

3. Create and push a version tag:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

4. GitHub Actions will automatically:
   - Build the app for macOS (Intel + Apple Silicon)
   - Sign the update artifacts
   - Create a draft release with all assets
   - Generate `latest.json` for the updater

5. Review and publish the draft release on GitHub.

### How Auto-Updates Work

- On app launch (after 5 seconds), and every hour, the app checks for updates
- It fetches `latest.json` from the GitHub releases
- If a newer version exists, a banner appears with "Update" button
- Clicking "Update" downloads the update with a progress bar
- Once complete, "Restart Now" restarts the app with the new version

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
│   ├── App.tsx                   # Main application & state management
│   └── App.css                   # Global styles (CSS variables, dark theme)
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

### Sanity CMS Integration

Projects using Sanity CMS get a dedicated "Open Sanity" button in the preview toolbar:

1. **Auto-Detection** → Ship Studio detects `sanity.config.ts` or Sanity dependencies
2. **Native Webview** → Opens Sanity Studio in a native webview (not iframe) for full OAuth support
3. **Full Features** → Google OAuth, image uploads, and all Sanity features work correctly

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

## Backend API (Tauri Commands)

The Rust backend (`src-tauri/src/commands/`) exposes these commands to the frontend. Commands are organized into domain-specific modules and registered in `src-tauri/src/lib.rs`:

### Project Management
| Command | Description |
|---------|-------------|
| `get_shipstudio_dir` | Returns `~/ShipStudio` path |
| `list_projects` | Lists all projects in Ship Studio directory |
| `create_project` | Clones template and installs dependencies |
| `delete_project` | Removes a project directory |
| `list_pages` | Scans Next.js app directory for routes |

### Dev Server & Terminal
| Command | Description |
|---------|-------------|
| `spawn_pty` | Creates a PTY for terminal emulation |
| `write_pty` | Sends input to a PTY |
| `resize_pty` | Resizes PTY dimensions |
| `kill_pty` | Terminates a PTY process |
| `start_dev_server` | Runs `npm run dev` in background |
| `stop_dev_server` | Kills the dev server process |

### GitHub Integration
| Command | Description |
|---------|-------------|
| `check_gh_cli_status` | Checks if `gh` is installed and authenticated |
| `get_project_github_status` | Returns repo info, remote URL, pending changes |
| `create_github_repo` | Creates a new GitHub repository |
| `commit_and_push` | Stages all changes, commits, and pushes |

### Vercel Integration
| Command | Description |
|---------|-------------|
| `check_vercel_cli_status` | Checks if `vercel` is installed and authenticated |
| `get_project_vercel_status` | Returns linked status and production URL |
| `deploy_to_vercel` | Links project and deploys to production |

### Environment Variables
| Command | Description |
|---------|-------------|
| `list_env_files` | Lists all `.env*` files in project |
| `read_env_file` | Parses env file into key-value pairs |
| `write_env_file` | Saves env variables with validation |
| `create_env_file` | Creates a new env file |
| `delete_env_file` | Removes an env file |

### Native Webview (for Sanity CMS)
| Command | Description |
|---------|-------------|
| `create_preview_webview` | Creates a child webview at specified position |
| `resize_preview_webview` | Updates webview position and size |
| `destroy_preview_webview` | Removes the child webview |
| `check_sanity_installed` | Detects Sanity in project |

### Utilities
| Command | Description |
|---------|-------------|
| `check_prerequisites` | Verifies Node, Git, Claude Code are installed |
| `capture_screenshot` | Takes a screenshot using headless Chrome |
| `check_ide_availability` | Checks if VS Code/Cursor are installed |
| `open_in_ide` | Opens project in VS Code or Cursor |

## Configuration

### Tauri Config

Edit `src-tauri/tauri.conf.json` to modify:
- Window size and title
- App identifier
- Build settings

### Template Repository

The Next.js template is cloned from:
```
https://github.com/ship-studio/static-marketing-site-starter
```

To use a different template, update `TEMPLATE_REPO` in `src/components/CreateProject.tsx`.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development setup, code style guidelines, and the pull request process.

**Before writing code**, read [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md) — it captures the design-system primitives (`<ModalFrame>`, `<Button>`, `useInvoke`, `useAsyncState`, `useCopyToClipboard`, `usePolling`, `ModalContext`, `ToastContext`, design tokens, `CommandError`) that keep the codebase consistent. New contributors and AI assistants should skim it first.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT

---

Built with Claude Code
