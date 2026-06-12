/**
 * AndroidMirrorStage — the Android half of {@link DeviceMirror}'s live stage.
 *
 * Where iOS embeds a serve-sim MJPEG `<img>`, the Android bridge streams H.264
 * over a WebSocket, which {@link createAndroidMirror} decodes onto a `<canvas>`
 * with WebCodecs. Input mirrors iOS: every pointer down/move/up is handed to the
 * mirror handle, which streams it live over scrcpy's control socket (real drags
 * and long-presses) — or, on the screenrecord fallback, synthesizes the gesture
 * into a discrete tap/swipe. The mode is the handle's concern; this stage just
 * reports what the pointer did.
 *
 * Self-contained: it owns the canvas, the decoder/socket handle, and its pointer
 * wiring. The parent ({@link DeviceMirror}) keeps the shared toolbar, build
 * panel, and launch detection.
 *
 * @module components/AndroidMirrorStage
 */

import { useEffect, useRef } from 'react';
import { createAndroidMirror, type AndroidMirrorHandle } from '../../lib/androidMirror';

interface AndroidMirrorStageProps {
  /** The bridge WebSocket (`ws://127.0.0.1:<port>`) from the started session. */
  wsUrl: string;
  /** Surfaced on connection/decode failure — the parent routes this to auto-heal. */
  onError: (message: string) => void;
  /** Fired once when the first frame paints — the parent drops its spinner / refills
   *  the heal budget. Must be referentially stable, or the decoder reconnects. */
  onFirstFrame: () => void;
}

export function AndroidMirrorStage({ wsUrl, onError, onFirstFrame }: AndroidMirrorStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<AndroidMirrorHandle | null>(null);
  // Last pointer position while down — pointercancel must release the streamed
  // touch SOMEWHERE, or the device is left with a finger held down forever.
  const downAtRef = useRef<{ x: number; y: number } | null>(null);

  // Connect the decoder once per wsUrl. A new session (Restart / heal) changes the
  // URL and re-runs this; onError/onFirstFrame are stable (parent useCallback) so a
  // healthy stream doesn't churn. Unmount closes the socket + decoder.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createAndroidMirror({ wsUrl, canvas, onError, onFirstFrame });
    handleRef.current = handle;
    return () => {
      handle.close();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [wsUrl, onError, onFirstFrame]);

  const norm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = norm(e);
    if (!p) return;
    downAtRef.current = p;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    handleRef.current?.sendTouch('down', p.x, p.y);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!downAtRef.current) return;
    const p = norm(e);
    if (!p) return;
    downAtRef.current = p;
    handleRef.current?.sendTouch('move', p.x, p.y);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!downAtRef.current) return;
    const p = norm(e) ?? downAtRef.current;
    downAtRef.current = null;
    handleRef.current?.sendTouch('up', p.x, p.y);
  };

  const onPointerCancel = () => {
    // Release the touch at its last known point so a cancelled gesture (e.g.
    // the OS stealing the pointer) can't strand a held-down finger on-device.
    const last = downAtRef.current;
    downAtRef.current = null;
    if (last) handleRef.current?.sendTouch('up', last.x, last.y);
  };

  return (
    <canvas
      ref={canvasRef}
      className="device-mirror-screen"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
  );
}
