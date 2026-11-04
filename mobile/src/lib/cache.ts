/**
 * The offline copy of one Mac's state (docs/mobile.md, "Offline cache and
 * outbox"): the overview, Mac status, projects, the last 400 messages of
 * each chat you've opened, the outbox and the cursor. Everything cached is
 * readable while the Mac can't be reached; nothing is claimed to be live.
 *
 * The cursor is written in the same file as the state it describes, so a
 * restart resumes from exactly what's on disk: replay can't skip an event
 * the copy doesn't hold.
 */

import type { AgentMessage, Cursor } from '@shipstudio/companion-protocol';
import { restorePending } from './outbox';
import { debounced, readJson, removeJson, writeJson } from './persist';
import { getApp, setApp, useApp } from './store';
import type { SyncState } from './sync';

export const CACHED_MESSAGES = 400;
const VERSION = 1;

export interface Cached {
  v: number;
  savedAt: number;
  overview: SyncState['overview'];
  mac: SyncState['mac'];
  projects: SyncState['projects'];
  cursor: Cursor | null;
  syncedAt: number | null;
  chats: Record<string, { messages: AgentMessage[]; more: boolean }>;
  pending: SyncState['pending'];
}

export function toCache(s: SyncState, now = Date.now()): Cached {
  return {
    v: VERSION,
    savedAt: now,
    overview: s.overview,
    mac: s.mac,
    projects: s.projects,
    cursor: s.cursor,
    syncedAt: s.syncedAt,
    chats: Object.fromEntries(
      Object.entries(s.chats)
        .filter(([, c]) => c.messages.length)
        .map(([id, c]) => [
          id,
          {
            messages: c.messages.slice(-CACHED_MESSAGES),
            more: c.more || c.messages.length > CACHED_MESSAGES,
          },
        ])
    ),
    pending: Object.fromEntries(Object.entries(s.pending).filter(([, list]) => list.length)),
  };
}

/** State to start from. Chats are marked unloaded, so each is re-read once connected. */
export function fromCache(c: Cached): Partial<SyncState> | null {
  if (c.v !== VERSION) return null;
  return {
    overview: c.overview,
    mac: c.mac,
    projects: c.projects,
    cursor: c.cursor,
    syncedAt: c.syncedAt,
    chats: Object.fromEntries(
      Object.entries(c.chats).map(([id, chat]) => [id, { ...chat, loaded: false }])
    ),
    pending: restorePending(c.pending),
  };
}

const fileFor = (serverId: string) => `cache-${serverId}.json`;
const saver = debounced(async () => {
  const id = getApp().credentials?.serverId;
  if (id) await writeJson(fileFor(id), toCache(getApp()));
}, 1000);

/** Read the copy for this Mac into the store. Returns whether there was one. */
export async function loadCache(serverId: string): Promise<boolean> {
  const saved = await readJson<Cached>(fileFor(serverId));
  const state = saved && fromCache(saved);
  if (state) setApp(state);
  return !!state;
}

/** Keep the copy current: written a second after the synced state settles. */
export function watchCache(): () => void {
  return useApp.subscribe((s, prev) => {
    if (
      s.overview !== prev.overview ||
      s.chats !== prev.chats ||
      s.pending !== prev.pending ||
      s.projects !== prev.projects ||
      s.mac !== prev.mac ||
      s.cursor !== prev.cursor
    ) {
      saver.schedule();
    }
  });
}

export const flushCache = () => saver.flush();

export async function forgetCache(serverId: string) {
  saver.cancel();
  await removeJson(fileFor(serverId));
}
