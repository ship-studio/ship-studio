/**
 * Workflows & Inbox — the frontend store.
 *
 * A `useSyncExternalStore` source over the Tauri commands in
 * `src-tauri/src/commands/workflows/`, shaped like `sessionRegistry` so
 * components read it the same way they read session state.
 *
 * The backend is the authority. Anything that changes workflows or the inbox —
 * a manual Run, the scheduler's tick, a workflow file the user's *agent* just
 * wrote — emits `workflows:changed`, and this store reloads. That matters
 * because the agent-authored path means files appear without the UI ever
 * having been touched.
 *
 * @module lib/workflowsStore
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { logger } from './logger';
import type { InboxItem, ProgressLine, Workflow, WorkflowDraft, WorkflowRun } from './workflows';

/** Emitted by the backend whenever runs or the inbox change. */
const CHANGED_EVENT = 'workflows:changed';

/** Emitted per activity line while a workflow runs. */
const PROGRESS_EVENT = 'workflows:progress';

/** Activity lines kept per workflow in the UI. The backend keeps more. */
const MAX_PROGRESS_LINES = 120;

/**
 * Poll interval while the app is showing workflows. The event covers everything
 * Ship Studio does itself; this catches the case the event cannot — a workflow
 * file written directly on disk, which is exactly what happens when the user's
 * agent creates one through the bundled skill.
 */
const POLL_MS = 15_000;

interface WorkflowsState {
  workflows: Workflow[];
  inbox: InboxItem[];
  /** Live activity per workflow id, oldest first. */
  progress: Record<string, ProgressLine[]>;
  /** False until the first load resolves, so the UI can tell empty from unknown. */
  loaded: boolean;
  error: string | null;
}

let state: WorkflowsState = {
  workflows: [],
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
let queued: Promise<void> | null = null;

function emit(next: WorkflowsState): void {
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
export function getSnapshot(): WorkflowsState {
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
        logger.warn('[Workflows] Could not subscribe to change events', { error: String(err) });
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
        logger.warn('[Workflows] Could not subscribe to progress events', { error: String(err) });
      });
  }
}

function appendProgress(line: ProgressLine): void {
  const existing = state.progress[line.workflowId] ?? [];
  const next = [...existing, line].slice(-MAX_PROGRESS_LINES);
  emit({ ...state, progress: { ...state.progress, [line.workflowId]: next } });
}

/**
 * Pull the backend's buffer for one workflow.
 *
 * A window opened mid-run has missed every event, so it asks once and follows
 * the stream from there.
 */
export async function loadProgress(workflowId: string): Promise<void> {
  try {
    const lines = await invoke<ProgressLine[]>('workflow_progress', { workflowId });
    emit({ ...state, progress: { ...state.progress, [workflowId]: lines } });
  } catch (err) {
    logger.warn('[Workflows] Could not load progress', { error: String(err) });
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

async function load(): Promise<void> {
  try {
    const [workflows, inbox] = await Promise.all([
      invoke<Workflow[]>('list_all_workflows'),
      invoke<InboxItem[]>('list_inbox_items'),
    ]);
    emit({ ...state, workflows, inbox, loaded: true, error: null });
  } catch (err) {
    logger.error('[Workflows] Failed to load', { error: String(err) });
    emit({ ...state, loaded: true, error: String(err) });
  }
}

/**
 * Reload workflows and inbox from disk.
 *
 * Concurrent calls collapse into at most one follow-up round trip rather than
 * sharing the one already in flight. Sharing looks tidier and is wrong: every
 * mutation here is "write, then refresh", and a load whose request went out
 * *before* the write answers with pre-write data — so archiving a finding would
 * see it bounce back into the list until the next poll. One extra round trip in
 * a rare race is much cheaper than a UI that undoes the user's click.
 */
export function refresh(): Promise<void> {
  if (inFlight === null) {
    inFlight = load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  queued ??= inFlight
    .catch(() => {})
    .then(() => {
      queued = null;
      return refresh();
    });
  return queued;
}

/* ------------------------------------------------------------- workflows */

/**
 * Arm or disarm a workflow's trigger.
 *
 * `autoRun` lives in the workflow's own file, so this is a save like any other
 * — the switch in the list writes the same `auto-run:` line the editor does.
 */
export async function setAutoRun(workflow: Workflow, autoRun: boolean): Promise<void> {
  await saveWorkflow(workflow.projectPath, workflow.slug, { ...toDraft(workflow), autoRun });
}

/** The editable half of a workflow. */
export function toDraft(workflow: Workflow): WorkflowDraft {
  return {
    name: workflow.name,
    icon: workflow.icon,
    description: workflow.description,
    agentId: workflow.agentId,
    trigger: workflow.trigger,
    permission: workflow.permission,
    prompt: workflow.prompt,
    severityFloor: workflow.severityFloor,
    autoRun: workflow.autoRun,
  };
}

/**
 * Create or update a workflow file.
 *
 * `slug` is null to create (the backend derives one from the name and
 * de-duplicates it) and set to edit in place.
 */
export async function saveWorkflow(
  projectPath: string,
  slug: string | null,
  draft: WorkflowDraft
): Promise<Workflow> {
  const saved = await invoke<Workflow>('save_workflow_file', { projectPath, slug, draft });
  await refresh();
  return saved;
}

/** Delete a workflow file. Findings it already filed stay in the inbox. */
export async function deleteWorkflow(projectPath: string, slug: string): Promise<void> {
  await invoke('delete_workflow_file', { projectPath, slug });
  await refresh();
}

/**
 * Run a workflow now.
 *
 * Resolves when the agent has finished and its findings are filed, which can be
 * minutes — callers should reflect `isRunning` from the store rather than
 * blocking on this promise for their spinner.
 */
export async function runWorkflowNow(workflow: Workflow): Promise<WorkflowRun> {
  const optimistic = state.workflows.map((r) =>
    r.id === workflow.id ? { ...r, isRunning: true } : r
  );
  emit({ ...state, workflows: optimistic });
  try {
    return await invoke<WorkflowRun>('run_workflow', {
      projectPath: workflow.projectPath,
      slug: workflow.slug,
    });
  } finally {
    await refresh();
  }
}

/** Run history for one workflow, newest first. */
export function listRuns(workflowId: string): Promise<WorkflowRun[]> {
  return invoke<WorkflowRun[]>('list_workflow_runs', { workflowId });
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
export function unreadCount(snapshot: WorkflowsState = state): number {
  return snapshot.inbox.filter((item) => !item.read && !item.archived).length;
}
