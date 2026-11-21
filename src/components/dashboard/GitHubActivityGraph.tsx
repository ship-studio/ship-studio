import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Tooltip } from '../primitives/Tooltip';
import {
  buildActivityWeeks,
  formatCalendarDate,
  latestPullRequestStatus,
  type ActivityDay,
  type ActivityMonthLabel,
  type ActivityView,
} from './githubCalendarUtils';

interface GitHubActivityGraphProps {
  days: ActivityDay[];
  view: ActivityView;
  emphasizedDates: ReadonlySet<string>;
  hoveredDate: string | null;
  onDayHover: (date: string | null) => void;
}

function countLabel(view: ActivityView, count: number) {
  const noun =
    view === 'contributions'
      ? 'contribution'
      : view === 'commits'
        ? 'commit'
        : view === 'pullRequests'
          ? 'pull request'
          : 'review contribution';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function statusSummary(day: ActivityDay) {
  const { merged, open, closed } = day.pullRequestStatuses;
  return [
    merged > 0 ? `${merged} merged` : null,
    open > 0 ? `${open} open` : null,
    closed > 0 ? `${closed} closed unmerged` : null,
    day.pullRequestStatuses.restricted > 0
      ? `${day.pullRequestStatuses.restricted} unknown status`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function reviewStateLabel(state: string) {
  switch (state) {
    case 'APPROVED':
      return 'Approved';
    case 'CHANGES_REQUESTED':
      return 'Changes requested';
    case 'COMMENTED':
      return 'Commented';
    case 'DISMISSED':
      return 'Dismissed';
    case 'RESTRICTED':
      return 'Details restricted';
    default:
      return 'Other';
  }
}

function PullRequestTooltipDescription({ text }: { text: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [marquee, setMarquee] = useState({ overflows: false, distance: 0, duration: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const textElement = textRef.current;
    if (!container || !textElement) return;

    const updateOverflow = () => {
      const distance = Math.max(textElement.scrollWidth - container.clientWidth, 0);
      const speed = Number.parseFloat(
        getComputedStyle(container).getPropertyValue(
          '--github-calendar-pr-marquee-pixels-per-second'
        )
      );
      setMarquee({
        overflows: distance > 0,
        distance,
        duration: speed > 0 ? distance / speed : 0,
      });
    };
    updateOverflow();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(container);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      className="github-calendar-tooltip-pr-description"
      data-overflowing={marquee.overflows || undefined}
      ref={containerRef}
    >
      <span className="github-calendar-tooltip-pr-static" ref={textRef}>
        {text}
      </span>
      <span
        className="github-calendar-tooltip-pr-track"
        aria-hidden="true"
        style={
          {
            '--github-calendar-pr-marquee-distance': `${marquee.distance}px`,
            '--github-calendar-pr-marquee-duration': `${marquee.duration}s`,
          } as CSSProperties
        }
      >
        <span>{text}</span>
      </span>
    </span>
  );
}

function activityTooltipContent(day: ActivityDay, view: ActivityView) {
  const date = formatCalendarDate(day.date, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const details =
    view === 'pullRequests'
      ? day.pullRequests.slice(0, 4).map((pullRequest) => ({
          kind: 'pullRequest' as const,
          key: `${pullRequest.repository}-${pullRequest.number}-${pullRequest.occurredAt}`,
          pullRequest,
        }))
      : view === 'reviews'
        ? day.reviews.slice(0, 4).map((review) => ({
            kind: 'review' as const,
            key: `${review.repository}-${review.number}-${review.occurredAt}`,
            text: [
              reviewStateLabel(review.state),
              review.repository,
              review.number ? `#${review.number}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
          }))
        : [];

  return (
    <div className="github-calendar-tooltip">
      <strong>{countLabel(view, day.count)}</strong>
      {view === 'pullRequests' && day.count > 0 && <span>{statusSummary(day)}</span>}
      <span className="github-calendar-tooltip-date">{date}</span>
      {details.map((detail) => {
        if (detail.kind === 'pullRequest') {
          const { pullRequest } = detail;
          const statusLabel =
            pullRequest.status === 'closed'
              ? 'closed unmerged'
              : pullRequest.status === 'restricted'
                ? 'unknown status'
                : pullRequest.status;
          const description = [pullRequest.repository, pullRequest.title, `(${statusLabel})`]
            .filter(Boolean)
            .join(' · ');
          const numberLabel = pullRequest.number === null ? null : `#${pullRequest.number}`;
          const pullRequestUrl = pullRequest.url;

          return (
            <div
              className="github-calendar-tooltip-detail github-calendar-tooltip-pr"
              key={detail.key}
            >
              {numberLabel && pullRequestUrl ? (
                <a
                  className="github-calendar-tooltip-pr-link"
                  href={pullRequestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (!isTauri()) return;
                    event.preventDefault();
                    void openUrl(pullRequestUrl);
                  }}
                >
                  {numberLabel}
                </a>
              ) : (
                numberLabel && <span>{numberLabel}</span>
              )}
              <PullRequestTooltipDescription text={description} />
            </div>
          );
        }

        return (
          <span className="github-calendar-tooltip-detail" key={detail.key}>
            {detail.text}
          </span>
        );
      })}
      {day.count > 4 && details.length === 4 && (
        <span className="github-calendar-tooltip-detail">and {day.count - 4} more</span>
      )}
    </div>
  );
}

function monthTooltipContent(month: ActivityMonthLabel, days: ActivityDay[], view: ActivityView) {
  const count = days.reduce(
    (total, day) => (day.date.startsWith(`${month.monthKey}-`) ? total + day.count : total),
    0
  );
  const [year, monthNumber] = month.monthKey.split('-').map(Number);
  const label = new Date(year, monthNumber - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="github-calendar-tooltip">
      <strong>{countLabel(view, count)}</strong>
      <span className="github-calendar-tooltip-date">{label}</span>
    </div>
  );
}

function cellAccessibleLabel(day: ActivityDay, view: ActivityView) {
  const date = formatCalendarDate(day.date, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  if (view === 'pullRequests' && day.count > 0) {
    return `${countLabel(view, day.count)}; ${statusSummary(day)} on ${date}`;
  }
  return `${countLabel(view, day.count)} on ${date}`;
}

export function GitHubActivityGraph({
  days,
  view,
  emphasizedDates,
  hoveredDate,
  onDayHover,
}: GitHubActivityGraphProps) {
  const [hoveredMonthKey, setHoveredMonthKey] = useState<string | null>(null);
  const { weeks, monthLabels } = buildActivityWeeks(days);
  const weekCount = weeks.length;
  const hasEmphasis = Boolean(hoveredDate || hoveredMonthKey || emphasizedDates.size > 0);

  return (
    <div
      className="github-calendar-graph"
      style={{ '--github-calendar-week-count': weekCount } as CSSProperties}
      role="group"
      aria-label="Daily GitHub activity calendar"
      onMouseLeave={() => {
        onDayHover(null);
        setHoveredMonthKey(null);
      }}
    >
      <div className="github-calendar-weekday-labels" aria-hidden="true">
        <span>Mon</span>
        <span />
        <span>Wed</span>
        <span />
        <span>Fri</span>
        <span />
        <span>Sun</span>
      </div>
      <div className="github-calendar-calendar">
        <div className="github-calendar-month-labels" aria-hidden="true">
          {monthLabels.map((month) => (
            <Tooltip
              content={monthTooltipContent(month, days, view)}
              delayMs={50}
              placement="above"
              key={`${month.weekIndex}-${month.label}`}
            >
              <span
                className="github-calendar-month-label"
                style={{ gridColumn: month.weekIndex + 1 }}
                data-month={month.monthKey}
                onMouseEnter={() => {
                  onDayHover(null);
                  setHoveredMonthKey(month.monthKey);
                }}
              >
                {month.label}
              </span>
            </Tooltip>
          ))}
        </div>
        <div className="github-calendar-weeks" data-emphasis-active={hasEmphasis}>
          {weeks.map((week, weekIndex) => (
            <div className="github-calendar-week" key={weekIndex}>
              {week.days.map((day, weekday) => {
                if (!day) return null;
                const isHovered = hoveredDate === day.date;
                const isMonthHighlighted =
                  !hoveredDate &&
                  hoveredMonthKey !== null &&
                  day.date.startsWith(`${hoveredMonthKey}-`);
                const isHighlighted = hoveredDate
                  ? isHovered
                  : isMonthHighlighted || emphasizedDates.has(day.date);
                const isDimmed = hasEmphasis && !isHighlighted;
                const status = view === 'pullRequests' ? latestPullRequestStatus(day) : undefined;

                return (
                  <Tooltip
                    content={activityTooltipContent(day, view)}
                    delayMs={50}
                    interactive={view === 'pullRequests'}
                    key={day.date}
                  >
                    <span
                      className={`github-calendar-day${isHighlighted ? ' is-highlighted' : ''}${isMonthHighlighted ? ' is-month-highlighted' : ''}${isDimmed ? ' is-dimmed' : ''}${isHovered ? ' is-hovered' : ''}`}
                      data-date={day.date}
                      data-view={view}
                      data-level={day.level}
                      data-status={status}
                      role="img"
                      aria-label={cellAccessibleLabel(day, view)}
                      style={{ '--github-calendar-weekday': weekday + 1 } as CSSProperties}
                      onMouseEnter={() => {
                        setHoveredMonthKey(null);
                        onDayHover(day.date);
                      }}
                    />
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
