import type {
  GitHubActivityData,
  GitHubPullRequestContribution,
  GitHubPullRequestStatus,
  GitHubReviewContribution,
} from '../../lib/githubActivity';

export type ActivityView = 'contributions' | 'commits' | 'pullRequests' | 'reviews';

export interface ActivityDateWindow {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
  from: string;
  to: string;
}

export interface PullRequestStatusCounts {
  merged: number;
  open: number;
  closed: number;
  restricted: number;
}

export interface ActivityDay {
  date: string;
  count: number;
  level: number;
  pullRequests: GitHubPullRequestContribution[];
  reviews: GitHubReviewContribution[];
  pullRequestStatuses: PullRequestStatusCounts;
}

/** Returns the status of the pull request with the latest known status change. */
export function latestPullRequestStatus(day: ActivityDay): GitHubPullRequestStatus | 'none' {
  const latestPullRequest = day.pullRequests.reduce<GitHubPullRequestContribution | null>(
    (latest, candidate) => {
      if (!latest) return candidate;
      return Date.parse(candidate.statusChangedAt) >= Date.parse(latest.statusChangedAt)
        ? candidate
        : latest;
    },
    null
  );

  return latestPullRequest?.status ?? 'none';
}

export interface ActivityWeek {
  days: Array<ActivityDay | null>;
}

export interface ActivityMonthLabel {
  weekIndex: number;
  label: string;
  monthKey: string;
}

export interface ActivitySummary {
  total: number;
  currentStreakDates: string[];
  longestStreakDates: string[];
  peakDay: ActivityDay | null;
}

const datePad = (value: number) => String(value).padStart(2, '0');

/** Formats a Date using its local calendar components instead of UTC. */
export function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${datePad(date.getMonth() + 1)}-${datePad(date.getDate())}`;
}

function dateAtLocalMidnight(value: Date | string): Date | null {
  if (typeof value === 'string') {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day);
  }

  if (Number.isNaN(value.getTime())) return null;
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/**
 * Returns a local calendar-year window, including both boundary dates.
 * The previous year is clamped to that month's last day for leap-day dates.
 */
export function getTrailingDateWindow(today = new Date()): ActivityDateWindow {
  const end = dateAtLocalMidnight(today) ?? new Date();
  const startYear = end.getFullYear() - 1;
  const lastDayInStartMonth = new Date(startYear, end.getMonth() + 1, 0).getDate();
  const start = new Date(startYear, end.getMonth(), Math.min(end.getDate(), lastDayInStartMonth));
  const localEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);

  return {
    start,
    end,
    startDate: localIsoDate(start),
    endDate: localIsoDate(end),
    from: start.toISOString(),
    to: localEnd.toISOString(),
  };
}

function eventLocalDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localIsoDate(date);
}

function emptyDay(date: string): ActivityDay {
  return {
    date,
    count: 0,
    level: 0,
    pullRequests: [],
    reviews: [],
    pullRequestStatuses: { merged: 0, open: 0, closed: 0, restricted: 0 },
  };
}

function inDateWindow(date: string | null, window: ActivityDateWindow): date is string {
  return Boolean(date && date >= window.startDate && date <= window.endDate);
}

function fillActivityLevels(days: ActivityDay[]): ActivityDay[] {
  const maximum = Math.max(0, ...days.map((day) => day.count));
  return days.map((day) => ({
    ...day,
    level: day.count === 0 ? 0 : Math.max(1, Math.ceil((day.count / maximum) * 4)),
  }));
}

/** Builds a complete local date range from one of the four authenticated views. */
export function buildActivityDays(
  view: ActivityView,
  data: GitHubActivityData,
  window: ActivityDateWindow
): ActivityDay[] {
  const days = new Map<string, ActivityDay>();
  const cursor = new Date(window.start);
  while (cursor <= window.end) {
    const date = localIsoDate(cursor);
    days.set(date, emptyDay(date));
    cursor.setDate(cursor.getDate() + 1);
  }

  if (view === 'contributions') {
    for (const contribution of data.contributions) {
      const day = days.get(contribution.date);
      if (day) {
        day.count = contribution.count;
        day.level = contribution.level;
      }
    }
    return [...days.values()];
  }

  if (view === 'commits') {
    for (const commit of data.commits) {
      const date = eventLocalDate(commit.occurredAt);
      if (inDateWindow(date, window)) {
        const day = days.get(date);
        if (day) day.count += commit.commitCount;
      }
    }
  } else if (view === 'pullRequests') {
    for (const pullRequest of data.pullRequests) {
      const date = eventLocalDate(pullRequest.occurredAt);
      if (!inDateWindow(date, window)) continue;
      const day = days.get(date);
      if (!day) continue;
      day.pullRequests.push(pullRequest);
      day.count += 1;
      day.pullRequestStatuses[pullRequest.status] += 1;
    }
  } else {
    for (const review of data.reviews) {
      const date = eventLocalDate(review.occurredAt);
      if (!inDateWindow(date, window)) continue;
      const day = days.get(date);
      if (!day) continue;
      day.reviews.push(review);
      day.count += 1;
    }
  }

  return fillActivityLevels([...days.values()]);
}

/** Arranges a Monday-first heatmap without creating cells after local today. */
export function buildActivityWeeks(days: ActivityDay[]): {
  weeks: ActivityWeek[];
  monthLabels: ActivityMonthLabel[];
} {
  const firstDay = days[0] ? ((dateAtLocalMidnight(days[0].date)?.getDay() ?? 1) + 6) % 7 : 0;
  const cells: Array<ActivityDay | null> = [
    ...Array<ActivityDay | null>(firstDay).fill(null),
    ...days,
  ];
  const weekCount = Math.ceil(cells.length / 7);
  const weeks = Array.from({ length: weekCount }, (_, weekIndex) => {
    const weekDays = Array<ActivityDay | null>(7).fill(null);
    for (let weekday = 0; weekday < 7; weekday += 1) {
      weekDays[weekday] = cells[weekIndex * 7 + weekday] ?? null;
    }
    return { days: weekDays };
  });

  const monthLabels: ActivityMonthLabel[] = [];
  const labelledMonths = new Set<string>();
  days.forEach((day, index) => {
    const date = dateAtLocalMidnight(day.date);
    if (!date) return;
    const monthKey = `${date.getFullYear()}-${datePad(date.getMonth() + 1)}`;
    const isWindowStart = index === 0;
    if (!isWindowStart && date.getDate() !== 1) return;
    if (labelledMonths.has(monthKey)) return;
    labelledMonths.add(monthKey);
    monthLabels.push({
      weekIndex: Math.floor((index + firstDay) / 7),
      label: date.toLocaleDateString('en-US', { month: 'short' }),
      monthKey,
    });
  });

  return { weeks, monthLabels };
}

function streakEndingAt(days: ActivityDay[], endIndex: number): string[] {
  const streak: string[] = [];
  for (let index = endIndex; index >= 0 && days[index]?.count > 0; index -= 1) {
    streak.push(days[index].date);
  }
  return streak.reverse();
}

/** Summarizes a view's total, current and longest streaks, and busiest day. */
export function summarizeActivity(days: ActivityDay[]): ActivitySummary {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const todayIndex = days.length - 1;
  const currentIndex = days[todayIndex]?.count ? todayIndex : todayIndex - 1;
  const currentStreakDates = streakEndingAt(days, currentIndex);

  let longestStreakDates: string[] = [];
  let streakStart = -1;
  days.forEach((day, index) => {
    if (day.count > 0 && streakStart < 0) streakStart = index;
    if (day.count === 0 && streakStart >= 0) {
      const candidate = days.slice(streakStart, index).map((entry) => entry.date);
      if (candidate.length >= longestStreakDates.length) longestStreakDates = candidate;
      streakStart = -1;
    }
  });
  if (streakStart >= 0) {
    const candidate = days.slice(streakStart).map((entry) => entry.date);
    if (candidate.length >= longestStreakDates.length) longestStreakDates = candidate;
  }

  const peakDay = days.reduce<ActivityDay | null>((peak, day) => {
    if (day.count === 0) return peak;
    return !peak || day.count >= peak.count ? day : peak;
  }, null);

  return { total, currentStreakDates, longestStreakDates, peakDay };
}

export function formatCalendarDate(value: string, options: Intl.DateTimeFormatOptions = {}) {
  const date = dateAtLocalMidnight(value);
  if (!date) return value;
  return date.toLocaleDateString('en-US', options);
}
