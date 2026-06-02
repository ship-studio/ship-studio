# Plan: Native Mobile App Preview

Status: **Proposal / not started**
Branch: `feat/mobile-app-preview`
Author: drafted with Claude, 2026-06-02

---

## 1. Goal

Let Ship Studio preview **real native mobile apps** (React Native / Expo, and
Flutter) the same way it previews web apps today: a live, interactive view of the
running app inside the workspace, with hot reload, logs, and screenshots — not a
375px-wide web iframe pretending to be a phone.

A user opens a React Native or Flutter project, the app is detected as mobile, the
preview pane shows a **live, controllable mirror of a booted simulator/emulator**
(tap, scroll, type with the mouse/keyboard), and editing code hot-reloads the
running app.

### Explicit non-goals (v1)
- **Building/signing release binaries** — that's EAS / Xcode / Gradle territory.
- **Real physical iOS devices** — Simulator only (see §4.3). Physical devices and
  cloud device farms are a later, possibly-bought capability.
- **Replacing the web preview** — this is a parallel preview mode, gated on project
  type. The web path is untouched.

---

## 2. Why this is feasible (the core insight)

The current preview pane is **a webview rendering an `<iframe src="http://localhost:PORT">`**
(`src/components/Preview.tsx:686`). The display surface, toolbar, resize frame,
device-breakpoint switcher, and Inspect/logs panel are all generic.

You can't put a native app in an iframe — but you don't need to. You swap the
iframe's *source* for a **live video stream of a simulator/emulator decoded into a
`<canvas>`**, and forward pointer/keyboard events back to the device as synthetic
input. Everything else in the pane is reused.

This is a proven pattern, not speculation:
- **`vscode-ios-simulator-embed`** (Apache-2.0, github.com/mkloouo/vscode-ios-simulator-embed)
  streams the iOS Simulator into a *VS Code webview* via **ScreenCaptureKit**, forwards
  input via **SimulatorKit Indigo HID** (borrowing from Meta's MIT-licensed `idb`), at
  ~12 FPS. VS Code's webview ≈ Ship Studio's webview. It is a working reference
  implementation of most of the iOS half.
- **`scrcpy`** (github.com/Genymobile/scrcpy, v3.3.4) does the entire Android pipeline:
  H.264 capture over USB/Wi-Fi + input injection, no device-side app, no root.
- **`serve-sim`** streams a booted iOS simulator to a browser at up to 60 FPS with a
  gesture control channel — an alternative transport we could shell out to.

### What also makes it feasible: the dev-server model is already "external"
Ship Studio does **not** spawn the web dev server. The user (or Claude, in the
integrated terminal) runs `npm run dev`; the preview just polls `localhost:PORT`
(`src/hooks/usePreviewConnection.ts`). Mobile follows the identical model: the user/
Claude runs `expo start` / `flutter run` in the terminal, and Ship Studio attaches the
mirror. **We do not have to build a bundler-orchestration engine** — only detection +
the mirror + connection UX. This significantly shrinks scope.

---

## 3. Architecture overview

```
┌─────────────────────────── Ship Studio (Tauri) ───────────────────────────┐
│                                                                            │
│  Frontend (webview)                     Backend (Rust)                     │
│  ┌──────────────────────────┐           ┌──────────────────────────────┐  │
│  │ Preview.tsx              │           │ commands/projects/detection.rs│  │
│  │  ├─ web mode → <iframe>  │           │   → ProjectType::ReactNative   │  │
│  │  └─ mobile mode:         │           │   → ProjectType::Flutter       │  │
│  │      <DeviceMirror>      │◀──frames──│ mobile/ (NEW)                  │  │
│  │       <canvas>           │  (events)─│   ├─ android.rs  (scrcpy)      │  │
│  │      device-frame chrome │──────────▶│   ├─ ios_sim.rs  (SCKit+HID)   │  │
│  └──────────────────────────┘           │   └─ devices.rs  (list/boot)   │  │
│  useDeviceStream.ts (NEW)               │ state.rs (RESERVED_PORTS reuse)│  │
│  usePreviewConnection.ts (abstract src) └──────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
        │ frames + input                          │ launches / talks to
        ▼                                          ▼
   simulator/emulator window         scrcpy-server (device) / Xcode Simulator
```

Two capture/input pipelines (Android, iOS) behind **one shared frontend mirror
component**. They share the transport contract (frames in, input events out) and
nothing at the device layer — that split is unavoidable.

### Transport contract (shared by both pipelines)
The backend exposes a uniform stream the frontend consumes regardless of platform:
- **Frames out**: backend emits frames to the webview. Options, simplest → best:
  1. **Tauri event with base64 JPEG per frame** (simplest; fine for ~12–15 FPS MVP).
  2. **A localhost WebSocket** serving JPEG/MJPEG (decouples from the Tauri event
     loop; what `serve-sim`/the VS Code ext effectively do).
  3. **H.264 + WebCodecs** decode in the webview (best perf, most work — Phase 3
     optimization, not MVP).
- **Input in**: frontend sends normalized events (`{type, x_norm, y_norm, ...}`) via a
  Tauri command; backend maps to device coordinates and injects (scrcpy control msg /
  Indigo HID).

Start with **(1) JPEG-over-event** for the MVP — it's the least code and matches the
VS Code extension's proven ~12 FPS. Upgrade transport later without touching the UI.

---

## 4. Per-platform pipelines

### 4.1 Android (do this first — most mature, cross-OS)

**Tool: `scrcpy`.** Two integration styles:

- **(Recommended for v1) Drive the `scrcpy-server` protocol from Rust.** Push the
  bundled `scrcpy-server.jar` to the device with ADB, open its socket, read the raw
  H.264 video stream, and send control messages for input. Full control, embeds
  cleanly, no extra window. More upfront work decoding the protocol.
- **(Faster spike) Wrap the `scrcpy` binary** in a borderless mode and capture/relay,
  or study **`escrcpy`** (github.com/viarotel-org/escrcpy, an Electron wrapper with an
  "inset mirror" embedded window) for integration patterns.

Targets **both** physical Android devices (USB/Wi-Fi via ADB) and Android emulators.
Works when Ship Studio runs on macOS **and** Windows.

Decode path for MVP: H.264 → frames in Rust (e.g. `ffmpeg`/`openh264` sidecar or a
Rust H.264 decoder) → re-encode to JPEG → event to webview. (Or pass H.264 straight to
WebCodecs later.)

### 4.2 iOS Simulator (second — macOS only)

No scrcpy equivalent; build from the `vscode-ios-simulator-embed` blueprint:
- **Boot/list**: `xcrun simctl list devices`, `xcrun simctl boot <udid>`. Run app via
  the user's `expo run:ios` / `flutter run` / Xcode in the terminal.
- **Capture**: **ScreenCaptureKit** captures the booted Simulator window → JPEG stream.
  (`xcrun simctl io booted recordVideo` is a documented but slower fallback.)
- **Input**: **SimulatorKit Indigo HID** (private framework) — pointer→touch, keys→USB
  HID codes. Derive from `idb` (MIT).
- This almost certainly needs a small **Swift/Obj-C sidecar** (ScreenCaptureKit + the
  private frameworks aren't ergonomic from Rust). Tauri spawns and pipes to it.
- **Alternative**: shell out to **`serve-sim`** (streams the booted sim to a localhost
  browser endpoint at up to 60fps with a control channel) and point our webview/canvas
  at its stream. Less code; adds a Node/`serve-sim` runtime dependency. Evaluate during
  Phase 2 spike.

**Constraints to state plainly in the UI:**
- macOS only — Windows users get the Android path only.
- Simulator only, not physical iPhones.
- Private-API dependency → an Xcode/Simulator update can break it; isolate it in the
  sidecar so breakage is contained and detectable.

### 4.3 Physical devices & cloud (explicitly later / buy-don't-build)
Real iPhones have no Simulator-HID path. If customers need real-device or cross-machine
preview, integrate **Corellium** (self-serve from ~$99/mo) or **Appetize.io** as a paid
tier rather than building device virtualization. Out of scope for this plan.

---

## 5. Detection & project type

`src-tauri/src/types.rs` — extend the `ProjectType` enum:
```rust
pub enum ProjectType {
    Nextjs, Sveltekit, Astro, Nuxt, Vite, Statichtml, Generic, Unknown,
    ReactNative,   // bare RN or Expo
    Flutter,
}
```

`src-tauri/src/commands/projects/detection.rs` — add detectors mirroring the existing
`is_sveltekit_project` / `is_astro_project` style, and wire them into
`detect_project_type_uncached` (`detection.rs:194`) **before** the generic/web fallbacks:
- **React Native / Expo**: `app.json` or `app.config.{js,ts}` with `expo`, or
  `package.json` containing `"react-native"` / `"expo"`, or an `ios/`+`android/` pair
  with a `metro.config.js`.
- **Flutter**: `pubspec.yaml` containing `flutter:`.

Also add the new config files to the mtime-signature list (`detection.rs:25`) so the
detection cache invalidates when they change (`app.json`, `pubspec.yaml`,
`metro.config.js`).

Add unit tests alongside the existing detection tests (`detection.rs:669`).

---

## 6. Frontend changes

- **`src/components/Preview.tsx`** — branch on preview kind:
  - web (today) → `<iframe>`
  - mobile → `<DeviceMirror>` (NEW). Keep the toolbar; swap the breakpoint buttons for
    **device-model presets** (iPhone 15, Pixel 8, …) + a rotate button. Keep the logs/
    Inspect panel (dev-server output still flows from the terminal/bundler).
- **`src/components/DeviceMirror.tsx`** (NEW) — `<canvas>` that paints incoming frames,
  draws optional device-frame chrome (bezel), and maps mouse/keyboard → normalized
  input events.
- **`src/hooks/useDeviceStream.ts`** (NEW) — subscribes to the frame stream (Tauri event
  or localhost WS), decodes, drives the canvas; exposes `sendInput(event)`.
- **`src/hooks/usePreviewConnection.ts`** — generalize "what is the preview source": an
  HTTP localhost URL (web) **or** a device-stream handle (mobile). Connection states
  (connecting / ready / error) and the "ask Claude to run …" affordance generalize:
  web → "run `npm run dev`", mobile → "run `expo start` / `flutter run` and boot a
  simulator".
- **`src/lib/`** — new wrapper (e.g. `mobile.ts`) for the device commands
  (list/boot/attach/sendInput), per the CLAUDE.md "components call lib wrappers" rule.
- **Cmd+K**: add `devices.boot` / `preview.selectDevice` via `useCommands` (device
  selection is a discrete action, palette-appropriate; per-row stuff stays out).

---

## 7. Backend changes

- **New module `src-tauri/src/mobile/`**:
  - `devices.rs` — list/boot simulators & emulators, detect connected Android devices
    (ADB), expose as `Result<_, CommandError>` Tauri commands with
    `#[tracing::instrument]`.
  - `android.rs` — scrcpy-server lifecycle, H.264 read, control-message input.
  - `ios_sim.rs` — spawn/talk to the Swift sidecar (ScreenCaptureKit + Indigo HID), or
    the `serve-sim` wrapper.
  - `stream.rs` — the shared frame-emit + input-inject plumbing (transport contract).
- **`src-tauri/src/state.rs`** — reuse the `RESERVED_PORTS` / `RESERVED_PORT_SET`
  machinery (`state.rs:20`) for any local stream/WS/bundler ports so mobile previews
  don't collide across windows.
- **`src-tauri/src/lib.rs`** — register the new commands in `invoke_handler!`.
- **Sidecar binary** (iOS): a small Swift target shipped alongside the app bundle, spawned
  via `run_with_timeout` / process spawn. Document the build in `RELEASING.md` (it has
  to be signed/notarized with the app).
- Follow the four backend rules (CommandError, validate_project_path on any project
  path, run_with_timeout for shelling out to adb/xcrun, `#[tracing::instrument]`).

---

## 8. Phased delivery

| Phase | Scope | Est. | Risk | Ships value? |
|------|-------|------|------|--------------|
| **0** | Detection only: RN/Expo/Flutter → new `ProjectType`; mobile projects show a "Mobile app" state in the preview pane with guidance ("boot a simulator, run `expo start`") instead of a broken web iframe. Logs from the terminal already visible. | ~1 wk | low | yes — stops the broken-web-preview experience immediately |
| **1** | **Android mirror** via scrcpy: live canvas, tap/scroll/type, device + emulator. Cross-OS. | ~2–3 wk | med | yes — full mobile preview for Android |
| **2** | **iOS Simulator mirror** (macOS only) via ScreenCaptureKit + Indigo HID sidecar (or `serve-sim`). Device-model presets, rotate. | ~3–5 wk | high (private APIs) | yes — completes the core feature on Apple |
| **3** | Polish & perf: H.264/WebCodecs transport, higher FPS, audio (optional), better device-frame chrome, multi-device. | ongoing | low/med | incremental |
| **(later)** | Physical devices / cloud (Corellium, Appetize) as a paid tier. | — | — | only if demanded |

**Recommended first move:** Phase 0 (cheap, immediately removes a broken experience and
validates detection), then a **throwaway Android spike** to prove the
frame-in/event-out transport end-to-end before committing to the full pipeline.

---

## 9. Key files (touch list)

New:
- `src-tauri/src/mobile/{mod,devices,android,ios_sim,stream}.rs`
- iOS Swift sidecar target (path TBD, e.g. `src-tauri/sidecars/ios-sim-bridge/`)
- `src/components/DeviceMirror.tsx`
- `src/hooks/useDeviceStream.ts`
- `src/lib/mobile.ts`

Modified:
- `src-tauri/src/types.rs` (ProjectType variants)
- `src-tauri/src/commands/projects/detection.rs` (detectors + signature + tests)
- `src-tauri/src/state.rs` (reuse RESERVED_PORTS for stream ports)
- `src-tauri/src/lib.rs` (register commands)
- `src/components/Preview.tsx` (web vs mobile branch, device presets)
- `src/hooks/usePreviewConnection.ts` (abstract preview source + guidance copy)
- `RELEASING.md` (sidecar build/sign/notarize for the iOS bridge)

---

## 10. Open questions / decisions to make before Phase 1

1. **Transport for MVP**: JPEG-over-Tauri-event vs localhost WebSocket. (Lean: event for
   the spike, WS if FPS suffers.)
2. **scrcpy integration depth**: speak the server protocol directly (more control) vs
   wrap the binary (faster spike). (Lean: spike with the binary, then move to protocol.)
3. **iOS**: build the ScreenCaptureKit+HID sidecar ourselves vs depend on `serve-sim`.
   (Decide during the Phase 2 spike — own-sidecar = no runtime dep but more code +
   private-API maintenance.)
4. **Do we spawn the bundler or keep it user-run (terminal)?** Default: keep user-run to
   match the web model; revisit if onboarding friction is high.
5. **H.264 decode in Rust**: ffmpeg sidecar vs pure-Rust decoder vs punt to WebCodecs.

---

## 10b. Spike findings (2026-06-02)

Empirical results from the first de-risking spike, run on Julian's machine.

### Tooling reality on this machine
- **iOS: ready.** Xcode 26 installed, iOS 26.1 runtimes, iPhone 15/16e/17/17 Pro/
  Air simulators all available. `xcrun simctl` works out of the box.
- **Android: absent.** No `scrcpy`, no `adb`, no `emulator`, no connected device.
  Homebrew is present (could `brew install scrcpy android-platform-tools`), but
  there's also no emulator/AVD — standing up Android testing means installing the
  SDK + a system image + creating an AVD. Heavy.
- **Consequence:** the plan's "Android first" sequencing (§8) assumed a typical
  Android setup. On *this* machine **iOS Simulator is the faster path to a testable
  prototype**. Revised recommendation below.

### Capture half — proven, with a hard limit
Booted an iPhone 17 sim and measured the **no-private-API** capture path
(`xcrun simctl io <udid> screenshot`):
- ✅ Captures the live simulator screen correctly (verified the frame — real home
  screen, not black).
- **Cadence: ~404 ms/frame ≈ 2.5 fps.** Each call pays ~330–400 ms of process-spawn
  overhead. **Not interactive** (interactive feel needs ~30–60 fps; even the VS Code
  extension's ScreenCaptureKit path is ~12 fps and feels borderline).
- Frame size: PNG ≈ 3.0 MB/frame (too big to ship per-frame), **JPEG ≈ 387 KB**
  (the right wire format).

**Conclusion:** `simctl screenshot` polling is fine for a one-off thumbnail but is
*not* a viable interactive transport. This empirically confirms the plan's claim
that interactive iOS mirroring requires **ScreenCaptureKit continuous capture** in a
Swift sidecar (§4.2), not screenshot polling. Input injection (Indigo HID / idb) was
not exercised in this spike — still the largest unknown.

### Revised near-term recommendation
1. **iOS-Simulator-first** on this machine (Xcode already here), reversing the
   Android-first order in §8 — *unless* we want Android, in which case step 0 is
   installing scrcpy + platform-tools + an AVD.
2. The next real build step is the **ScreenCaptureKit + input Swift sidecar** — this
   is the fragile, private-API-dependent crux. It's a genuine commitment (macOS-only,
   maintenance tax) and should be an explicit decision, not drift.
3. Hardware-independent foundation that's safe to build in parallel regardless of the
   capture decision: a `list_mobile_devices` command (booted sims via `simctl`,
   Android devices via `adb` when present) + the device-picker UI shell.

## 10c. serve-sim evaluation (2026-06-02) — DECISIVE

Evaluated `serve-sim` (Evan Bacon / Expo core, Apache-2.0, v0.1.39) against the
booted iPhone 17 sim. **It validates as a drop-in iOS transport and very likely lets
us skip building a ScreenCaptureKit + Indigo HID Swift sidecar entirely.**

What it gives us, all confirmed working on this machine:
- **Embeddable MJPEG stream** at `http://127.0.0.1:3100/stream.mjpeg` — drops straight
  into an `<img>`/canvas in our existing webview preview pane. CORS open, no proxy.
- **WebSocket control channel** at `ws://127.0.0.1:3100/ws`, plus a CLI mirror:
  `tap <x> <y>` (**normalized 0..1 coords — exactly our planned input contract**),
  `gesture`, `button`, `type`, `rotate`, permissions, camera injection.
- **Input verified end-to-end**: a normalized `tap 0.84 0.49` opened the Settings
  app on the sim. Not just capture — real input injection works.
- **Framerate is adaptive**: ~3 fps idle (static screen), **~18 fps under motion**.
  18fps interactive is usable (VS Code's ScreenCaptureKit ext ships ~12). JPEG frames
  ~350 KB.
- **Requirements**: macOS + Xcode CLI (`xcrun simctl`) + Node 18+ — all already
  present and already checked by Ship Studio onboarding.
- Daemon mode (`--detach`) + `--list`/`--kill` lifecycle — maps cleanly onto how we
  already manage the static file server (`static_server.rs`).

**Trade-offs / risks to accept:**
- Young dependency (v0.1.39, days old) — API may churn; pin the version, vendor if
  needed. Apache-2.0 means we *can* fork/vendor.
- Adds a Node-CLI runtime dep we spawn (acceptable: our users are web devs with Node;
  onboarding already verifies it).
- Binds to 127.0.0.1; it has a token-gated shell-exec route if exposed on LAN — we
  never pass `--host 0.0.0.0`.
- iOS **Simulator** only (not physical devices) — unchanged constraint.

**Decision:** for iOS, integrate `serve-sim` rather than build a custom sidecar. This
removes the single biggest risk in the whole plan (private-API fragility). The Swift
sidecar in §4.2 becomes a *fallback*, not the primary path.

### Revised iOS pipeline (supersedes §4.2 as the primary approach)
1. Rust: spawn/manage `serve-sim --detach` per booted sim (lifecycle like
   `static_server.rs`; reuse `RESERVED_PORTS` for :3100/:3200).
2. Frontend: mobile preview pane renders `<img src=".../stream.mjpeg">` (or canvas),
   maps pointer/keyboard events → `tap`/`gesture`/`type` over the WS/CLI.
3. Detection + device list (§5, §10b) feed which sim to target.

## 11. References

- vscode-ios-simulator-embed — ScreenCaptureKit + Indigo HID reference impl (Apache-2.0):
  https://github.com/mkloouo/vscode-ios-simulator-embed
- scrcpy — Android mirror + input: https://github.com/Genymobile/scrcpy
- escrcpy — embedded-window wrapper precedent: https://github.com/viarotel-org/escrcpy
- serve-sim — iOS simulator → browser stream (≤60fps) with control channel:
  https://toolhunter.cc/tools/serve-sim
- Apple simctl / Simulator control:
  https://developer.apple.com/library/archive/documentation/IDEs/Conceptual/iOS_Simulator_Guide/InteractingwiththeiOSSimulator/InteractingwiththeiOSSimulator.html
- Expo CLI: https://docs.expo.dev/more/expo-cli/
- Corellium / Appetize (cloud device alternatives):
  https://www.g2.com/products/appetize-io/competitors/alternatives
