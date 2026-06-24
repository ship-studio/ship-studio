/**
 * Terminal view for the generalized per-workspace connect flow
 * (GitHub / Codex / Opencode).
 *
 * A sibling of {@link ClaudeConnectTerminal}, but for the *config-dir* logins:
 * there's no secret to scrape, so this streams the CLI's output verbatim over
 * `workspace-connect-*` events and treats process exit (`onExit`) as the only
 * completion signal — there is no "captured" event. The backend spawns the
 * login under the workspace's isolated env so credentials land in that
 * workspace's config dir (see `workspaceConnectStart`). For GitHub the backend
 * auto-advances the "Press Enter to open…" prompt so the browser opens itself.
 */

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { createWebLinksAddon } from '../../lib/terminalLinks';
import { loadNerdFonts } from '../../lib/fonts';
import { logger } from '../../lib/logger';
import {
  workspaceConnectStart,
  workspaceConnectWrite,
  workspaceConnectResize,
  workspaceConnectClose,
  onWorkspaceConnectData,
  onWorkspaceConnectExit,
  type WorkspaceConnectService,
} from '../../lib/accounts';
import '@xterm/xterm/css/xterm.css';

interface WorkspaceConnectTerminalProps {
  /** Stable id correlating this terminal with its backend PTY session. */
  sessionId: string;
  /** Workspace whose login is being connected. */
  accountId: string;
  /** Which config-dir login to run. */
  service: WorkspaceConnectService;
  /** Fired when the connect process exits, with its exit code. */
  onExit: (exitCode: number) => void;
}

export function WorkspaceConnectTerminal({
  sessionId,
  accountId,
  service,
  onExit,
}: WorkspaceConnectTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Held in a ref so the setup effect runs exactly once per session.
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

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
        void workspaceConnectWrite(sessionId, data).catch(() => {
          /* session may have exited; ignore */
        });
      });

      // Subscribe BEFORE starting so we don't miss the initial output.
      unlisteners.push(
        await onWorkspaceConnectData(sessionId, (bytes) => {
          term?.write(bytes);
        })
      );
      unlisteners.push(
        await onWorkspaceConnectExit(sessionId, (code) => {
          onExitRef.current(code);
        })
      );
      if (!mounted) return;

      try {
        await workspaceConnectStart({
          sessionId,
          accountId,
          service,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (err) {
        logger.warn('[WorkspaceConnectTerminal] failed to start connect', { error: String(err) });
        term.write(`\r\n\x1b[31mCouldn't start login: ${String(err)}\x1b[0m\r\n`);
        return;
      }

      term.focus();

      resizeObserver = new ResizeObserver(() => {
        if (!fitAddon || !term) return;
        fitAddon.fit();
        void workspaceConnectResize(sessionId, term.cols, term.rows).catch(() => {
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
      void workspaceConnectClose(sessionId).catch(() => {
        /* ignore */
      });
      term?.dispose();
    };
    // Callbacks are held via refs, so the effect re-runs only when the session
    // identity changes — the PTY isn't torn down on every parent re-render.
  }, [sessionId, accountId, service]);

  return <div ref={containerRef} className="onboarding-terminal-container" />;
}
