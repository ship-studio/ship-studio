/**
 * Tests for PublishBranchDropdown.
 *
 * The core contract: the trigger button says "Push" at ALL times (or
 * "Pushing..." while in flight) — never "Sync", "Publish", "Synced", or
 * "Go Live". That label churn was a real UX complaint; these tests pin it.
 */

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PublishBranchDropdown } from './PublishBranchDropdown';
import type { ProjectGitHubStatus } from '../../lib/github';

vi.mock('../../lib/branches', () => ({
  publishBranch: vi.fn().mockResolvedValue({ state: 'PUSHED', url: null }),
}));

const connectedStatus = {
  status: 'connected',
  github_repo: 'user/repo',
} as unknown as ProjectGitHubStatus;

function makeProps(overrides?: Partial<Parameters<typeof PublishBranchDropdown>[0]>) {
  return {
    currentBranch: 'main',
    projectGithubStatus: connectedStatus,
    projectPath: '/test/path',
    hasChangesToSync: true,
    onStatusChange: vi.fn(),
    isPublishing: false,
    setIsPublishing: vi.fn(),
    ...overrides,
  };
}

const BANNED_LABELS = ['Sync', 'Synced', 'Syncing...', 'Publish', 'Publishing...', 'Go Live'];

function FakeCloudflareControls() {
  const [open, setOpen] = useState(false);
  return (
    <div className="cf-dropdown-wrapper" onMouseEnter={() => setOpen(true)}>
      <button type="button">Cloudflare</button>
      {open && (
        <div className="cf-dropdown">
          <div className="cf-dropdown-inner">
            <button type="button">Prod site</button>
            <button type="button">Dashboard</button>
            <button type="button" className="cf-dropdown-action">
              Deploy now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FakeVercelControls() {
  const [open, setOpen] = useState(false);
  return (
    <div className="vercel-button-container" onMouseEnter={() => setOpen(true)}>
      <button type="button" className="toolbar-icon-btn vercel-button">
        Vercel
      </button>
      {open && (
        <div className="vercel-site-dropdown">
          <div className="vercel-site-dropdown-inner">
            <button type="button">Production</button>
            <button type="button">Dashboard</button>
            <div className="vercel-dropdown-separator" />
            <button type="button" className="vercel-dropdown-action">
              Deploy now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function expectNoBannedLabels() {
  for (const label of BANNED_LABELS) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
}

function expectPushIcon() {
  expect(
    screen.getByRole('button', { name: /push/i }).querySelector('[data-icon-name="PushIcon"]')
  ).toBeTruthy();
}

describe('PublishBranchDropdown trigger label', () => {
  it('says "Push" on the main branch', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'main' })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectPushIcon();
    expectNoBannedLabels();
  });

  it('says "Push" on a feature branch', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'feature/thing' })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Push" even when there is nothing to push', () => {
    render(<PublishBranchDropdown {...makeProps({ hasChangesToSync: false })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Pushing..." while a push is in flight', () => {
    render(<PublishBranchDropdown {...makeProps({ isPublishing: true })} />);

    expect(screen.getByText('Pushing...')).toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('says "Push" (disabled) when no GitHub repo exists yet', () => {
    render(
      <PublishBranchDropdown
        {...makeProps({
          projectGithubStatus: { status: 'no_repo' } as unknown as ProjectGitHubStatus,
        })}
      />
    );

    const button = screen.getByText('Push').closest('button');
    expect(button).toBeDisabled();
    expectPushIcon();
    expectNoBannedLabels();
  });

  it('keeps the icon visible while GitHub status is loading', () => {
    render(<PublishBranchDropdown {...makeProps({ projectGithubStatus: null })} />);

    expect(screen.getByText('Push')).toBeInTheDocument();
    expectPushIcon();
  });
});

describe('PublishBranchDropdown open panel', () => {
  it('closes on outside click and Escape', () => {
    render(<PublishBranchDropdown {...makeProps()} />);

    const trigger = screen.getByRole('button', { name: 'Push' });
    fireEvent.click(trigger);
    expect(screen.getByText('Push to GitHub')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Push to GitHub')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByText('Push to GitHub')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Push to GitHub')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('uses push terminology throughout the idle panel (feature branch)', () => {
    render(<PublishBranchDropdown {...makeProps({ currentBranch: 'feature/thing' })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('Push to GitHub')).toBeInTheDocument();
    // Trigger + primary action both say Push
    expect(screen.getAllByText('Push').length).toBeGreaterThanOrEqual(2);
    expectNoBannedLabels();
  });

  it('includes changed files and discard in the Push menu', () => {
    render(
      <PublishBranchDropdown
        {...makeProps()}
        changedFiles={[{ path: 'src/app.tsx', status: 'modified' }]}
      />
    );

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('1 Unsaved Change')).toBeInTheDocument();
    expect(screen.getByText('app.tsx')).toBeInTheDocument();
    expect(screen.getByText('Discard All')).toBeInTheDocument();
    const actionRow = screen.getByText('Discard All').closest('.publish-actions');
    const pushButtons = screen.getAllByRole('button', { name: 'Push' });
    expect(actionRow).toContainElement(pushButtons[pushButtons.length - 1]);
  });

  it('renders hosting plugin controls inside the Push menu', () => {
    render(
      <PublishBranchDropdown
        {...makeProps()}
        hostingControls={<button type="button">Cloudflare deploy controls</button>}
      />
    );

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText('Hosting')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare deploy controls')).toBeInTheDocument();
  });

  it('keeps the panel actions below the hosting section', () => {
    const { container } = render(
      <PublishBranchDropdown
        {...makeProps()}
        hostingControls={<button type="button">Cloudflare deploy controls</button>}
      />
    );

    fireEvent.click(screen.getByText('Push'));

    const menu = container.querySelector('.publish-dropdown-menu');
    const hostingSection = menu?.querySelector('.publish-hosting-section');
    const actions = menu?.querySelector('.publish-actions');

    expect(hostingSection).toBeInTheDocument();
    expect(actions).toBeInTheDocument();
    expect(menu?.lastElementChild).toBe(actions);
  });

  it('keeps Done below the hosting section when GitHub is up to date', () => {
    const { container } = render(
      <PublishBranchDropdown
        {...makeProps({ hasChangesToSync: false })}
        hostingControls={<button type="button">Cloudflare deploy controls</button>}
      />
    );

    fireEvent.click(screen.getByText('Push'));

    const menu = container.querySelector('.publish-dropdown-menu');
    const actions = menu?.querySelector('.publish-actions');

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(menu?.lastElementChild).toBe(actions);
  });

  it('reveals Cloudflare production links by default', async () => {
    render(<PublishBranchDropdown {...makeProps()} hostingControls={<FakeCloudflareControls />} />);

    fireEvent.click(screen.getByText('Push'));

    expect(await screen.findByText('Prod site')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Deploy now')).toHaveClass('cf-dropdown-action');
  });

  it('reveals Vercel production links by default', async () => {
    render(<PublishBranchDropdown {...makeProps()} hostingControls={<FakeVercelControls />} />);

    fireEvent.click(screen.getByText('Push'));

    expect(await screen.findByText('Production')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Deploy now')).toHaveClass('vercel-dropdown-action');
  });

  it('describes the GitHub push without inferring deployment state', () => {
    const { container } = render(
      <PublishBranchDropdown {...makeProps({ currentBranch: 'main' })} />
    );

    fireEvent.click(screen.getByText('Push'));

    expect(container.querySelector('.publish-branch-description')).toHaveTextContent(
      'Commits your changes and pushes the main branch to GitHub.'
    );
    expect(screen.queryByText(/live site/i)).not.toBeInTheDocument();
    expectNoBannedLabels();
  });

  it('supports the grouped trigger treatment without changing the label', () => {
    const { container } = render(<PublishBranchDropdown {...makeProps()} grouped />);

    expect(container.querySelector('.publish-dropdown')).toHaveClass('publish-dropdown--grouped');
    expect(screen.getByText('Push')).toBeInTheDocument();
  });

  it('says there is nothing to push when GitHub is up to date', () => {
    render(<PublishBranchDropdown {...makeProps({ hasChangesToSync: false })} />);

    fireEvent.click(screen.getByText('Push'));

    expect(screen.getByText(/Nothing to push/i)).toBeInTheDocument();
    expectNoBannedLabels();
  });
});
