import { afterEach, describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import {
  __resetAgentsStore,
  getAgentsSnapshot,
  loadMessages,
  loadOlderMessages,
  MESSAGE_PAGE,
  updateDraft,
  upsertMessage,
} from './agentsStore';
import type { AgentMessage } from './agents';

const reply = (id: string, text: string): AgentMessage => ({
  id,
  agentId: 'a',
  ts: 2,
  kind: 'agent',
  text,
});

describe('streaming drafts', () => {
  afterEach(() => __resetAgentsStore());

  it('grows a draft and keeps the time it started', () => {
    updateDraft('a', 'd1', 'Hel');
    const started = getAgentsSnapshot().drafts.a.ts;
    updateDraft('a', 'd1', 'Hello there');
    expect(getAgentsSnapshot().drafts.a).toMatchObject({
      id: 'd1',
      text: 'Hello there',
      ts: started,
    });
  });

  it('the finished message replaces its draft, even in a chat that is not open', () => {
    updateDraft('a', 'd1', 'Hello');
    upsertMessage(reply('d1', 'Hello there.'));
    expect(getAgentsSnapshot().drafts.a).toBeUndefined();
  });

  it('a different message leaves the draft alone', () => {
    updateDraft('a', 'd2', 'Next');
    upsertMessage(reply('d1', 'Earlier.'));
    expect(getAgentsSnapshot().drafts.a?.id).toBe('d2');
  });
});

describe('paged history', () => {
  afterEach(() => __resetAgentsStore());

  /** A log of `n` lines served the way `agents_messages` pages it. */
  const serve = (n: number) => {
    const log = Array.from({ length: n }, (_, i) => reply(`m${i}`, `line ${i}`));
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd !== 'agents_messages') return null;
      const { limit, before, through } = args as {
        limit: number;
        before?: string;
        through?: string;
      };
      calls.push(args);
      const end = before ? log.findIndex((m) => m.id === before) : log.length;
      let start = Math.max(0, end - limit);
      const at = through ? log.findIndex((m) => m.id === through) : -1;
      if (at >= 0 && at < start) start = at;
      return log.slice(start, end);
    });
    return calls;
  };
  const ids = () => getAgentsSnapshot().messages.a.map((m) => m.id);

  it('opens on the newest page and loads older ones above it', async () => {
    serve(MESSAGE_PAGE * 2 + 10);
    await loadMessages('a');
    expect(ids()).toHaveLength(MESSAGE_PAGE);
    expect(getAgentsSnapshot().older.a).toBe(true);
    await loadOlderMessages('a');
    expect(ids()).toHaveLength(MESSAGE_PAGE * 2);
    await loadOlderMessages('a');
    expect(ids()[0]).toBe('m0');
    expect(getAgentsSnapshot().older.a).toBe(false);
  });

  it('a search hit loads back to its line in one request, however often it is asked', async () => {
    const calls = serve(MESSAGE_PAGE * 3);
    await loadMessages('a');
    await Promise.all([loadOlderMessages('a', 'm5'), loadOlderMessages('a', 'm5')]);
    expect(ids()[0]).toBe('m5');
    expect(calls).toHaveLength(2);
  });
});
