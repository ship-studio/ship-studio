/**
 * Native clipboard access for the embedded terminals.
 *
 * On Windows, WebView2 gates keyboard-initiated textarea paste behind an
 * async clipboard permission wait, so Ctrl+V into a terminal takes ~30s or
 * never lands (issue #157). The terminals intercept the chord (Windows only)
 * and read the clipboard natively through these wrappers instead, then feed
 * the content to xterm via `term.paste()`.
 *
 * @module lib/clipboard
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Read the system clipboard as text via the native backend.
 * Resolves to `null` when the clipboard holds no text (e.g. it's empty or
 * contains an image).
 */
export async function readClipboardText(): Promise<string | null> {
  return invoke<string | null>('read_clipboard_text');
}

/**
 * If the system clipboard holds an image (e.g. a screenshot), write it to a
 * temp PNG and return its absolute path — ready to be pasted into a terminal
 * the same way drag-dropped files are. Resolves to `null` when the clipboard
 * holds no image.
 */
export async function stageClipboardImage(): Promise<string | null> {
  return invoke<string | null>('stage_clipboard_image');
}

/** The subset of KeyboardEvent that paste-chord detection needs. */
export interface PasteChordEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * True only for a plain Ctrl+V keydown (no Shift/Alt/Meta) — the paste chord
 * the Windows terminals intercept. Keyup/keypress and every other modifier
 * combination (e.g. Ctrl+Shift+V) return false.
 */
export function isPasteChord(event: PasteChordEvent): boolean {
  return (
    event.type === 'keydown' &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'v'
  );
}

/**
 * True when this keydown should copy the terminal selection instead of
 * going to the PTY.
 *
 * Ctrl+C on every platform. Cmd+C only when `mac` is set — on Windows Meta
 * is the Windows key and must not steal the chord. Shift and Alt stay with
 * the PTY (Ctrl+Shift+C is a different shortcut). Callers still check that
 * a selection exists; with no selection, Ctrl+C remains SIGINT.
 */
export function isCopySelectionChord(event: PasteChordEvent, mac: boolean): boolean {
  if (event.type !== 'keydown' || event.shiftKey || event.altKey) return false;
  if (event.key.toLowerCase() !== 'c') return false;
  if (event.ctrlKey && !event.metaKey) return true;
  return mac && event.metaKey && !event.ctrlKey;
}
