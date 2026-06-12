/**
 * DevServerLogs component that displays the dev server output.
 *
 * This component creates a terminal view using xterm.js to display the
 * output from the dev server. It supports:
 * - Full ANSI color code rendering
 * - Automatic scrolling to latest output
 * - Terminal resize handling (mirrored to the PTY via onResize)
 * - Live updates as new output arrives
 * - Typing into the dev-server PTY (via onInput) so interactive CLI prompts
 *   — Shopify store passwords, y/n confirms — can be answered in place
 * - "Send to agent" — full buffer (tail-capped) or a user-dragged selection
 *
 * @module components/DevServerLogs
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createWebLinksAddon } from '../lib/terminalLinks';
import { loadNerdFonts } from '../lib/fonts';
import { useClickOutside } from '../hooks/useClickOutside';
import { useOptionalToast } from '../contexts/ToastContext';
import { CopyIcon } from './icons';
import { trackEvent } from '../lib/analytics';
import { stripAnsi } from '../lib/ansi';
import '@xterm/xterm/css/xterm.css';

/* Tail-limit the full-buffer send so we don't fire 3k+ lines of HMR
   chatter at the agent. 500 lines ≈ ~40KB of typical Next.js output —
   enough to capture recent requests + a stack trace, small enough to
   read. Selection-send is unbounded (user chose it deliberately). */
const MAX_LOG_LINES_ON_SEND = 500;

/* Some CLIs (TUI-style tools like `shopify theme dev`) emit alternate-screen
   switches. In xterm the alternate buffer has NO scrollback, so one stray
   `\x1b[?1049h` permanently kills scrolling in this read-only log view.
   Strip the smcup/rmcup family before writing. */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_SEQUENCES = /\x1b\[\?(?:1049|1047|1048|47)[hl]/g;

function sanitizeLogChunk(chunk: string): string {
  return chunk.replace(ALT_SCREEN_SEQUENCES, '');
}

/** Props for the DevServerLogs component */
interface DevServerLogsProps {
  /** Current output from the dev server */
  output: string;
  /** Version number that changes when output updates (triggers re-render) */
  outputVersion: number;
  /** Pipe the current server logs into the agent terminal. */
  onSendToAgent?: (text: string) => void;
  /** Forward keystrokes into the dev-server PTY (interactive prompts). */
  onInput?: (data: string) => void;
  /** Mirror the terminal's cols/rows to the dev-server PTY. */
  onResize?: (cols: number, rows: number) => void;
}

interface SelectionInfo {
  text: string;
  mouseX: number;
  mouseY: number;
}

export function DevServerLogs({
  output,
  outputVersion,
  onSendToAgent,
  onInput,
  onResize,
}: DevServerLogsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isReady, setIsReady] = useState(false);
  const lastWrittenLengthRef = useRef(0);

  // The terminal is created once (isReady effect); keep the latest handlers
  // in refs so its onData/resize hooks never go stale.
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  // Selection popover
  const { showToast } = useOptionalToast();
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [question, setQuestion] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  // xterm selection is cleared on certain redraws (new output mid-drag),
  // so snapshot the text on every selection change — we read from the ref
  // on mouseup rather than from `term.getSelection()` directly.
  const selectedTextRef = useRef('');

  const dismissPopover = useCallback(() => {
    setSelectionInfo(null);
    setQuestion('');
    terminalRef.current?.clearSelection();
    selectedTextRef.current = '';
  }, []);

  useClickOutside(popoverRef, dismissPopover, selectionInfo !== null);

  // Initialize terminal after mount and fonts are loaded
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const checkReady = async () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
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

    // Create terminal with same styling as Claude terminal
    const term = new XTerm({
      fontFamily: '"JetBrainsMono NF", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 10000,
      // Stdin stays enabled so interactive CLI prompts (Shopify password,
      // y/n confirms) can be answered here; keys flow to the PTY via onInput.
      disableStdin: false,
      theme: {
        background: '#1a1a1a',
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
    term.loadAddon(fitAddon);
    term.loadAddon(createWebLinksAddon());

    term.open(container);

    // Initial fit + sync the PTY to the visible size so interactive prompts
    // render at the width the user actually sees.
    setTimeout(() => {
      fitAddon.fit();
      onResizeRef.current?.(term.cols, term.rows);
    }, 0);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Forward keystrokes (including arrows/enter for CLI selection prompts)
    // into the dev-server PTY. The PTY echoes, so typed input renders via
    // the normal output path.
    const inputDisposable = term.onData((data) => {
      onInputRef.current?.(data);
    });

    // Snapshot selected text as xterm updates it. We read from the ref
    // in mouseup rather than calling term.getSelection() there, because
    // the selection can be cleared between the drag end and our handler
    // if new output arrives.
    const selectionDisposable = term.onSelectionChange(() => {
      selectedTextRef.current = term.getSelection();
    });

    // Write initial message
    term.write('\x1b[90m$ dev server\x1b[0m\r\n\r\n');

    // Write current output
    if (output) {
      term.write(sanitizeLogChunk(output), () => term.scrollToBottom());
      lastWrittenLengthRef.current = output.length;
    }

    // Handle resize. `fit()` recomputes cols/rows from the new container
    // size but doesn't force xterm to repaint already-rendered lines at
    // the new width — so without `refresh()` you get overlapping text
    // (old glyphs at old column positions bleeding through the new
    // layout). Debounce to coalesce transient resize events (grid
    // animation, font load, tab switches) into a single fit+refresh.
    let resizeTimer: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        const t = terminalRef.current;
        const fit = fitAddonRef.current;
        if (!t || !fit) return;
        try {
          fit.fit();
          t.refresh(0, t.rows - 1);
          onResizeRef.current?.(t.cols, t.rows);
        } catch {
          // fit() throws if container is 0×0 (e.g. mid-transition);
          // safe to ignore — next resize event will retry.
        }
      }, 16);
    });
    resizeObserver.observe(container);

    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      selectionDisposable.dispose();
      inputDisposable.dispose();
      lastWrittenLengthRef.current = 0;
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- output is intentionally excluded; incremental writes handled by separate effect below
  }, [isReady]); // Only recreate terminal when isReady changes

  // Write new output when it changes
  useEffect(() => {
    if (!terminalRef.current || !isReady) return;

    const term = terminalRef.current;
    if (output.length > lastWrittenLengthRef.current) {
      // Only write new content (what we haven't written yet). Follow the
      // tail unless the user has deliberately scrolled up to read history.
      const buf = term.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      const newContent = output.slice(lastWrittenLengthRef.current);
      term.write(sanitizeLogChunk(newContent), () => {
        if (wasAtBottom) term.scrollToBottom();
      });
      lastWrittenLengthRef.current = output.length;
    } else if (output.length < lastWrittenLengthRef.current) {
      // The buffer shrank — a dev-server restart cleared it. Without this
      // branch the slice-based comparison goes stale and NOTHING renders
      // until the new run's output outgrows the old one.
      term.reset();
      term.write('\x1b[90m$ dev server\x1b[0m\r\n\r\n');
      if (output) term.write(sanitizeLogChunk(output), () => term.scrollToBottom());
      lastWrittenLengthRef.current = output.length;
    }
  }, [output, outputVersion, isReady]);

  // Click to focus for scrolling
  const handleClick = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Surface the selection popover after a drag. xterm owns the mouse
  // events internally, but bubbling still reaches the container, so by
  // the time our handler fires `term.hasSelection()` is accurate.
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!onSendToAgent) return;
      const term = terminalRef.current;
      if (!term) return;
      // Bail if the drag started/ended on the popover itself (shouldn't
      // happen since it's portaled to body, but defensive).
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (!term.hasSelection()) return;
      const text = selectedTextRef.current || term.getSelection();
      if (!text.trim()) return;
      setSelectionInfo({ text, mouseX: e.clientX, mouseY: e.clientY });
      setQuestion('');
    },
    [onSendToAgent]
  );

  const handleSendFullBuffer = useCallback(() => {
    if (!onSendToAgent) return;
    const text = formatServerLogsForAgent(output);
    void trackEvent('logs_sent_to_agent', {
      source: 'full_buffer',
      char_count: text.length,
      // Count actual log lines (raw output), not the wrapped prompt — so
      // the metric is comparable to the selection branch below.
      line_count: output.split('\n').length,
    });
    onSendToAgent(text);
  }, [onSendToAgent, output]);

  const handleSendSelection = useCallback(() => {
    if (!onSendToAgent || !selectionInfo) return;
    const text = formatSelectionForAgent(selectionInfo.text, question);
    void trackEvent('logs_sent_to_agent', {
      source: 'selection',
      char_count: text.length,
      line_count: selectionInfo.text.split('\n').length,
      had_question: question.trim().length > 0,
    });
    onSendToAgent(text);
    showToast('Sent to agent', 'success');
    dismissPopover();
  }, [onSendToAgent, selectionInfo, question, showToast, dismissPopover]);

  // Popover position: anchored to mouseup point, clamped to viewport.
  const popoverWidth = 320;
  const popoverHeight = 120;
  let popoverStyle: React.CSSProperties | undefined;
  if (selectionInfo) {
    const top = Math.max(
      8,
      Math.min(selectionInfo.mouseY + 12, window.innerHeight - popoverHeight - 8)
    );
    const left = Math.max(
      8,
      Math.min(selectionInfo.mouseX - popoverWidth / 2, window.innerWidth - popoverWidth - 8)
    );
    popoverStyle = { top, left };
  }

  return (
    <div className="dev-server-logs">
      {onSendToAgent && (
        <div className="dev-server-logs-toolbar">
          <span className="dev-server-logs-hint">Select text to send a specific snippet</span>
          <button
            type="button"
            className="dev-server-logs-send"
            onClick={handleSendFullBuffer}
            disabled={output.length === 0}
            title={`Send the last ${MAX_LOG_LINES_ON_SEND} lines to the active agent`}
          >
            Send to agent
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        onClick={handleClick}
        onMouseUp={handleMouseUp}
        className="dev-server-logs-terminal"
      />
      {selectionInfo &&
        popoverStyle &&
        createPortal(
          <div className="code-selection-popover" ref={popoverRef} style={popoverStyle}>
            <input
              className="code-selection-input"
              type="text"
              placeholder="Ask about this..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSendSelection();
                if (e.key === 'Escape') dismissPopover();
              }}
              autoFocus
            />
            <div className="code-selection-actions">
              <button className="code-selection-cancel" onClick={dismissPopover}>
                Cancel
              </button>
              <button className="code-selection-copy" onClick={handleSendSelection}>
                <CopyIcon size={12} />
                Copy to agent
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function formatServerLogsForAgent(output: string): string {
  const stripped = stripAnsi(output).trimEnd();
  if (!stripped) return 'The dev server logs are currently empty.';

  const allLines = stripped.split('\n');
  const truncated = allLines.length > MAX_LOG_LINES_ON_SEND;
  const tail = truncated ? allLines.slice(-MAX_LOG_LINES_ON_SEND) : allLines;
  const skipped = allLines.length - tail.length;
  const header = truncated
    ? `Here are the last ${tail.length} lines of dev server output (${skipped} earlier lines omitted):`
    : "Here's the current dev server output:";

  return `${header}\n\n\`\`\`\n${tail.join('\n')}\n\`\`\``;
}

function formatSelectionForAgent(text: string, question: string): string {
  const cleaned = stripAnsi(text).replace(/\r$/gm, '').trimEnd();
  const parts = ['Here is a snippet from the dev server logs:', '', '```', cleaned, '```'];
  if (question.trim()) {
    parts.push('', question.trim());
  }
  return parts.join('\n');
}
