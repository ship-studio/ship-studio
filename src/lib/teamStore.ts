/**
 * Team — the frontend store.
 *
 * A `useSyncExternalStore` source shaped like `workflowsStore`, so the Team
 * surfaces read state the way every other screen does.
 *
 * State comes from `get_team_snapshot` (see `teamApi.ts`), which reads the
 * project's git history, its pull requests, and any records under
 * `.shipstudio-team/`. Nothing here folds, joins or derives — Rust owns every
 * claim about the repo, and this owns what is on screen.
 *
 * **One project at a time.** There was briefly a home-level screen reading
 * across the eight most recently opened projects at once, which is where the
 * cap came from: each project is a walk of every active branch, so eight of
 * them ran hundreds of git processes to answer a question nobody was asking
 * from outside a project. Team belongs where the work is.
 *
 * ## Two things live only here, and both are honest about it
 *
 * **Seen-ness** is per person, per machine. "New since you last looked" is not
 * a fact about the repo and must never be written into it — committing which
 * rows you have read would publish your reading habits to the whole team. It
 * goes to `localStorage`.
 *
 * **Pending replies** are comments typed before there is a writer to commit
 * them. They are kept, marked `pending`, and merged back over every refetch, so
 * a refresh does not silently eat something you typed. They persist to
 * `localStorage` for the same reason. When the writer lands they flush into
 * records and this buffer goes away.
 *
 * @module lib/teamStore
 */

import {
  addTeamComment,
  syncTeamThreads,
  editTeamMessage,
  getTeamSnapshot,
  replyToTeamThread,
  retractTeamMessage,
  setTeamThreadResolved,
} from './teamApi';
import { asCommandError, formatCommandError } from './errors';
import { logger } from './logger';
import {
  actorKey,
  lastMessageAt,
  type TeamActor,
  type TeamMessage,
  type TeamSnapshot,
  type TeamThread,
  type TeamThreadAnchor,
  type TeamUpdate,
} from './team';

/**
 * How often the snapshot is re-read.
 *
 * This is the feature's entire notion of "real time", and it is worth being
 * explicit: with no server, nobody can tell us something happened, so the floor
 * is however often we ask. A minute is frequent enough that a conversation
 * works and infrequent enough not to hammer a remote all day.
 *
 * Note that this re-reads what is already local. Learning about a teammate's
 * push additionally needs a `git fetch`, which Harbr does not do behind
 * the user's back — see `sync()`.
 */
export const TEAM_SYNC_INTERVAL_MS = 60_000;

/** Which of the three Team surfaces is showing. */
export type TeamTab = 'updates' | 'people' | 'comments';

interface TeamUiState {
  tab: TeamTab;
  howItWorksOpen: boolean;
  /** The update expanded to show its evidence, if any. */
  expandedId: string | null;
  /** True until the first snapshot for the current project has arrived. */
  loading: boolean;
  /**
   * Threads ticked for handing to an agent.
   *
   * Empty to start, always. Pre-selecting everything makes the send button a
   * loaded gun: the common case is "this one, now", and someone who wanted all
   * six can tick all six. It also has to live here rather than in either
   * component, because the pin on the page and the row in the panel are two
   * views of one decision and must never disagree about it.
   */
  selectedThreadIds: string[];
}

const SEEN_PREFIX = 'shipstudio.team.seen:';
const PENDING_PREFIX = 'shipstudio.team.pending:';
const CACHE_PREFIX = 'shipstudio.team.cache:';

/**
 * How many rows of the last snapshot are kept for the next open.
 *
 * Reading a repository takes a couple of seconds: 62 live branches on this one,
 * each a `git log --numstat`, plus GitHub. Waiting through that is fine once;
 * waiting through it every single time you open a project is what made the
 * header's face cluster look broken — it simply was not there yet.
 *
 * So the last snapshot is shown immediately and refreshed behind it. Forty rows
 * is well past a screenful and keeps the stored blob small enough not to matter
 * next to a browser storage quota.
 */
const CACHE_UPDATES = 40;

/** How many seen ids to keep. Past this the oldest are dropped. */
const MAX_SEEN = 500;

export function emptySnapshot(): TeamSnapshot {
  return {
    updates: [],
    members: [],
    threads: [],
    sync: { repo: null, lastSyncedAt: null, pendingCount: 0, error: null, syncing: false },
    seenIds: [],
    commitGuidanceInstalled: false,
  };
}

let state: TeamSnapshot = emptySnapshot();
let ui: TeamUiState = {
  tab: 'updates',
  howItWorksOpen: false,
  expandedId: null,
  loading: false,
  selectedThreadIds: [],
};
let adoptedPath: string | null = null;
/** Replies typed before there is a writer. Keyed by thread id. */
let pending = new Map<string, TeamMessage[]>();
/** Whether the user has picked a tab themselves. See landOnSomethingUseful. */
let tabChosen = false;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function emit(next: TeamSnapshot): void {
  state = next;
  notify();
}

function setUi(next: Partial<TeamUiState>): void {
  ui = { ...ui, ...next };
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): TeamSnapshot {
  return state;
}

export function getUiSnapshot(): TeamUiState {
  return ui;
}

export function setTeamTab(tab: TeamTab): void {
  // A tab the user picked is never moved out from under them again.
  tabChosen = true;
  if (ui.tab === tab) return;
  setUi({ tab });
}

export function setHowItWorksOpen(open: boolean): void {
  if (ui.howItWorksOpen === open) return;
  setUi({ howItWorksOpen: open });
}

export function toggleExpanded(id: string): void {
  setUi({ expandedId: ui.expandedId === id ? null : id });
}

/** Tick or untick one thread for the next handoff. */
export function toggleThreadSelected(id: string): void {
  const selected = ui.selectedThreadIds.includes(id)
    ? ui.selectedThreadIds.filter((candidate) => candidate !== id)
    : [...ui.selectedThreadIds, id];
  setUi({ selectedThreadIds: selected });
}

export function clearThreadSelection(): void {
  if (ui.selectedThreadIds.length === 0) return;
  setUi({ selectedThreadIds: [] });
}

/**
 * Drop selections for threads that are no longer there.
 *
 * A thread someone else resolved, or one you withdrew, must not stay ticked and
 * silently ride along in the next prompt.
 */
function pruneSelection(snapshot: TeamSnapshot): void {
  if (ui.selectedThreadIds.length === 0) return;
  const alive = new Set(snapshot.threads.filter((thread) => !thread.resolved).map((t) => t.id));
  const kept = ui.selectedThreadIds.filter((id) => alive.has(id));
  if (kept.length !== ui.selectedThreadIds.length) setUi({ selectedThreadIds: kept });
}

// ------------------------------------------------------------- persistence

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // A private window, cleared site data, or a browser that throws on access.
    // Every one of them means "no preference", never an error.
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A rejected write costs the preference, never the interaction.
  }
}

function loadPending(projectPath: string): Map<string, TeamMessage[]> {
  const raw = readJson<Record<string, TeamMessage[]>>(`${PENDING_PREFIX}${projectPath}`, {});
  return new Map(Object.entries(raw));
}

function savePending(projectPath: string): void {
  writeJson(`${PENDING_PREFIX}${projectPath}`, Object.fromEntries(pending));
}

/**
 * Lay the local, unpushed replies back over a freshly read snapshot.
 *
 * A pending reply whose id now appears in the real thread has been committed
 * and fetched back, so it is dropped from the buffer — that is the one moment
 * this state is allowed to disappear, and it happens because the real thing
 * arrived.
 */
function mergePending(snapshot: TeamSnapshot): TeamSnapshot {
  if (pending.size === 0) return snapshot;

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    const extra = pending.get(thread.id);
    if (!extra || extra.length === 0) return thread;

    const landed = new Set(thread.messages.map((message) => message.id));
    const stillPending = extra.filter((message) => !landed.has(message.id));
    if (stillPending.length !== extra.length) {
      changed = true;
      if (stillPending.length === 0) pending.delete(thread.id);
      else pending.set(thread.id, stillPending);
    }
    if (stillPending.length === 0) return thread;
    return { ...thread, messages: [...thread.messages, ...stillPending] };
  });

  if (changed && adoptedPath) savePending(adoptedPath);

  const pendingCount = [...pending.values()].reduce((total, list) => total + list.length, 0);
  return { ...snapshot, threads, sync: { ...snapshot.sync, pendingCount } };
}

// ------------------------------------------------------------------ loading

/**
 * Point the store at the project the user opened, and read it.
 *
 * Idempotent per path: re-entering a workspace must not throw away a reply in
 * progress or re-announce the whole backlog as news.
 */
export function adopt(projectPath: string, _projectName?: string, _repo?: string | null): void {
  if (adoptedPath === projectPath) return;
  adoptedPath = projectPath;

  pending = loadPending(projectPath);
  const seenIds = readJson<string[]>(`${SEEN_PREFIX}${projectPath}`, []);

  // Last time's answer, straight away, while this time's is fetched behind it.
  // Never the *previous project's* feed under this project's name — that is why
  // the fallback here is empty rather than whatever happened to be in `state`.
  const cached = readJson<TeamSnapshot | null>(`${CACHE_PREFIX}${projectPath}`, null);
  state = cached?.updates
    ? // `lastSyncedAt` stays as it was stored, so the sync row says how old this
      // is instead of claiming it was just fetched.
      mergePending({ ...cached, seenIds, sync: { ...cached.sync, syncing: false, error: null } })
    : { ...emptySnapshot(), seenIds };

  // Ticks belong to the project you made them in. Carrying them across would
  // mean a send bar counting comments that are not on screen, and — once the
  // ids happened to collide — handing an agent someone else's note.
  setUi({ loading: !cached, expandedId: null, selectedThreadIds: [] });
  notify();

  // Opening a project is a trigger the user can see, so it ignores the floor.
  // The first thing anyone wants on opening a workspace is to know what landed
  // while they were away.
  void sync(true);
}

/** Keep this snapshot for the next time the project opens. */
function cache(projectPath: string, snapshot: TeamSnapshot): void {
  writeJson(`${CACHE_PREFIX}${projectPath}`, {
    ...snapshot,
    updates: snapshot.updates.slice(0, CACHE_UPDATES),
    // Seen-ness has its own key, and the pending buffer has another. Storing
    // either here would give them two homes that disagree.
    seenIds: [],
  });
}

/**
 * Open on the tab that has something on it.
 *
 * "What's new" is the right landing tab for a repo with a team on it, and the
 * wrong one for a folder with no remote — there it is a permanent empty state,
 * and the person has to find the only tab that works. This moves them once, on
 * the first snapshot, and never fights a choice they have made themselves.
 */
function landOnSomethingUseful(snapshot: TeamSnapshot): void {
  if (tabChosen || ui.tab !== 'updates') return;
  if (snapshot.sync.repo === null && snapshot.updates.length === 0) {
    setUi({ tab: 'comments' });
  }
}

/** Re-read the snapshot for the adopted project. */
export async function refresh(projectPath = adoptedPath): Promise<void> {
  if (!projectPath) return;

  try {
    const snapshot = await getTeamSnapshot(projectPath);
    // Leaving the project mid-read must not drop another project's feed here.
    if (adoptedPath !== projectPath) return;
    const fresh = mergePending({
      ...snapshot,
      seenIds: state.seenIds,
      sync: { ...snapshot.sync, lastSyncedAt: Date.now(), error: null, syncing: false },
    });
    emit(fresh);
    pruneSelection(fresh);
    landOnSomethingUseful(fresh);
    cache(projectPath, fresh);
  } catch (error) {
    if (adoptedPath !== projectPath) return;
    const message = formatCommandError(asCommandError(error));
    logger.warn('team snapshot failed', { projectPath, error: message });
    // Kept, not swallowed: the panel says what went wrong rather than showing
    // an empty feed that reads as "nobody has done anything".
    emit({ ...state, sync: { ...state.sync, error: message, syncing: false } });
  } finally {
    if (adoptedPath === projectPath) setUi({ loading: false });
  }
}

/**
 * The floor under the comment sync.
 *
 * Everything worth syncing for is an event — opening a project, pushing,
 * switching a branch — and those call `sync` directly. This is only the
 * backstop for a session where nothing happens, so it is deliberately slow: a
 * teammate's comment can wait ten minutes when neither of you is touching the
 * repository, and a tighter loop would be reaching for someone's remote all day
 * to learn nothing.
 */
export const TEAM_SYNC_FLOOR_MS = 10 * 60_000;

/**
 * The in-flight sync, and when the last one finished.
 *
 * Every trigger routes through here, so a branch switch during a project open
 * during a push is one exchange rather than three. Coalescing on the promise
 * rather than a boolean means a caller that wants to wait for the result still
 * can.
 */
let inFlightSync: Promise<void> | null = null;
let lastSyncAt = 0;

/**
 * Exchange comments with the remote, then re-read.
 *
 * The only path in the feature that touches the network, and never automatic in
 * the sense that matters: it runs on things the user did. A failed push is
 * carried into the snapshot rather than thrown, because the comment is still on
 * disk and the panel has to be able to say which half worked.
 *
 * @param force ignore the floor — for a trigger the user can see, such as
 *   opening the project or asking for a sync themselves.
 */
export function sync(force = false): Promise<void> {
  if (!adoptedPath) return Promise.resolve();
  if (inFlightSync) return inFlightSync;
  if (!force && Date.now() - lastSyncAt < TEAM_SYNC_FLOOR_MS) return refresh();

  const projectPath = adoptedPath;
  emit({ ...state, sync: { ...state.sync, syncing: true, error: null } });

  inFlightSync = (async () => {
    try {
      const outcome = await syncTeamThreads(projectPath);
      // Leaving the project mid-sync must not write another project's state.
      if (adoptedPath !== projectPath) return;
      lastSyncAt = Date.now();
      await refresh(projectPath);
      if (adoptedPath !== projectPath) return;
      emit({
        ...state,
        sync: {
          ...state.sync,
          syncing: false,
          lastSyncedAt: Date.now(),
          pendingCount: outcome.pending,
          // A push that could not happen is reported. A project with no remote
          // is not a failure and says nothing.
          error: outcome.error,
        },
      });
    } catch (error) {
      if (adoptedPath !== projectPath) return;
      const message = formatCommandError(asCommandError(error));
      logger.warn('team sync failed', { projectPath, error: message });
      emit({ ...state, sync: { ...state.sync, syncing: false, error: message } });
    } finally {
      inFlightSync = null;
    }
  })();

  return inFlightSync;
}

/**
 * Ask the remote for comments, subject to the floor.
 *
 * For callers that are *already* doing something with the remote — a push, a
 * branch switch, a pull — where the marginal cost of also exchanging a few KB
 * of comments is nothing and the user plainly expects the app to be talking to
 * the remote at that moment.
 */
export function syncAfterGitActivity(): void {
  void sync();
}

/** Test seam: forget when the last sync ran. */
export function __resetSyncClock(): void {
  lastSyncAt = 0;
  inFlightSync = null;
}

// -------------------------------------------------------------- seen / unseen

/** The signed-in user, or the first member when nobody is identified. */
/**
 * The project this store is currently reading, or `null` before one is adopted.
 *
 * For the few callers that act on the project rather than on the snapshot —
 * writing the commit-message block into its agent instructions, say. They must
 * not keep their own copy of the path: the store already switches projects, and
 * a second copy is a second thing that can be pointing at the last one.
 */
export function adoptedProject(): string | null {
  return adoptedPath;
}

export function currentActor(): TeamActor | null {
  return state.members.find((member) => member.isSelf)?.actor ?? null;
}

/** Updates the user has not seen yet — what the header badge counts. */
export function unseenUpdates(snapshot: TeamSnapshot): TeamUpdate[] {
  const seen = new Set(snapshot.seenIds);
  return snapshot.updates.filter(
    (update) => !seen.has(update.id) && !isSelf(snapshot, update.actor)
  );
}

function isSelf(snapshot: TeamSnapshot, candidate: TeamActor): boolean {
  const me = snapshot.members.find((member) => member.isSelf)?.actor;
  return me ? actorKey(me) === actorKey(candidate) : false;
}

/**
 * Marks everything currently in the feed as seen.
 *
 * Local and private. Which rows you have read is not a fact about the repo, and
 * writing it into git would publish your reading habits to everyone with
 * access.
 */
export function markAllSeen(): void {
  const seenIds = [
    ...new Set([...state.seenIds, ...state.updates.map((update) => update.id)]),
  ].slice(-MAX_SEEN);
  emit({ ...state, seenIds });
  if (adoptedPath) writeJson(`${SEEN_PREFIX}${adoptedPath}`, seenIds);
}

// ------------------------------------------------------------------ threads

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-local-${Date.now().toString(36)}-${seq}`;
}

/**
 * Leave a comment. Resolves with the new thread's id, or null if it failed.
 *
 * Optimism here is earned rather than assumed: the write is a file write with
 * no network and no commit in it, so the wait between pressing save and the
 * record existing is a disk write. The UI still gets the thread back before the
 * refetch, because a re-read walks the repository and that is the slow part.
 */
export async function addComment(input: {
  route: string;
  target: string;
  pin: number;
  body: string;
  branch?: string | null;
  anchor?: TeamThreadAnchor | null;
}): Promise<string | null> {
  if (!adoptedPath) return null;
  const text = input.body.trim();
  if (!text) return null;

  try {
    const id = await addTeamComment({
      projectPath: adoptedPath,
      branch: input.branch ?? null,
      route: input.route,
      target: input.target,
      pin: input.pin,
      body: text,
      anchor: input.anchor ?? null,
    });
    await refresh(adoptedPath);
    return id;
  } catch (error) {
    reportThreadFailure(error, 'add a comment');
    return null;
  }
}

/**
 * Post a reply.
 *
 * Shown immediately and marked `pending`, then reconciled by the refetch. The
 * pending flag is not decoration — it means "this is on your machine and not
 * yet anywhere else", and it stays until the record is actually read back.
 */
export async function replyToThread(threadId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text || !adoptedPath) return;
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  const me = currentActor();
  if (!thread) return;

  const local: TeamMessage = {
    id: nextId('m'),
    actor: me ?? { login: null, name: 'You', avatarUrl: null },
    at: Date.now(),
    body: text,
    pending: true,
  };
  pending.set(threadId, [...(pending.get(threadId) ?? []), local]);
  savePending(adoptedPath);

  emit({
    ...state,
    threads: state.threads.map((candidate) =>
      candidate.id === threadId
        ? { ...candidate, messages: [...candidate.messages, local] }
        : candidate
    ),
    sync: { ...state.sync, pendingCount: state.sync.pendingCount + 1 },
  });

  try {
    const id = await replyToTeamThread(adoptedPath, threadId, text);
    // Re-key the buffered message to the id the record actually got, so the
    // refetch below recognises it as landed and drops it. Without this the
    // reply would show twice: once real, once forever pending.
    const buffered = pending.get(threadId);
    if (buffered) {
      pending.set(
        threadId,
        buffered.map((message) => (message.id === local.id ? { ...message, id } : message))
      );
      savePending(adoptedPath);
    }
    await refresh(adoptedPath);
  } catch (error) {
    // The optimistic message stays, still marked pending, because it is: the
    // person wrote it and it did not land. Dropping it would lose their words.
    reportThreadFailure(error, 'post that reply');
  }
}

/**
 * Resolve or reopen a thread.
 *
 * An append rather than a field flip, because that is the only shape that
 * survives two people doing it at once: both records land, the fold takes the
 * later one, and nobody's decision is lost to a merge.
 */
export async function setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
  if (!adoptedPath) return;
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  const me = currentActor();
  if (!thread || thread.resolved === resolved) return;

  emit({
    ...state,
    threads: state.threads.map((candidate) =>
      candidate.id === threadId
        ? { ...candidate, resolved, resolvedBy: resolved ? me : null }
        : candidate
    ),
  });

  try {
    await setTeamThreadResolved(adoptedPath, threadId, resolved);
    await refresh(adoptedPath);
  } catch (error) {
    reportThreadFailure(error, resolved ? 'resolve that thread' : 'reopen that thread');
    await refresh(adoptedPath);
  }
}

/** Rewrite a message you wrote. */
export async function editMessage(
  threadId: string,
  messageId: string,
  body: string
): Promise<boolean> {
  if (!adoptedPath) return false;
  const text = body.trim();
  if (!text) return false;
  try {
    await editTeamMessage(adoptedPath, threadId, messageId, text);
    await refresh(adoptedPath);
    return true;
  } catch (error) {
    reportThreadFailure(error, 'save that edit');
    return false;
  }
}

/**
 * Withdraw a message you wrote.
 *
 * The record stays on disk and in every clone that fetched it; this removes it
 * from the feed. Copy that promises deletion would be a lie about git.
 */
export async function retractMessage(threadId: string, messageId: string): Promise<boolean> {
  if (!adoptedPath) return false;
  try {
    await retractTeamMessage(adoptedPath, threadId, messageId);
    await refresh(adoptedPath);
    return true;
  } catch (error) {
    reportThreadFailure(error, 'remove that comment');
    return false;
  }
}

/**
 * Surface a write failure.
 *
 * Written into the snapshot's `error` rather than thrown, because every caller
 * is a click on a comment and none of them has anywhere to put an exception.
 * The panel already renders this field.
 */
function reportThreadFailure(error: unknown, action: string): void {
  const message = formatCommandError(asCommandError(error));
  logger.error(`team: could not ${action}`, { error: message });
  emit({ ...state, sync: { ...state.sync, error: `Couldn't ${action}. ${message}` } });
}

/** Test seam: replace the whole snapshot. */
export function __setTeamState(next: TeamSnapshot): void {
  emit(next);
}

/** Test seam: back to an empty store, as if no project were open. */
export function __resetTeamState(): void {
  seq = 0;
  adoptedPath = null;
  pending = new Map();
  ui = {
    tab: 'updates',
    howItWorksOpen: false,
    expandedId: null,
    loading: false,
    selectedThreadIds: [],
  };
  emit(emptySnapshot());
}

/** Threads for one project, unresolved first, most recently active first. */
export function threadsForProject(
  snapshot: TeamSnapshot,
  projectPath: string | null
): TeamThread[] {
  return snapshot.threads
    .filter((thread) => projectPath === null || thread.projectPath === projectPath)
    .sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
      return lastMessageAt(b) - lastMessageAt(a);
    });
}
