import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowsView } from './WorkflowsView';
import { listProjects } from '../../lib/project';
import type { Workflow } from '../../lib/workflows';
import * as store from '../../lib/workflowsStore';

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

vi.mock('../../lib/workflowsStore', () => ({
  subscribe: vi.fn(() => () => undefined),
  getSnapshot: vi.fn(),
  loadProgress: vi.fn(),
  runWorkflowNow: vi.fn(),
  saveWorkflow: vi.fn(),
  setAutoRun: vi.fn(),
  deleteWorkflow: vi.fn(),
}));

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: '/p/demo::security-sweep',
    slug: 'security-sweep',
    name: 'Security sweep',
    icon: null,
    description: 'Looks for secrets.',
    agentId: 'claude-code',
    projectPath: '/p/demo',
    projectName: 'demo',
    trigger: { kind: 'interval', everyMinutes: 30 },
    permission: 'read-only',
    prompt: 'Review the diff.',
    severityFloor: 'info',
    autoRun: true,
    filePath: '/p/demo/.shipstudio/workflows/security-sweep.md',
    nextRunAt: Date.now() + 12 * 60_000,
    isRunning: false,
    runningSince: null,
    runs: [],
    ...overrides,
  };
}

function snapshot(
  workflows: Workflow[],
  extra: {
    loaded?: boolean;
    error?: string | null;
    progress?: Record<string, { workflowId: string; at: number; text: string }[]>;
  } = {}
) {
  vi.mocked(store.getSnapshot).mockReturnValue({
    workflows,
    inbox: [],
    progress: extra.progress ?? {},
    loaded: extra.loaded ?? true,
    error: extra.error ?? null,
  });
}

describe('WorkflowsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProjects).mockResolvedValue([{ name: 'demo', path: '/p/demo' }]);
  });

  it('shows neither content nor an empty state before the first load resolves', () => {
    // An empty state that flashes before real data is a lie about the user's
    // workflows — "you have none" and "we haven't looked yet" are different.
    snapshot([], { loaded: false });
    render(<WorkflowsView />);
    expect(screen.queryByText('No workflows yet')).not.toBeInTheDocument();
  });

  it('offers the agent-authored path in the empty state', () => {
    snapshot([]);
    render(<WorkflowsView />);
    expect(screen.getByText('No workflows yet')).toBeInTheDocument();
    expect(screen.getByText(/ask your agent to make you one/i)).toBeInTheDocument();
  });

  it('surfaces a read failure instead of pretending there are no workflows', () => {
    snapshot([], { error: 'permission denied' });
    render(<WorkflowsView />);
    expect(screen.getByText('Could not read your workflows')).toBeInTheDocument();
    expect(screen.getByText('permission denied')).toBeInTheDocument();
    expect(screen.queryByText('No workflows yet')).not.toBeInTheDocument();
  });

  it('renders a workflow with its project, agent and honest schedule line', () => {
    snapshot([workflow()]);
    render(<WorkflowsView />);
    expect(screen.getByText('Security sweep')).toBeInTheDocument();
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Every 30 min, while Ship Studio is open')).toBeInTheDocument();
  });

  it('does not advertise a cadence a disarmed workflow is not keeping', () => {
    snapshot([workflow({ autoRun: false, nextRunAt: null })]);
    render(<WorkflowsView />);
    expect(screen.getByText('Every 30 min — auto-run off')).toBeInTheDocument();
    expect(screen.queryByText(/^Due /)).not.toBeInTheDocument();
  });

  it('omits the token total when no run reported usage', () => {
    // Codex reports none. A confident "0 tokens" would be a fabrication.
    snapshot([workflow({ runs: [] })]);
    render(<WorkflowsView />);
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });

  it('reports a clean run as success rather than as nothing happening', async () => {
    vi.mocked(store.runWorkflowNow).mockResolvedValue({
      id: 'run-1',
      workflowId: '/p/demo::security-sweep',
      startedAt: Date.now(),
      durationMs: 1000,
      status: 'ok',
      findings: 0,
      tokens: 100,
      error: null,
      transcript: '',
    });
    snapshot([workflow()]);
    render(<WorkflowsView />);

    await userEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Security sweep: nothing to report', 'success');
    });
  });

  it('points at the Inbox when a run finds something', async () => {
    vi.mocked(store.runWorkflowNow).mockResolvedValue({
      id: 'run-1',
      workflowId: '/p/demo::security-sweep',
      startedAt: Date.now(),
      durationMs: 1000,
      status: 'findings',
      findings: 2,
      tokens: 100,
      error: null,
      transcript: '',
    });
    snapshot([workflow()]);
    render(<WorkflowsView />);

    await userEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        'Security sweep: 2 findings — see your Inbox',
        'success'
      );
    });
  });

  it('surfaces a run failure as a toast rather than swallowing it', async () => {
    vi.mocked(store.runWorkflowNow).mockRejectedValue(new Error('Claude Code is not installed'));
    snapshot([workflow()]);
    render(<WorkflowsView />);

    await userEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Claude Code is not installed'),
        'error'
      );
    });
  });

  it('disables Run while a workflow is already in flight', () => {
    snapshot([workflow({ isRunning: true })]);
    render(<WorkflowsView />);
    expect(screen.getByRole('button', { name: /Running/ })).toBeDisabled();
  });

  it('shows elapsed time for a run rather than a silent spinner', () => {
    // A run is 30s-2min. "Running" alone reads as "is this thing broken?".
    snapshot([workflow({ isRunning: true, runningSince: Date.now() - 72_000 })]);
    render(<WorkflowsView />);
    expect(screen.getByText(/Running · 1m 12s/)).toBeInTheDocument();
  });

  it('falls back to a bare label when the start time is unknown', () => {
    snapshot([workflow({ isRunning: true, runningSince: null })]);
    const { container } = render(<WorkflowsView />);
    // Scoped to the status line: the Run button also reads "Running".
    expect(container.querySelector('.workflow-row-last')?.textContent).toBe('Running');
  });

  it('hides the empty switch column when every workflow is manual', () => {
    snapshot([workflow({ trigger: { kind: 'manual' }, nextRunAt: null })]);
    const { container } = render(<WorkflowsView />);
    expect(container.querySelector('.workflow-row-toggle-slot')).toBeNull();
  });

  it('keeps the switch column when the list is mixed', () => {
    // Alignment only matters when some row actually has a switch.
    snapshot([
      workflow({ id: 'a', trigger: { kind: 'manual' }, nextRunAt: null }),
      workflow({ id: 'b', trigger: { kind: 'interval', everyMinutes: 30 } }),
    ]);
    const { container } = render(<WorkflowsView />);
    expect(container.querySelector('.workflow-row-toggle-slot')).not.toBeNull();
  });

  it('shows the latest activity line while a workflow runs', () => {
    // A spinner says "running". This says "doing something sensible", which is
    // the question people actually have the first few times.
    snapshot([workflow({ isRunning: true, runningSince: Date.now() - 5000 })], {
      progress: {
        '/p/demo::security-sweep': [
          { workflowId: '/p/demo::security-sweep', at: 1, text: 'Starting Claude Code' },
          { workflowId: '/p/demo::security-sweep', at: 2, text: 'Reading …/src/api/checkout.js' },
        ],
      },
    });
    render(<WorkflowsView />);
    // Only the newest line shows until it's expanded.
    expect(screen.getByText('Reading …/src/api/checkout.js')).toBeInTheDocument();
    expect(screen.queryByText('Starting Claude Code')).not.toBeInTheDocument();
  });

  it('expands to the full activity log on request', async () => {
    snapshot([workflow({ isRunning: true })], {
      progress: {
        '/p/demo::security-sweep': [
          { workflowId: '/p/demo::security-sweep', at: 1, text: 'Starting Claude Code' },
          { workflowId: '/p/demo::security-sweep', at: 2, text: '$ git diff --stat' },
        ],
      },
    });
    render(<WorkflowsView />);

    await userEvent.click(screen.getByRole('button', { name: /Show what it is doing/ }));
    expect(screen.getByText('Starting Claude Code')).toBeInTheDocument();
    expect(screen.getByText('$ git diff --stat')).toBeInTheDocument();
  });

  it('shows no activity affordance for a workflow that has not run', () => {
    snapshot([workflow()]);
    render(<WorkflowsView />);
    expect(screen.queryByRole('button', { name: /Show what it is doing/ })).not.toBeInTheDocument();
  });

  it('shows no auto-run switch for a manual workflow', () => {
    snapshot([workflow({ trigger: { kind: 'manual' }, nextRunAt: null })]);
    render(<WorkflowsView />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('Manual — runs when you press Run')).toBeInTheDocument();
  });
});
