/**
 * Terminal view for the backend-owned Claude connect flow.
 *
 * Unlike {@link OnboardingTerminal} (which spawns its PTY via `tauri-pty` in
 * the webview), this terminal is a thin view over a PTY the *backend* owns: it
 * subscribes to `claude-connect-*` events for output, forwards keystrokes via
 * `claude_connect_write`, and never sees the captured token — Rust scrapes and
 * redacts it before any byte reaches here (see `claudeConnectStart`).
 *
 * The user logs in via the browser, then pastes the authorization code at the
 * CLI's prompt. When Rust captures the token it emits `claude-connect-captured`
 * → {@link onCaptured}; process end → {@link onExit}.
 */

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { createWebLinksAddon } from '../../lib/terminalLinks';
import { loadNerdFonts } from '../../lib/fonts';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  claudeConnectStart,
  claudeConnectWrite,
  claudeConnectResize,
  claudeConnectClose,
  onClaudeConnectData,
  onClaudeConnectCaptured,
  onClaudeConnectExit,
} from '../../lib/agents-management';
import '@xterm/xterm/css/xterm.css';

interface ClaudeConnectTerminalProps {
  /** Stable id correlating this terminal with its backend PTY session. */
  sessionId: string;
  /** Workspace whose Claude login is being connected. */
  accountId: string;
  /** Display-only email the user is signing in as. */
  email?: string;
  /** Fired when Rust has scraped + stored the token (the success signal). */
  onCaptured: () => void;
  /** Fired when the connect process exits, with its exit code. */
  onExit: (exitCode: number) => void;
}

export function ClaudeConnectTerminal({
  sessionId,
  accountId,
  email,
  onCaptured,
  onExit,
}: ClaudeConnectTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Refs for callbacks so the setup effect runs exactly once per session.
  const onCapturedRef = useRef(onCaptured);
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onCapturedRef.current = onCaptured;
    onExitRef.current = onExit;
  }, [onCaptured, onExit]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let mounted = true;
    let term: XTerm | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      await loadNerdFonts();
      if (!mounted) return;

      term = new XTerm({
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

      fitAddon = new FitAddon();
      const unicode11Addon = new Unicode11Addon();
      term.loadAddon(fitAddon);
      term.loadAddon(unicode11Addon);
      term.loadAddon(createWebLinksAddon());
      term.unicode.activeVersion = '11';
      term.open(container);
      fitAddon.fit();

      // Keystrokes -> backend PTY.
      term.onData((data) => {
        void claudeConnectWrite(sessionId, data).catch(() => {
          /* session may have exited; ignore */
        });
      });

      // Subscribe BEFORE starting so we don't miss the initial auth URL.
      unlisteners.push(
        await onClaudeConnectData(sessionId, (bytes) => {
          term?.write(bytes);
        })
      );
      unlisteners.push(
        await onClaudeConnectCaptured(sessionId, () => {
          onCapturedRef.current();
        })
      );
      unlisteners.push(
        await onClaudeConnectExit(sessionId, (code) => {
          onExitRef.current(code);
        })
      );
      if (!mounted) return;

      try {
        await claudeConnectStart({
          sessionId,
          accountId,
          email,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (err) {
        logger.warn('[ClaudeConnectTerminal] failed to start connect', { error: String(err) });
        term.write(
          `\r\n\x1b[31mCouldn't start Claude login: ${formatCommandError(asCommandError(err))}\x1b[0m\r\n`
        );
        return;
      }

      term.focus();

      resizeObserver = new ResizeObserver(() => {
        if (!fitAddon || !term) return;
        fitAddon.fit();
        void claudeConnectResize(sessionId, term.cols, term.rows).catch(() => {
          /* ignore */
        });
      });
      resizeObserver.observe(container);
    };

    void setup();

    return () => {
      mounted = false;
      resizeObserver?.disconnect();
      for (const off of unlisteners) off();
      void claudeConnectClose(sessionId).catch(() => {
        /* ignore */
      });
      term?.dispose();
    };
    // Callbacks are held via refs, so the effect re-runs only when the session
    // identity changes — the PTY isn't torn down on every parent re-render.
  }, [sessionId, accountId, email]);

  return <div ref={containerRef} className="onboarding-terminal-container" />;
}
