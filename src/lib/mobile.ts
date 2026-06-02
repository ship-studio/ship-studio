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
}

/**
 * List currently-booted iOS simulators. Rejects if Xcode/`xcrun` is missing;
 * resolves to an empty array when Xcode is present but nothing is booted.
 */
export async function listBootedSimulators(): Promise<MobileSimulator[]> {
  return invoke<MobileSimulator[]>('list_booted_simulators');
}

/**
 * Ensure a simulator is booted and return it, booting a sensible default
 * (newest available iPhone) when none is running. No-ops when one is already
 * booted. Rejects if Xcode is missing or no simulator is available to boot.
 */
export async function bootDefaultSimulator(preferred?: string): Promise<MobileSimulator> {
  return invoke<MobileSimulator>('boot_default_simulator', { preferred: preferred ?? null });
}

/** Start (or attach to) a serve-sim mirror for a booted simulator. */
export async function startSimulatorMirror(udid: string): Promise<MirrorInfo> {
  return invoke<MirrorInfo>('start_simulator_mirror', { udid });
}

/** Stop the serve-sim mirror for a simulator (or all if udid is empty). */
export async function stopSimulatorMirror(udid: string): Promise<void> {
  return invoke('stop_simulator_mirror', { udid });
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

/**
 * Open the serve-sim control WebSocket and return a small input API. The caller
 * sends normalized 0..1 coordinates (origin top-left); serve-sim maps them to
 * the device surface. Touches sent before the socket finishes opening are
 * dropped (serve-sim has no input backlog); callers should expect a brief
 * post-connect window where taps are ignored.
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
  const sendTouch = (phase: TouchPhase, x: number, y: number) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const json = encoder.encode(
      JSON.stringify({ type: PHASE_TO_SERVE_SIM[phase], x: clamp(x), y: clamp(y) })
    );
    const frame = new Uint8Array(1 + json.length);
    frame[0] = TOUCH_OPCODE;
    frame.set(json, 1);
    socket.send(frame);
  };
  return {
    socket,
    sendTouch,
    close: () => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
  };
}
