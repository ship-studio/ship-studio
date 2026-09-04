import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutinesView } from './RoutinesView';
import { listProjects } from '../../lib/project';
import type { Routine } from '../../lib/routines';
import * as store from '../../lib/routinesStore';

vi.mock('../../lib/project', () => ({
  listProjects: vi.fn(),
}));

vi.mock('../../hooks/useDashboardVisibility', () => ({
  useDashboardVisibility: () => ({ dashboardHeaderHidden: true, hideDashboardHeader: vi.fn() }),
}));

vi.mock('../dashboard/DashboardSearch', () => ({
  DashboardSearch: () => <div data-testid="search" />,
}));

const showToast = vi.fn<(message: string, type?: string) => void>();
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast }),
}));

vi.mock('../../lib/routinesStore', () => ({
  subscribe: vi.fn(() => () => undefined),
  getSnapshot: vi.fn(),
  runRoutineNow: vi.fn(),
  saveRoutine: vi.fn(),
  setAutoRun: vi.fn(),
  deleteRoutine: vi.fn(),
}));

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: '/p/demo::security-sweep',
    slug: 'security-sweep',
    name: 'Security sweep',
    description: 'Looks for secrets.',
    agentId: 'claude-code',
    projectPath: '/p/demo',
    projectName: 'demo',
    trigger: { kind: 'interval', everyMinutes: 30 },
    permission: 'read-only',
    prompt: 'Review the diff.',
    severityFloor: 'info',
    autoRun: true,
    filePath: '/p/demo/.shipstudio/routines/security-sweep.md',
    nextRunAt: Date.now() + 12 * 60_000,
    isRunning: false,
    runs: [],
    ...overrides,
  };
}

function snapshot(routines: Routine[], extra: { loaded?: boolean; error?: string | null } = {}) {
  vi.mocked(store.getSnapshot).mockReturnValue({
    routines,
    inbox: [],
    loaded: extra.loaded ?? true,
    error: extra.error ?? null,
  });
}

describe('RoutinesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProjects).mockResolvedValue([{ name: 'demo', path: '/p/demo' }]);
  });

  it('shows neither content nor an empty state before the first load resolves', () => {
    // An empty state that flashes before real data is a lie about the user's
    // routines — "you have none" and "we haven't looked yet" are different.
    snapshot([], { loaded: false });
    render(<RoutinesView />);
    expect(screen.queryByText('No routines yet')).not.toBeInTheDocument();
  });

  it('offers the agent-authored path in the empty state', () => {
    snapshot([]);
    render(<RoutinesView />);
    expect(screen.getByText('No routines yet')).toBeInTheDocument();
    expect(screen.getByText(/ask your agent to make you one/i)).toBeInTheDocument();
  });

  it('surfaces a read failure instead of pretending there are no routines', () => {
    snapshot([], { error: 'permission denied' });
    render(<RoutinesView />);
    expect(screen.getByText('Could not read your routines')).toBeInTheDocument();
    expect(screen.getByText('permission denied')).toBeInTheDocument();
    expect(screen.queryByText('No routines yet')).not.toBeInTheDocument();
  });

  it('renders a routine with its project, agent and honest schedule line', () => {
    snapshot([routine()]);
    render(<RoutinesView />);
    expect(screen.getByText('Security sweep')).toBeInTheDocument();
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Every 30 min, while Ship Studio is open')).toBeInTheDocument();
  });

  it('does not advertise a cadence a disarmed routine is not keeping', () => {
    snapshot([routine({ autoRun: false, nextRunAt: null })]);
    render(<RoutinesView />);
    expect(screen.getByText('Every 30 min — auto-run off')).toBeInTheDocument();
    expect(screen.queryByText(/^Due /)).not.toBeInTheDocument();
  });

  it('omits the token total when no run reported usage', () => {
    // Codex reports none. A confident "0 tokens" would be a fabrication.
    snapshot([routine({ runs: [] })]);
    render(<RoutinesView />);
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });

  it('reports a clean run as success rather than as nothing happening', async () => {
    vi.mocked(store.runRoutineNow).mockResolvedValue({
      id: 'run-1',
      routineId: '/p/demo::security-sweep',
      startedAt: Date.now(),
      durationMs: 1000,
      status: 'ok',
      findings: 0,
      tokens: 100,
      error: null,
      transcript: '',
    });
    snapshot([routine()]);
    render(<RoutinesView />);

    await userEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Security sweep: nothing to report', 'success');
    });
  });

  it('points at the Inbox when a run finds something', async () => {
    vi.mocked(store.runRoutineNow).mockResolvedValue({
      id: 'run-1',
      routineId: '/p/demo::security-sweep',
      startedAt: Date.now(),
      durationMs: 1000,
      status: 'findings',
      findings: 2,
      tokens: 100,
      error: null,
      transcript: '',
    });
    snapshot([routine()]);
    render(<RoutinesView />);

    await userEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        'Security sweep: 2 findings — see your Inbox',
        'success'
      );
    });
  });

  it('surfaces a run failure as a toast rather than swallowing it', async () => {
    vi.mocked(store.runRoutineNow).mockRejectedValue(new Error('Claude Code is not installed'));
    snapshot([routine()]);
    render(<RoutinesView />);

    await userEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Claude Code is not installed'),
        'error'
      );
    });
  });

  it('disables Run while a routine is already in flight', () => {
    snapshot([routine({ isRunning: true })]);
    render(<RoutinesView />);
    expect(screen.getByRole('button', { name: /Running/ })).toBeDisabled();
    expect(screen.getByText('Running now')).toBeInTheDocument();
  });

  it('shows no auto-run switch for a manual routine', () => {
    snapshot([routine({ trigger: { kind: 'manual' }, nextRunAt: null })]);
    render(<RoutinesView />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('Manual — runs when you press Run')).toBeInTheDocument();
  });
});
