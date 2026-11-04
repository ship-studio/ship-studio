/**
 * Agents on the desktop: the quit guard, quick entry's floating composer, and
 * the settings for the menu-bar icon and the quick-message shortcut.
 *
 * The menu-bar icon and the shortcut itself are native (agents/tray.rs,
 * agents/quick_entry.rs) and can't be drawn here; their logic is unit-tested
 * in Rust. What is here is every piece of React UI they lead to.
 */

import type { Scenario } from '../types';
import { msg, now, overview } from './agents';

/** The composer's window is 600pt wide; the capture gives it a little air. */
const QUICK_ENTRY_VIEWPORT = { width: 600, height: 320 };
const SCREENSHOT = '/harness/agents-demo/attachments/m-att1/Pricing on mobile.jpg';

const quickEntryCommands = {
  agents_overview: overview(),
  quick_entry_hide: null,
  quick_entry_resize: null,
  quick_entry_sent: null,
  quick_entry_open_chat: null,
  quick_entry_capture: SCREENSHOT,
  agents_inspect_files: (args: Record<string, unknown>) =>
    (args.paths as string[]).map((path) => ({
      path,
      name: 'Screenshot 2026-11-04 at 10.42.18.png',
      mime: 'image/jpeg',
      size: 40_266,
    })),
  agents_send: (args: Record<string, unknown>) => ({
    ...msg('user', String(args.text), 0, { agentId: String(args.agentId) }),
    ts: now,
  }),
  start_dictation: null,
  cancel_dictation: null,
  stop_dictation: null,
};

export const agentsDesktopScenarios: Scenario[] = [
  {
    id: 'agents-quit-guard',
    title: 'Quit — agents still working (⌘Q, menu-bar Quit)',
    looksRightWhen:
      'A small centred alert, not the plain “Are you sure?”: a semibold line “2 agents are still working. Quit anyway?”, then one muted paragraph naming them (“Quitting stops Acme Site and Native App mid-turn…”), saying Lead Gen is also waiting for your OK, and that Keep running in background hides the window instead. Three full-width buttons stacked like a macOS alert: Keep running in background (green, focused), Quit (danger), Cancel (outline).',
    command: 'app.quit',
    requires: '.quit-confirm-modal--guard',
    commands: {
      agents_quit_check: { working: ['Acme Site', 'Native App'], waiting: ['Lead Gen'] },
    },
  },
  {
    id: 'agents-quit-guard-approval',
    title: 'Quit — only an approval waiting',
    looksRightWhen:
      'The guard leads with “1 agent is waiting for your OK. Quit anyway?” and says quitting stops Lead Gen waiting on its approval. Same three stacked buttons.',
    command: 'app.quit',
    requires: '.quit-confirm-modal--guard',
    commands: {
      agents_quit_check: { working: [], waiting: ['Lead Gen'] },
    },
  },
  {
    id: 'agents-quit-plain',
    title: 'Quit — nothing working (unchanged)',
    looksRightWhen:
      'Exactly the old confirmation: “Are you sure you want to quit Ship Studio?” with Cancel and Quit side by side, Quit focused. No agent wording.',
    command: 'app.quit',
    requires: '.quit-confirm-modal:not(.quit-confirm-modal--guard)',
    commands: {},
  },
  {
    id: 'agents-quick-entry',
    title: 'Quick entry — just opened (⌥Space)',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'A floating card with a soft shadow on a transparent window: a muted “To” line with the Chief of Staff’s mini badge and name, “@name for another agent”, and a small “esc” keycap at the right. Under it the same composer as a chat — the field (“Message Chief of Staff”), a camera button on the left, mic and send on the right — and one muted line below the card about Screen Recording permission.',
    requires: '.quick-entry__composer',
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-mention',
    title: 'Quick entry — @ picks who it goes to',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'Typing “@fi” opens the mention menu under the field, in the card (not floating above the window): Finance first, highlighted. The window grows to fit it.',
    requires: '.quick-entry .agent-mention-menu',
    steps: [{ fill: '.quick-entry__input', value: '@fi' }],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-addressed',
    title: 'Quick entry — addressed to another agent',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'With “@Finance chase Northwind…” typed, the To line shows Finance’s orange badge and name, and the “@name for another agent” hint is gone. Send is green.',
    requires: '.quick-entry__composer',
    steps: [
      {
        fill: '.quick-entry__input',
        value: '@Finance chase Northwind about the $4,200 invoice, politely',
      },
    ],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-screenshot',
    title: 'Quick entry — a screenshot attached',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'After the camera button, the selection comes back as an image chip above the field (the chat composer’s chip, with its remove ×). The permission note is gone: a screenshot has worked.',
    requires: '.quick-entry .agent-attachment-chip',
    steps: [{ click: '.quick-entry__shot' }],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-quick-entry-sent',
    title: 'Quick entry — sent',
    root: 'quick-entry',
    viewport: QUICK_ENTRY_VIEWPORT,
    looksRightWhen:
      'The composer has become one quiet line on the same card: a green tick, “Sent to Chief of Staff”, and a green “Open chat” text action. Nothing else; the window hides itself a moment later.',
    requires: '.quick-entry__sent',
    steps: [
      { fill: '.quick-entry__input', value: 'Book me a table for 4 on Friday, somewhere quiet' },
      { click: '.quick-entry__composer .agent-composer__send' },
    ],
    commands: quickEntryCommands,
  },
  {
    id: 'agents-desktop-settings',
    title: 'Settings — Agents in the menu bar, Quick message',
    looksRightWhen:
      'At the end of Settings → General, two rows in the same style as the others: “Agents in the menu bar” (off; on by default once Agents has been used, or while Keep running when closed is on) and “Quick message” (on), whose description names ⌥Space, @name, dictation and the Screen Recording prompt, with a small field showing ⌥Space under it.',
    command: 'agents.desktopSettings',
    requires: '.agents-desktop-settings .agents-shortcut-field',
    clipSelector: '.agents-desktop-settings',
    commands: {
      agents_desktop_settings: {
        supported: true,
        menuBarIcon: false,
        quickEntry: true,
        shortcut: 'Alt+Space',
        shortcutLabel: '⌥Space',
      },
    },
  },
];
