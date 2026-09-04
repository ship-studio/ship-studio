/**
 * Delivers a queued "Fix with agent" prompt once a terminal exists.
 *
 * Opening a project is a multi-second, multi-stage affair (register, mount,
 * spawn a PTY, boot the agent) and there is no single "the agent is ready to
 * be typed at" signal to await. So this retries on a short interval and stops
 * on the first successful paste — bounded, so a project that never gets a
 * terminal doesn't leave a timer running for the rest of the session.
 *
 * @module hooks/useWorkflowHandoff
 */

import { useEffect } from 'react';
import { consumeHandoff, peekHandoff } from '../lib/workflowHandoff';
import { logger } from '../lib/logger';

const RETRY_MS = 700;
const GIVE_UP_MS = 60_000;

/**
 * What the user is told once the prompt lands.
 *
 * Deliberately explicit that the agent has *started*, not finished: a finding
 * handed over is the beginning of a change to review, and a toast that reads
 * like "done" would be the most expensive wrong impression this feature could
 * give.
 */
export const HANDOFF_DELIVERED_MESSAGE =
  'Sent to your agent — it has started on it, but nothing is fixed until you review it';

/**
 * @param projectPath The open project, or null when not in a workspace.
 * @param send Types a prompt into the active terminal. Returns whether it
 *   landed — false while no terminal is mounted yet.
 * @param onDelivered Optional notice for the user, e.g. a toast.
 */
export function useWorkflowHandoff(
  projectPath: string | null,
  send: (prompt: string) => boolean,
  onDelivered?: () => void
): void {
  useEffect(() => {
    if (!projectPath || peekHandoff(projectPath) === null) return;

    let timer: number | undefined;
    let cancelled = false;
    const deadline = Date.now() + GIVE_UP_MS;

    const attempt = () => {
      if (cancelled) return;
      // Peek, deliver, then consume: consuming first would drop the prompt
      // every time the terminal simply wasn't up yet.
      const prompt = peekHandoff(projectPath);
      if (prompt === null) return;
      if (send(prompt)) {
        consumeHandoff();
        onDelivered?.();
        return;
      }
      if (Date.now() > deadline) {
        logger.warn('[Workflows] Gave up delivering a fix handoff', { projectPath });
        return;
      }
      timer = window.setTimeout(attempt, RETRY_MS);
    };

    timer = window.setTimeout(attempt, RETRY_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectPath, send, onDelivered]);
}
