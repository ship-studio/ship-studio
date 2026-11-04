import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  describeCheckInTime,
  describeRepeat,
  formatWhen,
  splitScheduleInput,
  sortCheckIns,
  formatDivider,
  formatUsage,
  groupHits,
  highlightRuns,
  modelLabel,
  peerGroupLabel,
  sortAgents,
  splitQuotes,
  withQuotes,
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

  it('prints a time divider for a new sitting, not a pause', () => {
    const hour = 60 * 60 * 1000;
    const morning = new Date(2026, 10, 3, 8).getTime();
    const days = (messages: AgentMessage[]) =>
      buildChatItems(messages).filter((i) => i.type === 'day').length;
    // An hour's pause: still one sitting.
    expect(days([msg('a', 'user', morning), msg('b', 'agent', morning + hour)])).toBe(1);
    // Four hours of quiet: a new one.
    expect(days([msg('a', 'user', morning), msg('b', 'agent', morning + 4 * hour)])).toBe(2);
    // Across midnight, however short the gap.
    const lateNight = new Date(2026, 10, 3, 23, 50).getTime();
    expect(days([msg('a', 'user', lateNight), msg('b', 'agent', lateNight + hour / 3)])).toBe(2);
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

describe('quotes', () => {
  it('sends each quote as a blockquote ahead of the typed text', () => {
    expect(withQuotes(['one', 'two\nlines'], 'Why?')).toBe('> one\n\n> two\n> lines\n\nWhy?');
    expect(withQuotes(['only'], '')).toBe('> only');
  });

  it('reads blockquotes back out of a user message', () => {
    expect(splitQuotes('> one\n\n> two\n> lines\n\nWhy?')).toEqual([
      { kind: 'quote', text: 'one' },
      { kind: 'quote', text: 'two\nlines' },
      { kind: 'text', text: 'Why?' },
    ]);
    expect(splitQuotes('> a\n>\n> b')).toEqual([{ kind: 'quote', text: 'a\n\nb' }]);
    expect(splitQuotes('no quotes > here')).toEqual([{ kind: 'text', text: 'no quotes > here' }]);
  });
});

describe('schedule helpers', () => {
  // Times are written in the user's locale, like everything else on screen.
  const at = (hour: number, minute: number) =>
    new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

  it("describes routines in the backend's words, with locale times", () => {
    expect(describeRepeat({ kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe(
      `Every weekday at ${at(9, 0)}`
    );
    expect(describeRepeat({ kind: 'days', days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 45 })).toBe(
      `Every day at ${at(7, 45)}`
    );
    expect(describeRepeat({ kind: 'days', days: [1, 4], hour: 8, minute: 30 })).toBe(
      `Every Monday and Thursday at ${at(8, 30)}`
    );
    expect(describeRepeat({ kind: 'days', days: [1, 3, 5], hour: 8, minute: 30 })).toBe(
      `Every Monday, Wednesday and Friday at ${at(8, 30)}`
    );
    expect(describeRepeat({ kind: 'every', minutes: 120 })).toBe('Every 2 hours');
    expect(describeRepeat({ kind: 'every', minutes: 60 })).toBe('Every hour');
    expect(describeRepeat({ kind: 'every', minutes: 90 })).toBe('Every 90 minutes');
  });

  it('splits "when: what" at the first colon that is followed by a space', () => {
    expect(splitScheduleInput('every weekday 9am: brief me on Acme')).toEqual({
      when: 'every weekday 9am',
      note: 'brief me on Acme',
    });
    expect(splitScheduleInput('tomorrow 9:30: check: the invoices')).toEqual({
      when: 'tomorrow 9:30',
      note: 'check: the invoices',
    });
    expect(splitScheduleInput('every weekday 9:30')).toEqual({
      when: 'every weekday 9:30',
      note: '',
    });
    expect(splitScheduleInput('tomorrow 9am:')).toEqual({ when: 'tomorrow 9am', note: '' });
  });

  it('words a row: next time, how it repeats, paused', () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    const nextAt = new Date(2026, 10, 5, 9, 0).getTime();
    const repeat = { kind: 'days' as const, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 };
    const base = { id: 'x', note: 'n', nextAt, createdAt: 0, paused: false };
    expect(describeCheckInTime(base, now)).toBe(`Tomorrow ${at(9, 0)}`);
    expect(describeCheckInTime({ ...base, repeat }, now)).toBe(
      `Every weekday at ${at(9, 0)} · next tomorrow ${at(9, 0)}`
    );
    expect(describeCheckInTime({ ...base, repeat, paused: true }, now)).toBe(
      `Paused · Every weekday at ${at(9, 0)}`
    );
  });

  it('names today and tomorrow, and dates further out', () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    expect(formatWhen(new Date(2026, 10, 4, 18, 0).getTime(), now)).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 10, 5, 9, 0).getTime(), now)).toMatch(/^Tomorrow /);
    expect(formatWhen(new Date(2026, 10, 9, 9, 0).getTime(), now)).not.toMatch(/Today|Tomorrow/);
  });

  it('lists the soonest first and paused ones last', () => {
    const c = (id: string, nextAt: number, paused = false) => ({
      id,
      note: id,
      nextAt,
      createdAt: 0,
      paused,
    });
    expect(
      sortCheckIns([c('late', 3), c('paused', 1, true), c('soon', 2)]).map((x) => x.id)
    ).toEqual(['soon', 'late', 'paused']);
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
