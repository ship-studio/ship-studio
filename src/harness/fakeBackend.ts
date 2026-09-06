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
 *
 * A fixture may also be a function, and a function that throws rejects the
 * call — see `rejectsWith` in `./reject`. Several surfaces (the merge-conflict
 * panel among them) are only reachable through a failed command, so a layer
 * that could only resolve would confine the harness to every feature's happy
 * path.
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

/**
 * When the app last asked the backend for anything.
 *
 * A fixed post-mount delay is not a readiness signal: a panel whose state
 * arrives on a second or third IPC round-trip lands before the delay on one
 * run and after it on the next, and the two screenshots disagree for reasons
 * that have nothing to do with the app. Waiting for IPC to fall quiet is the
 * signal that actually corresponds to "the UI has everything it asked for".
 */
let lastCallAt = Date.now();

export function ipcIdleFor(): number {
  return Date.now() - lastCallAt;
}

/** Resolve once no command has been invoked for `quietMs`. */
export function whenIpcQuiet(quietMs = 500, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (ipcIdleFor() >= quietMs || Date.now() > deadline) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
}

export function installFakeBackend(scenario: Scenario): void {
  mockWindows('main');

  const commands: CommandMap = { ...baseCommands, ...scenario.commands };

  mockIPC((cmd, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    // Tauri's own event plumbing polls constantly; counting it would mean IPC
    // never falls quiet.
    if (!cmd.startsWith('plugin:')) lastCallAt = Date.now();

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
