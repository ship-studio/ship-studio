import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  formatDivider,
  formatUsage,
  groupHits,
  highlightRuns,
  modelLabel,
  peerGroupLabel,
  sortAgents,
  type Agent,
  type AgentMessage,
  type SearchHit,
  type UsageTotals,
} from './agents';

const msg = (id: string, kind: AgentMessage['kind'], ts: number, peer?: string): AgentMessage => ({
  id,
  agentId: 'chief',
  ts,
  kind,
  text: id,
  ...(peer ? { peer: { id: peer, name: peer.toUpperCase() } } : {}),
});

describe('buildChatItems', () => {
  it('collapses consecutive lines with the same agent into one group', () => {
    const items = buildChatItems([
      msg('a', 'agent', 1000),
      msg('b', 'sent_to_agent', 1001, 'acme'),
      msg('c', 'from_agent', 1002, 'acme'),
      msg('d', 'sent_to_agent', 1003, 'finance'),
      msg('e', 'agent', 1004),
    ]);
    const kinds = items.map((i) =>
      i.type === 'peer-group' ? `group:${i.messages.length}` : i.type
    );
    expect(kinds).toEqual(['day', 'message', 'group:2', 'group:1', 'message']);
  });

  it('does not merge groups across a regular message', () => {
    const items = buildChatItems([
      msg('a', 'sent_to_agent', 1000, 'acme'),
      msg('b', 'agent', 1001),
      msg('c', 'from_agent', 1002, 'acme'),
    ]);
    expect(items.filter((i) => i.type === 'peer-group')).toHaveLength(2);
  });

  it('prints a time divider after a long gap', () => {
    const hour = 60 * 60 * 1000;
    const items = buildChatItems([
      msg('a', 'user', hour),
      msg('b', 'agent', hour + 1000),
      msg('c', 'user', 3 * hour),
    ]);
    // One for the start of the conversation, one after the gap.
    expect(items.filter((i) => i.type === 'day')).toHaveLength(2);
  });
});

describe('peerGroupLabel', () => {
  it('says what happened', () => {
    expect(peerGroupLabel([msg('a', 'sent_to_agent', 0, 'x')])).toBe('Messaged');
    expect(peerGroupLabel([msg('a', 'from_agent', 0, 'x')])).toBe('Message from');
    expect(
      peerGroupLabel([msg('a', 'from_agent', 0, 'x'), msg('b', 'sent_to_agent', 1, 'x')])
    ).toBe('2 messages with');
  });
});

describe('formatDivider', () => {
  it('names today and yesterday', () => {
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    expect(formatDivider(new Date(2026, 10, 3, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(formatDivider(new Date(2026, 10, 2, 9, 5).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatDivider(new Date(2026, 9, 20, 9, 5).getTime(), now)).not.toMatch(
      /^(Today|Yesterday)/
    );
  });
});

describe('sortAgents', () => {
  const a = (id: string, lastActivityAt: number, pinned = false) =>
    ({ id, lastActivityAt, pinned }) as Agent;
  it('puts pinned first, then most recent', () => {
    const sorted = sortAgents([a('old', 1), a('pinned-old', 0, true), a('new', 5)]);
    expect(sorted.map((x) => x.id)).toEqual(['pinned-old', 'new', 'old']);
  });
});

describe('search results', () => {
  const hit = (agentId: string, messageId: string): SearchHit => ({
    agentId,
    agentName: agentId,
    agentColor: 'blue',
    messageId,
    ts: 0,
    kind: 'agent',
    snippet: '',
  });

  it('groups by agent in the order of each agent’s newest hit', () => {
    const groups = groupHits([hit('b', '1'), hit('a', '2'), hit('b', '3')]);
    expect(groups.map((g) => [g.agentId, g.hits.map((h) => h.messageId)])).toEqual([
      ['b', ['1', '3']],
      ['a', ['2']],
    ]);
  });

  it('highlights every word, case-insensitively, without regex surprises', () => {
    const runs = highlightRuns('Invoice for Northwind (Q3)', 'northwind invoice (q3');
    expect(runs.filter((r) => r.match).map((r) => r.text)).toEqual(['Invoice', 'Northwind', '(Q3']);
    expect(runs.map((r) => r.text).join('')).toBe('Invoice for Northwind (Q3)');
    expect(highlightRuns('plain', ' ')).toEqual([{ text: 'plain', match: false }]);
  });
});

describe('formatUsage', () => {
  const totals = (over: Partial<UsageTotals>): UsageTotals => ({
    turns: 2,
    inputTokens: 10,
    outputTokens: 500,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 9_490,
    costUsd: 0.4231,
    pricedTurns: 2,
    durationMs: 185_000,
    ...over,
  });

  it('prints only what was reported', () => {
    expect(formatUsage(totals({}))).toBe('$0.42 · 40k tokens · 2 turns · 3 min');
    expect(formatUsage(totals({ turns: 0 }))).toBeNull();
  });

  it('drops the cost when any turn reported none, rather than under-reporting it', () => {
    expect(formatUsage(totals({ pricedTurns: 1, durationMs: 0 }))).toBe('40k tokens · 2 turns');
  });

  it('labels models by alias and passes unknown ids through', () => {
    expect(modelLabel(null)).toBe('Default');
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('claude-x')).toBe('claude-x');
  });
});
