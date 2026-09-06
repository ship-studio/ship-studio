/**
 * Keeps the hosting section's answer current, without burning requests.
 *
 * Three rules shape the cadence:
 *
 * 1. **Only poll what someone is looking at.** The section it replaces ran a
 *    `vercel ls` every 15s and two `git` spawns every 3s for every open
 *    project, forever, whether or not the popover was open or the window even
 *    focused. This polls only while the popover is open and the window is
 *    visible and focused.
 * 2. **Match the cadence to the state.** A build in flight is worth a few
 *    seconds; a finished deployment does not change.
 * 3. **Back off on failure rather than hammering.** Transport errors are thrown
 *    so `usePolling`'s exponential backoff engages; auth and no-link states are
 *    returned as data and simply stop the poll, because nothing will change
 *    until the user acts.
 *
 * @module hooks/useHostingStatus
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from './usePolling';
import { getHostingStatus, deriveSectionState, isActive, shouldPoll } from '../lib/hosting';
import type { HostingStatus, SectionState } from '../lib/hosting';
import { logger } from '../lib/logger';

/** While something is moving. */
const ACTIVE_INTERVAL_MS = 4000;
/** Once it has settled, but the popover is still open. */
const SETTLED_INTERVAL_MS = 30000;

interface Options {
  projectPath: string;
  /** Only true while the popover is actually on screen. */
  open: boolean;
  /** When the user's push completed, so "not found" can be given a grace period. */
  pushedAt?: number;
}

interface Result {
  status: HostingStatus | null;
  state: SectionState;
  /** Force an immediate refetch — the Retry action. */
  refresh: () => void;
}

/** True when the window is both visible and focused. */
function useWindowActive(): boolean {
  const [active, setActive] = useState(() => typeof document === 'undefined' || !document.hidden);

  useEffect(() => {
    const update = () => setActive(!document.hidden && document.hasFocus());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    update();
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  return active;
}

export function useHostingStatus({ projectPath, open, pushedAt }: Options): Result {
  // The answer is stored with the project it describes. Clearing it in an
  // effect on `projectPath` would leave one render showing the previous
  // project's deployment under the new project's name.
  const [entry, setEntry] = useState<{ path: string; status: HostingStatus } | null>(null);
  const status = entry?.path === projectPath ? entry.status : null;

  const windowActive = useWindowActive();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchOnce = useCallback(async () => {
    const next = await getHostingStatus(projectPath);
    if (!mounted.current) return next;
    setEntry({ path: projectPath, status: next });

    // A transport failure is reported inside the payload rather than thrown,
    // so re-throw it here to engage the poller's backoff instead of retrying
    // an unreachable provider at full rate.
    const failing = next.providers.find((p) => p.transport_error);
    if (failing) {
      throw new Error(failing.transport_error ?? 'hosting provider unreachable');
    }
    return next;
  }, [projectPath]);

  const state = deriveSectionState(status, {
    pushedAt,
    stalenessMs: ACTIVE_INTERVAL_MS * 2,
  });

  const enabled = open && windowActive && Boolean(projectPath) && shouldPoll(state.kind);
  const intervalMs = isActive(state.kind) ? ACTIVE_INTERVAL_MS : SETTLED_INTERVAL_MS;

  // No separate "fetch on open" effect: the poller fires its first tick
  // immediately on start, and `enabled` flipping true starts it. Opening the
  // popover therefore fetches at once rather than after a full interval.
  usePolling(fetchOnce, { intervalMs, enabled, name: 'hosting-status' });

  const refresh = useCallback(() => {
    void fetchOnce().catch((err) => {
      logger.debug('hosting: manual refresh failed', { error: String(err) });
    });
  }, [fetchOnce]);

  return { status, state, refresh };
}
