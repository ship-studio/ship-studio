/**
 * Tests for GitHubCalendar — the dashboard contribution graph.
 *
 * Covers:
 *   - a throwing calendar (react-activity-calendar validates its data during
 *     render and throws on an empty contribution list — accounts with no public
 *     contributions, EMU accounts, new accounts) hides the widget instead of
 *     escaping to the app-level ErrorBoundary and crashing the whole dashboard
 *   - the surrounding dashboard content stays mounted when that happens
 *   - a healthy calendar still renders
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GitHubCalendar } from './GitHubCalendar';

const libState = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock('react-github-calendar', () => ({
  // Mirrors the real library: it hands the fetched contributions to
  // transformData during render, then renders the calendar — which validates
  // the data and can throw in that same render pass.
  GitHubCalendar: ({
    transformData,
  }: {
    transformData: (data: Array<{ date: string; count: number; level: 0 }>) => unknown;
  }) => {
    transformData([]);
    if (libState.shouldThrow) {
      throw new Error('Activity data must not be empty.');
    }
    return <div data-testid="calendar-graph" />;
  },
}));

describe('GitHubCalendar', () => {
  beforeEach(() => {
    libState.shouldThrow = false;
    // React re-throws caught render errors to console.error; keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the calendar when the contribution data is valid', async () => {
    render(<GitHubCalendar username="octocat" isAuthenticated isAuthCheckDone />);

    expect(await screen.findByTestId('calendar-graph')).toBeTruthy();
  });

  it('hides itself instead of crashing when the calendar throws', async () => {
    libState.shouldThrow = true;

    render(
      <div>
        <GitHubCalendar username="octocat" isAuthenticated isAuthCheckDone />
        <div data-testid="dashboard-content">projects</div>
      </div>
    );

    await waitFor(() => {
      expect(document.querySelector('.github-calendar-wrapper')).toBeNull();
    });
    // The rest of the dashboard survives — the error never reaches the app boundary.
    expect(screen.getByTestId('dashboard-content')).toBeTruthy();
  });
});
