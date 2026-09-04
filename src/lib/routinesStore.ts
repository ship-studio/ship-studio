/**
 * Routines & Inbox — the frontend store.
 *
 * A `useSyncExternalStore` source over the Tauri commands in
 * `src-tauri/src/commands/routines/`, shaped like `sessionRegistry` so
 * components read it the same way they read session state.
 *
 * The backend is the authority. Anything that changes routines or the inbox —
 * a manual Run, the scheduler's tick, a routine file the user's *agent* just
 * wrote — emits `routines:changed`, and this store reloads. That matters
 * because the agent-authored path means files appear without the UI ever
 * having been touched.
 *
 * @module lib/routinesStore
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { logger } from './logger';
import type { InboxItem, ProgressLine, Routine, RoutineDraft, RoutineRun } from './routines';

/** Emitted by the backend whenever runs or the inbox change. */
const CHANGED_EVENT = 'routines:changed';

/** Emitted per activity line while a routine runs. */
const PROGRESS_EVENT = 'routines:progress';

/** Activity lines kept per routine in the UI. The backend keeps more. */
const MAX_PROGRESS_LINES = 120;

/**
 * Poll interval while the app is showing routines. The event covers everything
 * Ship Studio does itself; this catches the case the event cannot — a routine
 * file written directly on disk, which is exactly what happens when the user's
 * agent creates one through the bundled skill.
 */
const POLL_MS = 15_000;

interface RoutinesState {
  routines: Routine[];
  inbox: InboxItem[];
  /** Live activity per routine id, oldest first. */
  progress: Record<string, ProgressLine[]>;
  /** False until the first load resolves, so the UI can tell empty from unknown. */
  loaded: boolean;
  error: string | null;
}

let state: RoutinesState = {
  routines: [],
  inbox: [],
  progress: {},
  loaded: false,
  error: null,
};

const listeners = new Set<() => void>();
let unlisten: UnlistenFn | null = null;
let unlistenProgress: UnlistenFn | null = null;
let pollTimer: number | null = null;
let inFlight: Promise<void> | null = null;

function emit(next: RoutinesState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Subscribe to store changes. Pair with `getSnapshot` in `useSyncExternalStore`. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** Current state. Referentially stable until a mutation. */
export function getSnapshot(): RoutinesState {
  return state;
}

function start(): void {
  void refresh();
  if (pollTimer === null) {
    pollTimer = window.setInterval(() => void refresh(), POLL_MS);
  }
  if (unlisten === null) {
    void listen(CHANGED_EVENT, () => void refresh())
      .then((fn) => {
        // A late resolve after the last subscriber left must not leak a listener.
        if (listeners.size === 0) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err: unknown) => {
        logger.warn('[Routines] Could not subscribe to change events', { error: String(err) });
      });
  }
  if (unlistenProgress === null) {
    void listen<ProgressLine>(PROGRESS_EVENT, (event) => appendProgress(event.payload))
      .then((fn) => {
        if (listeners.size === 0) {
          fn();
          return;
        }
        unlistenProgress = fn;
      })
      .catch((err: unknown) => {
        logger.warn('[Routines] Could not subscribe to progress events', { error: String(err) });
      });
  }
}

function appendProgress(line: ProgressLine): void {
  const existing = state.progress[line.routineId] ?? [];
  const next = [...existing, line].slice(-MAX_PROGRESS_LINES);
  emit({ ...state, progress: { ...state.progress, [line.routineId]: next } });
}

/**
 * Pull the backend's buffer for one routine.
 *
 * A window opened mid-run has missed every event, so it asks once and follows
 * the stream from there.
 */
export async function loadProgress(routineId: string): Promise<void> {
  try {
    const lines = await invoke<ProgressLine[]>('routine_progress', { routineId });
    emit({ ...state, progress: { ...state.progress, [routineId]: lines } });
  } catch (err) {
    logger.warn('[Routines] Could not load progress', { error: String(err) });
  }
}

function stop(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  unlisten?.();
  unlisten = null;
  unlistenProgress?.();
  unlistenProgress = null;
}

/**
 * Reload routines and inbox from disk.
 *
 * Concurrent calls share one round trip: the event and the poll routinely land
 * together, and two overlapping loads can otherwise resolve out of order and
 * flip the list back to a stale snapshot.
 */
export async function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const [routines, inbox] = await Promise.all([
        invoke<Routine[]>('list_all_routines'),
        invoke<InboxItem[]>('list_inbox_items'),
      ]);
      emit({ ...state, routines, inbox, loaded: true, error: null });
    } catch (err) {
      logger.error('[Routines] Failed to load', { error: String(err) });
      emit({ ...state, loaded: true, error: String(err) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/* ------------------------------------------------------------- routines */

/**
 * Arm or disarm a routine's trigger.
 *
 * `autoRun` lives in the routine's own file, so this is a save like any other
 * — the switch in the list writes the same `auto-run:` line the editor does.
 */
export async function setAutoRun(routine: Routine, autoRun: boolean): Promise<void> {
  await saveRoutine(routine.projectPath, routine.slug, { ...toDraft(routine), autoRun });
}

/** The editable half of a routine. */
export function toDraft(routine: Routine): RoutineDraft {
  return {
    name: routine.name,
    icon: routine.icon,
    description: routine.description,
    agentId: routine.agentId,
    trigger: routine.trigger,
    permission: routine.permission,
    prompt: routine.prompt,
    severityFloor: routine.severityFloor,
    autoRun: routine.autoRun,
  };
}

/**
 * Create or update a routine file.
 *
 * `slug` is null to create (the backend derives one from the name and
 * de-duplicates it) and set to edit in place.
 */
export async function saveRoutine(
  projectPath: string,
  slug: string | null,
  draft: RoutineDraft
): Promise<Routine> {
  const saved = await invoke<Routine>('save_routine_file', { projectPath, slug, draft });
  await refresh();
  return saved;
}

/** Delete a routine file. Findings it already filed stay in the inbox. */
export async function deleteRoutine(projectPath: string, slug: string): Promise<void> {
  await invoke('delete_routine_file', { projectPath, slug });
  await refresh();
}

/**
 * Run a routine now.
 *
 * Resolves when the agent has finished and its findings are filed, which can be
 * minutes — callers should reflect `isRunning` from the store rather than
 * blocking on this promise for their spinner.
 */
export async function runRoutineNow(routine: Routine): Promise<RoutineRun> {
  const optimistic = state.routines.map((r) =>
    r.id === routine.id ? { ...r, isRunning: true } : r
  );
  emit({ ...state, routines: optimistic });
  try {
    return await invoke<RoutineRun>('run_routine', {
      projectPath: routine.projectPath,
      slug: routine.slug,
    });
  } finally {
    await refresh();
  }
}

/** Run history for one routine, newest first. */
export function listRuns(routineId: string): Promise<RoutineRun[]> {
  return invoke<RoutineRun[]>('list_routine_runs', { routineId });
}

/* ---------------------------------------------------------------- inbox */

export async function setItemRead(id: string, read: boolean): Promise<void> {
  await invoke('set_inbox_item_read', { id, read });
  await refresh();
}

export async function markAllRead(): Promise<void> {
  await invoke('mark_all_inbox_read');
  await refresh();
}

export async function setItemArchived(id: string, archived: boolean): Promise<void> {
  await invoke('set_inbox_item_archived', { id, archived });
  await refresh();
}

/** Permanently remove a finding. Archiving mutes it; this forgets it. */
export async function deleteItem(id: string): Promise<void> {
  await invoke('delete_inbox_item', { id });
  await refresh();
}

/** Unread, non-archived count — drives the sidebar badge. */
export function unreadCount(snapshot: RoutinesState = state): number {
  return snapshot.inbox.filter((item) => !item.read && !item.archived).length;
}
