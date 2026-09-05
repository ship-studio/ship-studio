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

import { trackEvent } from './analytics';
import { logger } from './logger';

/**
 * The shape of the finding being handed over — what analytics needs to say
 * "a critical finding became work" without carrying the finding itself.
 */
export interface HandoffFinding {
  severity: string;
  occurrences: number;
}

/** How a "Fix in project" ended. */
export type HandoffOutcome = 'delivered' | 'no_room' | 'failed';

interface PendingHandoff {
  projectPath: string;
  prompt: string;
  queuedAt: number;
  finding: HandoffFinding | null;
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
export function queueHandoff(
  projectPath: string,
  prompt: string,
  finding: HandoffFinding | null = null
): void {
  pending = { projectPath, prompt, queuedAt: Date.now(), finding };
  logger.info('[Workflows] Queued a fix handoff', { projectPath });
}

/** The live record for `projectPath`, dropping it if it has expired. */
function current(projectPath: string): PendingHandoff | null {
  if (!pending || pending.projectPath !== projectPath) return null;
  if (Date.now() - pending.queuedAt > TTL_MS) {
    pending = null;
    return null;
  }
  return pending;
}

/**
 * The queued prompt for `projectPath`, without consuming it.
 *
 * Callers peek, attempt delivery, and only then {@link consumeHandoff} — a
 * retry loop that consumed first would drop the user's prompt on the floor the
 * moment the terminal wasn't ready yet.
 */
export function peekHandoff(projectPath: string): string | null {
  return current(projectPath)?.prompt ?? null;
}

/** The finding behind the queued prompt, for reporting how the handoff ended. */
export function peekHandoffFinding(projectPath: string): HandoffFinding | null {
  return current(projectPath)?.finding ?? null;
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

/**
 * Report how a "Fix in project" ended.
 *
 * One event per fix, carrying the outcome, rather than a click event followed
 * by a separate delivery event — the question is "does a finding become work?",
 * and that is only answerable once the agent has (or hasn't) started. Shape
 * only: severity and recurrence count, never the finding or the prompt.
 */
export function trackFindingFix(finding: HandoffFinding | null, outcome: HandoffOutcome): void {
  void trackEvent('workflow_finding_action', {
    action: 'fix',
    outcome,
    severity: finding?.severity ?? null,
    occurrences: finding?.occurrences ?? null,
  });
}
