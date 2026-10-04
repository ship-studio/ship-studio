/**
 * Copy the agent terminal's selection.
 *
 * xterm only copied on Ctrl+C, so a drag-select on macOS (where copy is
 * Cmd+C, and Ctrl+C is interrupt) never reached the clipboard. People were
 * screenshotting commands the agent told them to run (issue #1053).
 *
 * @module components/terminal/terminalCopy
 */

import { writeTextWithFocusRetry } from '../../hooks/useCopyToClipboard';
import { logger } from '../../lib/logger';

interface SelectionTerminal {
  getSelection(): string;
  onSelectionChange(listener: () => void): { dispose(): void };
}

/** Write `text` to the clipboard. Logs and swallows — a key or mouse
 *  handler must not throw. */
export async function copyTerminalText(text: string): Promise<void> {
  if (!text) return;
  try {
    await writeTextWithFocusRetry(text);
  } catch (err) {
    logger.warn('[Terminal] Failed to copy selection to clipboard', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Copy whatever is selected when a primary-button gesture ends.
 *
 * The gesture buffer remembers text xterm selected during the drag, in
 * case output clears the selection before mouseup. A plain click resets
 * that buffer on mousedown, so it does not recopy the previous selection.
 */
export function bindTerminalCopyOnSelect(
  term: SelectionTerminal,
  container: HTMLElement
): () => void {
  let gestureText = '';
  const selection = term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text) gestureText = text;
  });
  const onMouseDown = () => {
    gestureText = '';
  };
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const text = term.getSelection() || gestureText;
    gestureText = '';
    if (!text) return;
    void copyTerminalText(text);
  };
  container.addEventListener('mousedown', onMouseDown);
  container.addEventListener('mouseup', onMouseUp);
  return () => {
    selection.dispose();
    container.removeEventListener('mousedown', onMouseDown);
    container.removeEventListener('mouseup', onMouseUp);
  };
}
