/**
 * Tests for the contribution calendar's empty-data guard (issue #721).
 *
 * react-activity-calendar throws `Activity data must not be empty.` during
 * render when handed a zero-length array, which crashed the app to the error
 * boundary whenever the contributions fetch came back with nothing.
 */

import { describe, it, expect } from 'vitest';
import { placeholderYearActivity } from './GitHubCalendar';

describe('placeholderYearActivity', () => {
  it('covers every day of a common year', () => {
    const days = placeholderYearActivity(2023);
    expect(days).toHaveLength(365);
    expect(days[0]).toEqual({ date: '2023-01-01', count: 0, level: 0 });
    expect(days[days.length - 1]).toEqual({ date: '2023-12-31', count: 0, level: 0 });
  });

  it('covers the extra day of a leap year', () => {
    const days = placeholderYearActivity(2024);
    expect(days).toHaveLength(366);
    expect(days.some((d) => d.date === '2024-02-29')).toBe(true);
  });

  it('emits zero-padded ISO dates the library accepts', () => {
    // react-activity-calendar parses these with parseISO and rejects
    // anything that isn't a valid YYYY-MM-DD string.
    for (const day of placeholderYearActivity(2025)) {
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(day.date))).toBe(false);
    }
  });

  it('is never empty — that is the whole point of the guard', () => {
    expect(placeholderYearActivity(2026).length).toBeGreaterThan(0);
  });
});
