/**
 * GitHub contribution calendar component.
 *
 * Displays a user's GitHub contribution graph using react-github-calendar.
 * Shows contribution activity to encourage daily engagement.
 * Shows skeleton until auth check confirms status, then real data or hides.
 *
 * @module components/GitHubCalendar
 */

import { useState, useEffect, useCallback, memo, Component, ReactNode } from 'react';
import { GitHubCalendar as GitHubCalendarLib } from 'react-github-calendar';
import { Tooltip } from 'react-tooltip';
import 'react-tooltip/dist/react-tooltip.css';
import { EyeOffIcon } from '../icons';
import { logger } from '../../lib/logger';

interface Activity {
  date: string;
  count: number;
  level: number;
}

interface GitHubCalendarProps {
  /** GitHub username to display contributions for */
  username: string | null | undefined;
  /** Whether GitHub is authenticated */
  isAuthenticated?: boolean;
  /** Whether the auth check has completed */
  isAuthCheckDone?: boolean;
  /** Called when the user clicks the hide button */
  onHide?: () => void;
}

// Custom theme using app colors.
//
// BOTH `light` and `dark` MUST be provided as explicit 5-color hex scales, even
// though we only ever render `colorScheme="dark"`. react-activity-calendar fills
// any missing scale from its own default, and that default is generated with
// `color-mix(in oklab, …)`. It mutates the passed-in theme object to cache that
// scale, then re-validates it on a later render via `CSS.supports('color', …)`.
// macOS 12 ships Safari 15, which predates `color-mix()` — so the check returns
// false and the library throws "Invalid color …", white-screening the whole app
// a few seconds after launch (once the calendar data loads and it re-renders).
// Supplying both scales as plain hex keeps the library off every color-mix path.
const theme = {
  light: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  dark: ['#2d2d2d', '#0e4429', '#006d32', '#26a641', '#54e36e'],
};

function formatTooltip(activity: Activity): string {
  const date = new Date(activity.date);
  const formatted = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  if (activity.count === 0) {
    return `No contributions on ${formatted}`;
  }

  const s = activity.count === 1 ? '' : 's';
  return `${activity.count} contribution${s} on ${formatted}`;
}

function CalendarSkeleton() {
  return (
    <div className="github-calendar-skeleton">
      <div className="github-calendar-skeleton-grid">
        {Array.from({ length: 371 }).map((_, i) => (
          <div key={i} className="github-calendar-skeleton-block" />
        ))}
      </div>
    </div>
  );
}

// react-activity-calendar validates its data *during render* and throws on anything
// it dislikes — most commonly "Activity data must not be empty.", which happens
// whenever the contributions API answers 200 with an empty list (accounts with no
// public contributions in the requested year, EMU/enterprise accounts, brand new
// accounts). An uncaught throw there reaches the app-level ErrorBoundary and replaces
// the entire dashboard with the crash screen, so the calendar gets its own boundary:
// a decorative widget must never be able to take the app down.
class CalendarErrorBoundary extends Component<
  { onError: (error: Error) => void; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

// Stable renderBlock callback — avoids creating a new function reference every render,
// which would cause react-github-calendar to re-render all 365+ SVG blocks.
const renderBlock = (block: React.ReactElement, activity: Activity) => (
  <g data-tooltip-id="github-calendar-tooltip" data-tooltip-content={formatTooltip(activity)}>
    {block}
  </g>
);

export const GitHubCalendar = memo(function GitHubCalendar({
  username,
  isAuthenticated,
  isAuthCheckDone,
  onHide,
}: GitHubCalendarProps) {
  const currentYear = new Date().getFullYear();
  const [dataLoaded, setDataLoaded] = useState(false);
  // Username the calendar blew up for, rather than a plain boolean: the reset
  // effect below runs *after* the boundary's componentDidCatch on mount, so a
  // flag cleared there would immediately un-hide a calendar that just failed.
  const [failedFor, setFailedFor] = useState<string | null>(null);

  // Reset data loaded state when username changes
  useEffect(() => {
    setDataLoaded(false); // eslint-disable-line react-hooks/set-state-in-effect -- intentional: reset loading state when username prop changes
  }, [username]);

  const handleCalendarError = useCallback(
    (error: Error) => {
      logger.warn('GitHub contribution calendar failed to render, hiding it', {
        error: error.message,
        username,
      });
      setFailedFor(username ?? null);
    },
    [username]
  );

  // Stable transformData callback — prevents the library from re-fetching/re-processing
  // data on every parent re-render (unstable function refs trigger library effects).
  const handleTransformData = useCallback(
    (data: Array<{ date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }>) => {
      // Called when data is loaded
      setDataLoaded(true);
      return data;
    },
    []
  );

  // Only hide after auth check is DONE and confirmed NOT authenticated
  if (isAuthCheckDone && !isAuthenticated) {
    return null;
  }

  // The calendar threw for this user (no contribution data, unsupported CSS color
  // function, …). Drop the whole widget rather than leaving an empty frame behind.
  if (username && failedFor === username) {
    return null;
  }

  // Show skeleton while waiting for auth check OR waiting for data
  const showSkeleton = !isAuthCheckDone || !username || !dataLoaded;

  return (
    <div className="github-calendar-wrapper" data-education-id="github-calendar">
      {onHide && (
        <button
          className="github-calendar-hide-btn"
          onClick={onHide}
          title="Hide activity calendar"
          aria-label="Hide activity calendar"
        >
          <EyeOffIcon size={14} />
        </button>
      )}
      {showSkeleton && <CalendarSkeleton />}
      {username && (
        <div style={{ display: dataLoaded ? 'block' : 'none' }}>
          <CalendarErrorBoundary key={username} onError={handleCalendarError}>
            <GitHubCalendarLib
              username={username}
              colorScheme="dark"
              theme={theme}
              blockSize={12}
              blockMargin={4}
              blockRadius={3}
              fontSize={12}
              showColorLegend={false}
              showTotalCount={false}
              year={currentYear}
              renderBlock={renderBlock}
              transformData={handleTransformData}
            />
          </CalendarErrorBoundary>
        </div>
      )}
      <Tooltip id="github-calendar-tooltip" className="github-calendar-tooltip" />
    </div>
  );
});
