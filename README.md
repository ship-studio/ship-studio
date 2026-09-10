<p align="center">
  <img src="public/harbr-mark.svg" alt="Harbr" width="112" height="112" />
</p>

<h1 align="center">Harbr</h1>

<p align="center"><strong>A self-hosted workspace for AI-assisted development.</strong><br />
Run coding agents, live previews, Git workflows, and deployments from the browser or desktop.</p>

<p align="center">
  <a href="https://react.dev"><img alt="React" src="https://shieldcn.dev/badge/React-19-18181b.svg?variant=secondary&logo=react" /></a>
  <a href="https://www.rust-lang.org"><img alt="Rust" src="https://shieldcn.dev/badge/Rust-stable-18181b.svg?variant=secondary&logo=rust" /></a>
  <a href="https://tauri.app"><img alt="Tauri" src="https://shieldcn.dev/badge/Tauri-2-18181b.svg?variant=secondary&logo=tauri" /></a>
</p>

Harbr runs the same React workspace against a native Tauri backend or an authenticated Rust web server. It is single-user, self-hosted software. Your projects and agent processes stay on the machine where Harbr runs.

> [!WARNING]
> Harbr provides terminal and filesystem access to its host. Anyone with a valid web session can run commands with the Harbr process owner's permissions. Keep it on loopback or a trusted private network. If you expose it through a reverse proxy, require TLS and strong access controls.

## Run in a browser

Prerequisites: Node 22, pnpm, Rust stable, and Linux build tools for Tauri.

```bash
git clone https://github.com/kacigaya/harbr.git
cd harbr
pnpm install
pnpm build
cargo build --manifest-path src-tauri/Cargo.toml --features web --bin harbr-server
HARBR_AUTH_TOKEN="$(openssl rand -hex 32)" \
  ./src-tauri/target/debug/harbr-server
```

Open `http://127.0.0.1:1420`. Configuration, reverse-proxy guidance, preview port mapping, and the complete security model are in [docs/self-hosting.md](docs/self-hosting.md).

## Run the desktop app

```bash
pnpm install
pnpm tauri dev
```

Build production packages with `pnpm tauri build`. Linux onboarding detects missing system tools but does not install packages or request `sudo`. Install Node.js, Git, and GitHub CLI through your distribution. Native iOS simulator previews remain macOS-only.

## Features

- Claude Code, Codex, Cursor, and OpenCode terminals with tabs and split panes
- Live browser previews, responsive breakpoints, inspection, and visual editing
- Git branches, worktrees, pull requests, conflict resolution, and snapshots
- Project dashboards, folders, multiple workspaces, and hot sessions
- Vercel and Cloudflare hosting workflows backed by returned deployment state
- Extensible skills, MCP servers, and project plugins
- Authenticated command, event, and PTY transports for browser use

Harbr keeps `.shipstudio` project metadata and `ss:*` preview protocols compatible with existing projects. Fresh installations use `~/Harbr`. A first launch can copy supported Ship Studio JSON app state into Harbr's own state directory; it never overwrites Harbr data or changes legacy files. Existing project roots remain accessible.

Updater checks and updater artifacts are disabled until Harbr has its own signing key. Build and release workflows target this repository, but this change does not publish a release.

## Development

```bash
pnpm check:all
pnpm test:run
pnpm rust:test
cargo test --manifest-path src-tauri/Cargo.toml --features web
pnpm build
```

Architecture and contribution rules are documented in [CLAUDE.md](CLAUDE.md), [AGENTS.md](AGENTS.md), and [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md).

## Fork and license

Harbr is an independent fork of [Ship Studio](https://github.com/ship-studio/ship-studio). The repository preserves upstream Git history and remains available under the MIT License.

Harbr metadata is attributed to Gaya KACI and Harbr contributors. The original Ship Studio copyright notice remains in [LICENSE](LICENSE). Redistributed dependency notices remain in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
