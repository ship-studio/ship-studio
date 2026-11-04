/**
 * What you've typed in each chat and not sent: the text, the passages
 * you're quoting, the agents you @mentioned and the files already uploaded
 * to the Mac. Kept in the store (so leaving a chat loses nothing) and on
 * disk per Mac (so a restart, an OTA update or iOS reclaiming the app loses
 * nothing either).
 */

import type { AgentRef } from '@shipstudio/companion-protocol';
import { debounced, readJson, removeJson, writeJson } from './persist';
import { getApp, setApp, useApp } from './store';
import type { PendingAttachment } from './sync';

/** An upload the Mac is holding for this draft, and when it took it. */
export interface DraftFile extends PendingAttachment {
  stagedAt: number;
}

export interface ComposerDraft {
  text: string;
  quotes: string[];
  mentions: AgentRef[];
  /** Absent in drafts saved before files were kept. */
  files?: DraftFile[];
}

export const EMPTY_DRAFT: ComposerDraft = { text: '', quotes: [], mentions: [], files: [] };

/**
 * The Mac keeps a staged upload for an hour (`blobs.rs`). A little sooner
 * than that, the phone stops counting on it and asks for the file again.
 */
export const FILE_KEEP_MS = 55 * 60_000;

const isEmpty = (d: ComposerDraft) =>
  !d.text && !d.quotes.length && !d.mentions.length && !d.files?.length;

/** Files that waited too long for the Mac to still have them. */
export const expiredFiles = (d: ComposerDraft, now = Date.now()) =>
  (d.files ?? []).filter((f) => now - f.stagedAt > FILE_KEEP_MS);

/** The map with `agentId`'s draft changed; an emptied draft is removed, not kept blank. */
export function putDraft(
  drafts: Record<string, ComposerDraft>,
  agentId: string,
  change: Partial<ComposerDraft>
): Record<string, ComposerDraft> {
  const next = { ...(drafts[agentId] ?? EMPTY_DRAFT), ...change };
  if (isEmpty(next)) {
    if (!(agentId in drafts)) return drafts;
    const rest = { ...drafts };
    delete rest[agentId];
    return rest;
  }
  return { ...drafts, [agentId]: next };
}

/**
 * A mention whose `@Name` was deleted from the text no longer counts: the
 * text is what the user sees, so it decides.
 */
export function liveMentions(text: string, mentions: AgentRef[]): AgentRef[] {
  return mentions.filter((m) => text.includes(`@${m.name}`));
}

const fileFor = (serverId: string) => `drafts-${serverId}.json`;
const saver = debounced(async () => {
  const id = getApp().credentials?.serverId;
  if (id) await writeJson(fileFor(id), getApp().composer);
}, 400);

export const useComposerDraft = (agentId: string) =>
  useApp((s) => s.composer[agentId] ?? EMPTY_DRAFT);

export function setComposer(agentId: string, change: Partial<ComposerDraft>) {
  setApp((s) => ({ composer: putDraft(s.composer, agentId, change) }));
  saver.schedule();
}

export const clearComposer = (agentId: string) => setComposer(agentId, EMPTY_DRAFT);

export function addFile(agentId: string, file: DraftFile) {
  const files = getApp().composer[agentId]?.files ?? [];
  setComposer(agentId, { files: [...files.filter((f) => f.blobId !== file.blobId), file] });
}

export function removeFiles(agentId: string, blobIds: string[]) {
  const files = getApp().composer[agentId]?.files ?? [];
  setComposer(agentId, { files: files.filter((f) => !blobIds.includes(f.blobId)) });
}

/** Add a passage to the chat's quotes (the same passage once). */
export function addQuote(agentId: string, passage: string) {
  const text = passage.trim();
  if (!text) return;
  const quotes = getApp().composer[agentId]?.quotes ?? [];
  if (!quotes.includes(text)) setComposer(agentId, { quotes: [...quotes, text] });
}

export async function loadDrafts(serverId: string) {
  const saved = await readJson<Record<string, ComposerDraft>>(fileFor(serverId));
  if (saved) setApp({ composer: saved });
}

export const flushDrafts = () => saver.flush();

export async function forgetDrafts(serverId: string) {
  saver.cancel();
  setApp({ composer: {} });
  await removeJson(fileFor(serverId));
}
