import { afterEach, describe, expect, it } from 'vitest';
import { __resetAgentsStore, getAgentsSnapshot, updateDraft, upsertMessage } from './agentsStore';
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
