/**
 * Copy the agent terminal's selection.
 *
 * xterm only copied on Ctrl+C, so a drag-select on macOS (where copy is
 * Cmd+C, and Ctrl+C is interrupt) never reached the clipboard. People were
 * screenshotting commands the agent told them to run (issue #1053).
 *
 * @module components/terminal/terminalCopy
 */

import { describeClipboardError, writeTextWithFocusRetry } from '../../hooks/useCopyToClipboard';
import { logger } from '../../lib/logger';

interface SelectionTerminal {
  getSelection(): string;
  onSelectionChange(listener: () => void): { dispose(): void };
}

/** Write `text` to the clipboard. Failures are logged and rethrown so the
 *  caller can keep the selection and tell the user. */
export async function copyTerminalText(text: string): Promise<void> {
  if (!text) return;
  try {
    await writeTextWithFocusRetry(text);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('[Terminal] Failed to copy selection to clipboard', {
      error: error.message,
    });
    throw error;
  }
}

export function terminalCopyFailureMessage(error: Error): string {
  return `Failed to copy to clipboard (${describeClipboardError(error)})`;
}

/** Copy, then clear. A failed write leaves the selection so the user can retry. */
export async function copyTerminalSelection(
  text: string,
  clearSelection: () => void
): Promise<void> {
  await copyTerminalText(text);
  clearSelection();
}

/**
 * Copy whatever is selected when a primary-button gesture ends.
 *
 * The gesture buffer remembers text sampled during the drag, including
 * after the pointer leaves the terminal, in case output clears the
 * selection before mouseup. A plain click resets that buffer on
 * mousedown, so it does not recopy the previous selection.
 */
export function bindTerminalCopyOnSelect(
  term: SelectionTerminal,
  container: HTMLElement,
  onError?: (error: Error) => void
): () => void {
  let gestureText = '';
  let dragging = false;
  const remember = () => {
    const text = term.getSelection();
    if (text) gestureText = text;
  };
  const selection = term.onSelectionChange(remember);
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    gestureText = '';
  };
  // xterm updates the selection on mousemove and only fires
  // onSelectionChange at mouseup. Sample during the drag, including after
  // the pointer leaves the terminal, so a redraw cannot erase the text
  // before the button comes up.
  const onMouseMove = () => {
    if (!dragging) return;
    remember();
  };
  const onMouseUp = (event: MouseEvent) => {
    if (!dragging || event.button !== 0) return;
    dragging = false;
    remember();
    const text = term.getSelection() || gestureText;
    gestureText = '';
    if (!text) return;
    void copyTerminalText(text).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
    });
  };
  container.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  return () => {
    selection.dispose();
    container.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}
