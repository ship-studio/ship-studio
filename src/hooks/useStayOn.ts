/**
 * What keeps agents going on this Mac — keep awake, keep running when windows
 * close, open at login — shared by every place that offers it (the Chief of
 * Staff's first-run note, the schedule popover's footnote), so a change in
 * one shows in the other. Read from the backend on first use; the answer is
 * the thing itself, never what we last asked for.
 *
 * @module hooks/useStayOn
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getStayOn, setStayOn, type StayOn, type StayOnChange } from '../lib/remoteAccess';
import { asCommandError, formatCommandError } from '../lib/errors';
import { useOptionalToast } from '../contexts/ToastContext';

let current: StayOn | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: StayOn) {
  current = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Null until the backend has answered. */
export function useStayOn(): {
  state: StayOn | null;
  change: (change: StayOnChange) => Promise<void>;
} {
  const state = useSyncExternalStore(subscribe, () => current);
  const { showToast } = useOptionalToast();

  useEffect(() => {
    if (current || loading) return;
    loading = getStayOn()
      .then(publish)
      .catch(() => {
        /* unknown: the actions stay hidden */
      })
      .finally(() => {
        loading = null;
      });
  }, []);

  const change = useCallback(
    async (next: StayOnChange) => {
      try {
        publish(await setStayOn(next));
      } catch (error) {
        showToast(formatCommandError(asCommandError(error)), 'error');
      }
    },
    [showToast]
  );

  return { state, change };
}
