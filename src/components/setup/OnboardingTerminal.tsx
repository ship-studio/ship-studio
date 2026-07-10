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
import { spawnOnboardingPty, OnboardingPty } from '../../lib/onboardingPty';
import { homeDir } from '@tauri-apps/api/path';
import { getSystemEnv, getShellPath } from '../../lib/project';
import { readDir, exists } from '@tauri-apps/plugin-fs';
import { loadNerdFonts } from '../../lib/fonts';
import { isWindows, needsCmdExeWrapper, resolveCliPath, ResolvedCli } from '../../lib/setup';
import { isPasteChord, readClipboardText } from '../../lib/clipboard';
import { createPtyChunkDecoder, toPtyBytes, type PtyChunk } from '../../lib/terminalDiagnostics';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import '@xterm/xterm/css/xterm.css';

/**
 * Maximum characters of raw PTY output retained for exit diagnostics.
 * Enough to hold the tail of an npm/installer failure without growing
 * unboundedly during long-running commands.
 */
const OUTPUT_TAIL_MAX_CHARS = 8192;

/** Props for the OnboardingTerminal component */
interface OnboardingTerminalProps {
  /** Command to run (e.g., "gh", "bash") */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Working directory (defaults to home) */
  cwd?: string;
  /**
   * Callback fired when the process exits. `outputTail` is the last
   * ~{@link OUTPUT_TAIL_MAX_CHARS} characters of raw output so callers can
   * surface the actual error on failure (see lib/terminalDiagnostics).
   */
  onExit: (exitCode: number | null, outputTail: string) => void;
}

export function OnboardingTerminal({ command, args, cwd, onExit }: OnboardingTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<OnboardingPty | null>(null);
  // Bounded tail of raw PTY output, handed to onExit for failure diagnostics.
  const outputTailRef = useRef('');
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
      // Match the workspace terminal. A smaller buffer trims constantly under
      // a TUI agent's redraws, which makes the scrollbar jump around.
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

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
    }, 0);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track if this effect instance is still mounted (handles StrictMode/HMR)
    let mounted = true;
    // Startup watchdog state (see the watchdog block below). `autoRespawnUsed`
    // persists across respawn attempts; `startupTimer` is cleared on first
    // output, on exit, and on unmount.
    let autoRespawnUsed = false;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;

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

        // The backend's extended PATH is the authority: it queries the user's
        // login shell and knows version-manager layouts (asdf/volta/fnm/nvm,
        // incl. the Windows fnm_multishells + nvm-windows symlink dirs). The
        // hand-built lists below stay as a fallback/supplement, but without
        // this the install/auth status checks (which use the backend PATH)
        // could say "installed ✓" for a binary this PTY then can't see.
        const backendPath = await getShellPath().catch((err: unknown) => {
          logger.warn('[OnboardingTerminal] getShellPath failed — using fallback PATH', {
            error: String(err),
          });
          return '';
        });
        if (!mounted) return;

        if (isWin) {
          // Windows: get system env vars from backend and build Windows-compatible env
          const systemEnv = await getSystemEnv();

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
            // Version-manager Node installs — volta/fnm/nvm-windows users may
            // have no %ProgramFiles%\nodejs, and their shell-profile PATH edits
            // are invisible to a GUI-launched app. Without these, npm-based
            // installs fail with "'npm' is not recognized" (issue #164).
            // Nonexistent dirs on PATH are harmless.
            `${localAppData}\\Volta\\bin`,
            `${localAppData}\\fnm`,
            `${localAppData}\\Programs\\nodejs`,
          ];

          const systemPath = systemEnv['PATH'] || '';
          const fullPath = [extraPaths.join(';'), systemPath, backendPath]
            .filter((part) => part.length > 0)
            .join(';');

          env = {
            ...systemEnv,
            PATH: fullPath,
            TERM: 'xterm-256color',
          };

          // Placeholder — the real Windows spawn shape (direct vs. wrapped in
          // cmd.exe /C) is decided AFTER binary resolution below, because the
          // decision depends on what the command resolves to (.cmd shim vs.
          // real executable). See needsCmdExeWrapper in lib/setup.ts.
          spawnCmd = command;
          spawnArgs = args;
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
          const fullPath = [userPaths.join(':'), systemPaths, backendPath]
            .filter((part) => part.length > 0)
            .join(':');

          // Onboarding always runs in the Default workspace, which maps to the
          // global config dirs the CLIs use by default (~/.claude, ~/.config/gh,
          // ~/.codex). So there's no Workspace env to inject here — and we
          // deliberately don't fetch credential tokens into the webview.
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

        // Fail fast on a missing binary. Bare command names are resolved on
        // the backend (same discovery the status checks use); a definitive
        // "not installed" gets an instant, plain-English message instead of a
        // PTY that spawns nothing and hangs. Resolution errors fail OPEN —
        // the spawn proceeds and the watchdog below stays the backstop.
        const isBareName = !command.includes('/') && !command.includes('\\');
        let resolved: ResolvedCli | null | undefined;
        if (isBareName) {
          try {
            resolved = await resolveCliPath(command);
          } catch (err) {
            logger.warn('[OnboardingTerminal] resolveCliPath failed — spawning anyway', {
              command,
              error: String(err),
            });
            resolved = undefined;
          }
          if (!mounted) return;
          if (resolved === null) {
            const message = `${command}: not found — it doesn't appear to be installed on this computer.`;
            logger.warn('[OnboardingTerminal] Binary not found — skipping spawn', { command });
            terminalRef.current?.write(
              `\r\n\x1b[31m${message}\x1b[0m\r\n` +
                `\x1b[33mClose this window and install ${command} first — the setup checklist can do that for you.\x1b[0m\r\n`
            );
            setTimeout(() => onExitRef.current(1, message), 1000);
            return;
          }
          if (resolved) {
            // Make the PTY see the exact binary the status checks found,
            // even when it lives in a prefix the PATH above doesn't cover.
            const pathSep = isWin ? ';' : ':';
            if (!env.PATH.split(pathSep).includes(resolved.dir)) {
              env.PATH = `${env.PATH}${pathSep}${resolved.dir}`;
            }
            if (!isWin) {
              // Spawn the resolved absolute path — deterministic, no PATH
              // shadowing. (The Windows equivalent happens in the spawn-shape
              // block below, where wrapper-vs-direct is decided.)
              spawnCmd = resolved.path;
            }
          }
        }

        if (isWin) {
          // Windows spawn shape. Only .cmd/.bat shims (npm, vercel, npx)
          // go through `cmd.exe /C` — they are batch scripts and need it.
          // Real executables (powershell, gh, claude, codex, git) are
          // spawned DIRECTLY: routing them through cmd.exe adds a second
          // parse layer (cmd re-parses the portable_pty-composed command
          // line with its own quote rules) between us and the target;
          // direct spawn removes it, so arguments like a piped PowerShell
          // installer one-liner reach the target exactly as composed. Both
          // spawn shapes are exercised under a real ConPTY by the canary
          // tests in src-tauri/src/commands/pty_session.rs (windows-check
          // CI job, "PTY spawn-shape canaries" step) — see
          // needsCmdExeWrapper's doc comment for the evidence history.
          if (needsCmdExeWrapper(command, resolved?.path)) {
            spawnCmd = 'cmd.exe';
            spawnArgs = ['/C', command, ...args];
          } else {
            // Prefer the resolved absolute path (deterministic, no PATH
            // shadowing — quoting paths with spaces is safe without cmd.exe
            // in the middle); fall back to the bare name on the extended
            // PATH when resolution failed open (powershell reaches here).
            spawnCmd = resolved?.path ?? command;
            spawnArgs = args;
          }
        }

        // Spawn the PTY. This rejects with the backend's real error (e.g.
        // "Failed to start `gh`: No such file or directory") — caught below.
        // The env replaces (not merges with) the parent environment.
        const pty = await spawnOnboardingPty(spawnCmd, spawnArgs, {
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
        outputTailRef.current = '';

        // First byte from this PTY cancels the startup watchdog below.
        let receivedOutput = false;

        // Streaming decoder for the diagnostics tail — one per PTY so
        // multi-byte characters split across chunks decode correctly.
        const decodeChunk = createPtyChunkDecoder();

        // Handle PTY output -> terminal, keeping a bounded tail for
        // diagnostics. Chunks arrive as plain number arrays over IPC, so
        // everything below must normalize. The client tolerates listener
        // throws (unlike tauri-pty, where one throw froze the terminal — the
        // v0.13.2 bug), but stay defensive: diagnostics must never cost
        // output.
        const dataDisposable = pty.onData((data: PtyChunk) => {
          if (!receivedOutput) {
            receivedOutput = true;
            if (startupTimer) {
              clearTimeout(startupTimer);
              startupTimer = null;
            }
          }
          try {
            const chunk = typeof data === 'string' ? data : toPtyBytes(data);
            terminalRef.current?.write(chunk);
            const combined = outputTailRef.current + decodeChunk(data);
            outputTailRef.current =
              combined.length > OUTPUT_TAIL_MAX_CHARS
                ? combined.slice(-OUTPUT_TAIL_MAX_CHARS)
                : combined;
          } catch (err) {
            // Never let rendering/diagnostics break the read loop.
            logger.warn('[OnboardingTerminal] Failed to process PTY chunk', {
              error: String(err),
            });
          }
        });

        // Handle PTY exit
        const exitDisposable = pty.onExit(({ exitCode }) => {
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          onExitRef.current(exitCode, outputTailRef.current);
        });

        // Output stream died mid-session (rare, post-retries). Say so
        // instead of freezing silently — the process may still be running.
        pty.onStreamError(() => {
          terminalRef.current?.write(
            '\r\n\x1b[33mOutput stream interrupted — the command may still be running. ' +
              'If nothing else appears, close this window and try again.\x1b[0m\r\n'
          );
        });

        // Startup watchdog: a first PTY spawn can wedge and emit nothing
        // (Windows ConPTY especially, and occasionally macOS) — the main agent
        // terminal recovers from this by respawning (Terminal.tsx), but this
        // onboarding terminal previously just sat at "Starting…" forever with
        // no feedback (issues #156, #164). If no output arrives within 10s,
        // kill the silent PTY and respawn once; if the respawn is also silent,
        // surface an actionable message instead of hanging.
        if (startupTimer) clearTimeout(startupTimer);
        startupTimer = setTimeout(() => {
          if (!mounted || receivedOutput) return;
          if (!autoRespawnUsed) {
            autoRespawnUsed = true;
            logger.warn('[OnboardingTerminal] No output after 10s — respawning', { command });
            terminalRef.current?.write('\r\n\x1b[33mNo output — restarting…\x1b[0m\r\n');
            // Dispose this PTY's handlers BEFORE killing it, so the kill-induced
            // exit event can't clear the respawn timer or notify the parent that
            // the flow exited (mirrors the guard in Terminal.tsx).
            try {
              dataDisposable.dispose();
              exitDisposable.dispose();
            } catch {
              // Already disposed — ignore
            }
            try {
              ptyRef.current?.kill();
            } catch {
              // Already dead — the respawn will start fresh either way
            }
            ptyRef.current = null;
            // Brief grace period so the killed PTY tears down before respawn.
            startupTimer = setTimeout(() => {
              if (mounted) void setupPty();
            }, 500);
            return;
          }
          logger.error('[OnboardingTerminal] Still no output after respawn', { command });
          terminalRef.current?.write(
            `\r\n\x1b[31m${command} did not respond.\x1b[0m\r\n` +
              `\x1b[33mMake sure "${command}" is installed and on your PATH, then close this window and try again.\x1b[0m\r\n`
          );
        }, 10_000);

        // Focus the terminal
        term.focus();
      } catch (err) {
        logger.warn(`Failed to spawn ${command}`);
        const message = `Error starting command: ${formatCommandError(asCommandError(err))}`;
        term.write(`\x1b[31m${message}\x1b[0m\r\n`);
        // Notify parent of failure, passing the spawn error as the tail
        setTimeout(() => onExitRef.current(1, message), 1000);
      }
    };

    // Wire terminal input -> PTY once. It targets `ptyRef.current`, so it keeps
    // working across a watchdog respawn without double-registering handlers.
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
      // Windows-only: Ctrl+V paste (auth codes) via the native clipboard.
      // WebView2 gates keyboard-initiated textarea paste behind an async
      // clipboard permission wait (~30s or never — issue #157). macOS is
      // deliberately not intercepted (Cmd+V default paste works there).
      if (isWindows() && isPasteChord(event)) {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            const text = await readClipboardText();
            if (text) {
              term.focus();
              term.paste(text);
            }
          } catch (err) {
            logger.warn('[OnboardingTerminal] Native clipboard paste failed', {
              error: String(err),
            });
            // Best-effort fallback to the browser clipboard.
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
      if (startupTimer) clearTimeout(startupTimer);
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
