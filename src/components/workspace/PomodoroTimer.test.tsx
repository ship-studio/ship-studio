import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PomodoroState } from '../../hooks/usePomodoroTimer';
import { loadNotificationSettings, playSound } from '../../lib/sounds';
import { PomodoroTimer } from './PomodoroTimer';

const actions = {
  start: vi.fn(),
  pause: vi.fn(),
  reset: vi.fn(),
  startNext: vi.fn(),
  updateSettings: vi.fn(),
  acknowledgeAttention: vi.fn(),
};
const initial: PomodoroState = {
  phase: 'focus',
  status: 'idle',
  remainingSeconds: 1500,
  targetTimestamp: null,
  completedFocusCount: 0,
  settings: {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    sessionsBeforeLongBreak: 4,
  },
  needsAttention: false,
};
let timer = { state: initial, remainingSeconds: 1500, ...actions };

vi.mock('../../hooks/usePomodoroTimer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/usePomodoroTimer')>();
  return { ...actual, usePomodoroTimer: () => timer };
});
vi.mock('../../lib/sounds', () => ({
  loadNotificationSettings: vi.fn(() => ({ enabled: true, sound: {} })),
  playSound: vi.fn(),
}));

describe('PomodoroTimer', () => {
  beforeEach(() => {
    timer = { state: initial, remainingSeconds: 1500, ...actions };
  });

  it('opens an accessible timer popover and starts focus', async () => {
    const user = userEvent.setup();
    render(<PomodoroTimer />);
    const trigger = screen.getByRole('button', { name: 'Open Pomodoro timer' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Pomodoro timer' })).toBeVisible();
    expect(screen.getByText('25:00')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start focus' }));
    expect(actions.start).toHaveBeenCalledOnce();
    expect(actions.acknowledgeAttention).toHaveBeenCalledOnce();
  });

  it('offers pause and reset while running', async () => {
    timer = { ...timer, state: { ...initial, status: 'running' }, remainingSeconds: 1219 };
    const user = userEvent.setup();
    render(<PomodoroTimer />);
    expect(screen.getByText('20:19')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open Pomodoro timer' }));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(actions.pause).toHaveBeenCalledOnce();
    expect(actions.reset).toHaveBeenCalledOnce();
  });

  it.each([
    ['focus', 'Focus complete', 'Start break'],
    ['shortBreak', 'Break complete', 'Start next session'],
  ] as const)('renders completion action for %s', async (phase, copy, action) => {
    timer = {
      ...timer,
      state: { ...initial, phase, status: 'complete', needsAttention: true },
      remainingSeconds: 0,
    };
    const user = userEvent.setup();
    render(<PomodoroTimer />);
    expect(screen.getByRole('button', { name: 'Open Pomodoro timer' })).toHaveClass(
      'needs-attention'
    );
    await user.click(screen.getByRole('button', { name: 'Open Pomodoro timer' }));
    expect(screen.getByText(copy)).toBeVisible();
    await user.click(screen.getByRole('button', { name: action }));
    expect(actions.startNext).toHaveBeenCalled();
  });

  it('edits and saves settings', async () => {
    const user = userEvent.setup();
    render(<PomodoroTimer />);
    await user.click(screen.getByRole('button', { name: 'Open Pomodoro timer' }));
    await user.click(screen.getByRole('button', { name: 'Timer settings' }));
    expect(screen.getByLabelText('Short break minutes')).toHaveValue(5);
    await user.clear(screen.getByLabelText('Focus minutes'));
    await user.type(screen.getByLabelText('Focus minutes'), '40');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(actions.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ focusMinutes: 40 })
    );
  });

  it('closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(<PomodoroTimer />);
    const trigger = screen.getByRole('button', { name: 'Open Pomodoro timer' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    render(
      <>
        <PomodoroTimer />
        <button>Outside</button>
      </>
    );
    await user.click(screen.getByRole('button', { name: 'Open Pomodoro timer' }));
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when focus moves into the preview iframe, including after reopening', async () => {
    const user = userEvent.setup();
    render(
      <>
        <PomodoroTimer />
        <iframe title="Project preview" />
      </>
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await user.click(screen.getByRole('button', { name: 'Open Pomodoro timer' }));
      screen.getByTitle('Project preview').focus();
      fireEvent(window, new Event('blur'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
  });

  it('sends completion feedback once only on a running-to-complete transition', () => {
    const notify = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notify, { permission: 'granted' }));
    timer = { ...timer, state: { ...initial, status: 'running' } };
    const { rerender } = render(<PomodoroTimer />);

    timer = {
      ...timer,
      state: { ...initial, status: 'complete', completedFocusCount: 1, needsAttention: true },
      remainingSeconds: 0,
    };
    rerender(<PomodoroTimer />);
    rerender(<PomodoroTimer />);

    expect(loadNotificationSettings).toHaveBeenCalledOnce();
    expect(playSound).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('Focus complete', { body: 'Ready for a short break' });
    vi.unstubAllGlobals();
  });
});
