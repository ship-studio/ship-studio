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

// A contributions payload shaped like the real API's: the failing case mirrors
// the empty list GitHub returns for accounts with no public contributions,
// which is exactly what makes the library throw.
const CONTRIBUTIONS = [{ date: '2026-01-01', count: 1, level: 1 as const }];

vi.mock('react-github-calendar', async () => {
  const { useState, useEffect } = await import('react');

  // Mirrors the real library's ordering: it renders nothing while fetching,
  // then — once the request resolves — hands the contributions to transformData
  // *during* the render that follows, and validates them in that same pass.
  // The async arrival matters: it lands after the parent's mount effects, which
  // is what lets the parent's dataLoaded flag stick.
  return {
    GitHubCalendar: ({
      transformData,
    }: {
      transformData: (
        data: Array<{ date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }>
      ) => unknown;
    }) => {
      const [data, setData] = useState<typeof CONTRIBUTIONS | null>(null);

      useEffect(() => {
        setData(libState.shouldThrow ? [] : CONTRIBUTIONS);
      }, []);

      if (!data) return null;

      transformData(data);
      if (libState.shouldThrow) {
        throw new Error('Activity data must not be empty.');
      }
      return <div data-testid="calendar-graph" />;
    },
  };
});

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

    const graph = await screen.findByTestId('calendar-graph');
    expect(graph).toBeTruthy();
    // Valid data reaching transformData flips the widget out of its skeleton
    // state, so the calendar is actually visible rather than merely mounted.
    await waitFor(() => {
      expect(graph.parentElement?.style.display).toBe('block');
    });
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
