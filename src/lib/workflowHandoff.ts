/**
 * Handing an inbox finding to a terminal.
 *
 * "Fix with agent" is the whole reason findings are worth reading: a finding is
 * the head of a work session, not a notification. But the Inbox is a home-level
 * screen and the terminal only exists inside a workspace, so the prompt has to
 * survive the navigation between them.
 *
 * This is a one-slot queue rather than a prop chain because the two ends are
 * far apart in the tree and the trip is asynchronous — opening a project mounts
 * a workspace, spawns a PTY, and starts an agent, and only then is there
 * anything to paste into.
 *
 * @module lib/workflowHandoff
 */

import { logger } from './logger';

interface PendingHandoff {
  projectPath: string;
  prompt: string;
  queuedAt: number;
}

/**
 * How long a queued prompt stays valid. Long enough to cover a cold project
 * open (dev server, PTY spawn, agent boot), short enough that a prompt queued
 * before the user changed their mind and went somewhere else doesn't ambush
 * them in an unrelated terminal an hour later.
 */
const TTL_MS = 3 * 60_000;

let pending: PendingHandoff | null = null;

/** Queue a prompt to be typed into `projectPath`'s terminal once it exists. */
export function queueHandoff(projectPath: string, prompt: string): void {
  pending = { projectPath, prompt, queuedAt: Date.now() };
  logger.info('[Workflows] Queued a fix handoff', { projectPath });
}

/**
 * The queued prompt for `projectPath`, without consuming it.
 *
 * Callers peek, attempt delivery, and only then {@link consumeHandoff} — a
 * retry loop that consumed first would drop the user's prompt on the floor the
 * moment the terminal wasn't ready yet.
 */
export function peekHandoff(projectPath: string): string | null {
  if (!pending || pending.projectPath !== projectPath) return null;
  if (Date.now() - pending.queuedAt > TTL_MS) {
    pending = null;
    return null;
  }
  return pending.prompt;
}

/**
 * Drop the queued prompt after it has been delivered.
 *
 * A prompt must be typed exactly once; this is what stops a retry loop pasting
 * the same instruction twice.
 */
export function consumeHandoff(): void {
  pending = null;
}

/** Drop anything queued. Used when the user navigates away deliberately. */
export function clearHandoff(): void {
  pending = null;
}
