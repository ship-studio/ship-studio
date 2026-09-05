/**
 * Delivers a queued "Send to agent" prompt once the project is open.
 *
 * Delivery is a *spawn*, not a paste. The prompt becomes the agent CLI's
 * opening argument in a brand-new tab, which is the only way it cannot be
 * lost: it is in the process's argv before the agent starts, so there is no
 * window where the terminal exists but the CLI is not yet listening, and
 * nothing has to press Return afterwards.
 *
 * The previous approach typed into whichever terminal happened to be active.
 * It failed in three ways at once — the paste landed while the CLI was still
 * booting and was swallowed; when it did survive it sat unsent in the input
 * box; and if the tab was mid-conversation it interrupted it.
 *
 * Opening a project is still several seconds of mounting and seeding, so this
 * waits for the terminal system to be ready for that project before asking for
 * the tab, and gives up rather than leaving a timer running for the session.
 *
 * @module hooks/useWorkflowHandoff
 */

import { useCallback, useEffect } from 'react';
import { consumeHandoff, peekHandoff } from '../lib/workflowHandoff';
import { logger } from '../lib/logger';

const RETRY_MS = 400;
const GIVE_UP_MS = 60_000;

/**
 * What the user is told once the agent is running with the finding.
 *
 * Deliberately explicit that the agent has *started*, not finished: a finding
 * handed over is the beginning of a change to review, and a toast that read
 * like "done" would be the most expensive wrong impression this feature could
 * give.
 */
export const HANDOFF_DELIVERED_MESSAGE =
  'Your agent is on it — nothing is fixed until you review what it does';

/** What the user is told when the prompt could not be delivered at all. */
export const HANDOFF_FAILED_MESSAGE =
  'Could not start an agent for this finding. Use Copy prompt and paste it into a terminal.';

/**
 * What the user is told when the project has no room for another tab.
 *
 * Worth its own sentence: retrying for a minute would change nothing, and
 * "could not start an agent" would send them looking for a fault that isn't
 * there.
 */
export const HANDOFF_NO_ROOM_MESSAGE =
  'That project already has the maximum number of agent tabs. Close one and send this again.';

interface HandoffDelivery {
  /**
   * Open a new agent tab for `projectPath` whose CLI starts with `prompt`.
   * Returns false while the project's terminal system is not ready yet.
   */
  startAgentWithPrompt: (projectPath: string, prompt: string) => boolean;
  onDelivered?: () => void;
  onFailed?: () => void;
  /** Stop immediately instead of retrying — the blocker will not clear itself. */
  failFast?: boolean;
}

/** The subset of the workspace's terminal bundle this needs. */
interface HandoffTerminals {
  /** Empty until the open project's tabs are seeded. */
  terminalTabs: readonly unknown[];
  /** The cap. A finding cannot be handed over once it is reached. */
  maxTerminalTabs: number;
  addTerminalTab: (
    agentId?: string,
    options?: { initialPrompt?: string; projectPath?: string }
  ) => void;
}

/**
 * The whole "Send to agent" delivery, wired.
 *
 * Lives here rather than in App so the rule it encodes stays next to the
 * reason for it: a finding is handed over by *starting a new agent with it*,
 * never by typing into whatever terminal is in front of the user.
 */
export function useFindingHandoff(
  currentProjectPath: string | null,
  { terminalTabs, maxTerminalTabs, addTerminalTab }: HandoffTerminals,
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void
): void {
  const terminalTabCount = terminalTabs.length;
  const startAgentWithPrompt = useCallback(
    (projectPath: string, prompt: string): boolean => {
      // Not ready until the project is the open one and its tabs are seeded —
      // the Inbox asks for this in the same breath as opening the project.
      if (currentProjectPath !== projectPath || terminalTabCount === 0) return false;
      // A new tab, so an in-flight conversation is never interrupted.
      addTerminalTab(undefined, { initialPrompt: prompt, projectPath });
      return true;
    },
    [currentProjectPath, terminalTabCount, addTerminalTab]
  );

  // At the cap, `addTerminalTab` no-ops. Without this the prompt would be
  // consumed by a call that did nothing and the finding would vanish — the
  // exact silent failure this rewrite exists to remove.
  const atCapacity =
    currentProjectPath !== null && terminalTabCount >= maxTerminalTabs && maxTerminalTabs > 0;

  const onDelivered = useCallback(
    () => showToast(HANDOFF_DELIVERED_MESSAGE, 'success'),
    [showToast]
  );
  const onFailed = useCallback(
    () => showToast(atCapacity ? HANDOFF_NO_ROOM_MESSAGE : HANDOFF_FAILED_MESSAGE, 'error'),
    [showToast, atCapacity]
  );

  useWorkflowHandoff(currentProjectPath, {
    startAgentWithPrompt,
    onDelivered,
    onFailed,
    failFast: atCapacity,
  });
}

export function useWorkflowHandoff(
  projectPath: string | null,
  { startAgentWithPrompt, onDelivered, onFailed, failFast = false }: HandoffDelivery
): void {
  useEffect(() => {
    if (!projectPath || peekHandoff(projectPath) === null) return;

    let timer: number | undefined;
    let cancelled = false;
    const deadline = Date.now() + GIVE_UP_MS;

    const attempt = () => {
      if (cancelled) return;
      // Peek, deliver, then consume: consuming first would drop the prompt
      // every time the workspace simply wasn't ready yet.
      const prompt = peekHandoff(projectPath);
      if (prompt === null) return;

      if (failFast) {
        consumeHandoff();
        logger.warn('[Workflows] Cannot hand a finding over right now', { projectPath });
        onFailed?.();
        return;
      }

      if (startAgentWithPrompt(projectPath, prompt)) {
        consumeHandoff();
        onDelivered?.();
        return;
      }
      if (Date.now() > deadline) {
        // Give the prompt back rather than leaving it queued to ambush a
        // terminal minutes from now.
        consumeHandoff();
        logger.warn('[Workflows] Gave up delivering a finding to an agent', { projectPath });
        onFailed?.();
        return;
      }
      timer = window.setTimeout(attempt, RETRY_MS);
    };

    timer = window.setTimeout(attempt, RETRY_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectPath, startAgentWithPrompt, onDelivered, onFailed, failFast]);
}
