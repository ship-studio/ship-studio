/**
 * Regression test for the "Submit for Review" PR-create error display.
 *
 * Tauri command rejections arrive as a structured `CommandError` *object*, not
 * a JS `Error`. The submit handler used to render `String(e)` on failure, which
 * stringified that object to a literal "[object Object]" in the modal. It must
 * route the error through `formatCommandError(asCommandError(e))` so users see
 * the real reason a PR couldn't be created.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SubmitReviewModal } from './SubmitReviewModal';
import { ToastContext } from '../../contexts/ToastContext';

vi.mock('../../lib/branches', () => ({
  createPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  switchBranch: vi.fn(),
  deleteBranch: vi.fn(),
  getDefaultBaseBranch: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../lib/ai', () => ({ generatePRDescription: vi.fn() }));
vi.mock('../../lib/git', () => ({ commitChanges: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createPullRequest, getDefaultBaseBranch } from '../../lib/branches';
import { logger } from '../../lib/logger';

type Fn = ReturnType<typeof vi.fn>;

/** Render with a toast spy so the tests can assert toast type routing. */
function renderWithToasts(ui: ReactNode) {
  const showToast = vi.fn();
  render(
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      {ui}
    </ToastContext.Provider>
  );
  return { showToast };
}

describe('SubmitReviewModal — PR create error display', () => {
  const props = {
    projectPath: '/path/to/project',
    branchName: 'ptymoshenko/sanity',
    baseBranches: ['main'],
    aiAvailable: false,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default-base lookup runs on mount; keep it resolved so the effect no-ops.
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
  });

  it('renders a formatted CommandError, never "[object Object]"', async () => {
    // Tauri rejects with a tagged CommandError object (NOT a JS Error) — the
    // shape that used to stringify to "[object Object]".
    vi.mocked(createPullRequest).mockRejectedValue({
      type: 'Process',
      cmd: 'gh pr create',
      exit_code: 1,
      stderr: 'a pull request for branch "ptymoshenko/sanity" already exists',
    });

    render(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    // A readable, humanized message is surfaced (existing PR case)...
    expect(await screen.findByText(/already an open pull request/i)).toBeInTheDocument();
    // ...and the old broken output is gone.
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('handles a bare string rejection too (legacy commands)', async () => {
    vi.mocked(createPullRequest).mockRejectedValue('gh: not authenticated');

    render(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    // Humanized auth message, never "[object Object]".
    expect(await screen.findByText(/didn't accept the connection/i)).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });
});

describe('SubmitReviewModal — expected-refusal toast routing (#538)', () => {
  const props = {
    projectPath: '/path/to/project',
    branchName: 'ptymoshenko/sanity',
    baseBranches: ['main'],
    aiAvailable: false,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDefaultBaseBranch).mockResolvedValue(null);
  });

  it('toasts a recognized refusal as info (no generic error toast, warn log)', async () => {
    // "PR already exists" — backend classifies this Expected and skips its own
    // report; the frontend toast must not become the fallback reporter.
    vi.mocked(createPullRequest).mockRejectedValue({
      type: 'Process',
      cmd: 'gh pr create',
      exit_code: 1,
      stderr: 'GraphQL: A pull request already exists for julian:ptymoshenko/sanity.',
    });

    const { showToast } = renderWithToasts(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/already an open pull request/i),
      'info'
    );
    expect(showToast).not.toHaveBeenCalledWith('Failed to create pull request', 'error');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('keeps the generic error toast for genuinely unrecognized failures', async () => {
    vi.mocked(createPullRequest).mockRejectedValue({
      type: 'Other',
      message: 'some completely novel gh failure',
    });

    const { showToast } = renderWithToasts(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Failed to create pull request', 'error')
    );
    // The inline modal error still carries the real detail.
    expect(await screen.findByText(/some completely novel gh failure/)).toBeInTheDocument();
  });
});
