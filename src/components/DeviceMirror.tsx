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
import { logger } from '../lib/logger';
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
  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);
  const [device, setDevice] = useState<MobileSimulator | null>(null);

  const inputRef = useRef<InputChannel | null>(null);
  // UDID of the live mirror, so `disconnect` can stop the right daemon.
  const activeUdidRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isPointerDown = useRef(false);

  // Bump to (re)run the connect flow — used by Retry / Reconnect.
  const [attempt, setAttempt] = useState(0);

  // Connect flow: list → (boot default if none) → start mirror → stream.
  // Each run owns a local `cancelled` flag and tears down whatever IT started,
  // so React StrictMode's dev double-mount (and any real unmount or retry)
  // cancels cleanly without leaking the serve-sim daemon or stranding status.
  useEffect(() => {
    let cancelled = false;
    let startedUdid: string | null = null;
    let channel: InputChannel | null = null;

    const run = async () => {
      if (cancelled) return;
      setErrorMsg(null);
      setStatus('starting');
      try {
        logger.info('[DeviceMirror] listing booted simulators');
        let sims = await listBootedSimulators();
        if (cancelled) return;
        logger.info('[DeviceMirror] booted simulators', { count: sims.length });
        if (sims.length === 0) {
          setStatus('booting');
          logger.info('[DeviceMirror] no booted sim; booting default');
          sims = [await bootDefaultSimulator()];
          if (cancelled) return;
          logger.info('[DeviceMirror] booted default', { udid: sims[0]?.udid });
        }
        const target = sims[0];
        setDevice(target);

        setStatus('connecting');
        logger.info('[DeviceMirror] starting mirror', { udid: target.udid });
        startedUdid = target.udid;
        const info = await startSimulatorMirror(target.udid);
        logger.info('[DeviceMirror] mirror started', { stream: info.stream_url });
        if (cancelled) return; // cleanup stops `startedUdid`
        channel = connectInputChannel(info.ws_url);
        inputRef.current = channel;
        activeUdidRef.current = target.udid;
        setMirror(info);
        setStatus('connected');
      } catch (err) {
        if (cancelled) return;
        logger.error('[DeviceMirror] failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    };
    // Deferred so the first setState lands outside the effect's sync body.
    void Promise.resolve().then(run);

    return () => {
      cancelled = true;
      isPointerDown.current = false;
      channel?.close();
      if (inputRef.current === channel) inputRef.current = null;
      if (startedUdid) {
        void stopSimulatorMirror(startedUdid);
        if (activeUdidRef.current === startedUdid) activeUdidRef.current = null;
      }
    };
  }, [attempt]);

  // Stop the mirror but stay mounted (manual disconnect → idle). The effect's
  // cleanup also stops the daemon on unmount/retry; double-stop is a no-op.
  const disconnect = useCallback(() => {
    inputRef.current?.close();
    inputRef.current = null;
    isPointerDown.current = false;
    const udid = activeUdidRef.current;
    activeUdidRef.current = null;
    setMirror(null);
    setStatus('idle');
    if (udid) void stopSimulatorMirror(udid);
  }, []);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

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
        <Button variant="secondary" size="sm" onClick={retry}>
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
        <Button variant="primary" size="sm" onClick={retry}>
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
