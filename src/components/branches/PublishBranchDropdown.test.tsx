/**
 * Tests for PublishBranchDropdown's Vercel live-domain surface.
 *   - liveSiteHost picks custom domain → system url → null
 *   - on the main branch, the fetched custom domain renders and opens on click
 *   - on a feature branch, no domain is fetched or shown (production only)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { liveSiteHost } from '../../lib/vercel';

const invokeResults = new Map<string, unknown>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => Promise.resolve(invokeResults.get(cmd))),
}));

const openUrlMock = vi.fn<(u: string) => void>();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (u: string) => {
    openUrlMock(u);
  },
}));

import { PublishBranchDropdown } from './PublishBranchDropdown';

const baseProps = {
  currentBranch: 'main',
  projectGithubStatus: {
    status: 'connected' as const,
    github_repo: 'user/repo',
    github_url: 'https://github.com/user/repo',
  },
  projectPath: '/p',
  hasChangesToSync: true,
  onStatusChange: vi.fn(),
  isPublishing: false,
  setIsPublishing: vi.fn(),
};

beforeEach(() => {
  invokeResults.clear();
  openUrlMock.mockClear();
});

describe('liveSiteHost', () => {
  it('prefers the custom domain, falls back to the system url, else null', () => {
    expect(liveSiteHost({ custom_domain: 'pop.bimbi.co', system_url: 'x.vercel.app' })).toBe(
      'pop.bimbi.co'
    );
    expect(liveSiteHost({ custom_domain: null, system_url: 'x.vercel.app' })).toBe('x.vercel.app');
    expect(liveSiteHost({ custom_domain: null, system_url: null })).toBeNull();
    expect(liveSiteHost(null)).toBeNull();
  });
});

describe('PublishBranchDropdown live domain', () => {
  it('shows the Vercel custom domain on the main branch and opens it on click', async () => {
    invokeResults.set('get_vercel_production_domain', {
      custom_domain: 'pop.bimbi.co',
      system_url: 'pop-sandy-five.vercel.app',
    });
    render(<PublishBranchDropdown {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }));

    const link = await screen.findByRole('button', { name: /pop\.bimbi\.co/ });
    fireEvent.click(link);
    expect(openUrlMock).toHaveBeenCalledWith('https://pop.bimbi.co');
  });

  it('does not show a domain on a feature branch', async () => {
    invokeResults.set('get_vercel_production_domain', {
      custom_domain: 'pop.bimbi.co',
      system_url: null,
    });
    render(<PublishBranchDropdown {...baseProps} currentBranch="feature/x" />);
    fireEvent.click(screen.getByRole('button', { name: /Sync/ }));

    await waitFor(() => screen.getByText(/Sync your changes/));
    expect(screen.queryByText('pop.bimbi.co')).toBeNull();
  });
});
