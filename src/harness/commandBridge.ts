/**
 * Drives the app through its own command palette registry.
 *
 * `CLAUDE.md` makes the palette a contract: *every* user-facing feature must
 * register its primary actions there. That makes the registry the app's own,
 * self-maintaining inventory of what a user can do — so the harness enumerates
 * it rather than keeping a hand-written list of screens that silently goes
 * stale the moment someone adds a feature.
 *
 * The practical effect: a new feature that follows the palette rule gets
 * harness coverage for free, and one that skips the rule shows up as a gap in
 * `harness-capture.mjs --commands` instead of being quietly invisible.
 */

import { getSnapshot, subscribe } from '../commands/registry';
import type { Command } from '../commands/types';

/** A command flattened to something a capture runner can serialize. */
export interface HarnessCommand {
  id: string;
  title: string;
  subtitle?: string;
  category: Command['category'];
  /** Which view the harness opens before running it. */
  context: 'home' | 'project' | 'other' | 'any';
}

function contextOf(cmd: Command): HarnessCommand['context'] {
  if (typeof cmd.when === 'string') return cmd.when;
  if (cmd.when === undefined) return 'any';
  // A predicate depends on live state we can't evaluate ahead of time. 'any'
  // is honest about that: the runner tries it and reports what happened,
  // rather than us guessing which view it belongs to.
  return 'any';
}

export function listCommands(): HarnessCommand[] {
  return getSnapshot()
    .map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      category: c.category,
      context: contextOf(c),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Run a registered command by id. Resolves once its handler settles, so a
 * capture happens after the surface it opens exists — not a frame before.
 */
export async function runCommand(id: string): Promise<boolean> {
  const cmd = getSnapshot().find((c) => c.id === id);
  if (!cmd) return false;
  await cmd.run();
  return true;
}

/**
 * Resolve once the registry has settled. Buckets register from feature hooks
 * across several effects, so the first non-empty snapshot is not the final
 * one — waiting for a quiet period avoids enumerating a half-built palette.
 */
export function whenRegistryStable(quietMs = 600, timeoutMs = 15_000): Promise<HarnessCommand[]> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: number;
    const settle = () => resolve(listCommands());
    const bump = () => {
      clearTimeout(timer);
      if (Date.now() > deadline) return settle();
      timer = window.setTimeout(settle, quietMs);
    };
    const unsubscribe = subscribe(bump);
    bump();
    void Promise.resolve().then(() => unsubscribe);
  });
}
