# Cross-Platform Mobile Preview — Architecture & UX

**Goal:** one simple, powerful surface for building and testing mobile apps across
**iOS and Android**, where the two platforms share everything they can and diverge
only where the OS forces them to.

iOS is done and on `main` (Expo / bare RN / Flutter, verified live: boot → build →
launch → detect → mirror → reload, with auto-heal + crash reconciliation). This doc
is how Android slots in without a rewrite, and how the two coexist technically and
in the UI.

---

## 1. The seam that already exists

The iOS pipeline already separates cleanly into **platform-specific** and
**platform-agnostic** layers. Android reuses the agnostic half wholesale:

| Concern | iOS today | Android to add | Shared? |
| --- | --- | --- | --- |
| Boot a device | `simctl boot` (headless) | `emulator -avd` + `adb wait-for-device` | per-platform |
| Mirror transport | serve-sim → MJPEG `<img>` + WS touch | scrcpy server → **Rust WS bridge** → `<canvas>` (WebCodecs) | per-platform |
| Build + launch | `expo run:ios` / `rn run-ios` / `flutter run -d` | `expo run:android` / `rn run-android` / `flutter run -d` | framework-shared, target differs |
| Launch detection | `simctl … launchctl list` | `adb shell pidof <pkg>` | per-platform |
| Session registry, port reservation, teardown, boot locks, auto-heal, build-verdict poll, **the whole `DeviceMirror` UI** | — | reuse as-is | **shared** |

So the work is a **platform-tagged session** plus a **per-platform transport**, behind
the unchanged frontend model of "a stream + an input channel + a build verdict."

---

## 2. Backend abstraction — `Platform` enum, not a trait

Rust async traits are awkward; an explicit enum kept on the session, dispatched by a
small `match`, is simpler and just as powerful.

```rust
pub enum Platform { Ios, Android }
```

- `MobileSession` gains `platform: Platform`. `serve_sim_port` generalizes to
  `mirror_port` (the bridge/mirror port for either platform), `udid` generalizes to
  `device_id` (UDID for iOS, emulator serial like `emulator-5554` for Android).
- The four lifecycle operations become per-platform functions selected by `match`:
  - `ensure_device(platform, preferred)` → boot/attach, returns `(device_id, booted_by_us, name, runtime)`.
  - `establish_mirror(platform, …)` → start the mirror (serve-sim for iOS, the
    scrcpy bridge for Android), reserve the port, register the session.
  - `app_running(platform, device_id, app_id)` → the launch-detection probe.
  - `teardown(platform, session)` → kill mirror, shut the device if we booted it,
    release the port, kill the build PTY.
- `start_mobile_preview` stays the single entry point; it takes a `platform` arg
  (frontend passes it) and routes. Everything between (boot lock, reuse/heal,
  port reconcile, registry) is **already platform-agnostic and unchanged**.

Existing iOS functions are renamed/moved under the iOS arm (`ios::ensure_device`
wrapping today's `ensure_simulator`, etc.). No behavior change for iOS.

---

## 3. The Android mirror transport (the one genuinely hard part)

serve-sim hands us a clean HTTP MJPEG stream we drop into an `<img>`. Android has no
such turnkey web mirror. Ranked options:

1. **`adb exec-out screenrecord` (H.264 to stdout)** — simplest, platform-tools only,
   but a hard ~3-min session cap, high latency, and **`adb shell input` is one process
   per touch event → unusable for dragging.** Rejected as the primary path.
2. **ws-scrcpy** (node web client) — works, but it's a whole separate app with its own
   UI, a node dependency heavier than serve-sim, and awkward to embed cleanly. Rejected
   to avoid a second node tool and an iframe-of-someone-else's-UI.
3. **scrcpy server + our own Rust↔WebSocket bridge → WebCodecs `<canvas>`** — **chosen.**

### Why #3 is the simple-and-powerful choice

scrcpy's server is a single `.jar` we `adb push` and run; it streams **low-latency
H.264 over an adb-forwarded TCP socket** and accepts **input events over a control
socket**. The webview can't open a raw TCP socket — so we add a small **Rust bridge**:
it owns the adb forward, reads the scrcpy video/control sockets, and exposes them to
the frontend as **one WebSocket** (H.264 frames out, touch/key events in). The
frontend decodes H.264 with **WebCodecs `VideoDecoder`** onto a `<canvas>`.

> **Shipped (v4.0 server, vendored):** the video socket runs `raw_stream=true`
> (pure Annex-B), and the **control socket is real** — pointer down/move/up
> stream as scrcpy `INJECT_TOUCH_EVENT` messages (32-byte wire format, verified
> against the v4.0 server source), keys as `INJECT_KEYCODE`, text as
> `INJECT_TEXT` (full UTF-8, no sanitizing needed). Touch coordinates are sent
> in the **decoded video size** — scrcpy's `PositionMapper` requires the claimed
> size to equal the encoder's video size and maps the point back onto the
> display itself, which also makes rotation self-correcting. The bridge
> announces its input mode in a JSON hello as the first WebSocket message;
> on the screenrecord fallback (`"adb"`) the frontend synthesizes discrete
> taps/swipes instead.

Properties that make this the right call:
- **No new external service** — the bridge is ~one Rust module; we already
  reverse-engineered serve-sim's binary touch protocol, so scrcpy's is in scope.
- **Symmetry** — same mental model as iOS: a port + a socket + an input channel.
  `DeviceMirror` already owns exactly that shape.
- **Quality** — scrcpy is the latency/fidelity gold standard for Android mirroring;
  control-socket input gives smooth dragging (unlike `adb shell input`).
- **Forward path** — the same WebCodecs `<canvas>` renderer could later replace the
  iOS `<img>` for a single unified renderer. Not required for v1.

WebCodecs is available in the macOS WKWebView Tauri uses (Safari 16.4+; this machine
is on macOS 26). Frontend gains a `<canvas>` mirror branch alongside the iOS `<img>`;
both are driven by the same connect/heal/verdict machinery.

> Pragmatic bootstrap (optional): a screenrecord-based first light can prove the
> emulator→build→detect chain before the bridge exists, but it is **not** the shipping
> transport. The bridge is the deliverable.

---

## 4. Build, launch, detection — Android specifics

- **Launch commands** (extend `build_launch_command`, which is already framework-aware):
  - Expo → `npx --yes expo run:android`
  - Bare RN → `npx --yes react-native run-android`
  - Flutter → `flutter run -d <emulator-serial>`
  - Same attach semantics we just learned on iOS: Expo/Flutter stay attached (`r`
    reload works, `buildAlive` true); `react-native run-android` **exits after
    launching** — so the existing `'exited' → 'launched'` poll path and the
    `buildAlive` Reload-gating already handle RN correctly with zero new logic.
- **Boot:** `emulator -avd <name> -no-snapshot-save` (headless-capable with
  `-no-window`, but we want the framebuffer; scrcpy mirrors it regardless of a
  window — same "boot headless, mirror the framebuffer" trick as iOS). `adb
  wait-for-device` + `adb shell getprop sys.boot_completed` to block until ready
  (the `bootstatus` analog).
- **Detection:** `adb -s <serial> shell pidof <applicationId>` (or `dumpsys activity`)
  — the `simulator_app_running` analog. The app id comes from the build log /
  `applicationId` in `build.gradle`, mirroring the iOS bundle-id approach with a
  generic fallback.
- **Teardown:** kill the bridge + scrcpy server, `adb emu kill` only if we booted
  the emulator, release the port, kill the build PTY. Crash reconciliation reaps
  orphaned bridges the same way we reap serve-sim daemons.

---

## 5. UX — one surface, platform-aware

The preview surface must feel like **one feature that knows about two platforms**,
not two bolted-together panes.

- **Platform availability is detected, not assumed.** A project can target iOS only,
  Android only, or both (Expo/RN/Flutter generally both; a project with only an
  `ios/` folder is iOS-only, etc.). The toolbar shows only what the project + the
  machine can actually run (iOS needs Xcode; Android needs the SDK + an AVD).
- **A single segmented control in the `DeviceMirror` toolbar: `[ iOS | Android ]`**,
  shown only when both are available.

  > **Shipped (simplified):** sessions stay keyed by `project_path` — **one
  > active platform per project**. Switching tears the other platform's session
  > down (via the platform-dispatched teardown) before booting the new one,
  > rather than keeping both alive. Running a simulator + an emulator + two
  > native builds concurrently per project costs more than the instant-switch
  > is worth; revisit `(project_path, platform)` keying only if users actually
  > ask for simultaneous platforms.
- **Device picker** (second control) lists that platform's devices (iPhone 17 / SE /
  iPad; Pixel 8 / tablet) — the same control for both, populated per-platform.
- **Everything else is identical across platforms:** the build log panel, "App
  running" verdict, Reload, Restart, "Send to agent" on failure, auto-heal. The user
  learns the surface once.
- **No surprise windows:** Android's emulator window is hidden the same way we hide
  Simulator.app (the mirror is what they look at).

Registry: keyed by `project_path` (see the shipped note above) — iOS and Android
previews for the same project do NOT coexist; a switch is a clean teardown + boot.

---

## 6. Phased rollout (each phase compiles, iOS stays green, most are unit-testable)

1. **Platform seam** — add `Platform` to `MobileSession`, route `start_mobile_preview`,
   move iOS code behind the iOS arm. No behavior change; all iOS tests green.
2. **Android detect + launch commands** — `expo run:android` / `rn run-android` /
   `flutter run -d`; unit-tested like `build_launch_command_for_*`.
3. **Android boot + detection** — `emulator` / `adb wait-for-device` /
   `pidof`; parsing unit-tested.
4. **scrcpy WS bridge + WebCodecs `<canvas>` client** — the transport. The heavy lift.
5. **UX unification** — platform segmented control, per-platform device picker,
   `(project_path, platform)` registry keying, canvas-vs-img branch.
6. **Live verification** — install the Android toolchain (SDK + emulator + an arm64
   system image + scrcpy), create a test AVD, and run Expo/RN/Flutter Android through
   the full surface, exactly as we did for iOS.

---

## 7. Toolchain prerequisites (for §6, machine-specific)

This dev machine has **no** Android tooling (`adb`, `emulator`, AVDs, `scrcpy`,
`ANDROID_HOME` all absent). Live Android needs, roughly:
`brew install scrcpy android-platform-tools` + Android command-line tools + a JDK +
`sdkmanager "emulator" "platforms;android-35" "system-images;android-35;google_apis;arm64-v8a"`
+ an AVD. This is a multi-GB, JDK-dependent install — surfaced explicitly rather than
run blindly, and onboarding should detect/guide it the way it does Xcode for iOS.

---

## 8. What stays untouched (do not re-litigate)

The shared machinery proven on iOS — boot locks, port reservation + force-claim,
teardown ordering, auto-heal backoff/cap, the build-verdict poll, the `DeviceMirror`
connect/StrictMode model — is platform-agnostic and carries Android for free. Android
work lives in new per-platform functions and a new transport module, not in rewrites
of the shared core.
