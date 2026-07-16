/**
 * Platform-aware keyboard-shortcut labels.
 *
 * The app is developed on macOS, so shortcut hints throughout the UI were
 * hardcoded with Mac glyphs (`⌘`, `⇧`, `⌥`, `⌃`). On Windows/Linux those glyphs
 * are meaningless — the modifier is `Ctrl`, not `⌘`. This module renders a
 * shortcut for the current platform so the *label* matches the key the user
 * actually presses.
 *
 * This only affects DISPLAY. The key handling itself is already cross-platform:
 * every handler checks `e.metaKey || e.ctrlKey`, and CodeMirror's `Mod-*`
 * bindings map to ⌘ on macOS and Ctrl elsewhere automatically.
 *
 * macOS output is byte-identical to the old hardcoded strings (glyphs, joined
 * tightly: `⌘⇧S`), so switching a call site to `kbd(...)` is a no-op on Mac and
 * a fix on Windows. Windows/Linux joins the parts with `+`: `Ctrl+Shift+S`.
 *
 * @module lib/shortcuts
 */

import { isMac } from './setup';

/** [macGlyph, windowsWord] for each named modifier token. */
const MODIFIERS: Record<string, [string, string]> = {
  mod: ['⌘', 'Ctrl'], // primary accelerator: ⌘ on macOS, Ctrl elsewhere
  shift: ['⇧', 'Shift'],
  alt: ['⌥', 'Alt'], // Option on Mac keyboards, Alt on Windows
  ctrl: ['⌃', 'Ctrl'], // the literal Control key (rare; distinct from `mod`)
};

/**
 * Render a keyboard shortcut for the current platform.
 *
 * Pass modifier tokens (`'mod' | 'shift' | 'alt' | 'ctrl'`) followed by the
 * literal key(s). Anything not a known modifier token is emitted verbatim, so
 * `kbd('mod', 'K')`, `kbd('mod', String(n))`, and `kbd('mod', '/')` all work.
 *
 * @example
 * kbd('mod', 'K')            // macOS: "⌘K"    · Windows: "Ctrl+K"
 * kbd('mod', 'shift', 'S')   // macOS: "⌘⇧S"   · Windows: "Ctrl+Shift+S"
 * kbd('mod', '1')            // macOS: "⌘1"    · Windows: "Ctrl+1"
 */
export function kbd(...tokens: string[]): string {
  const mac = isMac();
  const parts = tokens.map((token) => {
    const mod = MODIFIERS[token];
    if (!mod) return token; // literal key
    return mac ? mod[0] : mod[1];
  });
  // Mac convention packs glyphs with no separator (⌘⇧S); Windows/Linux spells
  // the words and joins them with '+' (Ctrl+Shift+S).
  return parts.join(mac ? '' : '+');
}

/** The primary-modifier label on its own: `⌘` on macOS, `Ctrl` elsewhere. */
export const modKey = (): string => (isMac() ? '⌘' : 'Ctrl');
