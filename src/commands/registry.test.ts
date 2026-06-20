import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Command } from './types';
import { setBucket, getSnapshot, subscribe, _reset } from './registry';

const cmd = (id: string): Command => ({
  id,
  title: id,
  category: 'action',
  run: () => undefined,
});

describe('command registry', () => {
  beforeEach(() => {
    _reset();
  });

  it('merges commands from multiple buckets into the snapshot', () => {
    setBucket('a', [cmd('a.one')]);
    setBucket('b', [cmd('b.one'), cmd('b.two')]);
    expect(
      getSnapshot()
        .map((c) => c.id)
        .sort()
    ).toEqual(['a.one', 'b.one', 'b.two']);
  });

  it('clears a bucket when set to an empty array', () => {
    setBucket('a', [cmd('a.one')]);
    setBucket('b', [cmd('b.one')]);
    setBucket('a', []);
    expect(getSnapshot().map((c) => c.id)).toEqual(['b.one']);
  });

  it('is a no-op (no new snapshot) when clearing an absent bucket', () => {
    setBucket('a', [cmd('a.one')]);
    const before = getSnapshot();
    setBucket('ghost', []);
    expect(getSnapshot()).toBe(before);
  });

  it('keeps a stable snapshot reference until the next mutation', () => {
    setBucket('a', [cmd('a.one')]);
    const snap = getSnapshot();
    expect(getSnapshot()).toBe(snap);
    setBucket('b', [cmd('b.one')]);
    expect(getSnapshot()).not.toBe(snap);
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    setBucket('a', [cmd('a.one')]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setBucket('b', [cmd('b.one')]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
