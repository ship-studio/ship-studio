import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  describeCheckInTime,
  describeRepeat,
  formatWhen,
  splitScheduleInput,
  sortCheckIns,
  formatDivider,
  peerGroupLabel,
  sortAgents,
  type Agent,
  type AgentMessage,
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
