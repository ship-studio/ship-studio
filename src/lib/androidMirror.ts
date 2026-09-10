/**
 * Android mirror decoder — the frontend half of the Android mirror bridge
 * (`src-tauri/src/commands/mobile.rs`).
 *
 * The Rust bridge streams raw Annex-B H.264 (scrcpy-server preferred,
 * screenrecord fallback) over a WebSocket, unframed. This module reassembles NAL
 * units across arbitrary chunk boundaries, repackages them as length-prefixed
 * AVCC, and feeds them to a WebCodecs `VideoDecoder` that paints onto a
 * `<canvas>`.
 *
 * Input goes back over the same socket as JSON, in one of two modes announced by
 * the bridge's first (text) message:
 * - `scrcpy` — every pointer down/move/up is STREAMED (`{type:'touch'}`) to
 *   scrcpy's control socket, so drags and long-presses feel live. Touch
 *   coordinates carry the decoded video size (`vw`/`vh`): scrcpy's
 *   PositionMapper silently drops events whose claimed size doesn't match the
 *   encoder's video size, and the decoder is the one place that size is known.
 * - `adb` — the bridge can only run discrete `adb shell input` commands, so a
 *   press→release is synthesized into a tap or swipe here.
 *
 * AVCC (not description-less Annex-B) is deliberate: Harbr runs in WebKit
 * (Tauri's webview), whose `VideoDecoder` wants an `avcC` description + length-
 * prefixed samples, not in-band start codes. So we parse SPS/PPS, build the
 * `avcC`, and strip start codes — the portable path across WebKit and Chromium.
 *
 * The parsing/packaging functions are pure and unit-tested in `androidMirror.test.ts`,
 * and cross-checked against real screenrecord captures (a static frame and a 2MB
 * motion capture: SPS/PPS/IDR + 218 P-frames classified correctly, codec
 * `avc1.42c029`, AVCC length prefixes exact).
 *
 * @module lib/androidMirror
 */

/** H.264 NAL unit types we care about (`nal[0] & 0x1f`). */
const NAL_NON_IDR = 1; // P-frame slice (delta)
const NAL_IDR = 5; // IDR slice (keyframe)
const NAL_SPS = 7; // sequence parameter set
const NAL_PPS = 8; // picture parameter set

/**
 * Synthetic per-frame timestamp step (µs). screenrecord encodes Baseline H.264
 * (no B-frames), so decode order == display order and exact timestamps don't
 * matter — they only need to increase monotonically. ~30fps is a fine stand-in.
 */
const FRAME_DURATION_US = 33333;

/**
 * Split an Annex-B byte stream into NAL units (start codes removed). Handles 3- and
 * 4-byte start codes and trailing zero padding. The bytes from the LAST start code
 * onward are returned as `rest` — that final NAL may be incomplete (more bytes are
 * coming on the next WebSocket message), so the caller prepends `rest` to the next
 * chunk. Bytes before the first start code are discarded as junk.
 */
export function parseNalUnits(buf: Uint8Array): { nals: Uint8Array[]; rest: Uint8Array } {
  const starts: number[] = [];
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push(i);
      i += 3;
    } else {
      i++;
    }
  }
  if (starts.length === 0) return { nals: [], rest: buf };

  const nals: Uint8Array[] = [];
  for (let s = 0; s < starts.length - 1; s++) {
    const begin = starts[s] + 3; // NAL content begins after `00 00 01`
    let end = starts[s + 1];
    // Trim trailing zeros: a 4-byte start code's leading 0x00, plus any
    // cabac_zero_word padding, both belong to neither NAL's payload.
    while (end > begin && buf[end - 1] === 0) end--;
    if (end > begin) nals.push(buf.subarray(begin, end));
  }
  // Copy the tail out of `buf` so we don't pin the whole chunk in memory.
  return { nals, rest: buf.slice(starts[starts.length - 1]) };
}

/** NAL unit type for a start-code-stripped NAL. */
export function nalType(nal: Uint8Array): number {
  return nal[0] & 0x1f;
}

/** Two-byte lowercase hex of a byte. */
function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/**
 * WebCodecs codec string from an SPS NAL (start code stripped, NAL header included):
 * `avc1.<profile_idc><constraints><level_idc>`. e.g. SPS `67 42 c0 29 …` → `avc1.42c029`.
 */
export function codecString(sps: Uint8Array): string {
  return `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`;
}

/**
 * Build an AVCDecoderConfigurationRecord (`avcC`) from one SPS and one PPS NAL
 * (start codes stripped, NAL headers included) — the `description` a WebCodecs
 * `VideoDecoder` needs to decode length-prefixed AVCC samples. Hardcodes a 4-byte
 * NAL length size (lengthSizeMinusOne = 3), matching {@link toAvcc}.
 */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  let p = 0;
  out[p++] = 1; // configurationVersion
  out[p++] = sps[1]; // AVCProfileIndication (profile_idc)
  out[p++] = sps[2]; // profile_compatibility (constraint flags)
  out[p++] = sps[3]; // AVCLevelIndication (level_idc)
  out[p++] = 0xff; // 6 reserved bits + lengthSizeMinusOne (3 → 4-byte lengths)
  out[p++] = 0xe1; // 3 reserved bits + numOfSequenceParameterSets (1)
  out[p++] = (sps.length >> 8) & 0xff;
  out[p++] = sps.length & 0xff;
  out.set(sps, p);
  p += sps.length;
  out[p++] = 1; // numOfPictureParameterSets
  out[p++] = (pps.length >> 8) & 0xff;
  out[p++] = pps.length & 0xff;
  out.set(pps, p);
  return out;
}

/**
 * Pack NAL units as length-prefixed AVCC (4-byte big-endian length per NAL) — the
 * sample format the WebCodecs decoder expects when configured with an `avcC`.
 */
export function toAvcc(nals: Uint8Array[]): Uint8Array {
  const total = nals.reduce((s, n) => s + 4 + n.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const n of nals) {
    out[p++] = (n.length >>> 24) & 0xff;
    out[p++] = (n.length >>> 16) & 0xff;
    out[p++] = (n.length >>> 8) & 0xff;
    out[p++] = n.length & 0xff;
    out.set(n, p);
    p += n.length;
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Which input path the bridge announced for this connection. */
export type AndroidInputMode = 'scrcpy' | 'adb';

/** A streamed touch phase, mirroring the pointer events the canvas sees. */
export type AndroidTouchPhase = 'down' | 'move' | 'up';

/** Below this normalized move distance a press→release synthesizes to a tap,
 *  not a swipe (discrete `adb` mode only). */
export const TAP_SLOP = 0.02;

/** The discrete gesture a completed press→release synthesizes to in `adb` mode.
 *  Pure for testing. A flick gets its real (clamped) duration so it scrolls;
 *  a slow drag drags. */
export function synthesizeGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  elapsedMs: number
):
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms: number } {
  const moved = Math.hypot(end.x - start.x, end.y - start.y);
  if (moved < TAP_SLOP) return { type: 'tap', x: start.x, y: start.y };
  const ms = Math.max(50, Math.min(800, Math.round(elapsedMs)));
  return { type: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y, ms };
}

/** Parse the bridge's first (text) WebSocket message announcing the input mode.
 *  `null` = not a hello (ignore). Pure for testing. */
export function parseBridgeHello(text: string): AndroidInputMode | null {
  try {
    const v: unknown = JSON.parse(text);
    if (
      typeof v === 'object' &&
      v !== null &&
      (v as { type?: unknown }).type === 'mode' &&
      ((v as { input?: unknown }).input === 'scrcpy' || (v as { input?: unknown }).input === 'adb')
    ) {
      return (v as { input: AndroidInputMode }).input;
    }
  } catch {
    /* not JSON — not a hello */
  }
  return null;
}

/** Normalized 0..1 touch coordinate (origin top-left). */
export interface AndroidMirrorHandle {
  /** Stream a touch phase at a normalized point. In `scrcpy` mode each phase is
   *  injected live (real drags); in `adb` mode the gesture is synthesized into a
   *  tap/swipe on `up`. The path is chosen per-gesture at `down`, so a
   *  mid-gesture mode change can't strand a held-down pointer. */
  sendTouch: (phase: AndroidTouchPhase, x: number, y: number) => void;
  /** Tap at a normalized point (discrete; prefer {@link sendTouch}). */
  sendTap: (x: number, y: number) => void;
  /** Swipe between two normalized points over `ms` (default applied backend-side). */
  sendSwipe: (x1: number, y1: number, x2: number, y2: number, ms?: number) => void;
  /** Press a whitelisted hardware key (BACK | HOME | APP_SWITCH | ENTER | DEL). */
  sendKey: (key: 'BACK' | 'HOME' | 'APP_SWITCH' | 'ENTER' | 'DEL') => void;
  /** Tear down the socket and decoder. */
  close: () => void;
}

export interface AndroidMirrorOptions {
  wsUrl: string;
  canvas: HTMLCanvasElement;
  onError: (message: string) => void;
  /** Fired once, when the first frame paints — lets the UI drop its spinner. */
  onFirstFrame?: () => void;
}

/**
 * Connect the Android mirror: stream H.264 from `wsUrl` onto `canvas`, and return a
 * handle for sending input. The decoder is created lazily once the first SPS+PPS
 * arrive; delta frames before the first keyframe are dropped (decoding them errors).
 * Self-heals across screenrecord's 180s relaunch — each relaunch re-emits an IDR.
 */
export function createAndroidMirror(opts: AndroidMirrorOptions): AndroidMirrorHandle {
  const { wsUrl, canvas, onError, onFirstFrame } = opts;
  const ctx = canvas.getContext('2d');

  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let decoder: VideoDecoder | null = null;
  let sawKey = false;
  let ts = 0;
  let leftover = new Uint8Array(0);
  let firstFramePainted = false;
  let closed = false;
  // Input routing: the bridge announces its mode in a text hello; until then
  // (and on the screenrecord fallback) gestures synthesize to discrete taps.
  let inputMode: AndroidInputMode = 'adb';
  // The decoded video size — what scrcpy's PositionMapper expects touch
  // coordinates to claim. 0 until the first frame.
  let videoW = 0;
  let videoH = 0;
  // The in-flight gesture's path (chosen at `down`) and start, for synthesis.
  let gesturePath: 'stream' | 'discrete' | null = null;
  let gestureStart: { x: number; y: number; t: number } | null = null;

  const ensureDecoder = (): boolean => {
    if (decoder) return true;
    if (!sps || !pps) return false;
    if (typeof VideoDecoder === 'undefined') {
      onError('This webview does not support WebCodecs video decoding.');
      return false;
    }
    const dec = new VideoDecoder({
      output: (frame) => {
        try {
          videoW = frame.displayWidth;
          videoH = frame.displayHeight;
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          ctx?.drawImage(frame, 0, 0);
          if (!firstFramePainted) {
            firstFramePainted = true;
            onFirstFrame?.();
          }
        } finally {
          frame.close();
        }
      },
      error: (e) => onError(`Decoder error: ${e.message}`),
    });
    try {
      dec.configure({
        codec: codecString(sps),
        description: buildAvcC(sps, pps),
        optimizeForLatency: true,
      });
    } catch (e) {
      onError(`Failed to configure decoder: ${String(e)}`);
      return false;
    }
    decoder = dec;
    return true;
  };

  const onBytes = (bytes: Uint8Array) => {
    const { nals, rest } = parseNalUnits(concatBytes(leftover, bytes));
    leftover = rest;
    for (const nal of nals) {
      const t = nalType(nal);
      if (t === NAL_SPS) {
        sps = nal.slice();
        continue;
      }
      if (t === NAL_PPS) {
        pps = nal.slice();
        continue;
      }
      if (t !== NAL_IDR && t !== NAL_NON_IDR) continue; // skip SEI / AUD / etc.
      if (!ensureDecoder() || !decoder) continue;
      const isKey = t === NAL_IDR;
      if (!sawKey && !isKey) continue; // can't start on a delta
      sawKey = true;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: ts,
            data: toAvcc([nal]),
          })
        );
        ts += FRAME_DURATION_US;
      } catch (e) {
        onError(`Decode failed: ${String(e)}`);
      }
    }
  };

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (closed) return;
    if (ev.data instanceof ArrayBuffer) {
      onBytes(new Uint8Array(ev.data));
      return;
    }
    if (typeof ev.data === 'string') {
      const mode = parseBridgeHello(ev.data);
      if (mode) inputMode = mode;
    }
  };
  ws.onerror = () => {
    if (!closed) onError('Mirror connection error.');
  };

  const sendCtrl = (obj: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const sendTouch = (phase: AndroidTouchPhase, x: number, y: number) => {
    if (phase === 'down') {
      // Choose the gesture's path once: streaming needs the video size (the
      // first frame must have decoded) — otherwise fall back to synthesis.
      gesturePath = inputMode === 'scrcpy' && videoW > 0 && videoH > 0 ? 'stream' : 'discrete';
      gestureStart = { x, y, t: performance.now() };
    }
    const path = gesturePath;
    if (phase === 'up') gesturePath = null;
    if (path === 'stream') {
      sendCtrl({ type: 'touch', phase, x, y, vw: videoW, vh: videoH });
      return;
    }
    if (path !== 'discrete' || phase === 'move') return;
    if (phase === 'up') {
      const start = gestureStart;
      gestureStart = null;
      if (!start) return;
      const g = synthesizeGesture(start, { x, y }, performance.now() - start.t);
      if (g.type === 'tap') sendCtrl({ type: 'tap', x: g.x, y: g.y });
      else sendCtrl({ type: 'swipe', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, ms: g.ms });
    }
  };

  return {
    sendTouch,
    sendTap: (x, y) => sendCtrl({ type: 'tap', x, y }),
    sendSwipe: (x1, y1, x2, y2, ms) => sendCtrl({ type: 'swipe', x1, y1, x2, y2, ms: ms ?? 0 }),
    sendKey: (key) => sendCtrl({ type: 'key', key }),
    close: () => {
      closed = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      try {
        if (decoder && decoder.state !== 'closed') decoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}
