# Install Harbr

Harbr is currently intended to be built from source. Tagged workflows prepare
draft macOS, Windows, and Linux artifacts in the
[Harbr releases](https://github.com/kacigaya/harbr/releases) page; a draft is not
an endorsed public release until it has been tested and published.

## Browser server

Follow [self-hosting.md](self-hosting.md). The browser server is single-user and
has shell access as the account running it, so keep it on loopback or behind a
trusted TLS and authentication boundary.

## Desktop app

Install Node 22, pnpm, Rust stable, and the platform prerequisites from the
[Tauri documentation](https://v2.tauri.app/start/prerequisites/), then run:

```bash
pnpm install
pnpm tauri dev
```

Build installers with `pnpm tauri build`.

## Data locations

Fresh installs create projects in `~/Harbr` by default. App state and logs use
Harbr-owned platform directories:

- macOS state: `~/Library/Application Support/Harbr/app_state.json`
- macOS logs: `~/Library/Logs/Harbr/`
- Windows state and logs: `%LOCALAPPDATA%\Harbr\`
- Linux state: `${XDG_DATA_HOME:-~/.local/share}/harbr/app_state.json`
- Linux logs: `${XDG_STATE_HOME:-~/.local/state}/harbr/`

Per-project metadata remains under `<project>/.shipstudio` for compatibility.
On first launch, Harbr may copy supported legacy Ship Studio JSON state when no
Harbr state exists. It does not modify the legacy source or overwrite Harbr
state. Existing legacy project roots remain usable.

Automatic update checks and updater artifacts are disabled until Harbr has its
own signing key. Update by installing a reviewed release or rebuilding from
source.

For help, use [GitHub Issues](https://github.com/kacigaya/harbr/issues). Report
security concerns according to [SECURITY.md](../SECURITY.md).
