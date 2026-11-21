/**
 * Authenticated GitHub activity calendar on the home dashboard.
 *
 * @module components/GitHubCalendar
 */

import { useEffect, useMemo, useState, memo, type ReactNode } from 'react';
import { CalendarIcon, CalendarStreakIcon, EyeOffIcon, TrendIcon } from '@/components/icons';
import { useInvoke } from '@/hooks/useInvoke';
import type { GitHubActivityData } from '@/lib/githubActivity';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { ToggleButton } from '../primitives/ToggleButton';
import { GitHubActivityGraph } from './GitHubActivityGraph';
import {
  buildActivityDays,
  getTrailingDateWindow,
  localIsoDate,
  summarizeActivity,
  type ActivityView,
} from './githubCalendarUtils';

type MetricKey = 'current' | 'longest' | 'peak';
type GitHubCalendarPreferences = { view: ActivityView; selectedMetric: MetricKey | null };

const GITHUB_CALENDAR_PREFERENCES_KEY = 'shipstudio.github-calendar-preferences.v1';
const DEFAULT_GITHUB_CALENDAR_PREFERENCES: GitHubCalendarPreferences = {
  view: 'contributions',
  selectedMetric: null,
};
const METRIC_VALUES: readonly MetricKey[] = ['current', 'longest', 'peak'];

function readGitHubCalendarPreferences(): GitHubCalendarPreferences {
  if (typeof window === 'undefined') return DEFAULT_GITHUB_CALENDAR_PREFERENCES;

  try {
    const raw = window.localStorage.getItem(GITHUB_CALENDAR_PREFERENCES_KEY);
    if (!raw) return DEFAULT_GITHUB_CALENDAR_PREFERENCES;

    const stored = JSON.parse(raw) as { view?: unknown; selectedMetric?: unknown };
    const view = ACTIVITY_VIEWS.find((option) => option.value === stored.view)?.value;
    return {
      view: view ?? DEFAULT_GITHUB_CALENDAR_PREFERENCES.view,
      selectedMetric: METRIC_VALUES.includes(stored.selectedMetric as MetricKey)
        ? (stored.selectedMetric as MetricKey)
        : DEFAULT_GITHUB_CALENDAR_PREFERENCES.selectedMetric,
    };
  } catch {
    return DEFAULT_GITHUB_CALENDAR_PREFERENCES;
  }
}

function writeGitHubCalendarPreferences(preferences: GitHubCalendarPreferences): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(GITHUB_CALENDAR_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Keep the in-memory selection usable when browser storage is unavailable.
  }
}

function ActivityViewOptionLabel({ view, label }: { view: ActivityView; label: string }) {
  return (
    <span className="github-calendar-view-label">
      <span
        className="github-calendar-view-swatch"
        data-view={view}
        data-level="4"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

const ACTIVITY_VIEWS = [
  {
    value: 'contributions',
    label: <ActivityViewOptionLabel view="contributions" label="Contributions" />,
  },
  { value: 'commits', label: <ActivityViewOptionLabel view="commits" label="Commits" /> },
  { value: 'pullRequests', label: <ActivityViewOptionLabel view="pullRequests" label="PRs" /> },
  { value: 'reviews', label: <ActivityViewOptionLabel view="reviews" label="Reviews" /> },
] as const satisfies ReadonlyArray<{ value: ActivityView; label: ReactNode }>;

function CalendarSkeleton() {
  return (
    <div className="github-calendar-skeleton" role="status" aria-label="Loading GitHub activity">
      {Array.from({ length: 54 * 7 }, (_, index) => (
        <span className="github-calendar-skeleton-cell" key={index} />
      ))}
    </div>
  );
}

function pluralDays(count: number) {
  return `${count} day${count === 1 ? '' : 's'}`;
}

function viewItemLabel(view: ActivityView, count: number) {
  if (view === 'contributions') return `${count} contribution${count === 1 ? '' : 's'}`;
  if (view === 'commits') return `${count} commit${count === 1 ? '' : 's'}`;
  if (view === 'pullRequests') return `${count} pull request${count === 1 ? '' : 's'}`;
  return `${count} review contribution${count === 1 ? '' : 's'}`;
}

function viewTotalLabel(view: ActivityView) {
  if (view === 'contributions') return 'contributions in the last 12 months';
  if (view === 'commits') return 'commits in the last 12 months';
  if (view === 'pullRequests') return 'pull requests in the last 12 months';
  return 'review contributions in the last 12 months';
}

function peakMetricLabel(view: ActivityView) {
  if (view === 'contributions') return 'Busiest day';
  if (view === 'commits') return 'Most commits';
  if (view === 'pullRequests') return 'Most PRs';
  return 'Most reviews';
}

function GitHubCalendarError({
  message,
  onRetry,
  isLoading,
}: {
  message: string;
  onRetry: () => void;
  isLoading: boolean;
}) {
  return (
    <div className="github-calendar-error" role="alert">
      <div>
        <strong>GitHub activity is unavailable</strong>
        <span>{message}</span>
      </div>
      <Button variant="secondary" size="compact" disabled={isLoading} onClick={onRetry}>
        {isLoading ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}

/** Current activity total shown above the dashboard headline. */
export interface GitHubCalendarSummary {
  lead: string;
  count: string;
  description: string;
  view: ActivityView;
}

export const GitHubCalendar = memo(function GitHubCalendar({
  username,
  isAuthenticated = true,
  isAuthCheckDone = false,
  onHide,
  onSummaryChange,
  showSummaryInCalendar = false,
}: {
  username: string | null | undefined;
  isAuthenticated?: boolean;
  isAuthCheckDone?: boolean;
  onHide?: () => void;
  onSummaryChange?: (summary: GitHubCalendarSummary | null) => void;
  showSummaryInCalendar?: boolean;
}) {
  const layout: 'centered' | 'wide' = 'centered';
  const [preferences, setPreferences] = useState(readGitHubCalendarPreferences);
  const { view, selectedMetric } = preferences;
  const [hoveredMetric, setHoveredMetric] = useState<MetricKey | null>(null);
  const [focusedMetric, setFocusedMetric] = useState<MetricKey | null>(null);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);

  useEffect(() => {
    writeGitHubCalendarPreferences(preferences);
  }, [preferences]);

  const todayKey = localIsoDate(new Date());
  const dateWindow = useMemo(() => {
    const [year, month, day] = todayKey.split('-').map(Number);
    return getTrailingDateWindow(new Date(year, month - 1, day));
  }, [todayKey]);
  const { data, isLoading, error, execute, reset } =
    useInvoke<GitHubActivityData>('get_github_activity');

  useEffect(() => {
    if (!isAuthCheckDone) return;

    // The coarse CLI status probe can time out independently of the activity
    // request. Let the authenticated activity query decide whether data is
    // available so a temporary probe failure cannot hide the calendar.
    reset();
    void execute({ from: dateWindow.from, to: dateWindow.to });
    // The username changes when the active GitHub workspace changes. The backend
    // resolves that workspace's authenticated viewer through gh CLI.
  }, [username, isAuthenticated, isAuthCheckDone, dateWindow, execute, reset]);

  const days = useMemo(
    () => (data ? buildActivityDays(view, data, dateWindow) : []),
    [data, view, dateWindow]
  );
  const summary = useMemo(() => summarizeActivity(days), [days]);
  const displayedSummary = useMemo(
    () =>
      data && !isLoading && isAuthCheckDone && !error
        ? {
            lead: view === 'pullRequests' ? 'You opened' : 'You made',
            count: summary.total.toLocaleString(),
            description: viewTotalLabel(view),
            view,
          }
        : null,
    [data, error, isAuthCheckDone, isLoading, summary.total, view]
  );

  useEffect(() => {
    onSummaryChange?.(displayedSummary);
  }, [displayedSummary, onSummaryChange]);

  useEffect(() => {
    return () => onSummaryChange?.(null);
  }, [onSummaryChange]);

  const highlightedMetric = hoveredMetric ?? focusedMetric ?? selectedMetric;
  const emphasizedDates = useMemo(() => {
    if (!highlightedMetric) return new Set<string>();
    if (highlightedMetric === 'current') return new Set(summary.currentStreakDates);
    if (highlightedMetric === 'longest') return new Set(summary.longestStreakDates);
    return summary.peakDay ? new Set([summary.peakDay.date]) : new Set<string>();
  }, [highlightedMetric, summary]);

  const currentStreak = summary.currentStreakDates.length;
  const longestStreak = summary.longestStreakDates.length;
  const peakDayLabel = peakMetricLabel(view);
  const peakValue = summary.peakDay ? viewItemLabel(view, summary.peakDay.count) : '—';

  const incompleteMessages: string[] = [];
  if (view === 'commits' && !data?.completeness.commits) {
    incompleteMessages.push('Commit results may be incomplete.');
  }
  if (view === 'pullRequests' && !data?.completeness.pullRequests) {
    incompleteMessages.push('Pull request results may be incomplete.');
  }
  if (view === 'reviews' && !data?.completeness.reviews) {
    incompleteMessages.push('Review results may be incomplete.');
  }
  if (data?.completeness.privateActivityRestricted) {
    incompleteMessages.push('Some repository activity is restricted.');
  }

  const showSkeleton = !isAuthCheckDone || isLoading || (!data && !error);

  const retry = () => void execute({ from: dateWindow.from, to: dateWindow.to });

  function toggleMetric(metric: MetricKey) {
    setPreferences((current) => ({
      ...current,
      selectedMetric: current.selectedMetric === metric ? null : metric,
    }));
  }

  return (
    <section
      className="github-calendar-wrapper"
      data-highlight-metric={highlightedMetric ?? undefined}
      data-emphasis-active={Boolean(hoveredDate || emphasizedDates.size)}
      aria-label="GitHub activity"
      data-education-id="github-calendar"
    >
      {onHide && (
        <IconButton
          className="github-calendar-hide-btn"
          icon={<EyeOffIcon size={14} />}
          variant="ghost"
          size="compact"
          onClick={onHide}
          title="Hide activity calendar"
          aria-label="Hide activity calendar"
        />
      )}

      {error ? (
        <GitHubCalendarError message={error.message} onRetry={retry} isLoading={isLoading} />
      ) : showSkeleton ? (
        <div className="github-calendar-graph-row">
          <div className="github-calendar-graph-viewport">
            <CalendarSkeleton />
          </div>
        </div>
      ) : data ? (
        <>
          <div className="github-calendar-content" data-layout={layout} data-view={view}>
            <div
              className={`github-calendar-summary${showSummaryInCalendar && displayedSummary ? ' github-calendar-summary--with-total' : ''}`}
            >
              {showSummaryInCalendar && displayedSummary && (
                <div
                  className="github-calendar-total github-calendar-total--centered"
                  data-view={displayedSummary.view}
                  aria-live="polite"
                >
                  <span>{displayedSummary.lead}</span>
                  <strong className="tabular-nums">{displayedSummary.count}</strong>
                  <span>{displayedSummary.description}</span>
                </div>
              )}
              <div className="github-calendar-tabs-row">
                <Tabs
                  value={view}
                  mode="navigation"
                  onValueChange={(next) =>
                    setPreferences((current) => ({ ...current, view: next as ActivityView }))
                  }
                >
                  <TabsList className="github-calendar-tabs" aria-label="GitHub activity type">
                    {ACTIVITY_VIEWS.map((option) => (
                      <TabsTab key={option.value} value={option.value}>
                        {option.value === 'contributions' && layout === 'centered' ? (
                          <ActivityViewOptionLabel view="contributions" label="All" />
                        ) : (
                          option.label
                        )}
                      </TabsTab>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </div>

            <div className="github-calendar-activity">
              <div className="github-calendar-graph-viewport">
                <GitHubActivityGraph
                  days={days}
                  view={view}
                  emphasizedDates={emphasizedDates}
                  hoveredDate={hoveredDate}
                  onDayHover={setHoveredDate}
                />
              </div>
            </div>

            <div className="github-calendar-controls">
              <div
                className="github-calendar-metrics"
                data-view={view}
                role="group"
                aria-label="GitHub activity metrics"
              >
                <ToggleButton
                  className="github-calendar-metric github-calendar-metric--padded"
                  variant="default"
                  pressed={selectedMetric === 'current'}
                  aria-label={`Highlight current streak, ${pluralDays(currentStreak)}`}
                  title="Highlight current streak"
                  onMouseEnter={() => setHoveredMetric('current')}
                  onMouseLeave={() => setHoveredMetric(null)}
                  onFocus={() => setFocusedMetric('current')}
                  onBlur={() => setFocusedMetric(null)}
                  onClick={() => toggleMetric('current')}
                >
                  <span className="github-calendar-metric-heading">
                    <span className="github-calendar-metric-icon" aria-hidden="true">
                      <TrendIcon size={16} />
                    </span>
                    <span className="github-calendar-metric-label">Current streak</span>
                  </span>
                  <strong className="tabular-nums">{pluralDays(currentStreak)}</strong>
                </ToggleButton>
                <ToggleButton
                  className="github-calendar-metric github-calendar-metric--padded"
                  variant="default"
                  pressed={selectedMetric === 'longest'}
                  aria-label={`Highlight longest streak, ${pluralDays(longestStreak)}`}
                  title="Highlight longest streak"
                  onMouseEnter={() => setHoveredMetric('longest')}
                  onMouseLeave={() => setHoveredMetric(null)}
                  onFocus={() => setFocusedMetric('longest')}
                  onBlur={() => setFocusedMetric(null)}
                  onClick={() => toggleMetric('longest')}
                >
                  <span className="github-calendar-metric-heading">
                    <span className="github-calendar-metric-icon" aria-hidden="true">
                      <CalendarStreakIcon size={16} />
                    </span>
                    <span className="github-calendar-metric-label">Longest streak</span>
                  </span>
                  <strong className="tabular-nums">{pluralDays(longestStreak)}</strong>
                </ToggleButton>
                <ToggleButton
                  className="github-calendar-metric github-calendar-metric--padded"
                  variant="default"
                  pressed={selectedMetric === 'peak'}
                  aria-label={`Highlight ${peakDayLabel.toLowerCase()}, ${peakValue}`}
                  title={`Highlight ${peakDayLabel.toLowerCase()}`}
                  onMouseEnter={() => setHoveredMetric('peak')}
                  onMouseLeave={() => setHoveredMetric(null)}
                  onFocus={() => setFocusedMetric('peak')}
                  onBlur={() => setFocusedMetric(null)}
                  onClick={() => toggleMetric('peak')}
                >
                  <span className="github-calendar-metric-heading">
                    <span className="github-calendar-metric-icon" aria-hidden="true">
                      <CalendarIcon size={16} />
                    </span>
                    <span className="github-calendar-metric-label">{peakDayLabel}</span>
                  </span>
                  <strong className="tabular-nums">{peakValue}</strong>
                </ToggleButton>
              </div>
            </div>
          </div>

          {incompleteMessages.length > 0 && (
            <div className="github-calendar-notice" role="status">
              {incompleteMessages.join(' ')}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
});
