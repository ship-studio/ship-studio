import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recordRun, frecencyBoost, _reset } from './frecency';

describe('frecency', () => {
  beforeEach(() => {
    _reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 for a command that was never run', () => {
    expect(frecencyBoost('never.used')).toBe(0);
  });

  it('boosts a just-run command by its count (no recency penalty)', () => {
    recordRun('cmd.a');
    // days since last use ≈ 0 -> count / (1 + 0) === 1.
    expect(frecencyBoost('cmd.a')).toBe(1);
  });

  it('increments the count on repeated runs', () => {
    recordRun('cmd.a');
    recordRun('cmd.a');
    recordRun('cmd.a');
    expect(frecencyBoost('cmd.a')).toBe(3);
  });

  it('decays the score as days pass since last use', () => {
    recordRun('cmd.a'); // count 1, lastUsed = now
    // Advance one full day -> count / (1 + 1) === 0.5.
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(frecencyBoost('cmd.a')).toBe(0.5);
  });

  it('_reset clears all recorded frecency', () => {
    recordRun('cmd.a');
    expect(frecencyBoost('cmd.a')).toBeGreaterThan(0);
    _reset();
    expect(frecencyBoost('cmd.a')).toBe(0);
  });

  it('falls back to an empty map when stored data is corrupt', async () => {
    // The module caches in memory, so a fresh import is needed to exercise the
    // JSON.parse failure path on first load.
    vi.resetModules();
    localStorage.setItem('ship-studio-palette-frecency', '{ not valid json');
    const fresh = await import('./frecency');
    expect(fresh.frecencyBoost('anything')).toBe(0);
    localStorage.removeItem('ship-studio-palette-frecency');
  });
});
