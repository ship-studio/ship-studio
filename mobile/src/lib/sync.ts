/**
 * The phone's copy of the Mac's state, and the rules that keep it exact
 * (docs/mobile.md, "Events, cursors and resync"). Pure functions over plain
 * data, so the rules are tested without React or a socket:
 *
 * - messages are upserts by id, so a replayed or re-emitted one never doubles;
 * - a fetched page overwrites a row only if no newer event already wrote it
 *   (the row's seq ≤ the page's `asOf.seq`);
 * - drafts are appends at an offset, dropped when the offset disagrees;
 * - the cursor advances only after the event is applied.
 */

import type {
  AgentMessage,
  AgentsOverview,
  CompanionEvent,
  Cursor,
  MacStatus,
  Result,
} from '@shipstudio/companion-protocol';

export interface Chat {
  /** Oldest first. */
  messages: AgentMessage[];
  /** Older messages exist on the Mac. */
  more: boolean;
  /** A page has been fetched since the last snapshot. */
  loaded: boolean;
}

/** A message the user sent that the Mac hasn't confirmed yet. */
export interface PendingSend {
  clientId: string;
  agentId: string;
  text: string;
  ts: number;
  failed: boolean;
}

export interface Draft {
  id: string;
  text: string;
}

export interface SyncState {
  overview: AgentsOverview | null;
  mac: MacStatus | null;
  /** The last journaled event applied. Sent as `hello.resume`. */
  cursor: Cursor | null;
  chats: Record<string, Chat>;
  /** Message id → the seq it was last written at (from an event, or a page's `asOf`). */
  seqs: Record<string, number>;
  drafts: Record<string, Draft>;
  pending: Record<string, PendingSend[]>;
  /** When the phone last caught up with the Mac. */
  syncedAt: number | null;
}

export const emptySync = (): SyncState => ({
  overview: null,
  mac: null,
  cursor: null,
  chats: {},
  seqs: {},
  drafts: {},
  pending: {},
  syncedAt: null,
});

const emptyChat = (): Chat => ({ messages: [], more: true, loaded: false });

const before = (a: AgentMessage, b: AgentMessage) => a.ts < b.ts || (a.ts === b.ts && a.id < b.id);

/** Insert or replace by id, keeping time order. */
export function upsert(list: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const at = list.findIndex((m) => m.id === message.id);
  if (at !== -1 && list[at].ts === message.ts) {
    const next = list.slice();
    next[at] = message;
    return next;
  }
  const rest = at === -1 ? list : list.filter((m) => m.id !== message.id);
  let i = rest.length;
  while (i > 0 && before(message, rest[i - 1])) i--;
  return [...rest.slice(0, i), message, ...rest.slice(i)];
}

export function applyEvent(s: SyncState, event: CompanionEvent, cursor?: Cursor): SyncState {
  const next = reduce(s, event, cursor);
  return cursor ? { ...next, cursor } : next;
}

function reduce(s: SyncState, event: CompanionEvent, cursor?: Cursor): SyncState {
  switch (event.type) {
    case 'agents.message': {
      const m = event.message;
      const chat = s.chats[m.agentId] ?? emptyChat();
      const drafts = { ...s.drafts };
      if (drafts[m.agentId]?.id === m.id) delete drafts[m.agentId];
      return {
        ...s,
        chats: { ...s.chats, [m.agentId]: { ...chat, messages: upsert(chat.messages, m) } },
        seqs: { ...s.seqs, [m.id]: cursor?.seq ?? Number.MAX_SAFE_INTEGER },
        drafts,
        pending: settlePending(s.pending, m),
      };
    }
    case 'agents.status': {
      if (!s.overview) return s;
      const agents = s.overview.agents.map((a) =>
        a.id === event.agentId ? { ...a, status: event.status } : a
      );
      return { ...s, overview: { ...s.overview, agents } };
    }
    case 'agents.registry':
      return { ...s, overview: event.overview };
    case 'system.status':
      return { ...s, mac: event.status };
    case 'agents.draft':
      return { ...s, drafts: applyDraft(s.drafts, event) };
    case 'sync.snapshot':
      // Seqs from another epoch can't be compared with anything new: forget
      // them so the re-fetch overwrites. Drafts restart from 0 anyway.
      return {
        ...s,
        overview: event.overview,
        mac: event.status,
        cursor: event.cursor,
        seqs: {},
        drafts: {},
        chats: Object.fromEntries(
          Object.entries(s.chats).map(([id, chat]) => [id, { ...chat, loaded: false }])
        ),
      };
    case 'sync.caughtUp':
      return { ...s, cursor: event.cursor, syncedAt: Date.now() };
    default:
      // projects.* are P2; alerts are handled by the session, not stored.
      return s;
  }
}

/**
 * The confirmed copy of a pending send arrived (as an event, which the Mac
 * sends before the response). `AgentMessage` carries no `clientId`, so it is
 * matched on the text; the response settles it by id regardless.
 */
function settlePending(pending: SyncState['pending'], m: AgentMessage): SyncState['pending'] {
  const list = pending[m.agentId];
  if (m.kind !== 'user' || !list?.length) return pending;
  const at = list.findIndex((p) => p.text === m.text);
  if (at === -1) return pending;
  return { ...pending, [m.agentId]: list.filter((_, i) => i !== at) };
}

function applyDraft(
  drafts: Record<string, Draft>,
  e: Extract<CompanionEvent, { type: 'agents.draft' }>
): Record<string, Draft> {
  const held = drafts[e.agentId];
  if (e.from === 0) return { ...drafts, [e.agentId]: { id: e.id, text: e.text } };
  if (held?.id === e.id && held.text.length === e.from) {
    return { ...drafts, [e.agentId]: { id: e.id, text: held.text + e.text } };
  }
  // Out of step: drop it and wait for a restart from 0 or the finished message.
  if (!held) return drafts;
  const next = { ...drafts };
  delete next[e.agentId];
  return next;
}

/** Merge a page from `agents.messages`. `older`: it was fetched with `before`. */
export function mergePage(
  s: SyncState,
  agentId: string,
  page: Result<'agents.messages'>,
  older: boolean
): SyncState {
  const chat = s.chats[agentId] ?? emptyChat();
  const comparable = s.cursor?.epoch === page.asOf.epoch;
  let messages = chat.messages;
  const seqs = { ...s.seqs };
  for (const m of page.messages) {
    const written = seqs[m.id];
    // An event newer than this read already wrote the row: keep it.
    if (comparable && written != null && written > page.asOf.seq) continue;
    messages = upsert(messages, m);
    seqs[m.id] = page.asOf.seq;
  }
  const more = older || !chat.loaded ? page.more : chat.more || page.more;
  return { ...s, seqs, chats: { ...s.chats, [agentId]: { messages, more, loaded: true } } };
}

export function addPending(s: SyncState, p: PendingSend): SyncState {
  return { ...s, pending: { ...s.pending, [p.agentId]: [...(s.pending[p.agentId] ?? []), p] } };
}

/** The Mac answered a send: drop the pending copy and keep the real one. */
export function confirmSend(s: SyncState, clientId: string, message: AgentMessage): SyncState {
  const list = (s.pending[message.agentId] ?? []).filter((p) => p.clientId !== clientId);
  const chat = s.chats[message.agentId] ?? emptyChat();
  // The event usually got here first and is at least as new; only fill a gap.
  const known = chat.messages.some((m) => m.id === message.id);
  return {
    ...s,
    pending: { ...s.pending, [message.agentId]: list },
    chats: known
      ? s.chats
      : { ...s.chats, [message.agentId]: { ...chat, messages: upsert(chat.messages, message) } },
  };
}

export function setPendingFailed(
  s: SyncState,
  agentId: string,
  clientId: string,
  failed: boolean
): SyncState {
  const list = (s.pending[agentId] ?? []).map((p) =>
    p.clientId === clientId ? { ...p, failed } : p
  );
  return { ...s, pending: { ...s.pending, [agentId]: list } };
}
