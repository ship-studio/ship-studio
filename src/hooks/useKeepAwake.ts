/**
 * "Keep this Mac awake", shared by every place that offers it (the Chief of
 * Staff's first-run line, the schedule popover's footnote), so turning it on
 * in one updates the other. Read from the backend on first use; the answer
 * is the assertion itself, never what we last asked for.
 *
 * @module hooks/useKeepAwake
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getKeepAwake, setKeepAwake, type KeepAwake } from '../lib/remoteAccess';
import { asCommandError, formatCommandError } from '../lib/errors';
import { useOptionalToast } from '../contexts/ToastContext';

let current: KeepAwake | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: KeepAwake) {
  current = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Null until the backend has answered. */
export function useKeepAwake(): { state: KeepAwake | null; turnOn: () => Promise<void> } {
  const state = useSyncExternalStore(subscribe, () => current);
  const { showToast } = useOptionalToast();

  useEffect(() => {
    if (current || loading) return;
    loading = getKeepAwake()
      .then(publish)
      .catch(() => {
        /* unknown: the action stays hidden */
      })
      .finally(() => {
        loading = null;
      });
  }, []);

  const turnOn = useCallback(async () => {
    try {
      publish(await setKeepAwake(true));
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  }, [showToast]);

  return { state, turnOn };
}
