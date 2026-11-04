/**
 * Agents on the desktop: the quit guard's question, quick entry (the floating
 * composer on a system-wide shortcut), and the settings for both plus the
 * menu-bar icon. The native halves live in `agents/tray.rs` and
 * `agents/quick_entry.rs`; see docs/agents.md, "Menu bar, quit guard and
 * quick entry".
 *
 * @module lib/agentsDesktop
 */

import { invoke } from '@tauri-apps/api/core';
import type { Agent } from './agents';

// ---------------------------------------------------------------------------
// Quit guard
// ---------------------------------------------------------------------------

/** Mirrors `tray::QuitCheck`: who a quit would interrupt, by name. */
export interface QuitCheck {
  /** Mid-turn (or queued for a slot) and not waiting on you. */
  working: string[];
  /** An approval card is open. */
  waiting: string[];
}

/** A quit asked for from inside the page (the palette, a window close). */
export const QUIT_REQUEST_EVENT = 'shipstudio:confirm-quit';

/** Open the quit confirmation (or the guard, when agents are working). */
export function requestQuit(): void {
  window.dispatchEvent(new Event(QUIT_REQUEST_EVENT));
}

export const getQuitCheck = () => invoke<QuitCheck>('agents_quit_check');
export const keepRunningInBackground = () => invoke<void>('agents_keep_running_in_background');

export interface QuitPrompt {
  title: string;
  body: string;
  /** Offer "Keep running in background". */
  offerBackground: boolean;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "Acme Site", "Acme Site and Finance", "Acme Site, Finance and 2 others". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/**
 * What the quit dialog asks, or `null` when nothing would be interrupted and
 * the plain confirmation will do. Working agents lead; approvals waiting on
 * you are said after them, or lead when nothing is working.
 */
export function quitPrompt(
  check: QuitCheck | null,
  { backgroundAvailable }: { backgroundAvailable: boolean }
): QuitPrompt | null {
  if (!check) return null;
  const working = check.working.length;
  const waiting = check.waiting.length;
  if (working === 0 && waiting === 0) return null;

  const title =
    working > 0
      ? `${working} ${plural(working, 'agent is', 'agents are')} still working. Quit anyway?`
      : `${waiting} ${plural(waiting, 'agent is', 'agents are')} waiting for your OK. Quit anyway?`;

  const lines: string[] = [];
  if (working > 0) {
    lines.push(
      `Quitting stops ${nameList(check.working)} mid-turn; what ${plural(working, 'it has', 'they have')} done so far stays.`
    );
  }
  if (waiting > 0) {
    lines.push(
      working > 0
        ? `${nameList(check.waiting)} ${plural(waiting, 'is', 'are')} also waiting for your OK.`
        : `Quitting stops ${nameList(check.waiting)} waiting on ${plural(waiting, 'its', 'their')} approval.`
    );
  }
  return { title, body: lines.join(' '), offerBackground: backgroundAvailable };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Mirrors `quick_entry::Settings`. */
export interface DesktopSettings {
  supported: boolean;
  menuBarIcon: boolean;
  quickEntry: boolean;
  /** Stored form, e.g. `Alt+Space`. */
  shortcut: string;
  /** As shown, e.g. `⌥Space`. */
  shortcutLabel: string;
}

export interface DesktopSettingsChange {
  menuBarIcon?: boolean;
  quickEntry?: boolean;
  shortcut?: string;
}

export const getDesktopSettings = () => invoke<DesktopSettings>('agents_desktop_settings');
export const setDesktopSettings = (change: DesktopSettingsChange) =>
  invoke<DesktopSettings>('agents_set_desktop_settings', { ...change });

/** The keys a shortcut can end in, as `KeyboardEvent.code` (mirrors `quick_entry::key_label`). */
const PUNCTUATION: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

function keyLabel(code: string): string | null {
  if (code === 'Space') return 'Space';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return PUNCTUATION[code] ?? null;
}

type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

/**
 * A pressed combination as the backend stores it (`Ctrl+Alt+Shift+Super+<code>`),
 * or `null` while only modifiers are down or the key can't be a shortcut.
 * Uses `code`, not `key`: ⌥ changes the character a key types.
 */
export function acceleratorFromEvent(e: KeyLike): string | null {
  if (!keyLabel(e.code)) return null;
  const mods = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super',
  ].filter(Boolean);
  return [...mods, e.code].join('+');
}

/** `Ctrl+Alt+KeyK` → `⌃⌥K`, in macOS's modifier order. */
export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  const has = (...names: string[]) => parts.some((p) => names.includes(p));
  return (
    (has('Ctrl', 'Control') ? '⌃' : '') +
    (has('Alt', 'Option') ? '⌥' : '') +
    (has('Shift') ? '⇧' : '') +
    (has('Super', 'Cmd', 'Command', 'Meta') ? '⌘' : '') +
    (keyLabel(key) ?? key)
  );
}

// ---------------------------------------------------------------------------
// Quick entry
// ---------------------------------------------------------------------------

export const QUICK_ENTRY_EVENTS = {
  /** The composer was shown: reset, refocus, refetch the team. */
  shown: 'quick-entry://shown',
} as const;

export const hideQuickEntry = () => invoke<void>('quick_entry_hide');
/** Sent: focus goes back to the app it came from; the confirmation stays a moment. */
export const quickEntrySent = () => invoke<void>('quick_entry_sent');
export const openQuickEntryChat = (agentId: string) =>
  invoke<void>('quick_entry_open_chat', { agentId });
/** The screenshot's path, or null when the selection was cancelled. */
export const captureForQuickEntry = () => invoke<string | null>('quick_entry_capture');
export const resizeQuickEntry = (height: number) => invoke<void>('quick_entry_resize', { height });

/**
 * Who a quick message goes to: a leading "@Name" picks that agent (and is
 * taken off the text); otherwise the Chief of Staff. The longest matching
 * name wins, so "@Acme Site QA" isn't read as "@Acme Site".
 */
export function quickEntryRecipient(
  text: string,
  agents: Agent[]
): { agent: Agent | null; text: string; addressed: boolean } {
  const chief = agents.find((a) => a.isMain) ?? null;
  const lead = text.replace(/^\s+/, '');
  if (lead.startsWith('@')) {
    const after = lead.slice(1).toLowerCase();
    const named = [...agents]
      .filter((a) => !a.hidden)
      .sort((a, b) => b.name.length - a.name.length)
      .find((a) => {
        const name = a.name.toLowerCase();
        return after.startsWith(name) && !/[\w]/.test(after.charAt(name.length));
      });
    if (named) {
      return {
        agent: named,
        text: lead.slice(1 + named.name.length).replace(/^\s+/, ''),
        addressed: true,
      };
    }
  }
  return { agent: chief, text, addressed: false };
}
