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
import { createWebLinksAddon } from '../lib/terminalLinks';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  openPtySession,
  attachPtySession,
  writePtySession,
  resizePtySession,
  killPtySession,
  onPtySessionData,
  onPtySessionExit,
} from '../lib/ptySession';
import type { UnlistenFn } from '@tauri-apps/api/event';

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
import { loadNerdFonts } from '../lib/fonts';
import { isWindows } from '../lib/setup';
import { logger } from '../lib/logger';
import { getTerminalGpuEnabled } from '../lib/settings';
import type { AgentConfig } from '../lib/agent';
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
  const [isReady, setIsReady] = useState(false);
  const [isFocused, setIsFocused] = useState(false); // Start unfocused to show overlay until user clicks

  // Mirror `isActive` to a ref so non-effect closures (input handler,
  // resize observer) can read it without re-creating.
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Use refs for callbacks to prevent effect re-runs when callback references change
  const onExitRef = useRef(onExit);
  const onSpawnRef = useRef(onSpawn);
  const onStatusChangeRef = useRef(onStatusChange);
  const onTitleChangeRef = useRef(onTitleChange);
  const lastStatusRef = useRef<AgentStatus>('idle');
  useEffect(() => {
    onExitRef.current = onExit;
    onSpawnRef.current = onSpawn;
    onStatusChangeRef.current = onStatusChange;
    onTitleChangeRef.current = onTitleChange;
  }, [onExit, onSpawn, onStatusChange, onTitleChange]);

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
              error: String(err),
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
      // Listen for the tauri://drag-drop event
      const unlistenFn = await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-drop',
        (event) => {
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
      fontFamily: '"JetBrainsMono NF", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
        selectionBackground: '#3a3d41',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      },
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
    void (async () => {
      const gpuEnabled = await getTerminalGpuEnabled();
      if (!gpuEnabled) {
        logger.info('[Terminal] GPU rendering disabled by user, using canvas renderer');
        return;
      }
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        term.loadAddon(webglAddon);
      } catch {
        logger.warn('[Terminal] WebGL not available, using canvas renderer');
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
      const displayTitle = title.replace(/^[·•✳✱✲*\u2802\u2810\u00B7]\s*/, '').trim();
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
        const fullPath = await invoke<string>('get_shell_path');

        // Build platform-appropriate env vars
        // Must pass all essential env vars since env replaces (not merges with) parent environment
        let env: Record<string, string>;
        if (isWin) {
          // Windows: get system env vars from backend and merge with PATH
          const systemEnv = await invoke<Record<string, string>>('get_system_env');
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

        // On Windows, agent may be a .cmd script - must run through cmd.exe
        const spawnCmd = isWin ? 'cmd.exe' : agent.binaryName;
        const spawnArgs = isWin ? ['/C', agent.binaryName, ...agentArgs] : agentArgs;

        // The backend session id is the tab's sessionName UUID — it survives
        // component unmount/remount and project switches, so attach is
        // idempotent. `openPtySession` is a no-op if the session is already
        // alive; it evicts-and-respawns if a previous run exited (retry
        // path below). `attachPtySession` returns the ring-buffer tail for
        // xterm to replay before the live stream takes over.
        const backendSessionId = sessionName || `tab-${Date.now()}`;
        const opened = await openPtySession({
          sessionId: backendSessionId,
          command: spawnCmd,
          args: spawnArgs,
          cwd: projectPath,
          env,
          cols: term.cols,
          rows: term.rows,
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

        const attach = await attachPtySession(backendSessionId);
        if (!mounted) return;
        if (attach.buffer.length > 0) {
          // Replay ring-buffer tail so a newly-attached xterm shows prior
          // output (critical for project switches back to a background tab).
          terminalRef.current?.write(attach.buffer);
        }
        if (!attach.alive) {
          // Session already exited between open and attach. Treat as a
          // normal exit so the retry-on-resume-fail path can kick in.
          onExitRef.current?.(attach.exitCode ?? -1);
        }

        // Startup timeout: if no output is received within 10s, the agent
        // likely failed to launch (binary not found, permission error, etc.).
        // Show an error instead of hanging on "Starting..." forever.
        let receivedOutput = false;
        const startupTimeout = setTimeout(() => {
          if (!receivedOutput && mounted) {
            logger.error('[Terminal] Startup timeout - no output after 10s', {
              agent: agent.id,
              binary: agent.binaryName,
            });
            terminalRef.current?.write(
              `\r\n\x1b[31m${agent.displayName} did not produce any output after 10 seconds.\x1b[0m\r\n` +
                `\x1b[33mThe process may have failed to start. Check that "${agent.binaryName}" is installed and accessible.\x1b[0m\r\n`
            );
          }
        }, 10_000);

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

        // Handle PTY output -> terminal
        // Store disposables so cleanup() can remove IPC listeners and prevent CPU leak.
        // For agents without title-based detection, add idle-detection:
        // when output stops flowing for 1.5s after "thinking" state, transition to "waiting".
        const pushDisposable = (unlisten: UnlistenFn) => {
          ptyDisposablesRef.current.push({ dispose: () => unlisten() });
        };

        if (!agent.supportsStatusDetection) {
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const unlistenData = await onPtySessionData(backendSessionId, (bytes) => {
            receivedOutput = true;
            if (outputBuffer.length < 2000) {
              outputBuffer += new TextDecoder().decode(bytes);
            }
            clearTimeout(startupTimeout);
            writeToTerminal(bytes);
            if (lastStatusRef.current === 'thinking') {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                if (lastStatusRef.current === 'thinking') {
                  lastStatusRef.current = 'waiting';
                  onStatusChangeRef.current?.('waiting', '');
                }
              }, 1500);
            }
          });
          pushDisposable(unlistenData);
        } else {
          const unlistenData = await onPtySessionData(backendSessionId, (bytes) => {
            receivedOutput = true;
            if (outputBuffer.length < 2000) {
              outputBuffer += new TextDecoder().decode(bytes);
            }
            clearTimeout(startupTimeout);
            writeToTerminal(bytes);
          });
          pushDisposable(unlistenData);
        }

        // Handle PTY exit — subscribe to the backend event stream.
        const unlistenExit = await onPtySessionExit(backendSessionId, (exitCode) => {
          clearTimeout(startupTimeout);
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
                terminalRef.current?.write('\r\n[Process exited]\r\n');
                onExitRef.current?.(exitCode);
              }
            }, 200);
            return;
          }

          terminalRef.current?.write('\r\n[Process exited]\r\n');
          onExitRef.current?.(exitCode);
        });
        pushDisposable(unlistenExit);

        // Handle terminal input -> PTY. Resolves the session id lazily
        // from the ref so re-attach doesn't need a new listener.
        const inputDisposable = term.onData((data) => {
          const sid = ptyRef.current?.sessionId;
          if (sid) void writePtySession(sid, data);
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
                  error: String(err),
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
              if (sid) void writePtySession(sid, '\n');
            }
            // Prevent both keydown and keypress from being processed
            event.preventDefault();
            event.stopPropagation();
            return false;
          }
          return true; // Allow all other keys
        });
      } catch (err) {
        logger.error('[Terminal] Failed to spawn PTY', {
          agent: agent.id,
          binary: agent.binaryName,
          error: String(err),
          retry: retryCount,
        });

        if (!mounted) return;

        if (retryCount < maxRetries) {
          term.write(
            `\x1b[33mFailed to start ${agent.displayName}, retrying (${retryCount + 1}/${maxRetries})...\x1b[0m\r\n`
          );
          setTimeout(() => void setupPty(retryCount + 1), 1000);
        } else {
          term.write(`\x1b[31m${agent.notFoundMessage}: ${String(err)}\x1b[0m\r\n`);
          term.write(`\x1b[33m${agent.installHint}\x1b[0m\r\n`);
        }
      }
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
          void resizePtySession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      mounted = false;
      resizeObserver.disconnect();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
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
        if (sid) void writePtySession(sid, data);
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
      fit: () => {
        if (fitAddonRef.current && terminalRef.current && ptyRef.current) {
          fitAddonRef.current.fit();
          const { sessionId } = ptyRef.current;
          void resizePtySession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
        }
      },
    }),
    [cleanup]
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#1e1e1e',
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
            backgroundColor: '#1e1e1e',
            color: '#666666',
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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
