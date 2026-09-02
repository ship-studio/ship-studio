import { describe, it, expect } from 'vitest';
import { mergeExchangeSnapshot, upsertExchange, type StudioExchange } from './studioTalk';

function exchange(id: number, overrides: Partial<StudioExchange> = {}): StudioExchange {
  return {
    id,
    fromProject: '/u/ShipStudio/agent-app',
    toProject: '/u/ShipStudio/dashboard',
    question: 'What does /api/metrics return?',
    status: 'running',
    activity: [],
    answer: null,
    error: null,
    startedAtMs: 1000 + id,
    finishedAtMs: null,
    ...overrides,
  };
}

describe('upsertExchange', () => {
  it('prepends a new exchange and keeps newest-first order', () => {
    const list = upsertExchange([exchange(1)], exchange(2));
    expect(list.map((e) => e.id)).toEqual([2, 1]);
  });

  it('replaces an existing exchange in place by id', () => {
    const list = upsertExchange(
      [exchange(2), exchange(1)],
      exchange(1, { status: 'completed', answer: 'JSON.' })
    );
    expect(list.map((e) => e.id)).toEqual([2, 1]);
    expect(list[1].status).toBe('completed');
    expect(list[1].answer).toBe('JSON.');
  });
});

describe('mergeExchangeSnapshot', () => {
  it('unions snapshot entries with event-sourced ones', () => {
    const merged = mergeExchangeSnapshot([exchange(3)], [exchange(1), exchange(2)]);
    expect(merged.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('prefers the event-sourced entry on id conflict', () => {
    // The event arrived after the snapshot was requested — it is fresher.
    const fromEvent = exchange(1, { status: 'completed', answer: 'done' });
    const fromSnapshot = exchange(1, { status: 'running' });
    const merged = mergeExchangeSnapshot([fromEvent], [fromSnapshot]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('completed');
  });

  it('handles an empty current list (plain snapshot load)', () => {
    const merged = mergeExchangeSnapshot([], [exchange(2), exchange(1)]);
    expect(merged.map((e) => e.id)).toEqual([2, 1]);
  });
});
