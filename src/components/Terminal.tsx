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
import { spawn, IPty } from 'tauri-pty';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { loadNerdFonts } from '../lib/fonts';
import '@xterm/xterm/css/xterm.css';

/** Props for the Terminal component */
interface TerminalProps {
  /** Absolute path to the project directory where Claude Code will run */
  projectPath: string;
  /** Callback fired when the Claude Code process exits */
  onExit?: (code: number | null) => void;
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
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { projectPath, onExit },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<IPty | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Use ref for onExit to prevent effect re-runs when callback reference changes
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  const cleanup = useCallback(() => {
    if (ptyRef.current) {
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

    // Wait for container to have dimensions AND fonts to load
    const checkReady = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Load Nerd Fonts before initializing terminal
        void loadNerdFonts().then(() => {
          setIsReady(true);
        });
      } else {
        requestAnimationFrame(checkReady);
      }
    };
    checkReady();
  }, []);

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

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
    }, 0);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track if this effect instance is still mounted (handles StrictMode/HMR)
    let mounted = true;

    // Setup PTY connection using tauri-pty with retry logic
    const setupPty = async (retryCount = 0) => {
      const maxRetries = 3;

      // Check if still mounted before proceeding
      if (!mounted) return;

      try {
        // Fit again to ensure correct size
        fitAddon.fit();

        // Get extended PATH from backend (includes nvm, Claude desktop app, etc.)
        const home = await homeDir();
        const homeNormalized = home.endsWith('/') ? home : `${home}/`;
        const fullPath = await invoke<string>('get_shell_path');

        // Spawn PTY using tauri-pty
        // Must pass all essential env vars since env replaces (not merges with) parent environment
        // eslint-disable-next-line @typescript-eslint/await-thenable
        const pty = await spawn('claude', [], {
          cwd: projectPath,
          cols: term.cols,
          rows: term.rows,
          env: {
            PATH: fullPath,
            HOME: homeNormalized.slice(0, -1),
            USER: homeNormalized.split('/').filter(Boolean).pop() || 'user',
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            SHELL: '/bin/zsh',
          },
        });

        // Check again after async operation
        if (!mounted) {
          pty.kill();
          return;
        }

        ptyRef.current = pty;

        // Handle PTY output -> terminal
        pty.onData((data) => {
          terminalRef.current?.write(data);
        });

        // Handle PTY exit
        pty.onExit(({ exitCode }) => {
          terminalRef.current?.write('\r\n[Process exited]\r\n');
          onExitRef.current?.(exitCode);
        });

        // Handle terminal input -> PTY
        term.onData((data) => {
          ptyRef.current?.write(data);
        });

        // Handle Shift+Enter to insert newline instead of submitting
        term.attachCustomKeyEventHandler((event) => {
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
        console.warn('Failed to spawn Claude:', err);

        if (!mounted) return;

        if (retryCount < maxRetries) {
          term.write(
            `\x1b[33mFailed to start Claude, retrying (${retryCount + 1}/${maxRetries})...\x1b[0m\r\n`
          );
          setTimeout(() => void setupPty(retryCount + 1), 1000);
        } else {
          term.write(`\x1b[31mError starting Claude: ${String(err)}\x1b[0m\r\n`);
          term.write(
            `\x1b[33mMake sure Claude Code is installed: npm install -g @anthropic-ai/claude-code\x1b[0m\r\n`
          );
        }
      }
    };

    // Small delay before starting to ensure terminal is ready
    setTimeout(() => void setupPty(), 100);

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current && ptyRef.current) {
        fitAddonRef.current.fit();
        ptyRef.current.resize(terminalRef.current.cols, terminalRef.current.rows);
      }
    });
    resizeObserver.observe(container);

    return () => {
      mounted = false;
      resizeObserver.disconnect();
      cleanup();
    };
  }, [isReady, projectPath, cleanup]);

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
    }),
    [cleanup]
  );

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#1e1e1e',
      }}
    />
  );
});
