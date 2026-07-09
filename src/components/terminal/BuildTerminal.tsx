/**
 * BuildTerminal — a thin, interactive terminal that runs a mobile app build
 * (`expo run:ios` / `react-native run-ios` / `flutter run`) inside a backend
 * {@link openPtySession | pty_session}.
 *
 * It is the minimal subset of {@link Terminal} needed for a build log: open /
 * attach / subscribe / write. It deliberately has none of Terminal's agent,
 * resume, or status-detection logic. Two properties matter:
 *
 * - **Interactive.** Keystrokes are written to the PTY, so a build that prompts
 *   (CocoaPods, `npx` "Ok to proceed?") can actually be answered — the read-only
 *   `<pre>` it replaces could not.
 * - **Backend-owned.** Unmounting (a tab switch) unsubscribes but does NOT kill
 *   the session, so a multi-minute build keeps running and replays its scrollback
 *   on return. Teardown is the backend's job (suspend / close / window-close).
 *
 * @module components/BuildTerminal
 */

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { createWebLinksAddon } from '../../lib/terminalLinks';
import {
  openPtySession,
  attachPtySession,
  writePtySessionLogged,
  resizePtySession,
  detachPtySession,
  onPtySessionData,
  onPtySessionExit,
  createAttachGate,
} from '../../lib/ptySession';
import { getTerminalGpuEnabled } from '../../lib/settings';
import { loadNerdFonts } from '../../lib/fonts';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import '@xterm/xterm/css/xterm.css';

interface BuildTerminalProps {
  /** Stable pty_session id — use `buildSessionId(projectPath)` so it matches the
   *  backend and re-open across tab switches is idempotent. */
  sessionId: string;
  /** The launch command to run (from `getSimulatorLaunchCommand`). */
  command: string;
  /** Working directory for the build (the project path). */
  cwd: string;
  /** Focus the terminal when this becomes the active view. */
  isActive?: boolean;
  /** Called when the build process exits (clean = 0, error > 0, -1 = unknown). */
  onExit?: (exitCode: number) => void;
  /** Called with decoded terminal output as it arrives — both the replayed
   *  scrollback on attach and the live stream — so the parent can classify build
   *  progress. Kept generic: this component knows nothing about what the text
   *  means. */
  onOutput?: (text: string) => void;
}

// iOS previews are macOS-only; a login+interactive shell sources the user's
// profile so `npx` / `xcrun` / nvm-managed node resolve exactly as in their
// terminal (PATH parity with how the dev server used to launch the build).
const BUILD_SHELL = '/bin/zsh';

export function BuildTerminal({
  sessionId,
  command,
  cwd,
  isActive,
  onExit,
  onOutput,
}: BuildTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Keep the callbacks in refs so their identity churn doesn't re-run the heavy
  // setup effect (which would re-open the session).
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);
  const onOutputRef = useRef(onOutput);
  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

  // Setup: keyed only on the session identity, not on isActive/onExit.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const disposers: Array<() => void> = [];

    const term = new XTerm({
      fontFamily: '"JetBrainsMono NF", Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
        selectionBackground: '#3a3d41',
      },
    });
    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.loadAddon(createWebLinksAddon());
    term.unicode.activeVersion = '11';
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* container detached mid-teardown */
      }
    };

    void loadNerdFonts().then(() => {
      if (!cancelled) safeFit();
    });

    // GPU renderer, gated by the same user setting Terminal honors.
    void (async () => {
      if (cancelled) return;
      const gpuEnabled = await getTerminalGpuEnabled();
      if (cancelled || !gpuEnabled) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* canvas fallback */
      }
    })();

    // Initial fit after layout settles; focus is owned by the isActive effect.
    setTimeout(() => {
      if (!cancelled) safeFit();
    }, 0);

    // Stream-decode PTY bytes to text for onOutput, preserving multi-byte chars
    // split across chunk/replay boundaries.
    const decoder = new TextDecoder();
    const emitOutput = (bytes: Uint8Array) => {
      const cb = onOutputRef.current;
      if (cb) cb(decoder.decode(bytes, { stream: true }));
    };

    // User keystrokes → PTY (this is what makes prompts answerable).
    const inputDisposable = term.onData((data) => {
      writePtySessionLogged(sessionId, data);
    });
    disposers.push(() => inputDisposable.dispose());

    // Open (idempotent) → subscribe to live feed → attach (replay ring
    // buffer, then flush the gate). Subscribing BEFORE attaching matters:
    // Tauri drops events with no registered listener, so the old
    // attach-then-subscribe order could lose a chunk emitted between the
    // snapshot and the subscription (issue #156). The offset gate drops the
    // chunks the snapshot already covers, so nothing double-writes either.
    void (async () => {
      try {
        await openPtySession({
          sessionId,
          command: BUILD_SHELL,
          args: ['-lic', command],
          cwd,
          env: {},
          // Clamp: spawning before layout settles can report 0-size, and a
          // 0-size ConPTY produces no output at all (the backend clamps
          // too; this keeps xterm and the PTY in agreement).
          cols: Math.max(term.cols, 2),
          rows: Math.max(term.rows, 2),
          projectPath: cwd,
        });
        if (cancelled) return;

        const gate = createAttachGate((bytes) => {
          term.write(bytes);
          emitOutput(bytes);
        });
        const unlistenData = await onPtySessionData(sessionId, (bytes, offset) => {
          if (cancelled) return;
          gate.push(offset, bytes);
        });
        disposers.push(() => void unlistenData());

        // Exit is parked until the snapshot replay so onOutput consumers see
        // the build's final output before its exit classification.
        let gateOpen = false;
        let pendingExit: number | null = null;
        let exitEventSeen = false;
        const unlistenExit = await onPtySessionExit(sessionId, (exitCode) => {
          if (cancelled) return;
          exitEventSeen = true;
          if (!gateOpen) {
            pendingExit = exitCode;
            return;
          }
          onExitRef.current?.(exitCode);
        });
        disposers.push(() => void unlistenExit());

        const attach = await attachPtySession(sessionId);
        if (cancelled) return;
        if (attach.buffer.length > 0) {
          term.write(attach.buffer);
          emitOutput(attach.buffer);
        }
        gateOpen = true;
        gate.open(attach.endOffset);
        if (pendingExit !== null) {
          onExitRef.current?.(pendingExit);
        } else if (!attach.alive && attach.exitCode !== null && !exitEventSeen) {
          // It exited before we even subscribed — surface that immediately.
          onExitRef.current?.(attach.exitCode);
        }
      } catch (err) {
        if (!cancelled) {
          logger.error('[BuildTerminal] failed to start build session', {
            error: err instanceof Error ? err.message : String(err),
          });
          term.write(
            `\r\n\x1b[31mFailed to start build: ${formatCommandError(asCommandError(err))}\x1b[0m\r\n`
          );
        }
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      if (cancelled) return;
      safeFit();
      void resizePtySession(sessionId, term.cols, term.rows);
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      void detachPtySession(sessionId);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* best-effort */
        }
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Intentionally NOT killing the pty_session — the backend owns its
      // lifecycle so the build survives this unmount (e.g. a tab switch).
    };
  }, [sessionId, command, cwd]);

  // Focus when this becomes the active view (separate so it doesn't re-open).
  useEffect(() => {
    if (isActive) termRef.current?.focus();
  }, [isActive]);

  return <div ref={containerRef} className="build-terminal" />;
}
