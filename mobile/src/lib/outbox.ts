/**
 * Sends written while the Mac couldn't be reached. They go out by
 * themselves when it answers, but only for a short while: a message
 * arriving hours after it was written, with no one watching, is worse than
 * one that waits for you to press Send. Past the window a waiting send
 * becomes "Not sent · Send" and stays yours to send or discard.
 *
 * Flushing is safe to repeat: each send carries its `clientId`, and the Mac
 * returns the original message for one it has already seen.
 */

import type { PendingSend, SyncState } from './sync';
import { WireFailure } from './transport';

/** How long a send waits for the Mac on its own. */
export const OUTBOX_WAIT_MS = 10 * 60_000;

/** Which waiting sends to send now, and which have waited too long. */
export function outboxPlan(
  pending: SyncState['pending'],
  now: number
): { flush: PendingSend[]; expire: PendingSend[] } {
  const flush: PendingSend[] = [];
  const expire: PendingSend[] = [];
  for (const list of Object.values(pending)) {
    for (const p of list) {
      if (!p.waiting) continue;
      (now - p.ts < OUTBOX_WAIT_MS ? flush : expire).push(p);
    }
  }
  // Oldest first, so a chat's sends arrive in the order they were written.
  flush.sort((a, b) => a.ts - b.ts);
  return { flush, expire };
}

/**
 * The send may not have reached the Mac (no link, or no answer in time):
 * worth sending again with the same `clientId`. A refusal is final.
 */
export function unreached(error: unknown): boolean {
  if (!(error instanceof WireFailure)) return false;
  const e = error.error;
  return e.type === 'Timeout' || (e.type === 'Protocol' && e.code === 'not_connected');
}

/**
 * Pending sends restored from disk after a restart. One that was in flight
 * when the app died may or may not have reached the Mac; it waits, and the
 * `clientId` makes sending it again harmless.
 */
export function restorePending(pending: SyncState['pending']): SyncState['pending'] {
  return Object.fromEntries(
    Object.entries(pending).map(([id, list]) => [
      id,
      list.map((p) => (p.failed || p.waiting ? p : { ...p, waiting: true })),
    ])
  );
}
