# Native Mobile App Preview — Implementation Status

Status snapshot as of 2026-06-02. Companion to `mobile-app-preview-plan.md`
(which holds the design rationale + spike findings). This doc is the
"what's actually built, what works, what doesn't" record.

Branch: **`feat/mobile-app-preview`** (10 commits, **not pushed**, not merged).

---

## TL;DR

Ship Studio can now preview a **real, interactive iOS Simulator** inside the
workspace for React Native / Expo and Flutter projects. The mirror (video +
tap/scroll input) is **fully working and validated**. Auto-booting a simulator,
shutting it down on project close, and auto-launching the project's app onto the
sim are **built but the native-build path is not yet validated end-to-end**
(needs a real app with deps + a multi-minute Xcode build, which couldn't be run
in-repo).

---

## Commits on the branch (oldest → newest)

| Commit | What |
|--------|------|
| `6c07467` | Mobile preview plan doc |
| `e1d86d7` | **Phase 0**: detect RN/Expo & Flutter as `ProjectType`; stop routing them to the web iframe / web dev server |
| `6fecbc8` | iOS Simulator capture spike findings (simctl screenshot ≈ 2.5fps, too slow) |
| `365f440` | serve-sim validated as the iOS transport → skip a custom Swift sidecar |
| `89760bc` | **iOS Simulator mirror** in the preview pane (auto-boot, MJPEG stream, input) |
| `8324089` | Address code review (daemon-leak teardown, hasPreview gate, screenshot gate, iOS-only device pick, list_pages arm) |
| `dbaeb43` | **Fix touch input**: serve-sim WS is binary opcode-3 begin/move/end (not text down/up) |
| `02fb745` | **Fix "stuck on looking for a simulator"**: React StrictMode lifecycle bug → per-run `cancelled` pattern |
| `3160993` | **Auto-launch app on sim** + **shut sim down on project close** |
| `b6dedc9` | Fix auto-launch: deps-gate + `npx --yes` (no interactive hang) + real building/finished/failed status |

---

## How it works (end to end)

1. Open a React Native/Expo or Flutter project → detected as `ProjectType::Reactnative` / `Flutter` (`detection.rs`).
2. The web dev server is **not** started for these types (`useDevServer.ts` mobile branch). The workspace lands on the **Preview** tab, which renders `<DeviceMirror>` instead of the web `<Preview>` iframe (`WorkspaceView.tsx`, gated on `isMobileProject` / `hasPreview`).
3. `DeviceMirror` auto-connects:
   - Lists booted sims; if none, **boots the newest available iPhone** (`boot_default_simulator`) and waits via `simctl bootstatus -b`.
   - Starts a **serve-sim** daemon for that sim (`start_simulator_mirror` → `npx serve-sim --detach`).
   - Embeds serve-sim's **MJPEG stream** (`http://127.0.0.1:3100/stream.mjpeg`) in an `<img>`.
   - Opens serve-sim's **WebSocket** (`ws://127.0.0.1:3100/ws`) and forwards mouse → touch.
   - **Auto-launches the app**: gets the launch command, gates on installed deps, runs it via the dev-server PTY, streams the build into a collapsible log panel.
4. On **project close** (`unregister_project_session`) or **window close** (`lib.rs` Destroyed handler): stop serve-sim + `simctl shutdown` the sim **only if we booted it**. Tab switches do NOT close the session, so they don't shut the sim down.

---

## serve-sim (the iOS transport)

`serve-sim` by Evan Bacon (Expo core), Apache-2.0, run via `npx -y serve-sim`.
Requires macOS + Xcode CLI (`xcrun simctl`) + Node 18+.

- **Video**: MJPEG at `:3100/stream.mjpeg`. Adaptive framerate (~3fps idle, **~18fps under motion**). Streams a headless-booted runtime — serve-sim itself opens Simulator.app.
- **Input — IMPORTANT / hard-won**: the WS control channel is **BINARY**, not text. Each message is a **1-byte opcode + UTF-8 JSON**. Touch = **opcode `3`** + `{"type": "begin"|"move"|"end", "x": <0..1>, "y": <0..1>}`. (Keyboard is opcode `6`.) A tap is `begin`+`end`; a drag adds `move`. This is implemented in `connectInputChannel` (`src/lib/mobile.ts`) and verified end-to-end (a WS tap opens Settings; a swipe scrolls).
- Lifecycle: `--detach` daemon, `--list`, `--kill [udid]`.

---

## Backend (Rust)

### `src-tauri/src/commands/mobile.rs` (new)
Tauri commands:
- `list_booted_simulators() -> Vec<MobileSimulator>` — `simctl list devices booted --json`.
- `boot_default_simulator(project_path, preferred) -> BootResult { simulator, booted_by_us }` — reuse a booted sim (booted_by_us=false) or boot the newest available **iPhone** (`choose_default_simulator`, iOS-runtime-only); registers the sim in `state::MOBILE_SIMS`.
- `start_simulator_mirror(udid) -> MirrorInfo { stream_url, ws_url, port, udid }` — `npx serve-sim --detach`.
- `stop_simulator_mirror(udid)` — `serve-sim --kill`.
- `get_simulator_launch_command(project_path, udid) -> String` — `build_launch_command` picks: Expo → `npx --yes expo run:ios --device <udid>`; bare RN → `npx --yes react-native run-ios --udid <udid>`; Flutter → `flutter run -d <udid>`.
- `shutdown_simulator_for_project(project_path)` — stop serve-sim + `simctl shutdown` (only if booted_by_us). Called on project close.
- Plus `shutdown_all_booted_sims_sync()` (non-command) for the window-Destroyed handler.
- Pure helpers are unit-tested (12 tests): `parse_booted_simulators`, `parse_mirror_info`, `choose_default_simulator`, `runtime_version`, `build_launch_command`.

### Other backend
- `state.rs`: `MOBILE_SIMS: HashMap<project_path, BootedSim{udid, booted_by_us}>` + `register_booted_sim` / `take_booted_sim` / `take_all_booted_sims`.
- `types.rs`: `ProjectType::Reactnative`, `ProjectType::Flutter` (serde lowercase → `"reactnative"`, `"flutter"`).
- `detection.rs`: `is_react_native_project`, `is_flutter_project`, `is_expo_project`; mobile detectors run **before** web detectors; mobile config files added to the detection mtime-signature.
- `projects/mod.rs`: `list_pages` returns empty for RN/Flutter (don't scan Expo Router `app/` as Next.js).
- `sessions.rs`: `unregister_project_session` calls `shutdown_simulator_for_project`.
- `lib.rs`: registers the 6 mobile commands; window-Destroyed global cleanup calls `shutdown_all_booted_sims_sync`.

## Frontend (React/TS)

- `src/lib/mobile.ts` (new): wrappers + `connectInputChannel` (the binary WS protocol).
- `src/components/DeviceMirror.tsx` (new): the whole mirror UI + lifecycle state machine. Auto-connect via an effect keyed on an `attempt` counter, each run with a local `cancelled` flag (StrictMode-safe, no daemon leak). States: starting/booting/connecting/connected/idle/error; launch states: none/needs-install/building/finished/failed/unsupported.
- `src/lib/static-server.ts`: `ProjectType` union + `isMobileProjectType`.
- `src/hooks/useDevServer.ts`: mobile branch skips the web dev server.
- `WorkspaceView.tsx`: renders `<DeviceMirror>` on the preview tab for mobile; `isWebProject`/`isMobileProject`/`hasPreview` gating.
- `BranchPRTabContainer.tsx` / `BranchIndicator.tsx`: `isWebProject` → `hasPreview` so mobile gets the back-to-preview affordance and doesn't double-render the branches pane.
- `src/styles/features/device-mirror.css` (new).

---

## What's validated ✅ vs not ❌

**Validated (proven against a real booted sim or by tests):**
- ✅ Detection of RN/Expo/Flutter (unit tests + live).
- ✅ Mirror video stream renders the live sim.
- ✅ **Tap + drag/scroll input** (binary opcode-3 protocol) — verified end-to-end.
- ✅ Auto-boot of a default iPhone (simctl boot + bootstatus).
- ✅ `simctl shutdown` mechanics + booted-by-us tracking logic (tests + reasoning).
- ✅ StrictMode lifecycle fix (no more stuck status, logs confirm flow).
- ✅ Launch-command builder (unit tests).

**NOT validated ❌ (could not run in-repo):**
- ❌ The actual native build/launch (`expo run:ios` / `flutter run`) — needs a real app with `node_modules` + CocoaPods + a multi-minute Xcode build. Built to be transparent (streamed log) and non-fatal (mirror keeps working), but never seen to succeed here.
- ❌ Sim-shutdown-on-close in the live app (the hooks are wired; the per-project close path and window-close path are reasoned/coded but not observed firing).

---

## Known issues / limitations / follow-ups

1. **Auto-launch needs a real app.** The test projects (`~/ShipStudio/test-{expo,react-native,flutter}-app`) are bare skeletons with **no deps and no native project** — they will show "Dependencies not installed" or fail in the build log. Need a real `create-expo-app` (or user project) with deps to validate.
2. **Read-only build log can't host a fully interactive build.** Mitigated by deps-gate + `npx --yes`, but steps that still prompt (e.g. `pod install`) can't be answered. **Proper fix: run the launch in a real interactive terminal tab** (the user explicitly chose "auto-run in terminal"; current impl streams to a read-only `<pre>`). This is the top follow-up.
3. **serve-sim daemon lifecycle is partly component-driven.** DeviceMirror stops it on unmount; backend close hooks add a safety net. A hard crash could still orphan a daemon on `:3100`. Deeper fix: a backend mirror registry keyed by window (the review flagged this).
4. **Ports hardcoded `:3100/:3200`.** Multiple windows would collide. Should reserve via `RESERVED_PORTS` and pass `--port`.
5. **Tab-switch tears down + rebuilds the launch.** DeviceMirror unmounts on tab switch, killing the launch PTY; returning re-runs it. Acceptable for v1 but wasteful; project-scoped launch lifecycle would fix it.
6. **Android / physical devices**: not started. Android = scrcpy (cross-OS, plan §4.1); physical iOS = Corellium/Appetize (buy, don't build).
7. **serve-sim is a young dep (v0.1.x).** Pin/vendor before relying on it long-term.

---

## How to test

Dev build: `pnpm tauri dev` (the running instance is restarted manually after
big changes; HMR covers frontend, the watcher recompiles backend).

- **Mirror + input**: open `test-react-native-app` → Preview. It auto-boots an iPhone (~30s first time) and shows the live sim. Tap/drag should work.
- **Auto-launch**: shows "Dependencies not installed — npm install, then Reconnect" for the skeletons (correct). Needs a real Expo/RN app with deps to actually build.
- **Sim shutdown**: close the project → the sim Ship Studio booted should shut down. Switch tabs → it stays booted. A sim you pre-booted is never shut down.

Test project skeletons live in `~/ShipStudio/test-expo-app`, `test-react-native-app`, `test-flutter-app` (git-initialized, no deps).

---

## Recommended next steps (in order)

1. **Scaffold a real runnable Expo app** (deps installed) to validate the auto-launch loop end-to-end. *This is the current blocker to "make auto-open work."*
2. **Move the launch to a real interactive terminal tab** (matches "auto-run in terminal"; handles prompts; obviously live). Reuse the install-terminal pattern (`installTerminalConfig`).
3. Backend-owned serve-sim lifecycle (registry + window-close cleanup) + `RESERVED_PORTS`-based ports.
4. Verify sim-shutdown-on-close fires in the live app.
5. Then: Android via scrcpy.
