/**
 * Routines & Inbox — prototype store.
 *
 * PROTOTYPE ONLY. An in-memory store over the fixtures in `./routines`, shaped
 * like `sessionRegistry` so components can read it with `useSyncExternalStore`.
 * The real feature would back these reads with Tauri commands over
 * `.shipstudio/routines/` and `.shipstudio/inbox/` — see `docs/routines-inbox.md`.
 *
 * "Run now" fakes a run on a timer so the list has something live in it. It
 * spawns nothing.
 *
 * @module lib/routinesStore
 */

import {
  FIXTURE_INBOX,
  FIXTURE_ROUTINES,
  type InboxItem,
  type Routine,
  type RoutineRun,
} from './routines';

interface RoutinesState {
  routines: Routine[];
  inbox: InboxItem[];
}

let state: RoutinesState = {
  routines: FIXTURE_ROUTINES,
  inbox: FIXTURE_INBOX,
};

const listeners = new Set<() => void>();

function emit(next: RoutinesState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Subscribe to store changes. Pair with `getSnapshot` in `useSyncExternalStore`. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current state. Referentially stable until a mutation. */
export function getSnapshot(): RoutinesState {
  return state;
}

/* ------------------------------------------------------------- routines */

/** Flip a routine's enabled flag. Disabling clears its next run. */
export function toggleRoutine(id: string, enabled: boolean): void {
  emit({
    ...state,
    routines: state.routines.map((routine) =>
      routine.id === id
        ? {
            ...routine,
            enabled,
            nextRunAt:
              enabled && routine.trigger.kind !== 'event' ? Date.now() + 30 * 60_000 : null,
            // A paused routine has no window to miss.
            missedSince: enabled ? routine.missedSince : null,
          }
        : routine
    ),
  });
}

/** Create or replace a routine. */
export function saveRoutine(routine: Routine): void {
  const exists = state.routines.some((r) => r.id === routine.id);
  emit({
    ...state,
    routines: exists
      ? state.routines.map((r) => (r.id === routine.id ? routine : r))
      : [routine, ...state.routines],
  });
}

/** Remove a routine. Its already-filed inbox items stay. */
export function deleteRoutine(id: string): void {
  emit({ ...state, routines: state.routines.filter((routine) => routine.id !== id) });
}

/**
 * Fake a run: mark the routine running, then settle after a beat.
 *
 * The real implementation spawns the agent headless and streams its output;
 * this exists so the prototype's "Run now" does something visible.
 */
export function runRoutineNow(id: string): void {
  const routine = state.routines.find((r) => r.id === id);
  if (!routine || routine.runs[0]?.status === 'running') return;

  const runId = `run-${id}-${Date.now()}`;
  const pending: RoutineRun = {
    id: runId,
    startedAt: Date.now(),
    durationMs: 0,
    status: 'running',
    findings: 0,
    tokens: 0,
    transcript: routine.runs[0]?.transcript ?? '',
  };

  emit({
    ...state,
    routines: state.routines.map((r) => (r.id === id ? { ...r, runs: [pending, ...r.runs] } : r)),
  });

  window.setTimeout(() => {
    emit({
      ...state,
      routines: state.routines.map((r) =>
        r.id === id
          ? {
              ...r,
              nextRunAt: r.trigger.kind === 'event' ? null : Date.now() + 30 * 60_000,
              // A completed run closes any window that was missed while the
              // app was closed.
              missedSince: null,
              runs: r.runs.map((run) =>
                run.id === runId
                  ? {
                      ...run,
                      status: 'ok',
                      durationMs: 24_600,
                      tokens: 9_400,
                    }
                  : run
              ),
            }
          : r
      ),
    });
  }, 2600);
}

/* ---------------------------------------------------------------- inbox */

/** Mark one item read or unread. */
export function setItemRead(id: string, read: boolean): void {
  emit({
    ...state,
    inbox: state.inbox.map((item) => (item.id === id ? { ...item, read } : item)),
  });
}

/** Mark every non-archived item read. */
export function markAllRead(): void {
  emit({ ...state, inbox: state.inbox.map((item) => ({ ...item, read: true })) });
}

/** Archive or restore an item. Archiving also mutes its fingerprint. */
export function setItemArchived(id: string, archived: boolean): void {
  emit({
    ...state,
    inbox: state.inbox.map((item) =>
      item.id === id ? { ...item, archived, read: archived ? true : item.read } : item
    ),
  });
}

/** Unread, non-archived count — drives the sidebar badge. */
export function unreadCount(snapshot: RoutinesState = state): number {
  return snapshot.inbox.filter((item) => !item.read && !item.archived).length;
}
