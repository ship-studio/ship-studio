/**
 * DeviceMirror — live, interactive iOS Simulator preview.
 *
 * On mount it auto-connects: lists booted simulators, boots a sensible default
 * (newest available iPhone) if none is running, starts a serve-sim mirror, and
 * embeds the MJPEG stream. Mouse input is forwarded as normalized touch events
 * over serve-sim's WebSocket control channel.
 *
 * The simulator we boot is left running on disconnect (shutting down a device
 * the user may be using would be hostile); only our serve-sim daemon is torn
 * down. This is the mobile counterpart to {@link Preview}.
 *
 * See docs/mobile-app-preview-plan.md (§10c).
 *
 * @module components/DeviceMirror
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalToast } from '../contexts/ToastContext';
import {
  listBootedSimulators,
  bootDefaultSimulator,
  startSimulatorMirror,
  stopSimulatorMirror,
  connectInputChannel,
  type MirrorInfo,
  type MobileSimulator,
} from '../lib/mobile';
import { SpinnerIcon, ResetIcon, CloseIcon } from './icons';
import { Button } from './primitives/Button';

interface DeviceMirrorProps {
  /** Project name, for guidance copy. */
  projectName: string;
}

type InputChannel = ReturnType<typeof connectInputChannel>;
type Status = 'starting' | 'booting' | 'connecting' | 'connected' | 'idle' | 'error';

export function DeviceMirror({ projectName }: DeviceMirrorProps) {
  const { showToast } = useOptionalToast();

  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);
  const [device, setDevice] = useState<MobileSimulator | null>(null);

  const inputRef = useRef<InputChannel | null>(null);
  const mirrorRef = useRef<MirrorInfo | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isPointerDown = useRef(false);

  // Keep a ref in sync so the unmount cleanup can stop the right daemon without
  // depending on `mirror` (which would re-run cleanup on every change).
  useEffect(() => {
    mirrorRef.current = mirror;
  }, [mirror]);

  useEffect(() => {
    return () => {
      inputRef.current?.close();
      inputRef.current = null;
      const active = mirrorRef.current;
      if (active?.udid) void stopSimulatorMirror(active.udid);
    };
  }, []);

  // Full connect flow: list → (boot default if none) → start mirror → stream.
  const begin = useCallback(async () => {
    setErrorMsg(null);
    try {
      setStatus('starting');
      let sims = await listBootedSimulators();
      if (sims.length === 0) {
        setStatus('booting');
        sims = [await bootDefaultSimulator()];
      }
      const target = sims[0];
      setDevice(target);

      setStatus('connecting');
      const info = await startSimulatorMirror(target.udid);
      inputRef.current?.close();
      inputRef.current = connectInputChannel(info.ws_url);
      setMirror(info);
      setStatus('connected');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  // Auto-start once on mount. Deferred to a microtask so the first state
  // update happens outside the effect's synchronous body (avoids cascading
  // renders) and so a same-tick unmount can cancel cleanly.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void Promise.resolve().then(begin);
  }, [begin]);

  const disconnect = useCallback(() => {
    inputRef.current?.close();
    inputRef.current = null;
    isPointerDown.current = false;
    const active = mirror;
    setMirror(null);
    setStatus('idle');
    if (active?.udid) {
      stopSimulatorMirror(active.udid).catch(() =>
        showToast('Mirror stopped, but the simulator is still running.', 'info')
      );
    }
  }, [mirror, showToast]);

  // Map a pointer event to normalized 0..1 coords over the streamed image.
  const toNorm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toNorm(e);
    if (!p) return;
    isPointerDown.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    inputRef.current?.sendTouch('down', p.x, p.y);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!isPointerDown.current) return;
    const p = toNorm(e);
    if (p) inputRef.current?.sendTouch('move', p.x, p.y);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!isPointerDown.current) return;
    isPointerDown.current = false;
    const p = toNorm(e);
    if (p) inputRef.current?.sendTouch('up', p.x, p.y);
  };

  // ---- Connected: the live mirror ----
  if (status === 'connected' && mirror) {
    return (
      <div className="device-mirror">
        <div className="device-mirror-toolbar">
          <span className="device-mirror-label">
            {device
              ? `${device.name}${device.runtime ? ` · ${device.runtime}` : ''} · live`
              : 'iOS Simulator · live'}
          </span>
          <Button variant="ghost" size="sm" onClick={disconnect}>
            <CloseIcon size={14} /> Disconnect
          </Button>
        </div>
        <div className="device-mirror-stage">
          <img
            ref={imgRef}
            className="device-mirror-screen"
            src={mirror.stream_url}
            alt="iOS Simulator"
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>
      </div>
    );
  }

  // ---- Error ----
  if (status === 'error') {
    const needsXcode = /xcrun|xcode|command line tools/i.test(errorMsg ?? '');
    return (
      <div className="preview-install-prompt">
        <h3>{needsXcode ? 'iOS tooling unavailable' : "Couldn't start the mirror"}</h3>
        <p className="hint">
          {needsXcode
            ? 'Previewing a mobile app needs Xcode command line tools. Install Xcode, then run xcode-select --install.'
            : `Ship Studio couldn't mirror a simulator for ${projectName}.`}
        </p>
        {errorMsg && <p className="hint">{errorMsg}</p>}
        <Button variant="secondary" size="sm" onClick={() => void begin()}>
          <ResetIcon size={14} /> Try again
        </Button>
      </div>
    );
  }

  // ---- Idle (after manual disconnect) ----
  if (status === 'idle') {
    return (
      <div className="preview-install-prompt">
        <h3>Disconnected</h3>
        <p className="hint">The simulator is still running. Reconnect to preview {projectName}.</p>
        <Button variant="primary" size="sm" onClick={() => void begin()}>
          Reconnect
        </Button>
      </div>
    );
  }

  // ---- Progress (starting / booting / connecting) ----
  const message =
    status === 'booting'
      ? 'Booting iOS Simulator… (first boot can take ~30s)'
      : status === 'connecting'
        ? 'Starting the live mirror…'
        : 'Looking for a simulator…';
  return (
    <div className="preview-loading">
      <SpinnerIcon size={24} />
      <span className="hint">{message}</span>
    </div>
  );
}
