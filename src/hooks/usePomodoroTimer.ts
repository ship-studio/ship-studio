import { useCallback, useEffect, useReducer, useState } from 'react';

export type PomodoroPhase = 'focus' | 'shortBreak' | 'longBreak';
export type PomodoroStatus = 'idle' | 'running' | 'paused' | 'complete';

export interface PomodoroSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
}

export interface PomodoroState {
  phase: PomodoroPhase;
  status: PomodoroStatus;
  remainingSeconds: number;
  targetTimestamp: number | null;
  completedFocusCount: number;
  settings: PomodoroSettings;
  needsAttention: boolean;
}

export type PomodoroAction =
  | { type: 'start'; now: number }
  | { type: 'pause'; now: number }
  | { type: 'tick'; now: number }
  | { type: 'reset' }
  | { type: 'startNext'; now: number }
  | { type: 'updateSettings'; settings: PomodoroSettings }
  | { type: 'acknowledgeAttention' };

export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
};

const STORAGE_KEY = 'ss:pomodoro:v1';
// Keep the live deadline across workspace remounts, only for this app window.
let sessionState: PomodoroState | null = null;
const PHASES: PomodoroPhase[] = ['focus', 'shortBreak', 'longBreak'];
const STATUSES: PomodoroStatus[] = ['idle', 'running', 'paused', 'complete'];

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizeSettings(settings: PomodoroSettings): PomodoroSettings {
  return {
    focusMinutes: clampInteger(settings.focusMinutes, 1, 180),
    shortBreakMinutes: clampInteger(settings.shortBreakMinutes, 1, 180),
    longBreakMinutes: clampInteger(settings.longBreakMinutes, 1, 180),
    sessionsBeforeLongBreak: clampInteger(settings.sessionsBeforeLongBreak, 1, 12),
  };
}

function phaseDurationSeconds(phase: PomodoroPhase, settings: PomodoroSettings): number {
  if (phase === 'shortBreak') return settings.shortBreakMinutes * 60;
  if (phase === 'longBreak') return settings.longBreakMinutes * 60;
  return settings.focusMinutes * 60;
}

export function createInitialPomodoroState(): PomodoroState {
  return {
    phase: 'focus',
    status: 'idle',
    remainingSeconds: DEFAULT_POMODORO_SETTINGS.focusMinutes * 60,
    targetTimestamp: null,
    completedFocusCount: 0,
    settings: { ...DEFAULT_POMODORO_SETTINGS },
    needsAttention: false,
  };
}

function completeInterval(state: PomodoroState): PomodoroState {
  return {
    ...state,
    status: 'complete',
    remainingSeconds: 0,
    targetTimestamp: null,
    completedFocusCount:
      state.phase === 'focus' ? state.completedFocusCount + 1 : state.completedFocusCount,
    needsAttention: true,
  };
}

export function pomodoroReducer(state: PomodoroState, action: PomodoroAction): PomodoroState {
  switch (action.type) {
    case 'start': {
      if (state.status === 'running' || state.status === 'complete') return state;
      return {
        ...state,
        status: 'running',
        targetTimestamp: action.now + state.remainingSeconds * 1_000,
        needsAttention: false,
      };
    }
    case 'pause': {
      if (state.status !== 'running' || state.targetTimestamp === null) return state;
      return {
        ...state,
        status: 'paused',
        remainingSeconds: Math.max(0, Math.ceil((state.targetTimestamp - action.now) / 1_000)),
        targetTimestamp: null,
      };
    }
    case 'tick': {
      if (state.status !== 'running' || state.targetTimestamp === null) return state;
      if (action.now >= state.targetTimestamp) return completeInterval(state);
      const remainingSeconds = Math.max(0, Math.ceil((state.targetTimestamp - action.now) / 1_000));
      return remainingSeconds === state.remainingSeconds ? state : { ...state, remainingSeconds };
    }
    case 'reset':
      return {
        ...state,
        status: 'idle',
        remainingSeconds: phaseDurationSeconds(state.phase, state.settings),
        targetTimestamp: null,
        needsAttention: false,
      };
    case 'startNext': {
      if (state.status !== 'complete') return state;
      const afterFocus = state.phase === 'focus';
      const phase: PomodoroPhase = afterFocus
        ? state.completedFocusCount >= state.settings.sessionsBeforeLongBreak
          ? 'longBreak'
          : 'shortBreak'
        : 'focus';
      const completedFocusCount = state.phase === 'longBreak' ? 0 : state.completedFocusCount;
      const remainingSeconds = phaseDurationSeconds(phase, state.settings);
      return {
        ...state,
        phase,
        status: 'running',
        remainingSeconds,
        targetTimestamp: action.now + remainingSeconds * 1_000,
        completedFocusCount,
        needsAttention: false,
      };
    }
    case 'updateSettings': {
      const settings = normalizeSettings(action.settings);
      return {
        ...state,
        settings,
        remainingSeconds:
          state.status === 'idle'
            ? phaseDurationSeconds(state.phase, settings)
            : state.remainingSeconds,
      };
    }
    case 'acknowledgeAttention':
      return state.needsAttention ? { ...state, needsAttention: false } : state;
  }
}

export function restorePomodoroState(serializedState: string | null): PomodoroState {
  if (!serializedState) return createInitialPomodoroState();

  try {
    const value: unknown = JSON.parse(serializedState);
    if (typeof value !== 'object' || value === null) return createInitialPomodoroState();

    const persisted = value as Partial<PomodoroState>;
    if (
      !PHASES.includes(persisted.phase as PomodoroPhase) ||
      !STATUSES.includes(persisted.status as PomodoroStatus) ||
      typeof persisted.settings !== 'object' ||
      persisted.settings === null
    ) {
      return createInitialPomodoroState();
    }

    const rawSettings = persisted.settings as Partial<PomodoroSettings>;
    const settings = normalizeSettings({
      focusMinutes: Number(rawSettings.focusMinutes),
      shortBreakMinutes: Number(rawSettings.shortBreakMinutes),
      longBreakMinutes: Number(rawSettings.longBreakMinutes),
      sessionsBeforeLongBreak: Number(rawSettings.sessionsBeforeLongBreak),
    });
    const state: PomodoroState = {
      phase: persisted.phase as PomodoroPhase,
      status: persisted.status as PomodoroStatus,
      remainingSeconds:
        typeof persisted.remainingSeconds === 'number' &&
        Number.isFinite(persisted.remainingSeconds)
          ? Math.max(0, Math.ceil(persisted.remainingSeconds))
          : 0,
      targetTimestamp:
        typeof persisted.targetTimestamp === 'number' && Number.isFinite(persisted.targetTimestamp)
          ? persisted.targetTimestamp
          : null,
      completedFocusCount:
        typeof persisted.completedFocusCount === 'number' &&
        Number.isFinite(persisted.completedFocusCount)
          ? Math.max(0, Math.floor(persisted.completedFocusCount))
          : 0,
      settings,
      needsAttention: persisted.needsAttention === true,
    };

    if (state.status === 'running') {
      if (state.targetTimestamp === null) return createInitialPomodoroState();
      return { ...state, status: 'paused', targetTimestamp: null };
    }
    return state;
  } catch {
    return createInitialPomodoroState();
  }
}

export function formatPomodoroTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function usePomodoroTimer() {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [state, dispatch] = useReducer(pomodoroReducer, undefined, () => {
    if (sessionState) return pomodoroReducer(sessionState, { type: 'tick', now: Date.now() });
    try {
      return restorePomodoroState(
        typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
      );
    } catch {
      return createInitialPomodoroState();
    }
  });

  useEffect(() => {
    sessionState = state;
    // Persist a paused checkpoint so time spent outside the app is never deducted.
    // This also works when the OS terminates the process without an unload event.
    const checkpoint =
      state.status === 'running' ? { ...state, status: 'paused', targetTimestamp: null } : state;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(checkpoint));
    } catch {
      // Storage may be blocked or full; sessionState keeps the timer usable across remounts.
    }
  }, [state]);

  useEffect(() => {
    if (state.status !== 'running') return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setCurrentTime(now);
      dispatch({ type: 'tick', now });
    }, 250);
    return () => window.clearInterval(interval);
  }, [state.status]);

  const start = useCallback(() => {
    const now = Date.now();
    setCurrentTime(now);
    dispatch({ type: 'start', now });
  }, []);
  const pause = useCallback(() => {
    const now = Date.now();
    setCurrentTime(now);
    dispatch({ type: 'pause', now });
  }, []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const startNext = useCallback(() => {
    const now = Date.now();
    setCurrentTime(now);
    dispatch({ type: 'startNext', now });
  }, []);
  const updateSettings = useCallback(
    (settings: PomodoroSettings) => dispatch({ type: 'updateSettings', settings }),
    []
  );
  const acknowledgeAttention = useCallback(() => dispatch({ type: 'acknowledgeAttention' }), []);

  const remainingSeconds =
    state.status === 'running' && state.targetTimestamp !== null
      ? Math.max(0, Math.ceil((state.targetTimestamp - currentTime) / 1_000))
      : state.remainingSeconds;

  return {
    state,
    remainingSeconds,
    start,
    pause,
    reset,
    startNext,
    updateSettings,
    acknowledgeAttention,
  };
}
