/**
 * DeviceMirror — live, interactive iOS Simulator preview.
 *
 * A **thin view** over a backend-owned mobile preview session. On mount it asks
 * the backend to {@link startMobilePreview} (which boots a sim if needed, starts
 * a serve-sim mirror, and reserves a port), embeds the MJPEG stream, and forwards
 * pointer events as normalized touches over serve-sim's WebSocket. The app build
 * runs in an embedded interactive {@link BuildTerminal}.
 *
 * Crucially, **unmounting tears down nothing native** — the simulator, the
 * serve-sim daemon, and the build all outlive this component. The backend owns
 * their lifecycle and tears them down on project suspend / close / window close.
 * That's what lets a multi-minute build survive a tab switch. This is the mobile
 * counterpart to {@link Preview}.
 *
 * See docs/mobile-app-preview-plan.md (§10c) and docs/mobile-app-preview-status.md.
 *
 * @module components/DeviceMirror
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../lib/logger';
import {
  startMobilePreview,
  getSimulatorLaunchCommand,
  connectInputChannel,
  buildSessionId,
  type MirrorInfo,
} from '../lib/mobile';
import { checkDependenciesInstalled } from '../lib/project';
import { attachPtySession } from '../lib/ptySession';
import { getWindowLabel } from '../lib/window';
import { SpinnerIcon, ResetIcon, ChevronIcon } from './icons';
import { Button } from './primitives/Button';
import { BuildTerminal } from './BuildTerminal';

interface DeviceMirrorProps {
  /** Project name, for guidance copy. */
  projectName: string;
  /** Absolute project path — used to start/key the backend preview session. */
  projectPath: string;
  /** Hand a prompt to the embedded Claude agent (powers "Fix with AI"). */
  onSendToAgent?: (text: string) => void;
}

type InputChannel = ReturnType<typeof connectInputChannel>;
type Status = 'starting' | 'connected' | 'error';
/** App-build progress, shown on the build panel's summary under the mirror. */
type LaunchStatus = 'none' | 'building' | 'finished' | 'failed' | 'unsupported';

export function DeviceMirror({ projectName, projectPath, onSendToAgent }: DeviceMirrorProps) {
  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus>('none');
  const [buildCommand, setBuildCommand] = useState<string | null>(null);
  const [buildOpen, setBuildOpen] = useState(true);
  const [needsInstall, setNeedsInstall] = useState(false);

  const inputRef = useRef<InputChannel | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isPointerDown = useRef(false);

  // Bump to re-run the connect flow (Restart / Try again).
  const [attempt, setAttempt] = useState(0);

  // Connect flow: start the backend session → embed stream → wire input →
  // auto-launch the build. Each run owns a local `cancelled` flag so React
  // StrictMode's dev double-mount (and any real unmount/retry) only closes THIS
  // run's WebSocket — it never tears down the backend session (the backend owns
  // that lifecycle), so the mirror + build survive tab switches.
  useEffect(() => {
    let cancelled = false;
    let channel: InputChannel | null = null;

    const resolveBuild = async (udid: string) => {
      let cmd: string;
      try {
        cmd = await getSimulatorLaunchCommand(projectPath, udid);
      } catch {
        if (!cancelled) setLaunchStatus('unsupported');
        return;
      }
      if (cancelled) return;
      // Soft signal only — an interactive terminal can surface/answer a missing
      // install, so we hint rather than block the launch (unlike the old gate).
      try {
        const dep = await checkDependenciesInstalled(projectPath);
        if (!cancelled && dep.hasPackageJson && !dep.installed) setNeedsInstall(true);
      } catch {
        /* dep check is best-effort */
      }
      if (cancelled) return;
      setBuildCommand(cmd);
      setBuildOpen(true);
      setLaunchStatus('building');
    };

    const run = async () => {
      if (cancelled) return;
      setErrorMsg(null);
      setStatus('starting');
      setLaunchStatus('none');
      setBuildCommand(null);
      setNeedsInstall(false);
      try {
        logger.info('[DeviceMirror] starting backend mobile preview');
        const info = await startMobilePreview(projectPath, getWindowLabel());
        if (cancelled) return;
        logger.info('[DeviceMirror] preview started', { stream: info.stream_url });
        channel = connectInputChannel(info.ws_url);
        inputRef.current = channel;
        setMirror(info);
        setStatus('connected');

        // Auto-launch the app build into the embedded terminal.
        void resolveBuild(info.udid);
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
      // No native teardown here — the backend owns the session lifecycle.
    };
  }, [attempt, projectPath]);

  const restart = useCallback(() => setAttempt((a) => a + 1), []);

  const onBuildExit = useCallback((exitCode: number) => {
    setLaunchStatus(exitCode === 0 ? 'finished' : 'failed');
    if (exitCode === 0) setBuildOpen(false); // collapse once it's up
  }, []);

  // Hand the failing build's output to the embedded agent so it can diagnose and
  // fix it — the whole point of Ship Studio is the agent does the heavy lifting,
  // so the user shouldn't have to read xcodebuild stack traces.
  const sendBuildToAgent = useCallback(async () => {
    let log = '';
    try {
      const attach = await attachPtySession(buildSessionId(projectPath));
      log = new TextDecoder().decode(attach.buffer).slice(-6000);
    } catch {
      /* best-effort — send the prompt even if we couldn't grab the log */
    }
    const prompt =
      `The iOS preview build for "${projectName}" failed. Diagnose the error in the build output below and fix it so the app builds and launches on the simulator, then tell me what you changed.\n\n` +
      (buildCommand ? `Build command: ${buildCommand}\n\n` : '') +
      'Build output:\n```\n' +
      (log || '(no build output captured)') +
      '\n```';
    onSendToAgent?.(prompt);
  }, [projectPath, projectName, buildCommand, onSendToAgent]);

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
    // Note: a successful `expo run:ios` / `flutter run` stays attached (the dev
    // server keeps running), so 'building' is the steady state once the app is
    // up — the copy points at the mirror rather than promising the log will end.
    const summary =
      launchStatus === 'building'
        ? 'Building & launching… your app appears in the preview above (first build can take a few minutes)'
        : launchStatus === 'finished'
          ? 'Build process exited'
          : launchStatus === 'failed'
            ? 'Build exited with errors — see log'
            : '';
    return (
      <div className="device-mirror">
        <div className="device-mirror-toolbar">
          <span className="device-mirror-label">
            {mirror.device_name
              ? `${mirror.device_name}${mirror.device_runtime ? ` · ${mirror.device_runtime}` : ''} · live`
              : 'iOS Simulator · live'}
          </span>
          <Button variant="ghost" size="sm" onClick={restart}>
            <ResetIcon size={14} /> Restart
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
        {buildCommand && launchStatus !== 'unsupported' && (
          <div className={`device-mirror-build${buildOpen ? ' open' : ''}`}>
            <div className="device-mirror-build-header">
              <button
                type="button"
                className="device-mirror-build-toggle"
                data-state={launchStatus}
                onClick={() => setBuildOpen((o) => !o)}
                aria-expanded={buildOpen}
              >
                {launchStatus === 'building' && <SpinnerIcon size={12} />}
                <span className="device-mirror-build-title">{summary}</span>
              </button>
              {launchStatus === 'failed' && onSendToAgent && (
                <button
                  type="button"
                  className="device-mirror-build-send"
                  onClick={() => void sendBuildToAgent()}
                  title="Send the build error to the active agent"
                >
                  Send to agent
                </button>
              )}
              <button
                type="button"
                className={`device-mirror-build-chevron${buildOpen ? ' open' : ''}`}
                onClick={() => setBuildOpen((o) => !o)}
                aria-label={buildOpen ? 'Collapse build log' : 'Expand build log'}
              >
                <ChevronIcon size={14} />
              </button>
            </div>
            {needsInstall && (
              <p className="device-mirror-build-hint">
                Dependencies may not be installed — if the build fails, run <code>npm install</code>{' '}
                and Restart.
              </p>
            )}
            <div
              className="device-mirror-build-body"
              style={{ display: buildOpen ? 'flex' : 'none' }}
            >
              <BuildTerminal
                sessionId={buildSessionId(projectPath)}
                command={buildCommand}
                cwd={projectPath}
                isActive={buildOpen}
                onExit={onBuildExit}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Error ----
  if (status === 'error') {
    const needsXcode = /xcrun|xcode|command line tools/i.test(errorMsg ?? '');
    return (
      <div className="preview-install-prompt">
        <h3>{needsXcode ? 'iOS tooling unavailable' : "Couldn't start the preview"}</h3>
        <p className="hint">
          {needsXcode
            ? 'Previewing a mobile app needs Xcode command line tools. Install Xcode, then run xcode-select --install.'
            : `Ship Studio couldn't start a simulator preview for ${projectName}.`}
        </p>
        {errorMsg && <p className="hint">{errorMsg}</p>}
        <Button variant="secondary" size="sm" onClick={restart}>
          <ResetIcon size={14} /> Try again
        </Button>
      </div>
    );
  }

  // ---- Progress (starting) ----
  return (
    <div className="preview-loading">
      <SpinnerIcon size={24} />
      <span className="hint">Starting the iOS preview… (first boot can take ~30s)</span>
    </div>
  );
}
