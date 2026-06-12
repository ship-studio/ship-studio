/**
 * Embedded terminal for onboarding interactive commands.
 *
 * A simplified terminal component for running interactive CLI commands
 * during onboarding (e.g., gh auth, claude install, vercel login).
 * Reuses xterm.js setup from Terminal.tsx but without drag-drop handling.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { createWebLinksAddon } from '../../lib/terminalLinks';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { spawn, IPty } from 'tauri-pty';
import { homeDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { readDir, exists } from '@tauri-apps/plugin-fs';
import { loadNerdFonts } from '../../lib/fonts';
import { isWindows } from '../../lib/setup';
import { logger } from '../../lib/logger';
import '@xterm/xterm/css/xterm.css';

/** Props for the OnboardingTerminal component */
interface OnboardingTerminalProps {
  /** Command to run (e.g., "gh", "bash") */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Working directory (defaults to home) */
  cwd?: string;
  /** Callback fired when the process exits */
  onExit: (exitCode: number | null) => void;
}

export function OnboardingTerminal({ command, args, cwd, onExit }: OnboardingTerminalProps) {
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
    const checkReady = async () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Load Nerd Fonts before initializing terminal
        await loadNerdFonts();
        setIsReady(true);
      } else {
        requestAnimationFrame(() => void checkReady());
      }
    };
    void checkReady();
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
      scrollback: 1000,
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

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
    }, 0);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track if this effect instance is still mounted (handles StrictMode/HMR)
    let mounted = true;

    // Setup PTY connection using tauri-pty
    const setupPty = async () => {
      // Check if still mounted before proceeding
      if (!mounted) return;

      try {
        // Fit again to ensure correct size
        fitAddon.fit();

        // Get home directory for default cwd and PATH building
        const home = await homeDir();
        const isWin = isWindows();
        const sep = isWin ? '\\' : '/';
        const homeNormalized = home.endsWith(sep) ? home : `${home}${sep}`;
        const homePath = cwd || homeNormalized;

        let env: Record<string, string>;
        let spawnCmd: string;
        let spawnArgs: string[];

        if (isWin) {
          // Windows: get system env vars from backend and build Windows-compatible env
          const systemEnv = await invoke<Record<string, string>>('get_system_env');

          // Add extra tool installation paths to the front of PATH
          const programFiles = systemEnv['ProgramFiles'] || 'C:\\Program Files';
          const localAppData = systemEnv['LOCALAPPDATA'] || `${homeNormalized}AppData\\Local`;
          const appData = systemEnv['APPDATA'] || `${homeNormalized}AppData\\Roaming`;

          const extraPaths = [
            `${appData}\\npm`,
            `${localAppData}\\pnpm`,
            `${homeNormalized}.cargo\\bin`,
            `${programFiles}\\GitHub CLI`,
            `${programFiles}\\Git\\cmd`,
            `${programFiles}\\nodejs`,
          ];

          const systemPath = systemEnv['PATH'] || '';
          const fullPath = `${extraPaths.join(';')};${systemPath}`;

          env = {
            ...systemEnv,
            PATH: fullPath,
            TERM: 'xterm-256color',
          };

          // Wrap command through cmd.exe /C for .cmd scripts (vercel, npx, etc.)
          spawnCmd = 'cmd.exe';
          spawnArgs = ['/C', command, ...args];
        } else {
          // macOS/Linux: existing Unix path and env logic
          const userPaths = [
            `${homeNormalized}.npm-global/bin`,
            `${homeNormalized}.local/bin`,
            `${homeNormalized}.cargo/bin`,
            `${homeNormalized}n/bin`, // n version manager
            `${homeNormalized}.opencode/bin`, // opencode installer default
            `${homeNormalized}.bun/bin`, // bun-installed tools
          ];

          // Try to find nvm node versions and add their bin directories
          const nvmNodeDir = `${homeNormalized}.nvm/versions/node`;
          try {
            const entries = await readDir(nvmNodeDir);
            for (const entry of entries) {
              const name = entry.name;
              if (name && name.startsWith('v')) {
                const binPath = `${nvmNodeDir}/${name}/bin`;
                const pathExists = await exists(binPath);
                if (pathExists) {
                  userPaths.push(binPath);
                }
              }
            }
          } catch {
            // nvm not installed or no versions - ignore
          }

          const systemPaths = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
          const fullPath = `${userPaths.join(':')}:${systemPaths}`;

          env = {
            PATH: fullPath,
            HOME: homeNormalized.slice(0, -1),
            USER: homeNormalized.split('/').filter(Boolean).pop() || 'user',
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            SHELL: '/bin/zsh',
          };

          spawnCmd = command;
          spawnArgs = args;
        }

        // The PTY merges this env over the app's own — pin npm/pnpm
        // "invocation directory" vars so they can't leak a stale path into
        // tools that trust them over process.cwd() (see Terminal.tsx).
        env.INIT_CWD = homePath;
        env.PNPM_SCRIPT_SRC_DIR = homePath;

        // Spawn PTY using tauri-pty
        // Must pass all essential env vars since env replaces (not merges with) parent environment
        // eslint-disable-next-line @typescript-eslint/await-thenable
        const pty = await spawn(spawnCmd, spawnArgs, {
          cwd: homePath,
          cols: term.cols,
          rows: term.rows,
          env,
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
          onExitRef.current(exitCode);
        });

        // Handle terminal input -> PTY
        term.onData((data) => {
          ptyRef.current?.write(data);
        });

        // Intercept Ctrl+C: copy selection to clipboard instead of sending SIGINT
        term.attachCustomKeyEventHandler((event) => {
          if (event.key === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey) {
            const selection = term.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection).catch((err: unknown) => {
                logger.warn('[OnboardingTerminal] Failed to copy selection to clipboard', {
                  error: String(err),
                });
              });
              term.clearSelection();
              return false; // Prevent sending to PTY
            }
          }
          return true; // Allow all other keys
        });

        // Focus the terminal
        term.focus();
      } catch (err) {
        logger.warn(`Failed to spawn ${command}`);
        term.write(`\x1b[31mError starting command: ${String(err)}\x1b[0m\r\n`);
        // Notify parent of failure
        setTimeout(() => onExitRef.current(1), 1000);
      }
    };

    // Show a loading message while the command starts up
    term.write('\r\n  \x1b[2mStarting...\x1b[0m');

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
  }, [isReady, command, args, cwd, cleanup]);

  // Click to focus terminal
  const handleClick = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} onClick={handleClick} className="onboarding-terminal-container" />
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
          Starting...
        </div>
      )}
    </div>
  );
}
