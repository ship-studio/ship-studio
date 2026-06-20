# Installation guide

This guide is for end users who want to download and run Ship Studio.
If you want to **build from source** or **publish your own distribution**,
see [docs/FORKING.md](FORKING.md) instead.

## Supported platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | Apple Silicon (M-series) | Supported |
| macOS    | Intel (x86_64) | Supported |
| Windows  | x64 | Supported |
| Linux    | — | Not yet — PRs welcome |

Minimum versions:

- macOS 12 (Monterey) or newer
- Windows 10 21H2 or newer

## Step 1 — Download the installer

Grab the latest release from
[ship-studio/releases](https://github.com/ship-studio/releases/releases/latest):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Ship.Studio_<version>_aarch64.dmg` |
| macOS (Intel)         | `Ship.Studio_<version>_x64.dmg` |
| Windows (x64)         | `Ship.Studio_<version>_x64-setup.exe` |

The macOS installer is signed and notarised by Apple. The Windows installer
is not yet code-signed by a CA — SmartScreen may warn on first install (see
[Step 2 → Windows](#windows) for what to expect). Auto-updates are enabled
by default; the app checks for new releases on launch and once an hour.

## Step 2 — Install

### macOS

1. Open the downloaded `.dmg`.
2. Drag **Ship Studio** into `Applications`.
3. Eject the disk image.
4. Launch from `Applications` (or Spotlight).

On first launch macOS may show "Ship Studio is from the internet — are you
sure?" Click **Open**. If you see "cannot be opened because the developer
cannot be verified," right-click the app → **Open** to bypass once.

### Windows

1. Run `Ship.Studio_<version>_x64-setup.exe`.
2. SmartScreen will likely show "Windows protected your PC" because the
   current builds are not yet signed by a Certificate Authority. Click
   **More info → Run anyway** to install.
3. Launch from the Start menu.

## Step 3 — First-launch onboarding

Ship Studio's setup wizard checks for the tools it relies on and installs the
missing ones. You'll see four steps:

1. **Package manager** — Homebrew (macOS) and Node.js. Installed via your
   shell terminal so you can see what's happening.
2. **Git & GitHub** — Git, the `gh` CLI, and a one-click `gh auth login` flow.
3. **AI agent** — Claude Code or Codex CLI, plus an auth flow for whichever
   you choose. You can have both installed.
4. **Hosting (optional)** — skippable; you can connect Vercel later from the
   Publish menu.

Each item is detected automatically. If something's already installed (e.g.
you already use `gh`), the wizard auto-advances past it.

If you want to re-run onboarding for testing, set the environment variable
`SHIPSTUDIO_FORCE_ONBOARDING=1` before launching from a terminal.

## Step 4 — Open or create a project

After onboarding you land on the **Projects** view. Two paths:

- **Import an existing repo** — point at a folder on disk, or paste a GitHub
  URL to clone. Monorepos are detected and you'll be asked to pick a
  workspace.
- **Create a new project** — choose a starter template (Next.js, static
  HTML, etc.) and a name. Ship Studio clones it and runs `pnpm install`
  for you.

Once a project is open, the workspace has:

- An AI terminal (Claude / Codex)
- A live preview (or "Focus" mode to hide it)
- A branches tab and PR tab
- A publish menu (push to GitHub, deploy to Vercel)

## Where files live

| What | Location |
|------|----------|
| Projects | `~/ShipStudio/<project-name>` |
| Logs (macOS) | `~/Library/Logs/ShipStudio/` |
| Logs (Windows) | `%LOCALAPPDATA%\ShipStudio\logs\` |
| Per-project metadata | `<project>/.shipstudio/project.json` |
| Vercel linkage | `<project>/.vercel/project.json` |

## Updating

Ship Studio updates itself. When a new release is published, a banner appears
inside the app. Click **Update**, wait for the download, then **Restart Now**.

If you ever need to update manually, download the latest installer and run
it — your projects and settings persist outside the app bundle.

## Uninstalling

> The paths below use the official Ship Studio bundle identifier
> (`com.memberstack.shipstudio`). If you installed a fork, swap that for the
> bundle identifier the fork uses.

### macOS

```bash
# Remove the app
rm -rf /Applications/Ship\ Studio.app

# Remove logs and caches
rm -rf ~/Library/Logs/ShipStudio
rm -rf ~/Library/Application\ Support/com.memberstack.shipstudio
rm -rf ~/Library/Caches/com.memberstack.shipstudio

# Your projects in ~/ShipStudio/ stay put — delete them manually if you want.
```

### Windows

1. **Settings → Apps → Installed apps → Ship Studio → Uninstall.**
2. Optionally remove `%LOCALAPPDATA%\ShipStudio\` for logs and caches.
3. Optionally remove `%APPDATA%\com.memberstack.shipstudio\` for app state.

## Troubleshooting

### The app won't open on macOS ("cannot be opened")

Right-click the app in `Applications` → **Open** → confirm. This is a
one-time Gatekeeper prompt.

### GitHub features show "not connected" after I ran `gh auth login`

Quit and relaunch Ship Studio. Auth state is cached at startup.

### Auto-update banner doesn't appear

- Make sure you have internet access.
- Check `~/Library/Logs/ShipStudio/ship-studio.log` for `updater` entries.
- The check runs 5 seconds after launch and again every hour.

### Terminal text is unreadable / fonts look broken

The terminal uses **JetBrains Mono Nerd Font**. It's bundled with the app
binary, but if you're running from source, fonts come from
`src/assets/fonts/`. Confirm the dev server is serving them.

### Project thumbnails not generating

Thumbnails require Chrome, Chromium, or Edge installed for headless capture.
This is optional — the rest of the app works without it.

## Getting help

- [GitHub Discussions](https://github.com/ship-studio/ship-studio/discussions) for questions.
- [GitHub Issues](https://github.com/ship-studio/ship-studio/issues) for bug reports — please use the [bug report template](../.github/ISSUE_TEMPLATE/bug_report.md).
- [Community Slack](https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g) for real-time chat.
- Security issues → [SECURITY.md](../SECURITY.md).
