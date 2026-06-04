/**
 * Native mobile preview (iOS Simulator) wrappers.
 *
 * Thin wrappers over the Rust `mobile` commands that manage a `serve-sim`
 * daemon. serve-sim streams a booted iOS simulator as MJPEG and exposes a
 * WebSocket control channel; {@link DeviceMirror} embeds the stream and drives
 * input over that channel.
 *
 * See docs/mobile-app-preview-plan.md (§10c).
 *
 * @module lib/mobile
 */

import { invoke } from '@tauri-apps/api/core';

/** A booted iOS simulator that can be mirrored. */
export interface MobileSimulator {
  udid: string;
  name: string;
  state: string;
  /** Friendly runtime label, e.g. "iOS 26.1" (best-effort). */
  runtime: string | null;
}

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
}

/**
 * List currently-booted iOS simulators. Rejects if Xcode/`xcrun` is missing;
 * resolves to an empty array when Xcode is present but nothing is booted.
 */
export async function listBootedSimulators(): Promise<MobileSimulator[]> {
  return invoke<MobileSimulator[]>('list_booted_simulators');
}

/** The command that launches the project's app onto a booted simulator. */
export async function getSimulatorLaunchCommand(
  projectPath: string,
  udid: string
): Promise<string> {
  return invoke<string>('get_simulator_launch_command', { projectPath, udid });
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
  preferred?: string
): Promise<MirrorInfo> {
  return invoke<MirrorInfo>('start_mobile_preview', {
    projectPath,
    windowLabel,
    preferred: preferred ?? null,
  });
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

/** A normalized (0..1) touch event sent over the serve-sim WebSocket. */
export type TouchPhase = 'down' | 'move' | 'up';

/**
 * serve-sim's control channel is a BINARY protocol: each message is a 1-byte
 * opcode followed by a UTF-8 JSON payload. Touch events use opcode 3 with a
 * `{ type, x, y }` body, where `type` is "begin" | "move" | "end" (NOT
 * "down"/"up" — those are HID keyboard phases on a different opcode). This was
 * reverse-engineered from serve-sim's client and verified end-to-end against a
 * booted simulator. See docs/mobile-app-preview-plan.md.
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
