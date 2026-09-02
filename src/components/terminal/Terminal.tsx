/**
 * Terminal component that embeds Claude Code CLI in an xterm.js terminal.
 *
 * This component creates a fully functional terminal emulator using xterm.js,
 * connected to a PTY (pseudo-terminal) running the Claude Code CLI. It supports:
 * - Full terminal emulation with ANSI color codes
 * - File drag-and-drop (paths are pasted into the terminal)
 * - Automatic font loading (JetBrains Mono Nerd Font)
 * - Terminal resize handling
 * - PTY lifecycle management with retry logic
 *
 * @module components/Terminal
 */

import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { createWebLinksAddon } from '../../lib/terminalLinks';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { attachWebglRenderer } from '../../lib/terminalWebgl';
import {
  openPtySession,
  attachPtySession,
  writePtySessionLogged,
  resizePtySessionLogged,
  killPtySession,
  detachPtySession,
  onPtySessionData,
  onPtySessionExit,
  createAttachGate,
} from '../../lib/ptySession';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useAgentBridge } from '../../contexts/AgentBridgeContext';

/**
 * Handle to a backend-owned PTY session. A Terminal component attaches to
 * one via `openPtySession(sessionId)`; unmounting detaches (unsubscribes)
 * but leaves the PTY running. Only explicit close-tab actions kill it.
 */
interface SessionHandle {
  sessionId: string;
  pid: number | null;
}
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { getShellPath, getSystemEnv } from '../../lib/project';
import { loadNerdFonts } from '../../lib/fonts';
import { isWindows, needsCmdExeWrapper, resolveCliPath, type ResolvedCli } from '../../lib/setup';
import { isPasteChord, readClipboardText, stageClipboardImage } from '../../lib/clipboard';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { isResourcePressureError } from '../../lib/errorReporting';
import { isPointInRect, dropPointToLogical } from '../../lib/dropTarget';
import { getTerminalGpuEnabled } from '../../lib/settings';
import { attachedLibraryDirs } from '../../lib/attached-libraries';
import { sanitizeTerminalTitle } from '../../lib/terminalTitle';
import {
  decideStartupTimeoutAction,
  RESPAWN_GRACE_MS,
  STARTUP_TIMEOUT_MS,
} from './startupWatchdog';
import { createTerminalOptions } from './terminalTheme';
import type { AgentConfig } from '../../lib/agent';
import '@xterm/xterm/css/xterm.css';

/** Agent status based on terminal title */
export type AgentStatus = 'thinking' | 'waiting' | 'idle';

/** Props for the Terminal component */
interface TerminalProps {
  /** Agent configuration to use for this terminal */
  agent: AgentConfig;
  /** Absolute path to the project directory where the agent will run */
  projectPath: string;
  /** Callback fired when the PTY is spawned successfully. `pid` is the OS
   *  process id of the agent — used by the session registry to track
   *  liveness across project switches. */
  onSpawn?: (pid: number | null) => void;
  /** Callback fired when the agent process exits */
  onExit?: (code: number | null) => void;
  /** Whether to run the agent in auto-accept mode */
  autoAcceptMode?: boolean;
  /** Callback fired when the agent's status changes (thinking, waiting for input, idle) */
  onStatusChange?: (status: AgentStatus, title: string) => void;
  /** Callback fired when the terminal title changes (for tab display) */
  onTitleChange?: (title: string) => void;
  /** Unique session name for naming/resuming agent conversations */
  sessionName?: string;
  /** Whether this terminal tab is currently visible */
  isActive?: boolean;
  /** Whether to resume a previous session with this name */
  shouldResume?: boolean;
  /** Relaunch this tab's agent after it has exited. The parent mints a
   *  fresh session and remounts — keeps session-id semantics clean instead
   *  of reusing an id whose conversation file already exists. */
  onRequestRestart?: () => void;
}

/**
 * Handle exposed to parent components via ref.
 * Allows programmatic control of the terminal.
 */
export interface TerminalHandle {
  /** Focus the terminal input */
  focus: () => void;
  /** Write data directly to the PTY (as if typed) */
  write: (data: string) => void;
  /** Paste text into the terminal */
  paste: (data: string) => void;
  /** Kill the PTY process */
  kill: () => void;
  /** Whether the agent process has exited and the tab is showing the
   *  "press Enter to restart" prompt. The parent uses this to no-op a
   *  restart request while the agent is still running. */
  isExited: () => boolean;
  /** Re-fit the terminal to its container (call after display changes) */
  fit: () => void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  {
    agent,
    projectPath,
    onSpawn,
    onExit,
    autoAcceptMode = false,
    onStatusChange,
    onTitleChange,
    sessionName,
    isActive = true,
    shouldResume,
    onRequestRestart,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<SessionHandle | null>(null);
  const isActiveRef = useRef(isActive);
  // Track Unlisten handles from the PTY session events so we can unsubscribe
  // them on unmount without killing the backend PTY.
  const ptyDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  // True once the agent process has exited and the tab is showing the
  // "press Enter to restart" prompt. While set, keystrokes don't go to the
  // (dead) PTY — Enter relaunches the agent instead.
  const exitedRef = useRef(false);
  // Guards a held Enter from dispatching multiple restarts before the tab
  // remounts: only the first Enter after exit relaunches, the rest are swallowed.
  const restartRequestedRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const [isFocused, setIsFocused] = useState(false); // Start unfocused to show overlay until user clicks

  // Mirror `isActive` to a ref so non-effect closures (input handler,
  // resize observer) can read it without re-creating.
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Register this terminal as the "Send to agent" injection target while it's the
  // active tab — feature code (e.g. the CSS editor) calls `sendToAgent(prompt)` and
  // it lands in the terminal the user is looking at. The writer reads the live PTY id.
  const { registerAgent, unregisterAgent } = useAgentBridge();
  useEffect(() => {
    if (!isActive || !isReady) return;
    const writer = (data: string) => {
      const sid = ptyRef.current?.sessionId;
      if (sid) writePtySessionLogged(sid, data);
    };
    registerAgent(writer);
    return () => unregisterAgent(writer);
  }, [isActive, isReady, registerAgent, unregisterAgent]);

  // Use refs for callbacks to prevent effect re-runs when callback references change
  const onExitRef = useRef(onExit);
  const onSpawnRef = useRef(onSpawn);
  const onStatusChangeRef = useRef(onStatusChange);
  const onTitleChangeRef = useRef(onTitleChange);
  const onRequestRestartRef = useRef(onRequestRestart);
  const lastStatusRef = useRef<AgentStatus>('idle');
  useEffect(() => {
    onExitRef.current = onExit;
    onSpawnRef.current = onSpawn;
    onStatusChangeRef.current = onStatusChange;
    onTitleChangeRef.current = onTitleChange;
    onRequestRestartRef.current = onRequestRestart;
  }, [onExit, onSpawn, onStatusChange, onTitleChange, onRequestRestart]);

  // Auto-accept is a spawn-time flag (CLI arg) — it can't be toggled on a
  // live PTY. Keep it in a ref so a later change to the scalar doesn't
  // re-run the setup effect and tear the PTY down. This matters during
  // project switching: `autoAcceptMode` is a single shared scalar whose
  // value flips to the incoming project's preference, and including it in
  // the setup-effect deps used to kill every background project's Terminal
  // in the process.
  const autoAcceptModeRef = useRef(autoAcceptMode);
  useEffect(() => {
    autoAcceptModeRef.current = autoAcceptMode;
  }, [autoAcceptMode]);

  const cleanup = useCallback(() => {
    // Unmount detaches this component from the backend PTY session — it
    // does NOT kill the PTY. Kill happens exclusively through the
    // imperative `kill()` handle (close tab, switch agent, close project).
    // That separation is what lets a background project's Terminal unmount
    // freely while its agent keeps running.
    const sessionId = ptyRef.current?.sessionId;
    if (sessionId) {
      void detachPtySession(sessionId);
    }

    for (const d of ptyDisposablesRef.current) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    ptyDisposablesRef.current = [];
    ptyRef.current = null;

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }
  }, []);

  // Initialize terminal after mount and fonts are loaded
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const startTime = Date.now();

    // Wait for container to have dimensions AND fonts to load
    const checkReady = () => {
      if (cancelled) return;

      const rect = container.getBoundingClientRect();
      const elapsed = Date.now() - startTime;

      if (rect.width > 0 && rect.height > 0) {
        logger.info('[Terminal] Container ready', {
          agent: agent.id,
          width: rect.width,
          height: rect.height,
          waitMs: elapsed,
        });
        void loadNerdFonts()
          .then(() => {
            if (!cancelled) {
              logger.info('[Terminal] Fonts loaded, setting ready', { agent: agent.id });
              setIsReady(true);
            }
          })
          .catch((err) => {
            logger.error('[Terminal] Font loading failed, proceeding anyway', {
              agent: agent.id,
              error: formatCommandError(asCommandError(err)),
            });
            if (!cancelled) setIsReady(true);
          });
      } else if (elapsed > 10_000) {
        // Safety: if container never gets dimensions after 10s, log and try anyway
        logger.error('[Terminal] Container never got dimensions after 10s, forcing ready', {
          agent: agent.id,
          width: rect.width,
          height: rect.height,
          display: container.style.display,
          parentDisplay: container.parentElement?.style.display,
        });
        void loadNerdFonts()
          .catch(() => {})
          .then(() => {
            if (!cancelled) setIsReady(true);
          });
      } else {
        if (elapsed > 2000 && elapsed % 1000 < 50) {
          logger.warn('[Terminal] Still waiting for container dimensions', {
            agent: agent.id,
            width: rect.width,
            height: rect.height,
            waitMs: elapsed,
          });
        }
        requestAnimationFrame(checkReady);
      }
    };
    checkReady();

    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  // Listen for Tauri file drop events
  // Use a ref for debounce to persist across HMR
  const lastDropTimeRef = useRef(0);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let mounted = true;

    const setupDropListener = async () => {
      // Listen for the tauri://drag-drop event. It's window-global and every
      // mounted Terminal registers one — including hidden tabs and background
      // projects (kept mounted with `visibility: hidden` so their PTYs stay
      // alive, see WorkspaceView) — so route the drop by position: only the
      // visible pane under the cursor accepts it. Without this, one drop
      // pastes the path into every open agent's PTY (issue #167).
      const unlistenFn = await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-drop',
        (event) => {
          const container = containerRef.current;
          // offsetParent is null for display:none subtrees; their rects are
          // zero/stale and must never match.
          if (!container || container.offsetParent === null) return;
          // Hidden-but-mounted panes are absolutely positioned with
          // `visibility: hidden`, so their rects still overlap the visible
          // pane — computed visibility is the discriminator.
          if (getComputedStyle(container).visibility !== 'visible') return;
          // Normalize the payload position to logical CSS pixels before
          // hit-testing. Only Windows sends device pixels — macOS sends
          // logical AppKit points despite the PhysicalPosition typing, and
          // dividing them by DPR broke every Retina drop (see dropTarget.ts).
          // In a split, this routes the drop to the pane under the cursor.
          const point = dropPointToLogical(
            event.payload.position,
            isWindows(),
            window.devicePixelRatio
          );
          if (!isPointInRect(point, container.getBoundingClientRect())) return;

          // Debounce - ignore duplicate events within 500ms
          const now = Date.now();
          if (now - lastDropTimeRef.current < 500) {
            return;
          }
          lastDropTimeRef.current = now;

          const pty = ptyRef.current;
          const term = terminalRef.current;

          if (pty && term && event.payload.paths && event.payload.paths.length > 0) {
            // Quote paths that contain spaces
            const quotedPaths = event.payload.paths
              .map((p) => (p.includes(' ') ? `"${p}"` : p))
              .join(' ');

            // Focus terminal and paste the path
            term.focus();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
            (term as any).paste(quotedPaths);
          }
        }
      );

      // If component unmounted while awaiting, clean up immediately
      if (!mounted) {
        unlistenFn();
      } else {
        unlisten = unlistenFn;
      }
    };

    void setupDropListener();

    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // Create terminal when ready
  useEffect(() => {
    if (!isReady || !containerRef.current) return;

    const container = containerRef.current;

    // Create terminal with JetBrains Mono Nerd Font (fallback to system monospace)
    const term = new XTerm({
      ...createTerminalOptions('normal'),
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(createWebLinksAddon());
    term.unicode.activeVersion = '11';

    // Open terminal in container
    term.open(container);

    // Use WebGL renderer for GPU-accelerated rendering (reduces flickering).
    // Gated by a user setting — some macOS beta / GPU-driver combinations render corrupted
    // glyphs through WebGL, so users can opt out via Settings → Preferences.
    // attachWebglRenderer only keeps the addon loaded while the pane has
    // layout — background panes stay mounted (and streaming) while zero-sized,
    // which made the glyph atlas throw from getImageData (issue #383).
    let disposeWebgl: (() => void) | null = null;
    let webglTornDown = false;
    void (async () => {
      const gpuEnabled = await getTerminalGpuEnabled();
      if (!gpuEnabled) {
        logger.info('[Terminal] GPU rendering disabled by user, using canvas renderer');
        return;
      }
      // The effect can tear down while the settings read is in flight.
      if (!webglTornDown) {
        disposeWebgl = attachWebglRenderer(term, container);
      }
    })();

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
      // Auto-focus if this is the active tab — must happen after fit so
      // xterm's textarea is properly sized and ready to receive input.
      if (isActiveRef.current) {
        term.focus();
      }
    }, 0);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track terminal focus state for dimming overlay
    // xterm.js doesn't have onBlur/onFocus - use the underlying textarea
    const textarea = container.querySelector('textarea');
    const onTextareaFocus = () => setIsFocused(true);
    const onTextareaBlur = () => setIsFocused(false);
    if (textarea) {
      textarea.addEventListener('focus', onTextareaFocus);
      textarea.addEventListener('blur', onTextareaBlur);
    }

    // Listen for terminal title changes to detect agent's status
    // Claude Code updates the terminal title with icons:
    // - Dot (· char ~10242/10256) when thinking/processing
    // - Star (* char ~10035) when done/waiting for input
    term.onTitleChange((title) => {
      // Forward the display title (strip leading status icon if present)
      const displayTitle = sanitizeTerminalTitle(title);
      // Skip UUIDs and empty titles — these come from session naming, not user-facing content
      if (
        displayTitle &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(displayTitle)
      ) {
        onTitleChangeRef.current?.(displayTitle);
      }

      if (agent.supportsStatusDetection) {
        let status: AgentStatus = 'idle';

        // Check first character code to detect status
        const firstCharCode = title.charCodeAt(0);

        // Dot variants (thinking/processing) - char codes around 10242, 10256, or literal dot
        if (
          firstCharCode === 10242 ||
          firstCharCode === 10256 ||
          firstCharCode === 183 ||
          title.startsWith('·') ||
          title.startsWith('•')
        ) {
          status = 'thinking';
        }
        // Star variants (done/waiting) - char code 10035 or asterisk-like
        else if (
          firstCharCode === 10035 ||
          title.startsWith('*') ||
          title.startsWith('✳') ||
          title.startsWith('✱') ||
          title.startsWith('✲')
        ) {
          status = 'waiting';
        }

        // Only fire callback if status actually changed
        if (status !== lastStatusRef.current) {
          lastStatusRef.current = status;
          onStatusChangeRef.current?.(status, title);
        }
      }
    });

    // For agents that don't support title-based status detection,
    // listen for OSC 9 (desktop notification) sequences instead.
    // Codex emits OSC 9 when the agent finishes a turn.
    if (!agent.supportsStatusDetection) {
      term.parser.registerOscHandler(9, (_data: string) => {
        // Treat OSC 9 as a "finished processing" signal — equivalent to
        // the thinking→waiting transition used for title-based detection.
        if (lastStatusRef.current !== 'waiting') {
          lastStatusRef.current = 'waiting';
          onStatusChangeRef.current?.('waiting', '');
        }
        return true;
      });
    }

    // Track if this effect instance is still mounted (handles StrictMode/HMR)
    let mounted = true;
    // Start pessimistic. We'll flip to true below only if the on-disk
    // Claude session file actually exists — otherwise `--resume` exits 1
    // ("No conversation found") every time, wasting a full Claude spawn
    // per project open. Gating on disk-presence turns a ~1s miss into a
    // ~5ms file-exists check.
    let attemptResume = false;
    // One automatic respawn per mount for the spawned-but-silent case
    // (issue #158). Distinct from `maxRetries` (the spawn call threw) and
    // the resume-failed retry (the process exited) — this covers a PTY
    // that opened fine but never wrote a byte.
    let autoRespawnUsed = false;
    // Latest startup-watchdog / respawn-delay timers, cleared on unmount.
    let startupTimer: ReturnType<typeof setTimeout> | null = null;
    let respawnTimer: ReturnType<typeof setTimeout> | null = null;

    // Open (or re-attach to) the backend PTY session for this tab.
    // `retryCount` is used by the resume-failed-then-retry-fresh path.
    const setupPty = async (retryCount = 0) => {
      const maxRetries = 3;

      // Check if still mounted before proceeding
      if (!mounted) {
        logger.info('[Terminal] PTY setup skipped - component unmounted', { agent: agent.id });
        return;
      }

      logger.info('[Terminal] Setting up PTY', {
        agent: agent.id,
        binary: agent.binaryName,
        projectPath,
        retry: retryCount,
      });

      try {
        // Gate the optimistic resume on whether Claude CLI actually has a
        // conversation stored for this (projectPath, sessionId). Cheap
        // filesystem check; only runs on the first setupPty call (retry=0)
        // because a retry can't turn a missing session into an existing one.
        if (retryCount === 0 && shouldResume && agent.id === 'claude-code' && sessionName) {
          try {
            const exists = await invoke<boolean>('claude_session_exists', {
              projectPath,
              sessionId: sessionName,
            });
            attemptResume = exists;
          } catch {
            // If the check itself fails, fall through to fresh — safer
            // than attempting a resume we can't verify.
            attemptResume = false;
          }
        }

        // Fit again to ensure correct size
        fitAddon.fit();

        // If terminal has zero dimensions, wait for it to become visible
        if (term.cols <= 1 || term.rows <= 1) {
          logger.warn('[Terminal] Zero dimensions at spawn time, waiting for resize', {
            cols: term.cols,
            rows: term.rows,
          });
          await new Promise<void>((resolve) => {
            const checkSize = () => {
              fitAddon.fit();
              if (term.cols > 1 && term.rows > 1) {
                resolve();
              } else {
                setTimeout(checkSize, 100);
              }
            };
            setTimeout(checkSize, 100);
            // Safety timeout - proceed anyway after 3s
            setTimeout(resolve, 3000);
          });
          logger.info('[Terminal] Dimensions ready', { cols: term.cols, rows: term.rows });
        }

        // Get extended PATH from backend (includes nvm, Claude desktop app, etc.)
        const home = await homeDir();
        const isWin = isWindows();
        const sep = isWin ? '\\' : '/';
        const homeNormalized = home.endsWith(sep) ? home : `${home}${sep}`;
        const fullPath = await getShellPath();

        // Build platform-appropriate env vars
        // Must pass all essential env vars since env replaces (not merges with) parent environment
        let env: Record<string, string>;
        if (isWin) {
          // Windows: get system env vars from backend and merge with PATH
          const systemEnv = await getSystemEnv();
          env = {
            ...systemEnv,
            PATH: fullPath,
            TERM: 'xterm-256color',
          };
        } else {
          env = {
            PATH: fullPath,
            HOME: homeNormalized.slice(0, -1),
            USER: homeNormalized.split('/').filter(Boolean).pop() || 'user',
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            SHELL: '/bin/zsh',
          };
        }
        // Per-workspace isolation vars (CLAUDE_CONFIG_DIR, GH_CONFIG_DIR,
        // CODEX_HOME, XDG_DATA_HOME) and credential tokens are injected
        // SERVER-SIDE by `pty_session_open` from this project's workspace, so
        // secret token values never have to cross into the webview's JS. Nothing
        // to fetch or merge here — just pass `projectPath` (below) and the
        // backend resolves the right Workspace env.

        // The PTY merges this env over the app's own, so npm/pnpm "invocation
        // directory" vars leak through when Ship Studio runs under `pnpm tauri
        // dev`. Tools the agent runs (e.g. `shopify theme dev`) trust INIT_CWD
        // over process.cwd() and resolve paths against the wrong directory —
        // pin both to where this terminal actually runs.
        env.INIT_CWD = projectPath;
        env.PNPM_SCRIPT_SRC_DIR = projectPath;

        const agentArgs: string[] = [];

        // Session persistence for Claude Code: assign a fixed session ID per tab
        // so we can resume the exact conversation when the project is reopened
        if (agent.id === 'claude-code' && sessionName) {
          if (attemptResume) {
            agentArgs.push('--resume', sessionName);
          } else {
            agentArgs.push('--session-id', sessionName);
          }
          logger.info('[Terminal] Session config', {
            sessionId: sessionName,
            resuming: attemptResume,
          });
        }

        // When autoAcceptMode is enabled, pass the agent's auto-accept flag.
        // Read from the ref so the setup effect doesn't depend on the scalar.
        if (autoAcceptModeRef.current && agent.autoAcceptFlag) {
          agentArgs.push(agent.autoAcceptFlag);
        }

        // Attached libraries: ride the user's registered cross-project library
        // folders into this session via the agent's additional-directory flag
        // (Claude Code: `--add-dir`). Their skills load and files are readable,
        // but their CLAUDE.md is not loaded, so they can't override the project.
        // Only agents that expose such a flag opt in; the rest are a no-op.
        // Best-effort: a failure to read the registry must never block the
        // agent from starting, so we log and continue.
        if (agent.additionalDirFlag) {
          try {
            const libraryDirs = await attachedLibraryDirs();
            for (const dir of libraryDirs) {
              agentArgs.push(agent.additionalDirFlag, dir);
            }
          } catch (err) {
            logger.warn('[Terminal] Failed to load attached libraries', {
              agent: agent.id,
              error: String(err),
            });
          }
        }

        // Placeholder — on Windows the real spawn shape (direct vs. wrapped
        // in cmd.exe /C) is decided AFTER binary resolution below, because
        // the decision depends on what the command resolves to (.cmd shim vs.
        // real executable). See needsCmdExeWrapper in lib/setup.ts.
        let spawnCmd = agent.binaryName;
        let spawnArgs = agentArgs;

        // Resolve the bare binary name through the backend's thorough
        // discovery (every NVM version, ~/.<agent>/bin, npm prefix -g …) the
        // way OnboardingTerminal already does. The hand-built PATH above is a
        // subset of what the status checks search, so "installed ✓ but Unable
        // to spawn claude" was possible (issue #280). Resolution errors fail
        // OPEN — the spawn proceeds with the bare name as before.
        //
        // Guard: only bare names go to the resolver. The raw Terminal tab's
        // "binary" is an absolute path (/bin/zsh), which the backend rejects
        // with a validation error on every open (issue #303).
        const isBareName = !agent.binaryName.includes('/') && !agent.binaryName.includes('\\');
        let resolved: ResolvedCli | null | undefined;
        if (isBareName) {
          try {
            resolved = await resolveCliPath(agent.binaryName);
            if (resolved) {
              const pathSep = isWin ? ';' : ':';
              if (!env.PATH.split(pathSep).includes(resolved.dir)) {
                env.PATH = `${env.PATH}${pathSep}${resolved.dir}`;
              }
              if (!isWin) {
                // Spawn the resolved absolute path — deterministic, no PATH
                // shadowing. (The Windows equivalent happens in the
                // spawn-shape block below, where wrapper-vs-direct is
                // decided.)
                spawnCmd = resolved.path;
              }
            }
          } catch (err) {
            resolved = undefined;
            logger.warn('[Terminal] resolveCliPath failed — spawning bare name', {
              binary: agent.binaryName,
              error: String(err),
            });
          }
        }

        if (isWin) {
          // Windows spawn shape, same rule OnboardingTerminal already uses.
          // Only .cmd/.bat shims need `cmd.exe /C` — they are batch scripts.
          // Routing a REAL executable through cmd.exe adds a second parse
          // layer (portable_pty composes one command line, then cmd re-parses
          // it with its own quote rules) between us and the agent, which is
          // what split a single `--session-id`/`--add-dir` value into several
          // tokens and made Claude Code exit with "too many arguments"
          // (issue #797). Unresolved names still wrap — needsCmdExeWrapper's
          // conservative default — so nothing regresses when resolution
          // fails open.
          if (needsCmdExeWrapper(agent.binaryName, resolved?.path)) {
            spawnCmd = 'cmd.exe';
            spawnArgs = ['/C', agent.binaryName, ...agentArgs];
          } else {
            // Prefer the resolved absolute path (deterministic, no PATH
            // shadowing); fall back to the bare name on the extended PATH
            // when resolution failed open.
            spawnCmd = resolved?.path ?? agent.binaryName;
            spawnArgs = agentArgs;
          }
        }

        // The backend session id is the tab's sessionName UUID — it survives
        // component unmount/remount and project switches, so attach is
        // idempotent. `openPtySession` is a no-op if the session is already
        // alive; it evicts-and-respawns if a previous run exited (retry
        // path below). `attachPtySession` (called after subscribing, below)
        // returns the ring-buffer tail for xterm to replay plus the offset
        // the live stream is de-duplicated against.
        const backendSessionId = sessionName || `tab-${Date.now()}`;
        // Clamp dimensions: the zero-guard above gives up after 3s and can
        // reach this point with cols/rows ≤ 1, and a 0-size ConPTY produces
        // no output at all on Windows (issue #156). The backend clamps too;
        // this keeps xterm and the PTY in agreement.
        const opened = await openPtySession({
          sessionId: backendSessionId,
          command: spawnCmd,
          args: spawnArgs,
          cwd: projectPath,
          env,
          cols: Math.max(term.cols, 2),
          rows: Math.max(term.rows, 2),
          projectPath,
          tabSessionId: sessionName ?? null,
        });

        if (!mounted) {
          // Unmounted mid-open — leave the PTY alive for the next mount
          // to attach to. It'll be reaped on explicit close or app quit.
          return;
        }

        ptyRef.current = { sessionId: backendSessionId, pid: opened.pid };
        logger.info('[Terminal] PTY session opened', {
          agent: agent.id,
          sessionId: backendSessionId,
          pid: opened.pid,
        });
        onSpawnRef.current?.(opened.pid);

        // Subscribe BEFORE attaching. Tauri drops events that fire with no
        // registered listener, so the old attach-then-subscribe order lost
        // any chunk emitted between the attach snapshot and the
        // subscription going live — for a single-paint TUI (Codex) that
        // could be its only paint, leaving the tab stuck on the loading
        // message forever (issue #156). With subscribe-first, every byte is
        // either in the snapshot or delivered as an event; the offset gate
        // below drops the overlap exactly.

        // Set once any live PTY event arrives for this spawn — the process
        // demonstrably produced output even if the chunk itself is dropped
        // as snapshot-covered. (The replayed attach snapshot does NOT count
        // as output, matching the pre-gate behavior.)
        let receivedOutput = false;
        // Startup watchdog handle — armed after the snapshot replay below.
        let startupTimeout: ReturnType<typeof setTimeout> | null = null;

        // Buffer early output to detect resume failures on exit
        let outputBuffer = '';

        // Stream PTY data directly into xterm, even when the wrapper is
        // visibility-hidden. xterm needs to process the byte stream (not
        // just when visible) so `term.onTitleChange` fires for background
        // tabs — that's what drives the agent-done sound + green-label
        // notification while the user is on another project.
        const writeToTerminal = (data: string | Uint8Array | number[]) => {
          const normalized = Array.isArray(data) ? new Uint8Array(data) : data;
          terminalRef.current?.write(normalized);
        };

        // Store disposables so cleanup() can remove IPC listeners and prevent CPU leak.
        const pushDisposable = (unlisten: UnlistenFn) => {
          ptyDisposablesRef.current.push({ dispose: () => unlisten() });
        };

        // Gate: queues live chunks until the attach snapshot is written,
        // then flushes only the chunks the snapshot doesn't already cover.
        // For agents without title-based detection it also drives
        // idle-detection: when output stops flowing for 1.5s after
        // "thinking", transition to "waiting".
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const gate = createAttachGate((bytes) => {
          if (outputBuffer.length < 2000) {
            outputBuffer += new TextDecoder().decode(bytes);
          }
          writeToTerminal(bytes);
          if (!agent.supportsStatusDetection && lastStatusRef.current === 'thinking') {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              if (lastStatusRef.current === 'thinking') {
                lastStatusRef.current = 'waiting';
                onStatusChangeRef.current?.('waiting', '');
              }
            }, 1500);
          }
        });

        // Handle PTY output -> terminal (through the gate).
        const unlistenData = await onPtySessionData(backendSessionId, (bytes, offset) => {
          receivedOutput = true;
          if (startupTimeout) clearTimeout(startupTimeout);
          gate.push(offset, bytes);
        });
        pushDisposable(unlistenData);

        // Handle PTY exit — subscribe to the backend event stream. An exit
        // that fires before the snapshot replay is parked so the
        // "[Process exited]" prompt can't render above the scrollback it
        // belongs after.
        let gateOpen = false;
        let pendingExit: number | null = null;
        let exitEventSeen = false;

        const handleExit = (exitCode: number) => {
          if (startupTimeout) clearTimeout(startupTimeout);
          logger.info('[Terminal] PTY process exited', {
            agent: agent.id,
            exitCode,
            receivedOutput,
            outputBufferLen: outputBuffer.length,
            outputSnippet: outputBuffer.slice(0, 200),
          });

          const retryFreshSession = () => {
            logger.info('[Terminal] Resume failed, retrying as fresh session');
            terminalRef.current?.write(
              '\r\n\x1b[33mSession not found, starting fresh...\x1b[0m\r\n'
            );
            // Clean up current PTY
            for (const d of ptyDisposablesRef.current) {
              try {
                d.dispose();
              } catch {
                /* ignore */
              }
            }
            ptyDisposablesRef.current = [];
            ptyRef.current = null;
            // Retry without --resume
            attemptResume = false;
            void setupPty(0);
          };

          // If resume failed, retry as a fresh session.
          // Primary signal: non-zero exit code during a resume attempt means
          // the session is gone — retry without parsing output at all.
          // Secondary signal: output contains "no conversation found" etc.
          if (attemptResume && agent.id === 'claude-code') {
            if (exitCode !== 0) {
              logger.info('[Terminal] Resume exited non-zero, retrying fresh', { exitCode });
              retryFreshSession();
              return;
            }

            // Zero exit code but might still be a resume failure (edge case).
            // Strip ANSI escape sequences before matching.
            // Strip ANSI escape sequences so substring matching works on raw PTY output.
            // Uses a single combined pattern to avoid chained .replace type issues.
            const ansiPattern = new RegExp(
              [
                String.fromCharCode(0x1b) + '\\[[\\x20-\\x3f]*[\\x40-\\x7e]', // CSI
                String.fromCharCode(0x1b) +
                  '\\][^' +
                  String.fromCharCode(0x07) +
                  ']*(?:' +
                  String.fromCharCode(0x07) +
                  '|' +
                  String.fromCharCode(0x1b) +
                  '\\\\)', // OSC
                String.fromCharCode(0x1b) + '[^\\[\\]]', // other ESC
              ].join('|'),
              'g'
            );
            const stripAnsi = (s: string): string => s.replace(ansiPattern, '');
            const isResumeFail = () => {
              const clean = stripAnsi(outputBuffer).toLowerCase();
              return clean.includes('no conversation found') || clean.includes('session not found');
            };

            if (isResumeFail()) {
              retryFreshSession();
              return;
            }
            // Data may arrive after exit event — wait briefly and check again
            setTimeout(() => {
              if (isResumeFail()) {
                retryFreshSession();
              } else {
                offerRestart();
                onExitRef.current?.(exitCode);
              }
            }, 200);
            return;
          }

          offerRestart();
          onExitRef.current?.(exitCode);
        };

        const unlistenExit = await onPtySessionExit(backendSessionId, (exitCode) => {
          exitEventSeen = true;
          if (!gateOpen) {
            pendingExit = exitCode;
            return;
          }
          handleExit(exitCode);
        });
        pushDisposable(unlistenExit);

        const attach = await attachPtySession(backendSessionId);
        if (!mounted) return;
        if (attach.buffer.length > 0) {
          // Replay ring-buffer tail so a newly-attached xterm shows prior
          // output (critical for project switches back to a background tab).
          terminalRef.current?.write(attach.buffer);
        }
        // Open the gate: flush queued live chunks, dropping the ones the
        // snapshot already covers (offset < endOffset).
        gateOpen = true;
        gate.open(attach.endOffset);

        // Startup watchdog: if no output is received within the startup
        // window, the agent likely failed to launch (binary not found,
        // permission error, or a wedged first spawn — issue #158). The manual
        // fix users found is "create a new agent tab", i.e. a fresh PTY — so
        // kill the silent session and respawn once with the same config. Only
        // if the respawn is also silent do we surface the error text. Policy
        // and timings are shared with the onboarding terminal (startupWatchdog.ts).
        startupTimeout = setTimeout(() => {
          const action = decideStartupTimeoutAction({ receivedOutput, mounted, autoRespawnUsed });
          if (action === 'none') return;

          if (action === 'respawn') {
            autoRespawnUsed = true;
            logger.warn('[Terminal] No output after 10s - killing silent PTY and respawning', {
              agent: agent.id,
              binary: agent.binaryName,
              sessionId: backendSessionId,
            });
            terminalRef.current?.write(
              `\r\n\x1b[33mNo output — restarting ${agent.displayName}…\x1b[0m\r\n`
            );
            // Unsubscribe from the silent session BEFORE killing it so the
            // kill-induced exit event can't trigger the "[Process exited]"
            // prompt or the resume-retry path.
            for (const d of ptyDisposablesRef.current) {
              try {
                d.dispose();
              } catch {
                /* ignore */
              }
            }
            ptyDisposablesRef.current = [];
            ptyRef.current = null;
            void killPtySession(backendSessionId)
              .catch(() => {
                /* already dead — open will spawn fresh either way */
              })
              .then(() => {
                // Grace period so the killed PTY's exit event (same session
                // id) is delivered before the respawned run subscribes —
                // otherwise it would look like the new process exiting.
                respawnTimer = setTimeout(() => {
                  if (mounted) void setupPty(0);
                }, RESPAWN_GRACE_MS);
              });
            return;
          }

          logger.error('[Terminal] Startup timeout - no output after 10s', {
            agent: agent.id,
            binary: agent.binaryName,
          });
          terminalRef.current?.write(
            `\r\n\x1b[31m${agent.displayName} did not produce any output after 10 seconds.\x1b[0m\r\n` +
              `\x1b[33mThe process may have failed to start. Check that "${agent.binaryName}" is installed and accessible.\x1b[0m\r\n`
          );
        }, STARTUP_TIMEOUT_MS);
        startupTimer = startupTimeout;

        if (pendingExit !== null) {
          // The process exited while the snapshot was in flight — run the
          // full exit path now that the scrollback is on screen.
          handleExit(pendingExit);
        } else if (!attach.alive && !exitEventSeen) {
          // Session already exited before we subscribed (the exit event
          // predates this attach cycle and was dropped by Tauri). Treat as
          // a normal exit so the retry-on-resume-fail path can kick in.
          onExitRef.current?.(attach.exitCode ?? -1);
        }

        // Handle terminal input -> PTY. Resolves the session id lazily
        // from the ref so re-attach doesn't need a new listener.
        const inputDisposable = term.onData((data) => {
          // After the agent exits the PTY is dead — don't pipe keystrokes
          // into it. Enter relaunches; everything else is ignored so a
          // stray keypress can't look like it's being swallowed silently.
          if (exitedRef.current) {
            if (data.includes('\r') && !restartRequestedRef.current) {
              restartRequestedRef.current = true;
              onRequestRestartRef.current?.();
            }
            return;
          }
          const sid = ptyRef.current?.sessionId;
          if (sid) writePtySessionLogged(sid, data);
          // When user sends input to an agent without title-based status detection,
          // assume it transitions to "thinking" (processing the request).
          if (!agent.supportsStatusDetection && data.includes('\r')) {
            if (lastStatusRef.current !== 'thinking') {
              lastStatusRef.current = 'thinking';
              onStatusChangeRef.current?.('thinking', '');
            }
          }
        });
        ptyDisposablesRef.current.push(inputDisposable);

        // Handle special key combinations
        term.attachCustomKeyEventHandler((event) => {
          // Ctrl+C with selection: copy to clipboard instead of sending SIGINT
          if (event.key === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey) {
            const selection = term.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection).catch((err: unknown) => {
                logger.warn('[Terminal] Failed to copy selection to clipboard', {
                  error: formatCommandError(asCommandError(err)),
                });
              });
              term.clearSelection();
              return false;
            }
          }
          // Shift+Enter: insert newline instead of submitting
          if (event.key === 'Enter' && event.shiftKey) {
            if (event.type === 'keydown') {
              // Send a literal newline character (Ctrl+J / Line Feed)
              // This tells Claude Code to continue on a new line without submitting
              const sid = ptyRef.current?.sessionId;
              if (sid) writePtySessionLogged(sid, '\n');
            }
            // Prevent both keydown and keypress from being processed
            event.preventDefault();
            event.stopPropagation();
            return false;
          }
          // Windows-only: Ctrl+V paste via the native clipboard. WebView2
          // gates keyboard-initiated textarea paste behind an async clipboard
          // permission wait (~30s or never — issue #157), so we read the
          // clipboard natively and feed xterm directly. Also enables pasting
          // a clipboard image (screenshot): it's staged to a temp PNG and the
          // quoted path is pasted, like drag-drop. macOS is deliberately NOT
          // intercepted: Cmd+V default paste works there, and Ctrl+V must
          // keep sending 0x16 to the PTY — Claude Code uses it for its own
          // image paste.
          if (isWindows() && isPasteChord(event)) {
            event.preventDefault();
            event.stopPropagation();
            void (async () => {
              try {
                const text = await readClipboardText();
                if (text) {
                  term.focus();
                  term.paste(text);
                  return;
                }
                const imagePath = await stageClipboardImage();
                if (imagePath) {
                  // Quote paths that contain spaces (same as drag-drop above);
                  // trailing space separates the path from what's typed next.
                  const quotedPath = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
                  term.focus();
                  term.paste(`${quotedPath} `);
                }
              } catch (err) {
                logger.warn('[Terminal] Native clipboard paste failed', {
                  error: formatCommandError(asCommandError(err)),
                });
                // Best-effort fallback to the browser clipboard (may be slow
                // on WebView2, but better than dropping the paste entirely).
                try {
                  const fallback = await navigator.clipboard.readText();
                  if (fallback) {
                    term.focus();
                    term.paste(fallback);
                  }
                } catch {
                  // Never throw from a key handler.
                }
              }
            })();
            return false;
          }
          return true; // Allow all other keys
        });
      } catch (err) {
        const spawnError = formatCommandError(asCommandError(err));
        // The backend classifies "agent binary can't be resolved" spawn
        // failures as Expected (issue #329), but Expected serializes across
        // IPC identically to Other, so re-check the same message patterns
        // pty_session_open recognizes. The user already gets the friendly
        // notFoundMessage/installHint below — logger.error would additionally
        // file a bug report for a machine that simply lacks the CLI (#522).
        const lower = spawnError.toLowerCase();
        const binaryNotFound =
          lower.includes('no viable candidates found in path') ||
          lower.includes('does not exist') ||
          lower.includes('not executable');
        // The second Expected spawn shape: the machine is transiently out of
        // process slots / file descriptors (issues #587, #772).
        const expectedSpawnFailure = binaryNotFound || isResourcePressureError(err);
        logger[expectedSpawnFailure ? 'warn' : 'error']('[Terminal] Failed to spawn PTY', {
          agent: agent.id,
          binary: agent.binaryName,
          error: spawnError,
          retry: retryCount,
        });

        if (!mounted) return;

        if (retryCount < maxRetries) {
          term.write(
            `\x1b[33mFailed to start ${agent.displayName}, retrying (${retryCount + 1}/${maxRetries})...\x1b[0m\r\n`
          );
          setTimeout(() => void setupPty(retryCount + 1), 1000);
        } else {
          term.write(`\x1b[31m${agent.notFoundMessage}: ${spawnError}\x1b[0m\r\n`);
          term.write(`\x1b[33m${agent.installHint}\x1b[0m\r\n`);
        }
      }
    };

    // Print "[Process exited]" plus an inline hint that the tab can be
    // relaunched. The actual relaunch is parent-driven (fresh session), so
    // the user can toggle Auto-accept (--dangerously-skip-permissions) and
    // then restart into it without closing the tab.
    const offerRestart = () => {
      exitedRef.current = true;
      restartRequestedRef.current = false;
      terminalRef.current?.write(
        `\r\n\x1b[2m[Process exited] — press \x1b[0m\x1b[1mEnter\x1b[0m\x1b[2m to restart ${agent.displayName}\x1b[0m\r\n`
      );
    };

    // Show a loading message while agent starts up
    term.write(`\r\n  \x1b[2m${agent.loadingMessage}\x1b[0m`);

    // Spawn eagerly — the PTY read loop lives in Rust, so there's no
    // per-tab IPC polling to multiply across background sessions. We
    // *want* background agents running, not waiting on the user to focus.
    setTimeout(() => void setupPty(), 100);

    // Handle resize — debounce with rAF to avoid layout thrashing during drags/animations
    let resizeRaf: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        if (fitAddonRef.current && terminalRef.current && ptyRef.current) {
          fitAddonRef.current.fit();
          const { sessionId } = ptyRef.current;
          resizePtySessionLogged(sessionId, terminalRef.current.cols, terminalRef.current.rows);
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      mounted = false;
      webglTornDown = true;
      disposeWebgl?.();
      resizeObserver.disconnect();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (startupTimer) clearTimeout(startupTimer);
      if (respawnTimer) clearTimeout(respawnTimer);
      if (textarea) {
        textarea.removeEventListener('focus', onTextareaFocus);
        textarea.removeEventListener('blur', onTextareaBlur);
      }
      cleanup();
    };
    // `autoAcceptMode` is intentionally omitted — it's read from
    // `autoAcceptModeRef.current` at spawn time, and changing it must not
    // tear down an existing PTY (it's a CLI flag baked in at spawn).
  }, [isReady, projectPath, cleanup, agent, sessionName, shouldResume]);

  // Click to focus terminal
  const handleClick = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Handle drag over to allow drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Handle file drop - write file path to terminal (fallback for React drag events)
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Main drop handling is done via Tauri's drag-drop event listener
  }, []);

  // Expose methods to parent
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        terminalRef.current?.focus();
        containerRef.current?.focus();
        const textarea = containerRef.current?.querySelector('textarea');
        textarea?.focus();
      },
      write: (data: string) => {
        const sid = ptyRef.current?.sessionId;
        if (sid) writePtySessionLogged(sid, data);
      },
      paste: (data: string) => {
        if (terminalRef.current) {
          terminalRef.current.focus();
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
          (terminalRef.current as any).paste(data);
        }
      },
      kill: () => {
        // Imperative kill — used by `closeAllTerminalsForProject` and the
        // close-tab path. Tell the backend to reap the PTY, then let
        // cleanup unsubscribe and dispose xterm.
        const sid = ptyRef.current?.sessionId;
        if (sid) void killPtySession(sid);
        cleanup();
      },
      isExited: () => exitedRef.current,
      fit: () => {
        if (fitAddonRef.current && terminalRef.current && ptyRef.current) {
          fitAddonRef.current.fit();
          const { sessionId } = ptyRef.current;
          resizePtySessionLogged(sessionId, terminalRef.current.cols, terminalRef.current.rows);
        }
      },
    }),
    [cleanup]
  );

  return (
    <div
      className={`terminal-instance ${isFocused ? 'is-focused' : 'is-unfocused'}`}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        className="terminal-instance-container"
        ref={containerRef}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#141414',
          filter: isFocused ? 'none' : 'grayscale(100%)',
          transition: 'filter 150ms ease-in-out',
        }}
      />
      {/* Loading indicator while terminal is initializing */}
      {!isReady && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#141414',
            color: '#666666',
            fontFamily: 'var(--font-code)',
            fontSize: 13,
          }}
        >
          Loading...
        </div>
      )}
      {/* Dimming overlay when terminal is not focused */}
      <div
        onClick={handleClick}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(30, 30, 30, 0.4)',
          pointerEvents: isFocused ? 'none' : 'auto',
          opacity: isFocused ? 0 : 1,
          transition: 'opacity 150ms ease-in-out',
          cursor: 'text',
        }}
      />
    </div>
  );
});
