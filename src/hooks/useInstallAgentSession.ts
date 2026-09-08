/**
 * Runs one built-in-install-agent session and reduces its event stream into
 * the small amount of state a screen actually needs.
 *
 * The driver is an async iterable, so the whole session is a `for await` in an
 * effect. Two consequences worth knowing:
 *
 * - Cancellation is breaking the loop. The AbortSignal covers the driver's own
 *   waits; unmounting aborts it and the loop exits on the next yield.
 * - `requestUser` blocks the driver. The hook parks the request in state and
 *   holds the driver on an unresolved promise until the UI answers, which is
 *   what makes "waiting on a human" a real pause rather than a race.
 *
 * @module hooks/useInstallAgentSession
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  InstallAgentDriver,
  InstallAgentRequest,
  InstallStepId,
  RecoveryChoice,
  StepFailure,
  UserActionRequest,
  UserActionResult,
} from '../lib/installAgent';
import { logger } from '../lib/logger';

export type StepState = 'pending' | 'working' | 'done' | 'skipped' | 'failed';

export interface InstallAgentSession {
  /** Per-step progress, keyed by step id. Missing means untouched. */
  steps: Partial<Record<InstallStepId, StepState>>;
  /** The agent's most recent line. Null before it says anything. */
  narration: string | null;
  /** Set while the driver is blocked on a person. */
  pendingUserAction: UserActionRequest | null;
  /** True between the user answering and the driver moving on. */
  respondingToUser: boolean;
  /** Answer the pending request. No-op when nothing is pending. */
  respond: (result: UserActionResult) => void;
  /** Set while a step has failed and the driver is waiting on a decision. */
  pendingRecovery: StepFailure | null;
  /** Choose what to do about the failed step. No-op when none is pending. */
  recover: (choice: RecoveryChoice) => void;
  /**
   * True when a step has been working far longer than it should, with no
   * events. Not a failure — we do not know that it failed, only that it has
   * gone quiet, and saying more than we know is how a progress screen starts
   * lying. The UI offers a way out rather than a diagnosis.
   */
  stalled: boolean;
  /** Steps the user abandoned. The completion copy has to account for these. */
  skipped: InstallStepId[];
  /**
   * Give up on the whole session and let the flow move on.
   *
   * The escape hatch for a step that has genuinely wedged. `recover('skip')`
   * cannot help there: it resolves a promise the driver is only waiting on
   * *after* a failure, and a hung step has not failed — it is still awaiting
   * something that will never arrive. Nothing can interrupt that except
   * abandoning the run, so that is what this does, honestly and out loud.
   */
  abandon: () => void;
  status: 'idle' | 'running' | 'complete' | 'blocked' | 'error';
  summary: string | null;
}

/**
 * How long a single step may go without any event before the UI admits
 * something might be wrong.
 *
 * Generous on purpose: a Homebrew install on a slow connection genuinely takes
 * minutes, and crying wolf at ninety seconds would train people to ignore the
 * one message that matters.
 */
const STALL_AFTER_MS = 240_000;

interface InstallAgentSessionOptions {
  enabled?: boolean;
  /**
   * Fires once, when the driver reports it has finished.
   *
   * A callback rather than something the caller watches `status` for: advancing
   * a flow is a reaction to an event, and expressing it as an effect on
   * `status` means a `setState` during render-commit, which React now flags as
   * a cascading render.
   */
  onDone?: (status: 'complete' | 'blocked', summary: string) => void;
}

export function useInstallAgentSession(
  driver: InstallAgentDriver,
  request: InstallAgentRequest,
  { enabled = true, onDone }: InstallAgentSessionOptions = {}
): InstallAgentSession {
  const [steps, setSteps] = useState<Partial<Record<InstallStepId, StepState>>>({});
  const [narration, setNarration] = useState<string | null>(null);
  const [pendingUserAction, setPendingUserAction] = useState<UserActionRequest | null>(null);
  const [respondingToUser, setRespondingToUser] = useState(false);
  const [status, setStatus] = useState<InstallAgentSession['status']>('idle');
  const [summary, setSummary] = useState<string | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<StepFailure | null>(null);
  const [skipped, setSkipped] = useState<InstallStepId[]>([]);
  const [stalled, setStalled] = useState(false);

  /** Resolver for the driver's in-flight `requestUser` promise. */
  const resolveUserRef = useRef<((result: UserActionResult) => void) | null>(null);
  /** Resolver for the driver's in-flight `requestRecovery` promise. */
  const resolveRecoveryRef = useRef<((choice: RecoveryChoice) => void) | null>(null);

  const respond = useCallback((result: UserActionResult) => {
    const resolve = resolveUserRef.current;
    if (!resolve) return;
    resolveUserRef.current = null;
    setRespondingToUser(true);
    resolve(result);
  }, []);

  /** Aborts the run and reports it, since an aborted driver reports nothing. */
  const abandonRef = useRef<(() => void) | null>(null);
  const abandon = useCallback(() => abandonRef.current?.(), []);

  const recover = useCallback((choice: RecoveryChoice) => {
    const resolve = resolveRecoveryRef.current;
    if (!resolve) return;
    resolveRecoveryRef.current = null;
    setPendingRecovery(null);
    resolve(choice);
  }, []);

  // The request is rebuilt on every render by most callers; freeze it for the
  // session so a new array identity doesn't restart an install mid-flight.
  const requestRef = useRef(request);

  // Same reason the request is frozen: an inline callback would restart the
  // install on every render if it were an effect dependency.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let cancelled = false;
    const frozenRequest = requestRef.current;

    const host = {
      requestUser(userRequest: UserActionRequest): Promise<UserActionResult> {
        return new Promise<UserActionResult>((resolve) => {
          resolveUserRef.current = resolve;
          setPendingUserAction(userRequest);
        });
      },
      requestRecovery(failure: StepFailure): Promise<RecoveryChoice> {
        return new Promise<RecoveryChoice>((resolve) => {
          resolveRecoveryRef.current = resolve;
          setPendingRecovery(failure);
        });
      },
    };

    abandonRef.current = () => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      clearTimeout(stallTimer);
      setStatus('blocked');
      setSummary('Setup was stopped before everything finished.');
      onDoneRef.current?.('blocked', 'Setup was stopped before everything finished.');
    };

    /**
     * Restarted on every event. A step that keeps reporting progress never
     * trips it; one that goes silent for minutes does.
     */
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStallWatch = (active: boolean) => {
      clearTimeout(stallTimer);
      setStalled(false);
      if (!active) return;
      stallTimer = setTimeout(() => setStalled(true), STALL_AFTER_MS);
    };

    void (async () => {
      setStatus('running');
      try {
        for await (const event of driver.run(frozenRequest, host, controller.signal)) {
          if (cancelled) return;

          // Any event at all is proof of life; only `step_start` re-arms the
          // watch, because only a running step can stall.
          armStallWatch(event.type === 'step_start');

          switch (event.type) {
            case 'say':
              setNarration(event.text);
              break;
            case 'step_start':
              setSteps((prev) => ({ ...prev, [event.step]: 'working' }));
              break;
            case 'step_end':
              setSteps((prev) => ({ ...prev, [event.step]: event.ok ? 'done' : 'failed' }));
              break;
            case 'step_skipped':
              setSteps((prev) => ({ ...prev, [event.step]: 'skipped' }));
              break;
            case 'awaiting_user':
              // The prompt is already showing — `requestUser` set it. This
              // event exists so a transcript view can record the moment too.
              break;
            case 'user_responded':
              setPendingUserAction(null);
              setRespondingToUser(false);
              break;
            case 'awaiting_recovery':
              // The prompt is already showing — `requestRecovery` set it.
              break;
            case 'recovery_chosen':
              if (event.choice === 'skip') {
                setSkipped((prev) => (prev.includes(event.step) ? prev : [...prev, event.step]));
                setSteps((prev) => ({ ...prev, [event.step]: 'skipped' }));
              }
              break;
            case 'done':
              if (event.skipped?.length) setSkipped(event.skipped);
              setStatus(event.status === 'complete' ? 'complete' : 'blocked');
              setSummary(event.summary);
              onDoneRef.current?.(event.status, event.summary);
              break;
          }
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        logger.warn('Install agent session failed', { error: err });
        setStatus('error');
        setSummary(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(stallTimer);
      // Unblock a driver parked on a human so its loop can exit.
      resolveUserRef.current?.({ ok: false, reason: 'cancelled' });
      resolveUserRef.current = null;
      resolveRecoveryRef.current?.('stop');
      resolveRecoveryRef.current = null;
      abandonRef.current = null;
    };
  }, [driver, enabled]);

  return {
    steps,
    narration,
    pendingUserAction,
    respondingToUser,
    respond,
    pendingRecovery,
    recover,
    stalled,
    skipped,
    abandon,
    status,
    summary,
  };
}
