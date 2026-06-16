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
import { render, screen, fireEvent } from '@testing-library/react';
import { SubmitReviewModal } from './SubmitReviewModal';

vi.mock('../../lib/branches', () => ({
  createPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  switchBranch: vi.fn(),
  deleteBranch: vi.fn(),
}));
vi.mock('../../lib/ai', () => ({ generatePRDescription: vi.fn() }));
vi.mock('../../lib/git', () => ({ commitChanges: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));

import { createPullRequest } from '../../lib/branches';

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

    // The real stderr is surfaced…
    expect(
      await screen.findByText(/a pull request for branch .* already exists/i)
    ).toBeInTheDocument();
    // …and the old broken output is gone.
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('handles a bare string rejection too (legacy commands)', async () => {
    vi.mocked(createPullRequest).mockRejectedValue('gh: not authenticated');

    render(<SubmitReviewModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));

    expect(await screen.findByText(/gh: not authenticated/i)).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });
});
