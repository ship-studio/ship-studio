/**
 * Item actions for Phase 0 of the agent-led onboarding (getting one agent
 * installed + signed in). Mirrors the classic wizard's terminal-exit
 * verification semantics — a clean exit is a claim, not proof — but only for
 * agent items, which are all terminal-based. Under mock mode
 * (SHIPSTUDIO_FORCE_SETUP) actions resolve deterministically via the backend
 * mock state instead of spawning real processes, so contributors can click
 * through the whole flow on any machine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SetupItem,
  FullSetupStatus,
  TerminalCommand,
  TERMINAL_COMMANDS,
  USES_TERMINAL,
  checkClaudeAuthStatus,
  getFullSetupStatus,
  isSetupItemReady,
  recheckWithDelays,
} from '../../../lib/setup';
import { mockMarkSetupItemReady } from '../../../lib/agentOnboarding';
import { trackEvent } from '../../../lib/analytics';
import { withTimeout } from '../../../lib/withTimeout';
import {
  detectAlreadyLoggedIn,
  extractTerminalError,
  isNetworkError,
  isNodeMissingError,
} from '../../../lib/terminalDiagnostics';
import {
  alreadySignedInMessage,
  authFailureMessage,
  notDetectedMessage,
  NETWORK_FAILURE_MESSAGE,
} from '../setupFailureMessages';
import { logger } from '../../../lib/logger';

const SETUP_STATUS_TIMEOUT_MS = 15_000;
/** Simulated duration of a mock install/connect, long enough to see the spinner. */
const MOCK_ACTION_MS = 1200;

/** Configuration for the active terminal command */
export interface TerminalConfig extends TerminalCommand {
  itemId: string;
}

interface Params {
  /** Re-fetch setup status into the owner's `items` state. */
  fetchStatus: () => Promise<FullSetupStatus | null>;
  /** Patch a single item's status in the owner's `items` state. */
  updateItemStatus: (itemId: string, updates: Partial<SetupItem>) => void;
  /** Mock mode: resolve actions via backend mock state, no real processes. */
  mock: boolean;
}

export function useAgentSetupActions({ fetchStatus, updateItemStatus, mock }: Params) {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [terminalConfig, setTerminalConfig] = useState<TerminalConfig | null>(null);
  const [terminalExitCode, setTerminalExitCode] = useState<number | null>(null);

  // Staggered re-checks (600/1500/3000ms) outlive fast unmounts — their
  // continuations must not dispatch state into an unmounted tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleItemAction = useCallback(
    async (itemId: string) => {
      if (activeItemId || terminalConfig) return;
      const isAuth = itemId.endsWith('_auth');
      void trackEvent('setup_action_clicked', {
        item_id: itemId,
        action: isAuth ? 'connect' : 'install',
        step_id: 'agent_led_pick',
      });

      setActiveItemId(itemId);
      updateItemStatus(itemId, { status: 'in_progress', errorMessage: undefined });

      if (mock) {
        // Deterministic path for contributors: flip the backend mock state
        // after a visible beat. No real terminals, no host-machine changes.
        await new Promise((resolve) => setTimeout(resolve, MOCK_ACTION_MS));
        try {
          await mockMarkSetupItemReady(itemId);
        } catch (err) {
          logger.warn('Mock setup action failed', { itemId, error: String(err) });
        }
        if (!mountedRef.current) return;
        await fetchStatus();
        if (mountedRef.current) setActiveItemId(null);
        return;
      }

      // Auth items: re-check first — the user may have completed auth in a
      // previously cancelled terminal without the checklist updating. Only
      // skip the terminal when the CHECKLIST source agrees the item is ready;
      // if the quick probe and the checklist disagree, fall through and open
      // the login terminal anyway — the CLI's own flow is the tiebreaker the
      // user can actually see. (A probe-only early return here deadlocks the
      // button: it "loads" and nothing ever happens — the #159 failure shape.)
      if (itemId === 'claude_auth') {
        const isAuthed = await checkClaudeAuthStatus();
        if (!mountedRef.current) return;
        if (isAuthed) {
          const status = await fetchStatus();
          if (!mountedRef.current) return;
          if (status && isSetupItemReady(status.items, itemId)) {
            setActiveItemId(null);
            return;
          }
        }
      }

      // Every agent item (binary installs and auth flows) runs in a terminal.
      if (USES_TERMINAL.has(itemId)) {
        const cmd = TERMINAL_COMMANDS[itemId];
        if (cmd) {
          setTerminalConfig({ itemId, command: cmd.command, args: cmd.args });
          return;
        }
      }
      logger.warn('Agent-led pick phase asked to run a non-terminal item', { itemId });
      setActiveItemId(null);
    },
    [activeItemId, terminalConfig, mock, fetchStatus, updateItemStatus]
  );

  const handleTerminalExit = useCallback(
    async (exitCode: number | null, outputTail = '') => {
      const itemId = terminalConfig?.itemId;
      if (!itemId) return;

      if (exitCode === 0 || exitCode === null) {
        setTerminalConfig(null);
        setTerminalExitCode(null);

        // Verify the outcome actually landed — auth/token files and freshly
        // installed binaries can appear a beat after the process exits.
        let verified: boolean;
        if (itemId === 'claude_auth') {
          verified = await recheckWithDelays(() => checkClaudeAuthStatus());
        } else {
          verified = await recheckWithDelays(async () => {
            try {
              const status = await withTimeout(
                getFullSetupStatus(),
                SETUP_STATUS_TIMEOUT_MS,
                'Setup status check'
              );
              return isSetupItemReady(status.items, itemId);
            } catch {
              return false;
            }
          });
        }
        if (!mountedRef.current) return;

        await fetchStatus();
        if (!mountedRef.current) return;

        if (!verified) {
          void trackEvent('setup_action_failed', {
            item_id: itemId,
            exit_code: exitCode,
            error_excerpt: 'clean_exit_but_not_detected',
          });
          updateItemStatus(itemId, {
            status: 'error',
            errorMessage: itemId.endsWith('_auth')
              ? authFailureMessage(itemId, outputTail)
              : notDetectedMessage(itemId),
          });
        }
      } else {
        setTerminalExitCode(exitCode);

        // Surface the actual failure from the terminal output instead of a
        // generic message. Append guidance to the raw error, never replace it.
        const extractedError = extractTerminalError(outputTail);
        const alreadySignedIn = itemId.endsWith('_auth') ? detectAlreadyLoggedIn(outputTail) : null;
        const networkMessage = isNetworkError(outputTail) ? NETWORK_FAILURE_MESSAGE : null;
        let errorMessage =
          networkMessage && extractedError
            ? `${extractedError} — ${NETWORK_FAILURE_MESSAGE}`
            : (networkMessage ?? extractedError ?? 'Command failed. Click to try again.');
        if (isNodeMissingError(outputTail)) {
          errorMessage =
            "Node.js/npm wasn't found. This agent needs Node.js — pick one with a native installer (like Claude Code), or use classic onboarding to install Node.js first.";
        } else if (alreadySignedIn) {
          errorMessage = alreadySignedInMessage(itemId, alreadySignedIn.identity);
        }
        void trackEvent('setup_action_failed', {
          item_id: itemId,
          exit_code: exitCode,
          error_excerpt: extractedError ?? undefined,
        });
        updateItemStatus(itemId, { status: 'error', errorMessage });
      }

      setActiveItemId(null);
    },
    [terminalConfig, fetchStatus, updateItemStatus]
  );

  const handleTerminalCancel = useCallback(() => {
    const itemId = terminalConfig?.itemId;
    setTerminalConfig(null);
    setTerminalExitCode(null);
    setActiveItemId(null);

    if (itemId && !terminalExitCode) {
      void fetchStatus();
      // Auth flows may still be writing the token when the user cancels
      // (e.g. after the OAuth browser callback) — re-check once more.
      if (itemId.endsWith('_auth')) {
        setTimeout(() => void fetchStatus(), 2000);
      }
    }
  }, [terminalConfig, terminalExitCode, fetchStatus]);

  return {
    activeItemId,
    terminalConfig,
    terminalExitCode,
    handleItemAction,
    handleTerminalExit,
    handleTerminalCancel,
  };
}
