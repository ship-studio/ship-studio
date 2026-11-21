import { describe, expect, it } from 'vitest';
import type { GitHubActivityData } from '../../lib/githubActivity';
import {
  buildActivityDays,
  buildActivityWeeks,
  getTrailingDateWindow,
  latestPullRequestStatus,
  summarizeActivity,
} from './githubCalendarUtils';

const TODAY = new Date(2026, 10, 20, 12);

function activityData(overrides: Partial<GitHubActivityData> = {}): GitHubActivityData {
  return {
    username: 'octocat',
    contributions: [],
    commits: [],
    pullRequests: [],
    reviews: [],
    completeness: {
      commits: true,
      pullRequests: true,
      reviews: true,
      privateActivityRestricted: false,
    },
    ...overrides,
  };
}

describe('GitHub activity calendar data', () => {
  it('builds a local inclusive twelve-month range ending today with no future day cells', () => {
    const window = getTrailingDateWindow(TODAY);
    const days = buildActivityDays(
      'contributions',
      activityData({
        contributions: [
          { date: '2025-11-19', count: 6, level: 2 },
          { date: '2025-11-20', count: 2, level: 1 },
          { date: '2026-11-20', count: 3, level: 2 },
          { date: '2026-11-21', count: 9, level: 4 },
        ],
      }),
      window
    );
    const { weeks, monthLabels } = buildActivityWeeks(days);

    expect(window.startDate).toBe('2025-11-20');
    expect(window.endDate).toBe('2026-11-20');
    expect(days).toHaveLength(366);
    expect(days[0]).toMatchObject({ date: '2025-11-20', count: 2 });
    expect(days[days.length - 1]).toMatchObject({ date: '2026-11-20', count: 3 });
    expect(days.some((day) => day.date === '2026-11-21')).toBe(false);
    expect(weeks[0]?.days[3]?.date).toBe('2025-11-20');
    const completeWeek = weeks.find((week) => week.days[0]?.date === '2026-11-09');
    expect(completeWeek?.days[6]?.date).toBe('2026-11-15');
    expect(monthLabels.find(({ label }) => label === 'Dec')?.weekIndex).toBe(2);
    expect(monthLabels.find(({ monthKey }) => monthKey === '2025-12')?.label).toBe('Dec');
    expect(weeks[weeks.length - 1]?.days[4]?.date).toBe('2026-11-20');
    expect(weeks[weeks.length - 1]?.days[5]).toBeNull();
    expect(weeks[weeks.length - 1]?.days[6]).toBeNull();
  });

  it('clamps a leap-day window start to the last valid day of February', () => {
    const window = getTrailingDateWindow(new Date(2024, 1, 29, 12));
    expect(window.startDate).toBe('2023-02-28');
    expect(window.endDate).toBe('2024-02-29');
  });

  it('aggregates commits and PR statuses by local day while keeping other dates out', () => {
    const data = activityData({
      commits: [
        { occurredAt: '2026-11-20T12:00:00.000Z', commitCount: 2 },
        { occurredAt: '2026-11-20T18:00:00.000Z', commitCount: 3 },
        { occurredAt: '2026-11-21T12:00:00.000Z', commitCount: 7 },
      ],
      pullRequests: [
        {
          occurredAt: '2026-11-20T12:00:00.000Z',
          statusChangedAt: '2026-11-20T17:00:00.000Z',
          number: 1,
          title: 'Merged work',
          repository: 'octocat/repo',
          url: 'https://github.com/octocat/repo/pull/1',
          status: 'merged',
        },
        {
          occurredAt: '2026-11-20T14:00:00.000Z',
          statusChangedAt: '2026-11-20T18:00:00.000Z',
          number: 2,
          title: 'Open work',
          repository: 'octocat/repo',
          url: 'https://github.com/octocat/repo/pull/2',
          status: 'open',
        },
      ],
    });
    const window = getTrailingDateWindow(TODAY);
    const commitDays = buildActivityDays('commits', data, window);
    const pullRequestDays = buildActivityDays('pullRequests', data, window);

    expect(commitDays[commitDays.length - 1]).toMatchObject({ count: 5, level: 4 });
    expect(commitDays.some((day) => day.date === '2026-11-21')).toBe(false);
    expect(pullRequestDays[pullRequestDays.length - 1]).toMatchObject({
      count: 2,
      pullRequestStatuses: { merged: 1, open: 1, closed: 0, restricted: 0 },
    });
    expect(latestPullRequestStatus(pullRequestDays[pullRequestDays.length - 1])).toBe('open');
  });

  it('calculates streaks and the peak day from the selected view counts', () => {
    const days = buildActivityDays(
      'commits',
      activityData({
        commits: [
          { occurredAt: '2026-11-17T12:00:00.000Z', commitCount: 1 },
          { occurredAt: '2026-11-18T12:00:00.000Z', commitCount: 2 },
          { occurredAt: '2026-11-19T12:00:00.000Z', commitCount: 3 },
        ],
      }),
      getTrailingDateWindow(TODAY)
    );
    const summary = summarizeActivity(days);

    expect(summary.total).toBe(6);
    expect(summary.currentStreakDates).toEqual(['2026-11-17', '2026-11-18', '2026-11-19']);
    expect(summary.longestStreakDates).toEqual(summary.currentStreakDates);
    expect(summary.peakDay).toMatchObject({ date: '2026-11-19', count: 3 });
  });
});
