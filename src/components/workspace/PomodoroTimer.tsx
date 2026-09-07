import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import {
  formatPomodoroTime,
  type PomodoroPhase,
  type PomodoroSettings,
  usePomodoroTimer,
} from '../../hooks/usePomodoroTimer';
import { loadNotificationSettings, playSound } from '../../lib/sounds';
import { TimerIcon } from '../icons';
import { Button } from '../primitives/Button';

const PHASE_NAMES: Record<PomodoroPhase, string> = {
  focus: 'Focus',
  shortBreak: 'Short break',
  longBreak: 'Long break',
};

type SettingsDraft = Record<keyof PomodoroSettings, string>;

function makeDraft(settings: PomodoroSettings): SettingsDraft {
  return {
    focusMinutes: String(settings.focusMinutes),
    shortBreakMinutes: String(settings.shortBreakMinutes),
    longBreakMinutes: String(settings.longBreakMinutes),
    sessionsBeforeLongBreak: String(settings.sessionsBeforeLongBreak),
  };
}

function clampDraft(value: string, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, parsed)) : 1;
}

function completionBody(phase: PomodoroPhase, completed: number, cycleLength: number): string {
  if (phase !== 'focus') return 'Ready for the next focus session';
  return completed >= cycleLength ? 'Ready for a long break' : 'Ready for a short break';
}

export function PomodoroTimer() {
  const {
    state,
    remainingSeconds,
    start,
    pause,
    reset,
    startNext,
    updateSettings,
    acknowledgeAttention,
  } = usePomodoroTimer();
  const [isOpen, setIsOpen] = useState(false);
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const [draft, setDraft] = useState(() => makeDraft(state.settings));
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStatus = useRef(state.status);

  const close = useCallback(() => {
    setIsOpen(false);
    setIsEditingSettings(false);
  }, []);
  useClickOutside(wrapperRef, close, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    headingRef.current?.focus();
  }, [isOpen, isEditingSettings]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [close, isOpen]);

  useEffect(() => {
    const justCompleted = previousStatus.current === 'running' && state.status === 'complete';
    previousStatus.current = state.status;
    if (!justCompleted) return;

    const settings = loadNotificationSettings();
    if (settings.enabled) void playSound(settings.sound);

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const title = state.phase === 'focus' ? 'Focus complete' : 'Break complete';
      new Notification(title, {
        body: completionBody(
          state.phase,
          state.completedFocusCount,
          state.settings.sessionsBeforeLongBreak
        ),
      });
    }
  }, [
    state.completedFocusCount,
    state.phase,
    state.settings.sessionsBeforeLongBreak,
    state.status,
  ]);

  const openTimer = () => {
    if (isOpen) {
      close();
      return;
    }
    setDraft(makeDraft(state.settings));
    setIsEditingSettings(false);
    setIsOpen(true);
    acknowledgeAttention();
  };

  const openSettings = () => {
    setDraft(makeDraft(state.settings));
    setIsEditingSettings(true);
  };

  const saveSettings = (event: FormEvent) => {
    event.preventDefault();
    updateSettings({
      focusMinutes: clampDraft(draft.focusMinutes, 180),
      shortBreakMinutes: clampDraft(draft.shortBreakMinutes, 180),
      longBreakMinutes: clampDraft(draft.longBreakMinutes, 180),
      sessionsBeforeLongBreak: clampDraft(draft.sessionsBeforeLongBreak, 12),
    });
    setIsEditingSettings(false);
  };

  const sessionNumber = Math.min(
    state.settings.sessionsBeforeLongBreak,
    state.completedFocusCount + (state.phase === 'focus' && state.status !== 'complete' ? 1 : 0)
  );
  const completeTitle = state.phase === 'focus' ? 'Focus complete' : 'Break complete';
  const completeAction = state.phase === 'focus' ? 'Start break' : 'Start next session';
  const idleAction = state.phase === 'focus' ? 'Start focus' : 'Start break';
  const triggerClasses = [
    'toolbar-icon-btn',
    'pomodoro-trigger',
    isOpen && 'is-open',
    state.needsAttention && 'needs-attention',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="pomodoro" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClasses}
        aria-label="Open Pomodoro timer"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title="Pomodoro timer"
        onClick={openTimer}
      >
        <TimerIcon size={12} />
        {state.status === 'running' && (
          <span className="pomodoro-trigger-time">{formatPomodoroTime(remainingSeconds)}</span>
        )}
      </button>

      {isOpen && (
        <section className="pomodoro-popover" role="dialog" aria-label="Pomodoro timer">
          {isEditingSettings ? (
            <form className="pomodoro-settings" onSubmit={saveSettings}>
              <h2 ref={headingRef} tabIndex={-1} className="pomodoro-heading">
                Timer settings
              </h2>
              {(
                [
                  ['focusMinutes', 'Focus minutes', 180],
                  ['shortBreakMinutes', 'Short break minutes', 180],
                  ['longBreakMinutes', 'Long break minutes', 180],
                  ['sessionsBeforeLongBreak', 'Sessions before long break', 12],
                ] as const
              ).map(([name, label, max]) => (
                <label className="pomodoro-field" key={name}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min="1"
                    max={max}
                    step="1"
                    required
                    value={draft[name]}
                    onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
                  />
                </label>
              ))}
              <div className="pomodoro-actions">
                <Button type="submit" variant="primary" size="sm" aria-label="Save settings">
                  Save settings
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(makeDraft(state.settings));
                    setIsEditingSettings(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="pomodoro-timer-view">
              <div className="pomodoro-heading-row">
                <h2 ref={headingRef} tabIndex={-1} className="pomodoro-heading" aria-live="polite">
                  {state.status === 'complete' ? completeTitle : PHASE_NAMES[state.phase]}
                </h2>
                <button
                  type="button"
                  className="pomodoro-settings-button"
                  aria-label="Timer settings"
                  onClick={openSettings}
                >
                  Settings
                </button>
              </div>
              <div className="pomodoro-time">{formatPomodoroTime(remainingSeconds)}</div>
              <p className="pomodoro-session">
                Session {Math.max(1, sessionNumber)} of {state.settings.sessionsBeforeLongBreak}
              </p>
              {state.status === 'complete' && (
                <p className="pomodoro-completion-copy">
                  {completionBody(
                    state.phase,
                    state.completedFocusCount,
                    state.settings.sessionsBeforeLongBreak
                  )}
                </p>
              )}
              <div className="pomodoro-actions">
                {state.status === 'idle' && (
                  <Button variant="primary" size="sm" onClick={start} aria-label={idleAction}>
                    {idleAction}
                  </Button>
                )}
                {state.status === 'paused' && (
                  <Button variant="primary" size="sm" onClick={start} aria-label="Resume">
                    Resume
                  </Button>
                )}
                {state.status === 'running' && (
                  <Button variant="primary" size="sm" onClick={pause} aria-label="Pause">
                    Pause
                  </Button>
                )}
                {state.status === 'complete' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={startNext}
                    aria-label={completeAction}
                  >
                    {completeAction}
                  </Button>
                )}
                {(state.status === 'running' || state.status === 'paused') && (
                  <Button variant="ghost" size="sm" onClick={reset} aria-label="Reset">
                    Reset
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
