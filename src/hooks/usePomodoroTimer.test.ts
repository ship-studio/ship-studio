import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_POMODORO_SETTINGS,
  createInitialPomodoroState,
  formatPomodoroTime,
  pomodoroReducer,
  restorePomodoroState,
  usePomodoroTimer,
} from './usePomodoroTimer';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pomodoroReducer', () => {
  it('completes focus and offers a short break for sessions one through three', () => {
    const running = pomodoroReducer(createInitialPomodoroState(), { type: 'start', now: 1_000 });
    const complete = pomodoroReducer(running, {
      type: 'tick',
      now: 1_000 + 25 * 60_000,
    });
    expect(complete).toMatchObject({
      phase: 'focus',
      status: 'complete',
      completedFocusCount: 1,
      needsAttention: true,
    });
    const breakState = pomodoroReducer(complete, {
      type: 'startNext',
      now: 2_000_000,
    });
    expect(breakState).toMatchObject({ phase: 'shortBreak', status: 'running' });
  });

  it('offers a long break after the fourth completed focus session', () => {
    const state = {
      ...createInitialPomodoroState(),
      status: 'complete' as const,
      completedFocusCount: 4,
    };
    expect(pomodoroReducer(state, { type: 'startNext', now: 10_000 }).phase).toBe('longBreak');
  });

  it('returns to focus session one after the long break', () => {
    const state = {
      ...createInitialPomodoroState(),
      phase: 'longBreak' as const,
      status: 'complete' as const,
      completedFocusCount: 4,
    };
    expect(pomodoroReducer(state, { type: 'startNext', now: 10_000 })).toMatchObject({
      phase: 'focus',
      status: 'running',
      completedFocusCount: 0,
    });
  });

  it('preserves remaining seconds when paused and resumed', () => {
    const running = pomodoroReducer(createInitialPomodoroState(), { type: 'start', now: 1_000 });
    const paused = pomodoroReducer(running, { type: 'pause', now: 31_000 });
    expect(paused).toMatchObject({
      status: 'paused',
      remainingSeconds: 24 * 60 + 30,
      targetTimestamp: null,
    });

    const resumed = pomodoroReducer(paused, { type: 'start', now: 100_000 });
    expect(resumed).toMatchObject({
      status: 'running',
      remainingSeconds: 24 * 60 + 30,
      targetTimestamp: 100_000 + (24 * 60 + 30) * 1_000,
    });
  });

  it('resets to the configured duration of the current phase', () => {
    const state = {
      ...createInitialPomodoroState(),
      phase: 'shortBreak' as const,
      status: 'paused' as const,
      remainingSeconds: 10,
      targetTimestamp: null,
      needsAttention: true,
    };
    expect(pomodoroReducer(state, { type: 'reset' })).toMatchObject({
      phase: 'shortBreak',
      status: 'idle',
      remainingSeconds: 5 * 60,
      targetTimestamp: null,
      needsAttention: false,
    });
  });

  it('updates settings without altering the current running interval', () => {
    const running = pomodoroReducer(createInitialPomodoroState(), { type: 'start', now: 1_000 });
    const settings = { ...DEFAULT_POMODORO_SETTINGS, focusMinutes: 50 };
    const updated = pomodoroReducer(running, { type: 'updateSettings', settings });
    expect(updated.settings.focusMinutes).toBe(50);
    expect(updated.targetTimestamp).toBe(running.targetTimestamp);
    expect(updated.remainingSeconds).toBe(running.remainingSeconds);
  });

  it('updates the displayed duration when idle settings change and clamps values', () => {
    const updated = pomodoroReducer(createInitialPomodoroState(), {
      type: 'updateSettings',
      settings: {
        focusMinutes: 0,
        shortBreakMinutes: 181,
        longBreakMinutes: 20,
        sessionsBeforeLongBreak: 99,
      },
    });
    expect(updated.settings).toEqual({
      focusMinutes: 1,
      shortBreakMinutes: 180,
      longBreakMinutes: 20,
      sessionsBeforeLongBreak: 12,
    });
    expect(updated.remainingSeconds).toBe(60);
  });
});

describe('restorePomodoroState', () => {
  it('falls back to defaults for corrupt persisted JSON', () => {
    expect(restorePomodoroState('{nope')).toEqual(createInitialPomodoroState());
  });

  it('restores legacy running timers paused without deducting time away', () => {
    const persisted = JSON.stringify({
      ...createInitialPomodoroState(),
      status: 'running',
      targetTimestamp: 1_000,
    });
    const restored = restorePomodoroState(persisted);
    expect(restored).toMatchObject({
      status: 'paused',
      remainingSeconds: 1500,
      targetTimestamp: null,
      completedFocusCount: 0,
      needsAttention: false,
    });
    expect(pomodoroReducer(restored, { type: 'tick', now: 3_000 })).toEqual(restored);
  });
});

describe('formatPomodoroTime', () => {
  it('formats remaining seconds as minutes and seconds', () => {
    expect(formatPomodoroTime(1_500)).toBe('25:00');
    expect(formatPomodoroTime(5)).toBe('00:05');
  });
});

describe('usePomodoroTimer persistence', () => {
  it('keeps running across workspace remounts but saves a paused restart checkpoint', async () => {
    localStorage.clear();
    const first = renderHook(() => usePomodoroTimer());
    act(() => first.result.current.start());
    await act(() => vi.advanceTimersByTime(10_000));
    expect(first.result.current.remainingSeconds).toBe(1490);

    const checkpoint = localStorage.getItem('ss:pomodoro:v1');
    expect(JSON.parse(checkpoint!)).toMatchObject({
      status: 'paused',
      remainingSeconds: 1490,
      targetTimestamp: null,
    });
    first.unmount();
    await act(() => vi.advanceTimersByTime(60_000));

    const second = renderHook(() => usePomodoroTimer());
    expect(second.result.current.state.status).toBe('running');
    expect(second.result.current.remainingSeconds).toBe(1430);
    second.unmount();

    // A fresh app process has no in-memory session and restores the checkpoint.
    const restarted = restorePomodoroState(checkpoint);
    expect(restarted.status).toBe('paused');
    expect(restarted.remainingSeconds).toBe(1490);
    const resumed = pomodoroReducer(restarted, { type: 'start', now: Date.now() });
    expect(resumed.targetTimestamp).toBe(Date.now() + 1490_000);
  });
});
