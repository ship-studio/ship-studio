# Ship Studio

[![CI](https://github.com/ship-studio/ship-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/ship-studio/ship-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Download](https://img.shields.io/badge/Download-macOS%20%7C%20Windows-54E36E)](https://www.ship.studio/download)

**The professional studio for modern development.**
Build it, ship it, host it — without leaving the app.

Ship Studio is a **free desktop app** that puts everything you need for
agentic development in one window: an AI agent terminal, a live preview,
visual editing, Git branches and PRs, and one-click deploys. Plug in the
agent and accounts you already pay for — Claude Code, Codex, or OpenCode;
GitHub; Vercel — and start shipping.

The web is changing, and freelancers, agencies, and designers are trying to
stay up to speed. Ship Studio is the easiest path to modern development: all
the simplicity of the all-in-one tools you're used to, **without the
lock-in**. It's a real desktop app that runs locally on your Mac — your code
lives on your machine, not on our servers.

*Dev tools for the rest of us.*

[**Download for free**](https://www.ship.studio/download) · [Website](https://www.ship.studio/) · [Community Slack](https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g) · [Follow @galluzzo_julian](https://x.com/galluzzo_julian) · [YouTube](https://www.youtube.com/@shipstudio_app)

---

## Why Ship Studio

- **Truly free.** No account, no Ship Studio subscription on top. Bring the
  agent and hosting accounts you already have.
- **No lock-in.** It's your repo, your machine, your hosting. Stop using
  Ship Studio tomorrow and you keep everything.
- **One window.** Agent, preview, branches, deploys — no tab-juggling
  between a terminal, an editor, GitHub, and a hosting dashboard.

## What you get

- **AI Agent Terminal** — Claude Code, Codex, or OpenCode built in, with
  multi-tab and side-by-side agent panes.
- **Live Preview** — Real-time preview with responsive breakpoints, zoom,
  fullscreen mode, and a locale switcher for multilingual projects.
- **Visual Editing** — Select an element, change it, write custom CSS —
  without burning AI credits. Pinnable editor panel and a Webflow-style
  element tree in fullscreen.
- **Mobile App Preview** — Build and mirror Expo, React Native, and Flutter
  apps on the iOS simulator, right in the workspace.
- **GitHub Integration** — One-click repo creation, publishing, PR
  submission with AI-generated titles/descriptions, and a merge-conflict
  resolution UI.
- **Deploys** — Push to staging or production on Vercel with one click;
  auto-deploys on every push.
- **Projects Dashboard** — Visual cards and a dense list view with bulk
  selection, automatic screenshot thumbnails, folders, pinned hot sessions,
  and multi-window support.
- **Snapshots & Backups** — Create and restore project snapshots when an
  agent goes off the rails.
- **Command Palette** — Cmd+K for every action in the app.
- **Starter Templates** — Next.js, SvelteKit, Astro, Nuxt, plain
  HTML/CSS/JS — plus Expo, React Native, and Flutter mobile starters.
- **Plugins, Skills & MCP** — Extend the app with plugins, install agent
  skills, and configure MCP servers.
- **Env Editor, IDE Launcher, Monorepo Support, Auto-Updates** — the
  unglamorous stuff, handled.

## Install

Grab the latest release from
[ship-studio/releases](https://github.com/ship-studio/releases/releases/latest):

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | `Ship.Studio_<version>_aarch64.dmg` |
| macOS (Intel)         | `Ship.Studio_<version>_x64.dmg` |
| Windows (x64)         | `Ship.Studio_<version>_x64-setup.exe` |
| Linux (x64)           | `ShipStudio_linux-x86_64.AppImage` or `.deb` |

Launch the app and the onboarding wizard takes it from there — it installs
the system prerequisites (Node, Git, GitHub CLI, an AI agent CLI) for you.
See [docs/INSTALLATION.md](docs/INSTALLATION.md) for the full guide.

### Linux notes

Ship Studio does **not** install system packages on Linux — your distribution
owns that, and we'd rather not ask for your sudo password. The onboarding
wizard detects Node, Git, and the GitHub CLI and shows you the command to run
if any are missing:

```bash
sudo apt install nodejs npm git gh   # Debian/Ubuntu; adjust for your distro
```

Agent CLIs (Claude Code, Codex, Opencode, Cursor) ship their own installers and
are still installed by the wizard as on macOS.

Running the AppImage needs FUSE (`sudo apt install libfuse2` on Ubuntu 22.04+),
or extract it with `./ShipStudio_linux-x86_64.AppImage --appimage-extract`.

One feature is macOS-only and is hidden rather than shown broken on Linux: the
**native mobile app preview**, which drives Xcode's iOS simulator. Everything
else — the agent terminal, live preview, visual editing, git/PR flows,
snapshots, plugins — works. "Open in browser" uses Chromium, Chrome, Firefox,
Brave, or Edge, whichever it finds on your `PATH`.

Official builds auto-update: the app checks on launch and hourly, then
applies updates with one click. Recent changes live in
[RELEASE_NOTES.md](RELEASE_NOTES.md).

## Build from source

Prerequisites: [Node 22](https://nodejs.org) (see [`.nvmrc`](.nvmrc)),
[pnpm](https://pnpm.io), [Rust stable](https://rustup.rs/), and on macOS the
Xcode Command Line Tools (`xcode-select --install`).

On Debian/Ubuntu, Tauri also needs the GTK/WebKit development headers:

```bash
sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev patchelf
```

```bash
git clone https://github.com/ship-studio/ship-studio.git
cd ship-studio
pnpm install
pnpm tauri dev      # run in development mode
pnpm tauri build    # production build → src-tauri/target/release/bundle/
```

## How it's built

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite |
| Backend | Rust, Tauri 2 |
| Terminal | xterm.js + tauri-pty |
| Styling | CSS design tokens (dark theme) |

```
ship-studio/
├── src/                      # React frontend
│   ├── components/           # UI components (incl. setup/, edit/, primitives/)
│   ├── lib/                  # Tauri command wrappers & utilities
│   ├── hooks/                # Custom React hooks
│   ├── commands/             # Cmd+K palette registry
│   ├── contexts/             # Modal, toast, and other app contexts
│   └── styles/               # CSS (global tokens, features, modes)
├── src-tauri/                # Rust backend
│   └── src/commands/         # Tauri commands by domain:
│                             #   git/ projects/ setup/ pty/ plugins/ skills/
│                             #   health/ ide/ + mobile, edit, publishing,
│                             #   github, conflicts, snapshots, i18n, …
├── docs/                     # Contributor & forking docs
└── packages/plugin-sdk/      # Plugin SDK
```

The backend exposes its functionality as Tauri commands registered in
[`src-tauri/src/lib.rs`](src-tauri/src/lib.rs); the frontend calls them
through typed wrappers in [`src/lib/`](src/lib/). For the full architecture
tour, read [CLAUDE.md](CLAUDE.md) — it's the same guide AI agents use to
work on this codebase.

## Contributing

We'd love your help — and we've tried to make it **absurdly easy** for both
humans and AI agents to contribute:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) — setup, CI gates, and the PR process.
2. Skim [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md) — the
   shared primitives (`<ModalFrame>`, `<Button>`, `useInvoke`, design
   tokens, `CommandError`) that keep the codebase consistent.
3. Working with an AI agent? It will pick up [CLAUDE.md](CLAUDE.md) /
   [AGENTS.md](AGENTS.md) automatically and follow the house patterns.

Before pushing, run the same gates CI runs:

```bash
pnpm check:all && pnpm test:run && pnpm rust:test
```

Want to fork and ship your own distribution instead? See
[docs/FORKING.md](docs/FORKING.md).

## Privacy & telemetry

Official builds send anonymous usage events to the maintainers'
[PostHog](https://posthog.com/) project and crash reports to
[Sentry](https://sentry.io/). Every event is documented in
[docs/analytics.md](docs/analytics.md).

Disable analytics any time from inside the app (**Settings → Usage
analytics**) — the setting persists and the Rust backend short-circuits all
sends, crash reports included. Building your own distribution? See
[docs/FORKING.md → Telemetry](docs/FORKING.md#5--telemetry) to swap in your
own keys or strip telemetry entirely.

## Self-hosting

Ship Studio can also run as a server you reach from a browser. It is
**single-user software that grants shell access to its host** — read
[docs/self-hosting.md](docs/self-hosting.md) before exposing it to anything.

## Security

Found a vulnerability? **Do not file a public issue.** See
[SECURITY.md](SECURITY.md) for private reporting.

## Sponsors

Ship Studio is free and open source. These are the people covering the bills
and putting in the hours to keep it that way.

### [Native](https://www.native.agency/) — Web & product agency

Native is the web and product team for companies who value speed and quality
above all else. One team covering strategy, design, and development.

Native funds Ship Studio's running costs and contributes
development hours to the app itself. It's also part-owned by Ship Studio's
founders, so when you hire Native for a project, you're directly supporting
this one too.

- **Need a website or product?** [Work with Native ↗](https://www.native.agency/contact)
- **Agency or freelancer?** Native teams up on projects too — [reach out ↗](https://www.native.agency/contact)

### Support Ship Studio

Want to support the project with contributions or financially?
[Reach out](mailto:juliangalluzzois@gmail.com) — `juliangalluzzois@gmail.com`.

## Community

- [GitHub Discussions](https://github.com/ship-studio/ship-studio/discussions) — questions, ideas, show-and-tell
- [Community Slack](https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g) — real-time chat with maintainers and users
- [Issues](https://github.com/ship-studio/ship-studio/issues) — bug reports and feature requests
- [@galluzzo_julian](https://x.com/galluzzo_julian) — follow along on X
- [YouTube](https://www.youtube.com/@shipstudio_app) — tutorials, demos, and walkthroughs

## License

[MIT](LICENSE) © Julian Galluzzo and Ship Studio contributors.
