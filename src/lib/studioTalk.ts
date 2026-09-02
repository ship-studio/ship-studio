/**
 * Studio Talk — cross-project agent exchanges.
 *
 * The backend (`src-tauri/src/studio_talk.rs`) runs a headless agent in the
 * target project when one project's agent calls the `studio_ask` MCP tool,
 * and records every exchange in an in-memory registry. This file is the
 * frontend half: the initial snapshot command and the live update event,
 * kept here so components never listen by string.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type StudioExchangeStatus = 'running' | 'completed' | 'failed';

export interface StudioExchangeActivity {
  atMs: number;
  /** "status" (lifecycle), "tool" (what it's doing), "text" (what it's saying). */
  kind: 'status' | 'tool' | 'text';
  text: string;
}

export interface StudioExchange {
  id: number;
  /** Canonical path of the asking project. */
  fromProject: string;
  /** Canonical path of the answering project. */
  toProject: string;
  question: string;
  status: StudioExchangeStatus;
  activity: StudioExchangeActivity[];
  answer: string | null;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

/** All known exchanges, newest first (in-memory; empty after app restart). */
export async function listStudioExchanges(): Promise<StudioExchange[]> {
  return invoke<StudioExchange[]>('list_studio_exchanges');
}

/**
 * Subscribe to live exchange updates. The payload is a full snapshot of the
 * changed exchange (not a delta), so handlers can upsert by `id`.
 */
export function onStudioExchangeUpdated(
  handler: (exchange: StudioExchange) => void
): Promise<UnlistenFn> {
  return listen<StudioExchange>('studio-exchange-updated', (event) => handler(event.payload));
}

/** Upsert one exchange into a newest-first list (pure; used by the hook and tests). */
export function upsertExchange(list: StudioExchange[], exchange: StudioExchange): StudioExchange[] {
  const next = list.some((e) => e.id === exchange.id)
    ? list.map((e) => (e.id === exchange.id ? exchange : e))
    : [exchange, ...list];
  return next.sort((a, b) => b.id - a.id);
}

/**
 * Merge the initial snapshot under exchanges already received via events.
 * Event payloads are always at least as fresh as the snapshot (the snapshot
 * was requested after subscribing), so existing entries win on conflict.
 */
export function mergeExchangeSnapshot(
  current: StudioExchange[],
  snapshot: StudioExchange[]
): StudioExchange[] {
  const byId = new Map<number, StudioExchange>(snapshot.map((e) => [e.id, e]));
  for (const exchange of current) {
    byId.set(exchange.id, exchange);
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}
