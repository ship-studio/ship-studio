import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxView } from './InboxView';
import type { InboxItem } from '../../lib/routines';
import { peekHandoff, clearHandoff } from '../../lib/routineHandoff';
import * as store from '../../lib/routinesStore';

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
  markAllRead: vi.fn().mockResolvedValue(undefined),
  setItemArchived: vi.fn().mockResolvedValue(undefined),
  setItemRead: vi.fn().mockResolvedValue(undefined),
}));

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'finding-1',
    routineId: '/p/demo::security-sweep',
    routineName: 'Security sweep',
    projectName: 'demo',
    projectPath: '/p/demo',
    severity: 'critical',
    title: 'Checkout route trusts the cookie',
    summary: 'Any client can set userId.',
    bodyMd: 'The **checkout** route reads the cookie without verifying it.',
    createdAt: Date.now() - 60_000,
    read: false,
    archived: false,
    fingerprint: 'abc',
    occurrences: 1,
    firstSeenAt: Date.now() - 60_000,
    locations: [{ path: 'src/api/checkout.js', line: 2, note: 'unverified read' }],
    suggestedPrompt: 'Fix the checkout route to verify the session.',
    runId: 'run-1',
    ...overrides,
  };
}

function snapshot(inbox: InboxItem[]) {
  vi.mocked(store.getSnapshot).mockReturnValue({
    routines: [],
    inbox,
    loaded: true,
    error: null,
  });
}

describe('InboxView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHandoff();
  });

  it('renders a finding with its location and severity', () => {
    snapshot([item()]);
    render(<InboxView />);
    expect(screen.getAllByText('Checkout route trusts the cookie').length).toBeGreaterThan(0);
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('src/api/checkout.js:2')).toBeInTheDocument();
  });

  it('renders the agent-authored markdown body as HTML', () => {
    snapshot([item()]);
    const { container } = render(<InboxView />);
    expect(container.querySelector('.inbox-detail-body strong')?.textContent).toBe('checkout');
  });

  it('hides the fix action when there is nowhere to navigate to', () => {
    // A button that does nothing is worse than no button.
    snapshot([item()]);
    render(<InboxView />);
    expect(screen.queryByRole('button', { name: /Fix in/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy prompt/ })).toBeInTheDocument();
  });

  it('queues the prompt and opens the project when fixing', async () => {
    const onOpenProject = vi.fn();
    snapshot([item()]);
    render(<InboxView onOpenProject={onOpenProject} />);

    await userEvent.click(screen.getByRole('button', { name: /Fix in demo/ }));

    expect(onOpenProject).toHaveBeenCalledWith({
      name: 'demo',
      path: '/p/demo',
      thumbnail: null,
    });
    // The prompt has to survive the navigation — the terminal doesn't exist yet.
    expect(peekHandoff('/p/demo')).toBe('Fix the checkout route to verify the session.');
  });

  it('marks a finding read when it is opened', async () => {
    snapshot([item({ id: 'a' }), item({ id: 'b', title: 'Second finding', severity: 'warning' })]);
    render(<InboxView />);

    await userEvent.click(screen.getByText('Second finding'));
    await waitFor(() => {
      expect(store.setItemRead).toHaveBeenCalledWith('b', true);
    });
  });

  it('shows a caught-up state rather than an empty pane', () => {
    snapshot([]);
    render(<InboxView />);
    expect(screen.getByText('You are all caught up')).toBeInTheDocument();
  });

  it('shows how many times a recurring finding has been seen', () => {
    snapshot([item({ occurrences: 3, firstSeenAt: Date.now() - 3 * 86_400_000 })]);
    render(<InboxView />);
    expect(screen.getByText('seen 3×')).toBeInTheDocument();
    expect(screen.getByText(/reported 3× since 3d ago/)).toBeInTheDocument();
  });

  it('disables Mark all read when nothing is unread', () => {
    snapshot([item({ read: true })]);
    render(<InboxView />);
    expect(screen.getByRole('button', { name: /Mark all read/ })).toBeDisabled();
  });
});
