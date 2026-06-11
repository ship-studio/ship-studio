/**
 * Native mobile preview (iOS Simulator) wrappers.
 *
 * Thin wrappers over the Rust `mobile` commands that manage a `serve-sim`
 * daemon. serve-sim streams a booted iOS simulator as MJPEG and exposes a
 * WebSocket control channel; {@link DeviceMirror} embeds the stream and drives
 * input over that channel.
 *
 * See docs/internal/mobile-app-preview-plan.md (§10c).
 *
 * @module lib/mobile
 */

import { invoke } from '@tauri-apps/api/core';

/** Which mobile platform a preview targets. Serializes to the Rust `Platform`
 *  enum (`"ios"` / `"android"`). */
export type Platform = 'ios' | 'android';

/** Which platforms a project can actually build for, from its layout/framework.
 *  Drives the platform picker so it only offers real targets. */
export interface MobileTargets {
  ios: boolean;
  android: boolean;
}

/** Whether this machine's toolchain can preview each platform (Xcode CLT for iOS,
 *  the Android SDK for Android) — distinct from what a project targets. */
export interface MobilePlatformSupport {
  ios: boolean;
  android: boolean;
}

/** Detect a project's mobile build targets (Expo → both; bare RN/Flutter → which
 *  native folders exist). AND this with {@link mobilePlatformSupport} so the UI only
 *  offers a platform the project targets AND the machine can build. */
export async function detectMobileTargets(projectPath: string): Promise<MobileTargets> {
  return invoke<MobileTargets>('detect_mobile_targets', { projectPath });
}

/** Which platforms this machine can preview (toolchain installed). Combined with
 *  {@link detectMobileTargets} to avoid offering a platform that would dead-end —
 *  the UI routes a missing toolchain to agent-driven setup instead. */
export async function mobilePlatformSupport(): Promise<MobilePlatformSupport> {
  return invoke<MobilePlatformSupport>('mobile_platform_support');
}

/** Whether the project's app is running on an Android emulator/device — the Android
 *  analog of {@link simulatorAppRunning}. `appId` is the Gradle applicationId; without
 *  it we can't distinguish our app, so the backend reports not-running. */
export async function androidAppRunning(serial: string, appId?: string): Promise<boolean> {
  return invoke<boolean>('android_app_running', { serial, appId: appId ?? null });
}

/** A booted iOS simulator that can be mirrored. */
export interface MobileSimulator {
  udid: string;
  name: string;
  state: string;
  /** Friendly runtime label, e.g. "iOS 26.1" (best-effort). */
  runtime: string | null;
}

/** A build verdict, as stored on the backend session. */
export type MobileLaunchStatus = 'building' | 'launched' | 'failed' | 'exited';

/** Connection details for an active serve-sim mirror. */
export interface MirrorInfo {
  udid: string;
  /** MJPEG stream URL, e.g. http://127.0.0.1:3100/stream.mjpeg */
  stream_url: string;
  /** WebSocket control channel, e.g. ws://127.0.0.1:3100/ws */
  ws_url: string;
  port: number;
  /** Friendly device name (e.g. "iPhone 17") for the toolbar — saves a second
   *  `listBootedSimulators` round-trip. May be empty if unknown. */
  device_name: string;
  /** Friendly runtime label (e.g. "iOS 26.1"), best-effort. */
  device_runtime: string | null;
  /** The session's last reported build verdict — present only on the reuse path
   *  (tab-return), so the panel can restore "App running" instantly instead of
   *  re-deriving it from a replayed (possibly truncated) build log. */
  launch_status: MobileLaunchStatus | null;
}

/**
 * List currently-booted iOS simulators. Rejects if Xcode/`xcrun` is missing;
 * resolves to an empty array when Xcode is present but nothing is booted.
 */
export async function listBootedSimulators(): Promise<MobileSimulator[]> {
  return invoke<MobileSimulator[]>('list_booted_simulators');
}

/** Whether the project's app is currently running on the booted simulator. This
 *  is the ground-truth "did it launch" signal — true regardless of whether Ship
 *  Studio or the agent built it — so the preview panel can resolve even when the
 *  build-log classifier misses (Expo's success banner) or can't see the build
 *  (a "Send to agent" rebuild in the agent's own terminal). Pass `bundleId` when
 *  known (parsed from the build log) for an exact match. */
export async function simulatorAppRunning(udid: string, bundleId?: string): Promise<boolean> {
  return invoke<boolean>('simulator_app_running', { udid, bundleId: bundleId ?? null });
}

/** Hide the Simulator.app GUI window (best-effort). The sim is mirrored
 *  headlessly, so the window is redundant; the build tool foregrounds it over Ship
 *  Studio, so we hide it once the app is up. A no-op if Simulator isn't running or
 *  automation permission is denied. */
export async function hideSimulator(): Promise<void> {
  return invoke<void>('hide_simulator');
}

/** The command that launches the project's app onto a booted device. */
export async function getSimulatorLaunchCommand(
  projectPath: string,
  platform: Platform,
  udid: string
): Promise<string> {
  return invoke<string>('get_simulator_launch_command', { projectPath, platform, udid });
}

/**
 * Start (or reuse) a complete native mobile preview for a project: ensures a
 * simulator is booted, reserves a port, and starts a serve-sim mirror — all
 * backend-owned, so the lifecycle survives this component unmounting. Idempotent
 * and serialized per project. The returned {@link MirrorInfo} is what the mirror
 * embeds; the app build is launched separately as a pty_session (see
 * {@link buildSessionId}).
 */
export async function startMobilePreview(
  projectPath: string,
  windowLabel: string,
  platform: Platform,
  preferred?: string
): Promise<MirrorInfo> {
  return invoke<MirrorInfo>('start_mobile_preview', {
    projectPath,
    windowLabel,
    platform,
    preferred: preferred ?? null,
  });
}

/** Report the settled build verdict to the backend session, so a later reuse
 *  (tab-return) restores it instantly — the pty ring buffer may have dropped the
 *  log marker the verdict came from. Fire-and-forget; a race with teardown is
 *  harmless (the next session starts fresh). */
export async function setMobileLaunchStatus(
  projectPath: string,
  status: MobileLaunchStatus
): Promise<void> {
  return invoke<void>('set_mobile_launch_status', { projectPath, status });
}

/**
 * The stable `pty_session` id for a project's app build. MUST match the backend
 * format in `mobile.rs` (`build_session_id_for`) so teardown kills the right
 * session and re-open across tab switches is idempotent.
 */
export function buildSessionId(projectPath: string): string {
  return `mobile-build:${projectPath}`;
}

/**
 * Terminal outcome of an app build, inferred from its log output. `launched`
 * means the native build compiled and the app is up on the simulator; `failed`
 * means a hard build failure. `null` means "still building" — no verdict yet.
 */
export type BuildOutcome = 'launched' | 'failed';

/**
 * Strong, structural failure markers only. We deliberately do NOT match a bare
 * `error:` — it appears in benign output (warnings, log lines that contain the
 * word) and would false-positive a healthy build. The authoritative failure
 * backstop is the build process exiting non-zero (handled in the component);
 * these markers just give an earlier, specific signal for the common toolchains.
 */
const BUILD_FAILURE_MARKERS = [
  '** BUILD FAILED **', // xcodebuild (expo / react-native)
  'The following build commands failed',
  'xcodebuild: error',
  'Could not build the application for the simulator', // flutter
  'Encountered error while building', // flutter
  'Error launching application on', // flutter
  'FAILURE: Build failed with an exception', // gradle (android expo / react-native)
] as const;

/**
 * Success markers meaning the native build compiled and the app is launching.
 * We match xcodebuild's exact final banner `** BUILD SUCCEEDED **` (Expo / bare
 * RN), NOT the bare `BUILD SUCCEEDED` substring — the bare form can appear for an
 * intermediate target/pre-build that finishes before the app's own build, which
 * would report success early. Flutter suppresses the banner but prints its
 * interactive command menu once the app is actually up.
 */
const BUILD_SUCCESS_MARKERS = [
  '** BUILD SUCCEEDED **', // xcodebuild (expo / react-native), final scheme banner
  'Flutter run key commands.', // flutter: app running, interactive menu shown
] as const;

/**
 * Classify accumulated build-log text into a terminal {@link BuildOutcome}, or
 * `null` if the build hasn't reached a verdict yet. Pure and order-stable:
 * failure markers win over success markers (within a single build run the two
 * don't co-occur). Callers pass the full accumulated log — markers can land
 * anywhere — and stop classifying once a non-null verdict is returned.
 */
export function classifyBuildOutput(text: string): BuildOutcome | null {
  for (const marker of BUILD_FAILURE_MARKERS) {
    if (text.includes(marker)) return 'failed';
  }
  for (const marker of BUILD_SUCCESS_MARKERS) {
    if (text.includes(marker)) return 'launched';
  }
  return null;
}

/** iOS bundle id from the build log (Expo prints
 *  `› Opening on iPhone 17 Pro (com.anonymous.my-app)`). Lets the launch poll match
 *  our exact app instead of "any third-party app". */
const IOS_BUNDLE_ID_RE = /Opening on .*?\(([A-Za-z0-9.-]+)\)/;

/** Android applicationId from the build log, across launch styles:
 *  - bare RN `run-android` → `am start` logs `Starting: Intent { … cmp=com.x/.Act }`
 *  - Expo `run:android` → dev-client deep link `Opening com.x://expo-development-client/…`
 *    (no `cmp=`, so the bare-RN regex alone left Expo's launch poll stuck forever).
 *  Both require a dotted package so a plain `http://` URL can't match. */
const ANDROID_APP_ID_RES: RegExp[] = [
  /cmp=([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\//,
  /Opening ([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+):\/\//,
];

/** The app id (iOS bundle id / Android applicationId) for the launch poll, parsed
 *  per platform from the accumulated build-log text. `undefined` when not yet seen. */
export function appIdFromLog(platform: Platform, log: string): string | undefined {
  if (platform === 'android') {
    for (const re of ANDROID_APP_ID_RES) {
      const m = log.match(re);
      if (m) return m[1];
    }
    return undefined;
  }
  return log.match(IOS_BUNDLE_ID_RE)?.[1];
}

/** A normalized (0..1) touch event sent over the serve-sim WebSocket. */
export type TouchPhase = 'down' | 'move' | 'up';

/**
 * serve-sim's control channel is a BINARY protocol: each message is a 1-byte
 * opcode followed by a UTF-8 JSON payload. Touch events use opcode 3 with a
 * `{ type, x, y }` body, where `type` is "begin" | "move" | "end" (NOT
 * "down"/"up" — those are HID keyboard phases on a different opcode). This was
 * reverse-engineered from serve-sim's client and verified end-to-end against a
 * booted simulator. See docs/internal/mobile-app-preview-plan.md.
 */
const TOUCH_OPCODE = 3;
const PHASE_TO_SERVE_SIM: Record<TouchPhase, string> = {
  down: 'begin',
  move: 'move',
  up: 'end',
};

/** Cap on touch frames buffered while the socket is still connecting, so a
 *  socket that never opens can't grow this unboundedly. A tap is 2 frames; this
 *  is a few gestures' worth — enough to cover the brief connect window. */
const MAX_PENDING_TOUCHES = 64;

/**
 * Open the serve-sim control WebSocket and return a small input API. The caller
 * sends normalized 0..1 coordinates (origin top-left); serve-sim maps them to
 * the device surface. Touches sent during the brief CONNECTING window are
 * buffered and flushed once the socket opens (so the user's first tap isn't
 * silently dropped); touches after the socket closes are discarded.
 */
export function connectInputChannel(wsUrl: string): {
  socket: WebSocket;
  sendTouch: (phase: TouchPhase, x: number, y: number) => void;
  close: () => void;
} {
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  const encoder = new TextEncoder();
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  // Frames sent before the socket finishes opening — flushed on 'open'.
  const pending: Uint8Array[] = [];

  socket.addEventListener('open', () => {
    for (const frame of pending) socket.send(frame);
    pending.length = 0;
  });

  const sendTouch = (phase: TouchPhase, x: number, y: number) => {
    const json = encoder.encode(
      JSON.stringify({ type: PHASE_TO_SERVE_SIM[phase], x: clamp(x), y: clamp(y) })
    );
    const frame = new Uint8Array(1 + json.length);
    frame[0] = TOUCH_OPCODE;
    frame.set(json, 1);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
    } else if (socket.readyState === WebSocket.CONNECTING) {
      if (pending.length < MAX_PENDING_TOUCHES) pending.push(frame);
    }
    // CLOSING / CLOSED → drop.
  };
  return {
    socket,
    sendTouch,
    close: () => {
      pending.length = 0;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
  };
}
