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
 * See docs/internal/mobile-app-preview-plan.md (§10c) and docs/internal/mobile-app-preview-status.md.
 *
 * @module components/DeviceMirror
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../../lib/logger';
import {
  startMobilePreview,
  getSimulatorLaunchCommand,
  connectInputChannel,
  buildSessionId,
  classifyBuildOutput,
  simulatorAppRunning,
  androidAppRunning,
  hideSimulator,
  detectMobileTargets,
  mobilePlatformSupport,
  appIdFromLog,
  setMobileLaunchStatus,
  type MirrorInfo,
  type MobileLaunchStatus,
  type Platform,
  type MobileTargets,
  type MobilePlatformSupport,
} from '../../lib/mobile';
import { usePolling } from '../../hooks/usePolling';
import { checkDependenciesInstalled } from '../../lib/project';
import { attachPtySession, writePtySession } from '../../lib/ptySession';
import { getWindowLabel } from '../../lib/window';
import { ResetIcon, ChevronIcon } from '../icons';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { BuildTerminal } from '../terminal/BuildTerminal';
import { AndroidMirrorStage } from './AndroidMirrorStage';

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
/**
 * App-build progress, shown on the build panel's summary under the mirror.
 * - `building` — running, no verdict yet (the default while compiling)
 * - `launched` — compiled and the app is up on the simulator (success steady state)
 * - `failed`   — a hard build failure (marker matched, or non-zero exit)
 * - `exited`   — the build process ended cleanly without launching (unusual)
 */
type LaunchStatus = 'none' | 'building' | 'launched' | 'failed' | 'exited' | 'unsupported';

/** Cap on the build log we keep in memory for outcome classification. Markers
 *  (BUILD SUCCEEDED / FAILED) land near the end of a build, so keeping the tail
 *  is sufficient and bounds memory on a long, chatty build. */
const BUILD_LOG_SCAN_CAP = 262144;

/** Per-platform UI copy so one component serves both without scattered ternaries. */
const PLATFORM_COPY: Record<Platform, { device: string; surface: string; startHint: string }> = {
  ios: {
    device: 'iOS Simulator',
    surface: 'simulator',
    startHint: 'Starting the iOS preview… (first boot can take ~30s)',
  },
  android: {
    device: 'Android Emulator',
    surface: 'emulator',
    startHint: 'Starting the Android preview… (first boot can take ~30s)',
  },
};

/** What the user sees, and the prompt handed to the embedded agent, when a platform
 *  the project targets has no toolchain on this machine. We lean on the agent to do
 *  the heavy, nuanced setup rather than dead-ending the user with manual steps. The
 *  Android prompt bakes in the lessons that bit us (Homebrew owned by another user →
 *  install to $HOME without sudo; create an AVD; set ANDROID_HOME). */
const MOBILE_SETUP: Record<Platform, { need: string; prompt: string }> = {
  ios: {
    need: 'Previewing iOS apps needs the Xcode command line tools and a Simulator.',
    prompt:
      "I want to preview iOS apps in Ship Studio, but the iOS toolchain isn't set up on " +
      'this Mac. Please do the heavy lifting to set it up: install the Xcode command line ' +
      'tools (`xcode-select --install`) if missing, verify `xcrun simctl list devices` ' +
      'works, and make sure at least one iOS Simulator runtime + device is available ' +
      '(walk me through any Xcode GUI steps that need me). When it works, tell me to click ' +
      '"Try again".',
  },
  android: {
    need: 'Previewing Android apps needs the Android SDK, a JDK, and an emulator (AVD).',
    prompt:
      "I want to preview Android apps in Ship Studio, but the Android toolchain isn't set " +
      'up on this Mac. Please do the heavy lifting end-to-end without making me fiddle with ' +
      'config: install the Android SDK command line tools (sdkmanager, platform-tools/adb, ' +
      'emulator), a recent system image, and a JDK 17 for Gradle; create an emulator (AVD); ' +
      'and set ANDROID_HOME. If Homebrew is owned by another user, install to my home ' +
      'directory without sudo instead. Verify `adb devices` and `emulator -list-avds` work. ' +
      'When it works, tell me to click "Try again".',
  },
};

/** Auto-heal budget for a dropped mirror: reconnect with exponential backoff,
 *  then give up to the error view rather than looping forever. The budget resets
 *  once the stream is healthy again (a frame loads, or it stays connected for
 *  HEAL_STABLE_MS), so isolated blips over a long session don't exhaust it. */
const MAX_HEAL_ATTEMPTS = 3;
const HEAL_BASE_DELAY_MS = 1500;
const HEAL_STABLE_MS = 5000;

export function DeviceMirror({ projectName, projectPath, onSendToAgent }: DeviceMirrorProps) {
  // Which platforms the project targets, which this machine can actually preview, and
  // which one we're showing. Platform stays null until detection resolves (so we don't
  // connect to a platform the project can't build or the machine can't run) — and
  // stays null when NO platform is available, which renders the agent-setup view.
  const [targets, setTargets] = useState<MobileTargets | null>(null);
  const [support, setSupport] = useState<MobilePlatformSupport | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);

  const [status, setStatus] = useState<Status>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus>('none');
  const [buildCommand, setBuildCommand] = useState<string | null>(null);
  const [buildOpen, setBuildOpen] = useState(true);
  const [needsInstall, setNeedsInstall] = useState(false);
  // Whether the build command is still running. Expo (`expo run:ios`) and Flutter
  // (`flutter run`) stay attached to their bundler, so 'r' reloads work and the
  // process never exits. Bare RN (`react-native run-ios`) exits after launching —
  // Metro runs detached — so reload-via-PTY is impossible and the clean exit must
  // not be mistaken for a failed/ended preview.
  const [buildAlive, setBuildAlive] = useState(false);

  const inputRef = useRef<InputChannel | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isPointerDown = useRef(false);
  // Auto-heal retry budget — declared up here (not next to the heal callbacks)
  // because the connect effect's stable-timer closes over it; a forward reference
  // would also trip the react-hooks immutability rule.
  const healAttemptsRef = useRef(0);

  // Accumulated build-log tail + a mirror of launchStatus, both read inside the
  // output handler (which must stay identity-stable so BuildTerminal's setup
  // effect doesn't re-run). The ref avoids stale-closure reads of launchStatus.
  const buildTextRef = useRef('');
  const launchStatusRef = useRef<LaunchStatus>('none');
  useEffect(() => {
    launchStatusRef.current = launchStatus;
  }, [launchStatus]);

  // Bump to re-run the connect flow (Restart / Try again).
  const [attempt, setAttempt] = useState(0);

  // Detect the project's build targets AND this machine's toolchain, then pick the
  // initial platform — only one we can actually preview (targeted + supported),
  // preferring iOS. If neither is available, platform stays null and we render the
  // agent-setup view. Re-runs on `attempt` so "Try again" (after the agent installs a
  // toolchain) re-checks support and proceeds. Picker shows only available platforms.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([detectMobileTargets(projectPath), mobilePlatformSupport()])
      .then(([t, s]) => {
        if (cancelled) return;
        setTargets(t);
        setSupport(s);
        const avail = { ios: t.ios && s.ios, android: t.android && s.android };
        setPlatform((prev) => prev ?? (avail.ios ? 'ios' : avail.android ? 'android' : null));
      })
      .catch(() => {
        // Detection failed — assume capable and attempt iOS, so the connect flow
        // surfaces a concrete error (which itself offers agent setup).
        if (!cancelled) {
          setSupport((prev) => prev ?? { ios: true, android: true });
          setPlatform((prev) => prev ?? 'ios');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, attempt]);

  // Connect flow: start the backend session → embed stream → wire input →
  // auto-launch the build. Each run owns a local `cancelled` flag so React
  // StrictMode's dev double-mount (and any real unmount/retry) only closes THIS
  // run's WebSocket — it never tears down the backend session (the backend owns
  // that lifecycle), so the mirror + build survive tab switches.
  useEffect(() => {
    let cancelled = false;
    let channel: InputChannel | null = null;
    let stableTimer: number | null = null;

    const resolveBuild = async (
      activePlatform: Platform,
      udid: string,
      seededStatus: MobileLaunchStatus | null
    ) => {
      let cmd: string;
      try {
        cmd = await getSimulatorLaunchCommand(projectPath, activePlatform, udid);
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
      buildTextRef.current = '';
      setBuildCommand(cmd);
      setBuildAlive(true);
      // A reused session carries its backend-stored verdict — restore it
      // directly instead of waiting for the (possibly truncated) log replay or
      // the next app-running poll, which used to regress a long-lived launched
      // app back to 'building' on tab-return. Fresh sessions start at
      // 'building' and report it so the backend session knows one is underway.
      const initial: LaunchStatus =
        seededStatus && seededStatus !== 'building' ? seededStatus : 'building';
      launchStatusRef.current = initial;
      setLaunchStatus(initial);
      setBuildOpen(initial !== 'launched');
      if (initial === 'building') {
        void setMobileLaunchStatus(projectPath, 'building').catch(() => {
          /* best-effort — a teardown race just drops the report */
        });
      }
    };

    const run = async () => {
      // Wait for platform detection before the first connect (see the detect effect).
      if (cancelled || !platform) return;
      setErrorMsg(null);
      setStatus('starting');
      setLaunchStatus('none');
      setBuildCommand(null);
      setNeedsInstall(false);
      setBuildAlive(false);
      try {
        logger.info('[DeviceMirror] starting backend mobile preview', { platform });
        const info = await startMobilePreview(projectPath, getWindowLabel(), platform);
        if (cancelled) return;
        logger.info('[DeviceMirror] preview started', { stream: info.stream_url, platform });
        // iOS drives input over serve-sim's WebSocket from here; Android's canvas
        // stage owns its own socket (video + input), so no channel is wired here.
        if (platform === 'ios') {
          channel = connectInputChannel(info.ws_url);
          inputRef.current = channel;
        }
        setMirror(info);
        setStatus('connected');

        // Stayed connected this long → mirror is healthy; refill the heal budget
        // so blips spread across a long session don't exhaust it (and we don't
        // depend on the MJPEG <img> firing onLoad to reset it).
        stableTimer = window.setTimeout(() => {
          healAttemptsRef.current = 0;
        }, HEAL_STABLE_MS);

        // Auto-launch the app build into the embedded terminal, seeding any
        // verdict the backend session already holds (reuse path).
        void resolveBuild(platform, info.udid, info.launch_status);
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
      if (stableTimer !== null) clearTimeout(stableTimer);
      channel?.close();
      if (inputRef.current === channel) inputRef.current = null;
      // No native teardown here — the backend owns the session lifecycle.
    };
    // `platform` is a dep: switching it re-runs the connect flow, and the backend
    // tears down the previous platform's session before starting the new one.
  }, [attempt, projectPath, platform]);

  // Manual restart (button / "Try again") is a fresh user intent — refill the
  // heal budget so auto-heal gets its full allowance again.
  const restart = useCallback(() => {
    healAttemptsRef.current = 0;
    setAttempt((a) => a + 1);
  }, []);

  // Switch the previewed platform. Changing `platform` re-runs the connect effect,
  // and the backend tears down the previous platform's session first. No-op if it's
  // already the active platform (avoids a needless teardown/reboot).
  const switchPlatform = useCallback((next: Platform) => {
    healAttemptsRef.current = 0;
    setPlatform((prev) => (prev === next ? prev : next));
  }, []);

  // Auto-heal: the MJPEG <img> fires onError when the stream drops (serve-sim
  // died). Rather than freeze on the last frame until the user clicks Restart, we
  // reconnect — which re-runs startMobilePreview and the backend respawns the dead
  // mirror. Bounded: exponential backoff and a hard attempt cap, after which we
  // surface the error instead of looping (an unrecoverable sim would otherwise
  // re-trigger a boot every cycle). The budget refills once the mirror is healthy
  // again (onMirrorLoad, or HEAL_STABLE_MS connected — see the connect effect).
  const healTimerRef = useRef<number | null>(null);
  const cancelHeal = useCallback(() => {
    if (healTimerRef.current !== null) {
      clearTimeout(healTimerRef.current);
      healTimerRef.current = null;
    }
  }, []);
  const scheduleHeal = useCallback(() => {
    if (healTimerRef.current !== null) return; // a heal is already pending
    if (healAttemptsRef.current >= MAX_HEAL_ATTEMPTS) {
      // Mirror won't come back on its own — stop looping and let the user act.
      setErrorMsg('Lost the connection to the device mirror.');
      setStatus('error');
      return;
    }
    const delay = HEAL_BASE_DELAY_MS * 2 ** healAttemptsRef.current; // 1.5s, 3s, 6s
    healAttemptsRef.current += 1;
    healTimerRef.current = window.setTimeout(() => {
      healTimerRef.current = null;
      setAttempt((a) => a + 1); // reconnect; backend respawns the mirror
    }, delay);
  }, []);
  // A healthy frame means the stream recovered — drop any pending heal and refill
  // the budget so future blips get a fresh allowance.
  const onMirrorLoad = useCallback(() => {
    healAttemptsRef.current = 0;
    cancelHeal();
  }, [cancelHeal]);
  useEffect(() => cancelHeal, [cancelHeal]);

  // Reload the JS bundle without a full rebuild: Metro (`expo run:ios` /
  // `react-native run-ios`) and `flutter run` all reload on an 'r' keystroke. We
  // write it straight to the build PTY the app is running in.
  const reloadApp = useCallback(() => {
    void writePtySession(buildSessionId(projectPath), 'r');
  }, [projectPath]);

  // Settle the build verdict. 'launched' is ground truth — the app is actually on
  // the simulator — so it always wins, even over a prior 'failed'. That's what lets
  // an agent's out-of-band rebuild (which our BuildTerminal can't see) resolve a
  // failed panel to launched. Other verdicts settle only from the initial
  // 'building', so a torn-down Metro (which exits non-zero) can't flip a launched
  // app to 'failed', and a stale 'failed' stays put until the app genuinely comes up.
  const settleLaunchStatus = useCallback(
    (next: 'launched' | 'failed' | 'exited') => {
      if (launchStatusRef.current === 'launched') return;
      if (next !== 'launched' && launchStatusRef.current !== 'building') return;
      launchStatusRef.current = next;
      setLaunchStatus(next);
      // Persist the verdict on the backend session so a tab-return restores it
      // even after the log marker scrolls out of the pty ring buffer.
      void setMobileLaunchStatus(projectPath, next).catch(() => {
        /* best-effort — a teardown race just drops the report */
      });
      if (next === 'launched') {
        setBuildOpen(false); // app is up — collapse the log
        // iOS only: the build tool foregrounded Simulator.app over Ship Studio; the
        // mirror is headless so the window is redundant — tuck it away. Android's
        // emulator window has no equivalent we hide. Best-effort.
        if (platform === 'ios') void hideSimulator();
      }
    },
    [platform, projectPath]
  );

  // Ground-truth launch detection: poll the simulator for our actually-running app.
  // This is the authoritative "did it launch" signal and covers two gaps the
  // build-log classifier can't: (1) it misses some frameworks' success banners
  // (Expo's "iOS Bundled" / "Opening on …" aren't markers), and (2) it can't see a
  // build the agent ran in its OWN terminal after "Send to agent". So it resolves
  // both 'building' → 'launched' (normal build) and 'failed' → 'launched' (agent
  // rescue). We pass the bundle id parsed from the log when we have it, so a stale
  // app on a pre-booted sim can't cause a false launch. Enabled only while a verdict
  // is still pending; usePolling backs off on error (sim booting / mid-teardown).
  usePolling(
    async () => {
      const id = mirror?.udid; // iOS: sim udid · Android: emulator serial
      if (!id || !platform) return;
      const appId = appIdFromLog(platform, buildTextRef.current);
      const running =
        platform === 'android'
          ? await androidAppRunning(id, appId)
          : await simulatorAppRunning(id, appId);
      if (running) settleLaunchStatus('launched');
    },
    {
      intervalMs: 3000,
      // Include 'exited': bare RN's `run-ios` / `run-android` exit 0 right after
      // launching, so the app is up but the build process is gone — the poll is
      // what upgrades that clean exit to 'launched'.
      enabled:
        status === 'connected' &&
        (launchStatus === 'building' || launchStatus === 'failed' || launchStatus === 'exited'),
      name: 'mobile-app-running',
    }
  );

  // Classify build progress from the embedded terminal's output. A successful
  // `expo run:ios` / `flutter run` never exits (it stays attached to Metro), so
  // log markers — not the process exit — are how we know the app actually came
  // up. See classifyBuildOutput.
  //
  // Known limitation: the verdict lives only in this component. On a tab-return
  // the log is replayed from the pty's bounded ring buffer; for a long-lived
  // launched app whose success banner has scrolled out of the ring, the marker
  // is gone and the status can fall back to 'building'. The fix is a
  // backend-owned build status (persisted in MobileSession, returned from
  // start_mobile_preview) — the same signal the agent-assist loop will need.
  const handleBuildOutput = useCallback(
    (chunk: string) => {
      if (launchStatusRef.current !== 'building') return;
      buildTextRef.current = (buildTextRef.current + chunk).slice(-BUILD_LOG_SCAN_CAP);
      const outcome = classifyBuildOutput(buildTextRef.current);
      if (outcome) settleLaunchStatus(outcome);
    },
    [settleLaunchStatus]
  );

  // Process exit is the authoritative failure backstop: a build that died before
  // emitting a marker we recognize (e.g. a failed `pod install`) still resolves.
  const onBuildExit = useCallback(
    (exitCode: number) => {
      setBuildAlive(false); // bundler is gone — no reload-via-PTY past this point
      settleLaunchStatus(exitCode === 0 ? 'exited' : 'failed');
    },
    [settleLaunchStatus]
  );

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
    const surface = platform ? PLATFORM_COPY[platform].surface : 'simulator';
    const platformName = platform === 'android' ? 'Android' : 'iOS';
    const prompt =
      `The ${platformName} preview build for "${projectName}" failed. Diagnose the error in the build output below and fix it so the app builds and launches on the ${surface}, then tell me what you changed.\n\n` +
      (buildCommand ? `Build command: ${buildCommand}\n\n` : '') +
      'Build output:\n```\n' +
      (log || '(no build output captured)') +
      '\n```';
    onSendToAgent?.(prompt);
  }, [projectPath, projectName, buildCommand, onSendToAgent, platform]);

  // Hand the toolchain setup for a platform to the embedded agent — the heavy,
  // nuanced work (installers, SDKs, AVDs, env) the user shouldn't have to do by hand.
  const handleAgentSetup = useCallback(
    (p: Platform) => {
      onSendToAgent?.(MOBILE_SETUP[p].prompt);
    },
    [onSendToAgent]
  );

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

  // Shared card for the setup / tooling-error states: heading + detail (+ optional
  // extra line) + an optional "Set up with AI" agent hand-off + "Try again". Used by
  // both the proactive (no-toolchain) and reactive (tooling-error) paths so they
  // don't drift. `setup` null → no agent button (a generic, non-tooling failure).
  const renderSetupCard = (
    heading: string,
    detail: string,
    setup: Platform | null,
    extra?: string
  ) => (
    <div className="preview-install-prompt">
      <h3>{heading}</h3>
      <p className="hint">{detail}</p>
      {extra && <p className="hint">{extra}</p>}
      {setup && onSendToAgent && (
        <Button variant="primary" size="sm" onClick={() => handleAgentSetup(setup)}>
          Set up with AI
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={restart}>
        <ResetIcon size={14} /> Try again
      </Button>
    </div>
  );

  // A platform is usable only if the project targets it AND this machine can build
  // it; null means detection is still running.
  const available =
    targets && support
      ? { ios: targets.ios && support.ios, android: targets.android && support.android }
      : null;
  const anyAvailable = !!available && (available.ios || available.android);

  // ---- Agent-driven setup: a targeted platform with no toolchain ----
  // Rather than dead-end the user with manual install steps, hand the heavy setup to
  // the embedded agent. Prefer iOS when both are targeted-but-unavailable.
  if (targets && support && !anyAvailable && status !== 'connected') {
    const setupPlatform: Platform | null = targets.ios ? 'ios' : targets.android ? 'android' : null;
    if (setupPlatform) {
      const platformName = setupPlatform === 'android' ? 'Android' : 'iOS';
      return renderSetupCard(
        `Set up ${platformName} previews`,
        MOBILE_SETUP[setupPlatform].need,
        setupPlatform,
        onSendToAgent ? 'Let the agent install and configure it for you.' : undefined
      );
    }
  }

  // ---- Connected: the live mirror ----
  if (status === 'connected' && mirror) {
    const activePlatform: Platform = platform ?? 'ios';
    const surface = PLATFORM_COPY[activePlatform].surface;
    // A successful `expo run` / `flutter run` stays attached to Metro and never
    // exits, so the verdict comes from log markers / the app-running poll, not the
    // process exit. 'launched' is the success steady state.
    const summary =
      launchStatus === 'building'
        ? 'Building & launching… your app appears in the preview above (first build can take a few minutes)'
        : launchStatus === 'launched'
          ? `App running on the ${surface}`
          : launchStatus === 'exited'
            ? 'Build process exited'
            : launchStatus === 'failed'
              ? 'Build failed — see log'
              : '';
    // The picker only appears when BOTH platforms are usable here (targeted + the
    // toolchain present) — never offer a tab that would dead-end.
    const showPicker = !!available?.ios && !!available?.android;
    return (
      <div className="device-mirror">
        <div className="device-mirror-toolbar">
          {showPicker && (
            <div className="device-mirror-platform" role="group" aria-label="Preview platform">
              {(['ios', 'android'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`device-mirror-platform-btn${activePlatform === p ? ' active' : ''}`}
                  aria-pressed={activePlatform === p}
                  onClick={() => switchPlatform(p)}
                >
                  {p === 'ios' ? 'iOS' : 'Android'}
                </button>
              ))}
            </div>
          )}
          <span className="device-mirror-label">
            {mirror.device_name
              ? `${mirror.device_name}${mirror.device_runtime ? ` · ${mirror.device_runtime}` : ''} · live`
              : `${PLATFORM_COPY[activePlatform].device} · live`}
          </span>
          {launchStatus === 'launched' && buildAlive && (
            <Button variant="ghost" size="sm" onClick={reloadApp}>
              <ResetIcon size={14} /> Reload
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={restart}>
            <ResetIcon size={14} /> Restart
          </Button>
        </div>
        <div
          className="device-mirror-stage"
          // A double-click would start a native text/image selection that
          // floods the pane blue — clicks here are touches, never selections.
          onMouseDown={(e) => {
            if (e.detail > 1) e.preventDefault();
          }}
        >
          {activePlatform === 'android' ? (
            // Key by attempt so a heal/Restart remounts the decoder even when the
            // backend hands back the same bridge port (wsUrl alone wouldn't change).
            <AndroidMirrorStage
              key={attempt}
              wsUrl={mirror.ws_url}
              onError={scheduleHeal}
              onFirstFrame={onMirrorLoad}
            />
          ) : (
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
              onError={scheduleHeal}
              onLoad={onMirrorLoad}
            />
          )}
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
                {launchStatus === 'building' && <Spinner size="sm" />}
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
                title={buildOpen ? 'Collapse build log' : 'Expand build log'}
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
                onOutput={handleBuildOutput}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Error ----
  if (status === 'error') {
    // A tooling error is fixable by the agent — set up the platform we were actually
    // attempting (`platform`), not one re-derived from the error text. The keyword
    // match only classifies tooling-vs-generic so we know whether to offer setup.
    const isToolingError =
      /xcrun|xcode|command line tools/i.test(errorMsg ?? '') ||
      /\b(adb|emulator|android sdk|avd|virtual device|java runtime)\b/i.test(errorMsg ?? '');
    const setupPlatform: Platform | null = isToolingError ? platform : null;
    const heading = setupPlatform
      ? `${setupPlatform === 'android' ? 'Android' : 'iOS'} tooling unavailable`
      : "Couldn't start the preview";
    const detail = setupPlatform
      ? MOBILE_SETUP[setupPlatform].need
      : `Ship Studio couldn't start a ${PLATFORM_COPY[platform ?? 'ios'].surface} preview for ${projectName}.`;
    return renderSetupCard(heading, detail, setupPlatform, errorMsg ?? undefined);
  }

  // ---- Progress (starting) ----
  return (
    <div className="preview-loading">
      <Spinner />
      <span className="hint">{PLATFORM_COPY[platform ?? 'ios'].startHint}</span>
    </div>
  );
}
