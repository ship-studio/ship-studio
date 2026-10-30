/**
 * The dashboard list's loading contract.
 *
 * `loading` started as `useState(true)` and was only ever cleared when
 * `loadAll`'s promise settled, so a backend call that never came back left
 * "Loading projects…" on screen forever with nothing to click. These tests
 * pin the two ways out of the spinner: a rejection, and a hang.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  getDashboardProjects: vi.fn(),
  getProjectThumbnail: vi.fn(),
  listFolders: vi.fn(),
  getFiledProjectPaths: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/logger', () => ({ logger: mocks.logger }));

vi.mock('../../lib/project', () => ({
  getDashboardProjects: mocks.getDashboardProjects,
  getProjectThumbnail: mocks.getProjectThumbnail,
  setHideMainBranchWarning: vi.fn(),
  uploadProjectThumbnail: vi.fn(),
  renameProject: vi.fn(),
  exportProjectAsTemplate: vi.fn(),
}));

vi.mock('../../lib/folders', () => ({
  listFolders: mocks.listFolders,
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  getFiledProjectPaths: mocks.getFiledProjectPaths,
  getFolderProjects: vi.fn(),
  getFolder: vi.fn(),
  moveProjectToFolder: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', listen: vi.fn().mockResolvedValue(() => {}) }),
}));

vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));
vi.mock('../../lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/accounts')>()),
  moveProjectToAccount: vi.fn(),
  getProjectAccountId: vi.fn(),
}));

// Side panels are not under test; stub them so their own data fetching can
// neither fail the render nor be mistaken for the list's loading state.
vi.mock('./AgentsPanel', () => ({ AgentsPanel: () => null }));
vi.mock('./MachineToolsPanel', () => ({ MachineToolsPanel: () => null }));
vi.mock('./GitHubCalendar', () => ({ GitHubCalendar: () => null }));
vi.mock('../../contexts/ModalContext', () => ({
  useModal: () => ({ isOpen: false, open: vi.fn(), close: vi.fn() }),
  useOpenModal: () => vi.fn(),
}));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ activeAccount: null, accounts: [] }),
}));
vi.mock('../../hooks/useDashboardVisibility', () => ({
  useDashboardVisibility: () => ({
    dashboardHeaderHidden: true,
    calendarHidden: true,
    slackCtaHidden: true,
    hideDashboardHeader: vi.fn(),
    hideCalendar: vi.fn(),
    hideSlackCta: vi.fn(),
    setDashboardHeaderHidden: vi.fn(),
    setCalendarHidden: vi.fn(),
    setSlackCtaHidden: vi.fn(),
  }),
}));
vi.mock('../../hooks/useProjectViewModeCommands', () => ({
  useProjectViewModeCommands: () => {},
}));
vi.mock('../../hooks/useProjectRemovalActions', () => ({
  useProjectRemovalActions: () => ({
    removeTarget: null,
    setRemoveTarget: vi.fn(),
    deleteTarget: null,
    setDeleteTarget: vi.fn(),
    removing: false,
    deleting: false,
    confirmRemove: vi.fn(),
    confirmDelete: vi.fn(),
  }),
}));

// The grid is not under test here; stub it so a failing render inside it can
// never be mistaken for the loading state under test.
vi.mock('./ProjectGridView', () => ({
  ProjectGridView: ({ filteredProjects }: { filteredProjects: { name: string }[] }) => (
    <div data-testid="grid">{filteredProjects.map((p) => p.name).join(',')}</div>
  ),
}));

import { ProjectList } from './ProjectList';

/** The spinner's own copy. Matched exactly, because the timeout error text
 *  also starts with "Loading projects" and a loose regex would let the
 *  spinner-is-gone assertion pass for the wrong reason. */
const SPINNER_LABEL = 'Loading projects...';

function renderList() {
  return render(<ProjectList onSelectProject={vi.fn()} onCreateProject={vi.fn()} />);
}

describe('ProjectList loading state', () => {
  beforeEach(() => {
    mocks.getProjectThumbnail.mockResolvedValue(null);
    mocks.listFolders.mockResolvedValue([]);
    mocks.getFiledProjectPaths.mockResolvedValue([]);
    mocks.getDashboardProjects.mockReset();
    mocks.logger.error.mockClear();
    mocks.logger.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the list once the scan resolves', async () => {
    mocks.getDashboardProjects.mockResolvedValue([
      { name: 'alpha', path: '/p/alpha', thumbnail: null, last_opened: 2, is_external: false },
    ]);
    renderList();
    expect(await screen.findByTestId('grid')).toHaveTextContent('alpha');
    expect(screen.queryByText(SPINNER_LABEL)).not.toBeInTheDocument();
  });

  it('shows a retryable error instead of an empty grid when the scan rejects', async () => {
    mocks.getDashboardProjects.mockRejectedValueOnce({
      type: 'Other',
      message: 'projects folder is on a disconnected volume',
    });
    renderList();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn’t load your projects/i);
    expect(alert).toHaveTextContent(/disconnected volume/i);
    expect(screen.queryByTestId('grid')).not.toBeInTheDocument();

    // Retry re-runs the scan and replaces the error with the list.
    mocks.getDashboardProjects.mockResolvedValueOnce([
      { name: 'beta', path: '/p/beta', thumbnail: null, last_opened: 1, is_external: false },
    ]);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByTestId('grid')).toHaveTextContent('beta');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('logs a backend-Expected TCC denial as a warning, not a bug (issue #1139)', async () => {
    const message =
      "Ship Studio isn't allowed to read your projects folder (<redacted>). Grant access in System Settings → Privacy & Security → Files & Folders (or Full Disk Access), then reload the dashboard.";
    mocks.getDashboardProjects.mockRejectedValueOnce({ type: 'Other', message, expected: true });
    renderList();

    // The backend's own actionable text still reaches the user.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Full Disk Access/);
    expect(mocks.logger.warn).toHaveBeenCalledWith('Failed to load projects', { error: message });
    expect(mocks.logger.error).not.toHaveBeenCalledWith(
      'Failed to load projects',
      expect.anything()
    );
  });

  it('still reports an unclassified scan failure as an error', async () => {
    mocks.getDashboardProjects.mockRejectedValueOnce({
      type: 'Other',
      message: 'projects folder is on a disconnected volume',
    });
    renderList();

    await screen.findByRole('alert');
    expect(mocks.logger.error).toHaveBeenCalledWith('Failed to load projects', {
      error: 'projects folder is on a disconnected volume',
    });
  });

  it('gives up on a scan that never comes back rather than spinning forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Never settles — the shape that produced the unbounded spinner.
    mocks.getDashboardProjects.mockReturnValue(new Promise(() => {}));
    renderList();

    expect(await screen.findByText(SPINNER_LABEL)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(41_000);
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/took longer than 40 seconds/i);
    // The raw TimeoutError text is a log line, not a sentence for a user.
    expect(screen.getByRole('alert')).not.toHaveTextContent(/40000ms/);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(SPINNER_LABEL)).not.toBeInTheDocument();
  });

  it('gives up when the folder calls are the ones that hang', async () => {
    // Watched happen. On a machine where the backend stalled, the scan timed
    // out and logged its error on schedule — and the spinner stayed up anyway,
    // forever, which is the exact symptom the timeout was added to remove.
    //
    // `loadAll` awaits the scan and the folder calls together, and only the
    // scan was bounded. A folder call that never settles keeps `loading` true,
    // and `loading` deliberately wins over `loadError`, so the error that was
    // already set could never be shown.
    //
    // Every test above resolved the folder mocks instantly, which is why none
    // of them could see it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.getDashboardProjects.mockRejectedValueOnce({
      type: 'Other',
      message: 'projects folder is on a disconnected volume',
    });
    mocks.listFolders.mockReturnValue(new Promise(() => {}));
    renderList();

    expect(await screen.findByText(SPINNER_LABEL)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(41_000);
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/disconnected volume/i);
    expect(screen.queryByText(SPINNER_LABEL)).not.toBeInTheDocument();
  });
});
