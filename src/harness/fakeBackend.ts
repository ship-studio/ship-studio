/**
 * The harness's fake Tauri backend.
 *
 * Installs `window.__TAURI_INTERNALS__` via the official `mockIPC`, the same
 * mechanism the vitest suite uses, so the app under test is the real app —
 * real components, real CSS, real state machines — with only the IPC boundary
 * replaced.
 *
 * Two rules keep it honest:
 *
 * 1. A command with no fixture is *recorded*, not invented. It returns
 *    `undefined` and shows up in the harness badge and in
 *    `window.__harness.unhandled`.
 * 2. Plugin channels the app cannot run in a browser (PTY, screenshots,
 *    updater) are answered with explicit inert values rather than left to
 *    throw, because an uncaught boot error hides everything downstream.
 */

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { CommandHandler, CommandMap, Scenario } from './types';
import { baseCommands } from './scenarios/base';
import { recordUnhandled } from './unhandled';

/** Tauri plugin channels answered inertly so boot never dies on them. */
const PLUGIN_DEFAULTS: Record<string, unknown> = {
  'plugin:event|listen': 0,
  'plugin:event|unlisten': null,
  'plugin:event|emit': null,
  'plugin:window|is_maximized': false,
  'plugin:window|theme': 'dark',
  'plugin:updater|check': null,
  'plugin:opener|open_url': null,
  'plugin:path|resolve_directory': '/Users/harness',
};

function isHandler(value: unknown): value is CommandHandler {
  return typeof value === 'function';
}

export function installFakeBackend(scenario: Scenario): void {
  mockWindows('main');

  const commands: CommandMap = { ...baseCommands, ...scenario.commands };

  mockIPC((cmd, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;

    if (cmd in commands) {
      const value = commands[cmd];
      return isHandler(value) ? value(payload) : value;
    }

    if (cmd in PLUGIN_DEFAULTS) return PLUGIN_DEFAULTS[cmd];

    // Tauri's internal plumbing — noise, not a missing fixture.
    if (cmd.startsWith('plugin:')) return null;

    recordUnhandled(cmd, payload);
    return undefined;
  });
}
