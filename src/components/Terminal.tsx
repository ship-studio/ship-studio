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
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { spawn, IPty } from 'tauri-pty';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { loadNerdFonts } from '../lib/fonts';
import { isWindows } from '../lib/setup';
import { logger } from '../lib/logger';
import type { AgentConfig } from '../lib/agent';
import '@xterm/xterm/css/xterm.css';

/** Agent status based on terminal title */
export type AgentStatus = 'thinking' | 'waiting' | 'idle';

/** Max buffer size for hidden terminal output (500KB) */
const MAX_HIDDEN_BUFFER = 512 * 1024;

/** Props for the Terminal component */
interface TerminalProps {
  /** Agent configuration to use for this terminal */
  agent: AgentConfig;
  /** Absolute path to the project directory where the agent will run */
  projectPath: string;
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
  const ptyRef = useRef<IPty | null>(null);
  // Buffer for data received while terminal is hidden
  const hiddenBufferRef = useRef<string[]>([]);
  const hiddenBufferSizeRef = useRef(0);
  const isActiveRef = useRef(isActive);
  // Deferred spawn: set by the main effect, called when tab becomes active
  const deferredSpawnRef = useRef<(() => void) | null>(null);
  // Track IDisposable handles from pty.onData/onExit so we can remove listeners on cleanup.
  // Without this, killed PTY processes continue flooding Tauri IPC → microtasks → 100% CPU.
  const ptyDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const [isReady, setIsReady] = useState(false);
  const [isFocused, setIsFocused] = useState(false); // Start unfocused to show overlay until user clicks

  // When tab becomes active: flush hidden buffer and spawn PTY if deferred
  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive) {
      // Flush buffered output
      if (terminalRef.current && hiddenBufferRef.current.length > 0) {
        for (const chunk of hiddenBufferRef.current) {
          terminalRef.current.write(chunk);
        }
        hiddenBufferRef.current = [];
        hiddenBufferSizeRef.current = 0;
      }
      // Spawn PTY if it was deferred (tab was created while hidden)
      if (deferredSpawnRef.current) {
        const spawn = deferredSpawnRef.current;
        deferredSpawnRef.current = null;
        spawn();
      }
    }
  }, [isActive]);

  // Use refs for callbacks to prevent effect re-runs when callback references change
  const onExitRef = useRef(onExit);
  const onStatusChangeRef = useRef(onStatusChange);
  const onTitleChangeRef = useRef(onTitleChange);
  const lastStatusRef = useRef<AgentStatus>('idle');
  useEffect(() => {
    onExitRef.current = onExit;
    onStatusChangeRef.current = onStatusChange;
    onTitleChangeRef.current = onTitleChange;
  }, [onExit, onStatusChange, onTitleChange]);

  const cleanup = useCallback(() => {
    // Dispose PTY event listeners FIRST to stop IPC message flood
    for (const d of ptyDisposablesRef.current) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    ptyDisposablesRef.current = [];

    if (ptyRef.current) {
      // Invalidate PID FIRST to break tauri-pty's infinite readData() loop
      // and prevent kill() from blocking. The backend's kill_window_pty
      // handles cleanup of any zombie processes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (ptyRef.current as any).pid = undefined;
      try {
        ptyRef.current.kill();
      } catch {
        // Ignore - PTY may already be dead
      }
      ptyRef.current = null;
    }

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
    term.unicode.activeVersion = '11';

    // Open terminal in container
    term.open(container);

    // Use WebGL renderer for GPU-accelerated rendering (reduces flickering)
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch {
      logger.warn('[Terminal] WebGL not available, using canvas renderer');
    }

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
    let attemptResume = !!shouldResume;

    // Setup PTY connection using tauri-pty with retry logic
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

        // When autoAcceptMode is enabled, pass the agent's auto-accept flag
        if (autoAcceptMode && agent.autoAcceptFlag) {
          agentArgs.push(agent.autoAcceptFlag);
        }

        // On Windows, agent may be a .cmd script - must run through cmd.exe
        const spawnCmd = isWin ? 'cmd.exe' : agent.binaryName;
        const spawnArgs = isWin ? ['/C', agent.binaryName, ...agentArgs] : agentArgs;

        // eslint-disable-next-line @typescript-eslint/await-thenable
        const pty = await spawn(spawnCmd, spawnArgs, {
          cwd: projectPath,
          cols: term.cols,
          rows: term.rows,
          env,
        });

        // Check again after async operation
        if (!mounted) {
          pty.kill();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
          (pty as any).pid = undefined;
          return;
        }

        ptyRef.current = pty;
        logger.info('[Terminal] PTY spawned successfully', { agent: agent.id });

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

        // Write data to xterm, or buffer it if the terminal is hidden.
        // Note: tauri-pty's read command returns Vec<u8> from Rust, which Tauri
        // serializes as a JSON number[]. We must convert to Uint8Array for both
        // xterm.write() and TextDecoder.decode() to work.
        const writeToTerminal = (data: string | Uint8Array | number[]) => {
          const normalized = Array.isArray(data) ? new Uint8Array(data) : data;
          if (isActiveRef.current) {
            terminalRef.current?.write(normalized);
          } else {
            const str =
              typeof normalized === 'string' ? normalized : new TextDecoder().decode(normalized);
            hiddenBufferRef.current.push(str);
            hiddenBufferSizeRef.current += str.length;
            // Cap buffer to prevent memory growth
            while (
              hiddenBufferSizeRef.current > MAX_HIDDEN_BUFFER &&
              hiddenBufferRef.current.length > 1
            ) {
              const removed = hiddenBufferRef.current.shift()!;
              hiddenBufferSizeRef.current -= removed.length;
            }
          }
        };

        // Handle PTY output -> terminal
        // Store disposables so cleanup() can remove IPC listeners and prevent CPU leak.
        // For agents without title-based detection, add idle-detection:
        // when output stops flowing for 1.5s after "thinking" state, transition to "waiting".
        if (!agent.supportsStatusDetection) {
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const dataDisposable = pty.onData((data) => {
            receivedOutput = true;
            if (outputBuffer.length < 2000) outputBuffer += String(data);
            clearTimeout(startupTimeout);
            writeToTerminal(data);
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
          ptyDisposablesRef.current.push(dataDisposable);
        } else {
          const dataDisposable = pty.onData((data) => {
            receivedOutput = true;
            if (outputBuffer.length < 2000) outputBuffer += String(data);
            clearTimeout(startupTimeout);
            writeToTerminal(data);
          });
          ptyDisposablesRef.current.push(dataDisposable);
        }

        // Handle PTY exit
        const exitDisposable = pty.onExit(({ exitCode }) => {
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
        ptyDisposablesRef.current.push(exitDisposable);

        // Handle terminal input -> PTY
        const inputDisposable = term.onData((data) => {
          ptyRef.current?.write(data);
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
              void navigator.clipboard.writeText(selection);
              term.clearSelection();
              return false;
            }
          }
          // Shift+Enter: insert newline instead of submitting
          if (event.key === 'Enter' && event.shiftKey) {
            if (event.type === 'keydown') {
              // Send a literal newline character (Ctrl+J / Line Feed)
              // This tells Claude Code to continue on a new line without submitting
              ptyRef.current?.write('\n');
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

    // Only spawn PTY when this tab is active to avoid IPC congestion
    // from multiple concurrent PTY read loops.
    // If hidden, defer until the tab becomes active.
    if (isActiveRef.current) {
      setTimeout(() => void setupPty(), 100);
    } else {
      deferredSpawnRef.current = () => setTimeout(() => void setupPty(), 100);
    }

    // Handle resize — debounce with rAF to avoid layout thrashing during drags/animations
    let resizeRaf: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        if (fitAddonRef.current && terminalRef.current && ptyRef.current) {
          fitAddonRef.current.fit();
          ptyRef.current.resize(terminalRef.current.cols, terminalRef.current.rows);
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
  }, [isReady, projectPath, cleanup, autoAcceptMode, agent, sessionName, shouldResume]);

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
        ptyRef.current?.write(data);
      },
      paste: (data: string) => {
        if (terminalRef.current) {
          terminalRef.current.focus();
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
          (terminalRef.current as any).paste(data);
        }
      },
      kill: () => {
        cleanup();
      },
      fit: () => {
        if (fitAddonRef.current && terminalRef.current && ptyRef.current) {
          fitAddonRef.current.fit();
          ptyRef.current.resize(terminalRef.current.cols, terminalRef.current.rows);
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
