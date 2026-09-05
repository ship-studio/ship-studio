import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxView } from './InboxView';
import type { InboxItem } from '../../lib/workflows';
import { peekHandoff, clearHandoff } from '../../lib/workflowHandoff';
import * as store from '../../lib/workflowsStore';

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

const openUrl = vi.fn<(url: string) => Promise<void>>();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => openUrl(url),
}));

vi.mock('../../lib/workflowsStore', () => ({
  subscribe: vi.fn(() => () => undefined),
  getSnapshot: vi.fn(),
  deleteItem: vi.fn().mockResolvedValue(undefined),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  setItemArchived: vi.fn().mockResolvedValue(undefined),
  setItemRead: vi.fn().mockResolvedValue(undefined),
}));

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'finding-1',
    workflowId: '/p/demo::security-sweep',
    workflowName: 'Security sweep',
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
    workflows: [],
    inbox,
    progress: {},
    loaded: true,
    error: null,
  });
}

describe('InboxView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes the resolved values along with the call log, and
    // these are awaited by the handlers under test.
    vi.mocked(store.setItemArchived).mockResolvedValue(undefined);
    vi.mocked(store.setItemRead).mockResolvedValue(undefined);
    vi.mocked(store.deleteItem).mockResolvedValue(undefined);
    vi.mocked(store.markAllRead).mockResolvedValue(undefined);
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
    expect(screen.queryByRole('button', { name: /Send to agent/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy prompt/ })).toBeInTheDocument();
  });

  it('queues the prompt and opens the project when fixing', async () => {
    const onOpenProject = vi.fn();
    snapshot([item()]);
    render(<InboxView onOpenProject={onOpenProject} />);

    await userEvent.click(screen.getByRole('button', { name: /Send to agent/ }));

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

  it('says that sending to the agent is not the same as fixing it', () => {
    snapshot([item()]);
    render(<InboxView onOpenProject={vi.fn()} />);
    expect(screen.getByText(/doesn’t mean the finding is fixed/)).toBeInTheDocument();
  });

  it('offers restore and permanent delete only once archived', async () => {
    snapshot([item({ archived: true, read: true })]);
    render(<InboxView />);
    // The archived filter is what shows archived items.
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('offers archive but not delete for a live finding', () => {
    snapshot([item()]);
    render(<InboxView />);
    // "Archived" is also a filter button, so match the action exactly.
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
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

  it('keeps the finding you opened on screen when the Unread filter would drop it', async () => {
    // Reading is what marks a finding read, and the default filter is Unread.
    // If the list re-filters on that, the row vanishes under the cursor and the
    // reader jumps to a different finding — so the filter people land on would
    // be the one filter in which findings cannot be read.
    const user = userEvent.setup();
    const first = item({ id: 'finding-1', title: 'First finding', severity: 'critical' });
    const second = item({ id: 'finding-2', title: 'Second finding', severity: 'warning' });
    snapshot([first, second]);
    const { rerender } = render(<InboxView />);

    await user.click(screen.getByText('Second finding'));
    expect(store.setItemRead).toHaveBeenCalledWith('finding-2', true);

    // The backend now reports it read; the store pushes that back down.
    snapshot([first, { ...second, read: true }]);
    rerender(<InboxView />);

    expect(screen.getByRole('option', { name: /Second finding/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('option', { name: /First finding/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('moves to the next finding when the open one is archived', async () => {
    const user = userEvent.setup();
    const first = item({ id: 'finding-1', title: 'First finding', severity: 'critical' });
    const second = item({ id: 'finding-2', title: 'Second finding', severity: 'warning' });
    snapshot([first, second]);
    render(<InboxView />);

    // The critical one is selected by default; archiving it should land on the
    // next finding rather than on whatever happens to sort first.
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(store.setItemArchived).toHaveBeenCalledWith('finding-1', true);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Second finding/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });
  });

  it('walks the list with the arrow keys', async () => {
    const user = userEvent.setup();
    const first = item({ id: 'finding-1', title: 'First finding', severity: 'critical' });
    const second = item({ id: 'finding-2', title: 'Second finding', severity: 'warning' });
    snapshot([first, second]);
    render(<InboxView />);

    // The critical finding sorts first and is selected on arrival; click its
    // row so focus is inside the listbox, then walk down.
    await user.click(screen.getByRole('option', { name: /First finding/ }));
    // Keydown from the focused row bubbles to the listbox that handles it.
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('option', { name: /Second finding/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('offers findings as selectable options rather than inert list items', () => {
    // role="listitem" on a button silently replaces the button role, so the row
    // stops being announced as something that can be activated.
    snapshot([item()]);
    render(<InboxView />);
    const list = within(screen.getByRole('listbox', { name: 'Findings' }));
    expect(list.getAllByRole('option')).toHaveLength(1);
    expect(list.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('opens a link in a report in the browser, not in the app window', async () => {
    // A link here navigates the Tauri webview itself, which replaces Ship
    // Studio with a web page and offers no way back — and this body is written
    // by an agent that has just read a repository, so the URL may have come
    // from the repository rather than from the agent.
    const user = userEvent.setup();
    snapshot([item({ bodyMd: 'See [the advisory](https://example.com/advisory).' })]);
    render(<InboxView />);

    await user.click(screen.getByRole('link', { name: 'the advisory' }));
    expect(openUrl).toHaveBeenCalledWith('https://example.com/advisory');
  });

  it('refuses to hand a non-web scheme to the opener', async () => {
    const user = userEvent.setup();
    // DOMPurify drops javascript: before this ever renders; file: survives
    // sanitizing in some configurations and has no business being opened.
    snapshot([item({ bodyMd: 'See [a file](file:///etc/passwd).' })]);
    render(<InboxView />);

    const link = screen.queryByRole('link', { name: 'a file' });
    if (link) {
      await user.click(link);
    }
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('drops the queued prompt when the project fails to open', async () => {
    // The queue stays valid for three minutes. Left behind, it would type an
    // instruction from a failed action into the next terminal that appears.
    const user = userEvent.setup();
    snapshot([item()]);
    const onOpenProject = vi.fn().mockRejectedValue(new Error('project is gone'));
    render(<InboxView onOpenProject={onOpenProject} />);

    await user.click(screen.getByRole('button', { name: /Send to agent/ }));

    await waitFor(() => expect(peekHandoff('/p/demo')).toBeNull());
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Could not open'), 'error');
  });
});
