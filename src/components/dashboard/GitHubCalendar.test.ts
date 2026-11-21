import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubActivityData } from '../../lib/githubActivity';
import { TooltipProvider } from '../primitives/Tooltip';
import { getTrailingDateWindow } from './githubCalendarUtils';

const mocks = vi.hoisted(() => ({ useInvoke: vi.fn() }));

vi.mock('@/hooks/useInvoke', () => ({ useInvoke: mocks.useInvoke }));

import { GitHubCalendar } from './GitHubCalendar';

function activityData(): GitHubActivityData {
  const today = getTrailingDateWindow();
  return {
    username: 'octocat',
    contributions: [{ date: today.endDate, count: 4, level: 4 }],
    commits: [{ occurredAt: today.to, commitCount: 2 }],
    pullRequests: [],
    reviews: [],
    completeness: {
      commits: true,
      pullRequests: true,
      reviews: true,
      privateActivityRestricted: false,
    },
  };
}

describe('GitHubCalendar', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    mocks.useInvoke.mockReturnValue({
      data: activityData(),
      isLoading: false,
      error: null,
      execute: vi.fn(),
      reset: vi.fn(),
    });
  });

  it('renders and toggles the computed busiest-day label without a render error', () => {
    render(
      createElement(GitHubCalendar, {
        username: 'octocat',
        isAuthenticated: true,
        isAuthCheckDone: true,
      })
    );

    const busiestDay = screen.getByRole('button', { name: /highlight busiest day/i });
    expect(screen.getByText('Busiest day')).toBeInTheDocument();
    expect(busiestDay).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(busiestDay);
    expect(busiestDay).toHaveAttribute('aria-pressed', 'true');
  });

  it('tries the authoritative activity request and shows its error when the CLI status probe says unauthenticated', () => {
    const execute = vi.fn();
    const reset = vi.fn();
    mocks.useInvoke.mockReturnValue({
      data: null,
      isLoading: false,
      error: { message: 'Not authenticated' },
      execute,
      reset,
    });

    render(
      createElement(GitHubCalendar, {
        username: null,
        isAuthenticated: false,
        isAuthCheckDone: true,
      })
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub activity is unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows rich activity cell details through the shared tooltip portal', () => {
    vi.useFakeTimers();
    const { endDate } = getTrailingDateWindow();
    const { container } = render(
      createElement(
        TooltipProvider,
        null,
        createElement(GitHubCalendar, {
          username: 'octocat',
          isAuthenticated: true,
          isAuthCheckDone: true,
        })
      )
    );
    const cell = container.querySelector(`[data-date="${endDate}"]`);

    expect(cell).toHaveAttribute(
      'data-tooltip-content',
      expect.stringContaining('4 contributions')
    );
    fireEvent.pointerOver(cell!);
    void act(() => vi.advanceTimersByTime(50));

    expect(screen.getByRole('tooltip')).toHaveTextContent('4 contributions');
  });

  it('highlights every day in a month when its label is hovered', () => {
    const window = getTrailingDateWindow();
    const { container } = render(
      createElement(GitHubCalendar, {
        username: 'octocat',
        isAuthenticated: true,
        isAuthCheckDone: true,
      })
    );
    const monthKey = window.endDate.slice(0, 7);
    const monthLabel = container.querySelector(`[data-month="${monthKey}"]`);
    const monthCells = container.querySelectorAll(`[data-date^="${monthKey}-"]`);
    const outsideMonthCell = container.querySelector(
      `[data-date^="${window.startDate.slice(0, 7)}-"]`
    );

    fireEvent.mouseEnter(monthLabel!);

    expect(monthCells.length).toBeGreaterThan(0);
    monthCells.forEach((cell) =>
      expect(cell).toHaveClass('is-highlighted', 'is-month-highlighted')
    );
    expect(outsideMonthCell).toHaveClass('is-dimmed');
  });

  it('shows that month’s activity total in a tooltip above the month label', () => {
    vi.useFakeTimers();
    const window = getTrailingDateWindow();
    const { container } = render(
      createElement(
        TooltipProvider,
        null,
        createElement(GitHubCalendar, {
          username: 'octocat',
          isAuthenticated: true,
          isAuthCheckDone: true,
        })
      )
    );
    const monthLabel = container.querySelector(`[data-month="${window.endDate.slice(0, 7)}"]`);
    const [year, month] = window.endDate.slice(0, 7).split('-').map(Number);
    const monthName = new Date(year, month - 1, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });

    expect(monthLabel).toHaveAttribute('data-tooltip-placement', 'above');
    fireEvent.pointerOver(monthLabel!);
    void act(() => vi.advanceTimersByTime(50));

    expect(screen.getByRole('tooltip')).toHaveTextContent('4 contributions');
    expect(screen.getByRole('tooltip')).toHaveTextContent(monthName);
  });
});
