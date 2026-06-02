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
  getSimulatorLaunchCommand,
  connectInputChannel,
  type MirrorInfo,
  type MobileSimulator,
} from '../lib/mobile';
import { startDevServer, checkDependenciesInstalled, type DevServerHandle } from '../lib/project';
import { getWindowLabel } from '../lib/window';
import { SpinnerIcon, ResetIcon, CloseIcon } from './icons';
import { Button } from './primitives/Button';

interface DeviceMirrorProps {
  /** Project name, for guidance copy. */
  projectName: string;
  /** Absolute project path — used to boot/register the sim and launch the app. */
  projectPath: string;
}

type InputChannel = ReturnType<typeof connectInputChannel>;
type Status = 'starting' | 'booting' | 'connecting' | 'connected' | 'idle' | 'error';
/** App-launch progress, shown in the build-log panel under the mirror. */
type LaunchStatus = 'none' | 'needs-install' | 'building' | 'finished' | 'failed' | 'unsupported';

/** Keep the build log bounded so a chatty bundler can't grow it unboundedly. */
const MAX_LAUNCH_LOG = 12000;

export function DeviceMirror({ projectName, projectPath }: DeviceMirrorProps) {
  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);
  const [device, setDevice] = useState<MobileSimulator | null>(null);
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus>('none');
  const [launchLog, setLaunchLog] = useState('');

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
    let launchHandle: DevServerHandle | null = null;

    // Build + launch the project's app onto the booted sim, streaming output to
    // the build log. Non-fatal: a launch failure leaves the mirror working.
    const launchApp = async (udid: string) => {
      let cmd: string;
      try {
        cmd = await getSimulatorLaunchCommand(projectPath, udid);
      } catch {
        // Project type we don't know how to launch — leave the mirror as-is.
        if (!cancelled) setLaunchStatus('unsupported');
        return;
      }
      if (cancelled) return;

      // Don't run a doomed build: a JS project with no node_modules will make
      // the bundler stall on an interactive "install packages?" prompt that the
      // read-only log can't answer. Tell the user to install first instead.
      try {
        const dep = await checkDependenciesInstalled(projectPath);
        if (cancelled) return;
        if (dep.hasPackageJson && !dep.installed) {
          setLaunchStatus('needs-install');
          setLaunchLog('Install dependencies first, then Reconnect:\n\n  npm install\n');
          return;
        }
      } catch {
        /* dep check is best-effort; fall through and try the launch */
      }

      setLaunchStatus('building');
      setLaunchLog(`$ ${cmd}\n`);
      logger.info('[DeviceMirror] launching app', { cmd });
      try {
        launchHandle = await startDevServer(
          projectPath,
          0,
          getWindowLabel(),
          (data) => {
            if (!cancelled) setLaunchLog((prev) => (prev + data).slice(-MAX_LAUNCH_LOG));
          },
          cmd
        );
        // Reflect the real outcome so it never "looks done" while building.
        launchHandle.pty.onExit(({ exitCode }) => {
          if (!cancelled) setLaunchStatus(exitCode === 0 ? 'finished' : 'failed');
        });
      } catch (err) {
        if (cancelled) return;
        setLaunchStatus('failed');
        setLaunchLog((prev) => prev + `\n${err instanceof Error ? err.message : String(err)}\n`);
      }
    };

    const run = async () => {
      if (cancelled) return;
      setErrorMsg(null);
      setStatus('starting');
      try {
        logger.info('[DeviceMirror] listing booted simulators');
        let target: MobileSimulator;
        const sims = await listBootedSimulators();
        if (cancelled) return;
        logger.info('[DeviceMirror] booted simulators', { count: sims.length });
        if (sims.length > 0) {
          target = sims[0]; // attach to a user-booted sim (we won't shut it down)
        } else {
          setStatus('booting');
          logger.info('[DeviceMirror] no booted sim; booting default');
          const result = await bootDefaultSimulator(projectPath);
          if (cancelled) return;
          target = result.simulator;
          logger.info('[DeviceMirror] booted default', { udid: target.udid });
        }
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

        // Fire-and-watch the app launch (its own try/catch; never blocks the mirror).
        void launchApp(target.udid);
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
      void launchHandle?.stop();
      if (startedUdid) {
        void stopSimulatorMirror(startedUdid);
        if (activeUdidRef.current === startedUdid) activeUdidRef.current = null;
      }
    };
  }, [attempt, projectPath]);

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
    setLaunchStatus('none');
    setLaunchLog('');
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
        {launchStatus !== 'none' && launchStatus !== 'unsupported' && (
          <details className="device-mirror-buildlog" open={launchStatus !== 'finished'}>
            <summary data-state={launchStatus}>
              {launchStatus === 'building' && <SpinnerIcon size={12} />}
              <span>
                {launchStatus === 'building' &&
                  'Building & launching your app… (can take several minutes)'}
                {launchStatus === 'needs-install' &&
                  'Dependencies not installed — run npm install, then Reconnect'}
                {launchStatus === 'finished' && 'App launched · build finished'}
                {launchStatus === 'failed' && 'Build failed — see log below'}
              </span>
            </summary>
            <pre className="device-mirror-buildlog-output">{launchLog || '(no output yet)'}</pre>
          </details>
        )}
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
