import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  describeRepeat,
  formatWhen,
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
  it('describes routines in the same words as the backend', () => {
    expect(describeRepeat({ kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe(
      'Every weekday at 09:00'
    );
    expect(describeRepeat({ kind: 'days', days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 45 })).toBe(
      'Every day at 07:45'
    );
    expect(describeRepeat({ kind: 'days', days: [1, 4], hour: 8, minute: 30 })).toBe(
      'Every Monday and Thursday at 08:30'
    );
    expect(describeRepeat({ kind: 'days', days: [1, 3, 5], hour: 8, minute: 30 })).toBe(
      'Every Monday, Wednesday and Friday at 08:30'
    );
    expect(describeRepeat({ kind: 'every', minutes: 120 })).toBe('Every 2 hours');
    expect(describeRepeat({ kind: 'every', minutes: 60 })).toBe('Every hour');
    expect(describeRepeat({ kind: 'every', minutes: 90 })).toBe('Every 90 minutes');
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
