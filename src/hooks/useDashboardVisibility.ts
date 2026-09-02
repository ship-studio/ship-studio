import { useCallback, useEffect, useState } from 'react';

import {
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  type DashboardVisibilityChangedDetail,
  getCalendarHidden,
  setCalendarHidden as persistCalendarHidden,
  getSlackCtaHidden,
  setSlackCtaHidden as persistSlackCtaHidden,
  getDashboardHeaderHidden,
  setDashboardHeaderHidden as persistDashboardHeaderHidden,
} from '../lib/settings';

export interface DashboardVisibility {
  dashboardHeaderHidden: boolean;
  calendarHidden: boolean;
  slackCtaHidden: boolean;
  hideDashboardHeader: () => void;
  hideCalendar: () => void;
  hideSlackCta: () => void;
  /** Raw setters for surfaces that persist the flag themselves (SettingsModal). */
  setDashboardHeaderHidden: (hidden: boolean) => void;
  setCalendarHidden: (hidden: boolean) => void;
  setSlackCtaHidden: (hidden: boolean) => void;
}

/**
 * Per-section dismissal state for the dashboard (header card, GitHub calendar,
 * Slack CTA).
 *
 * The settings modal can toggle the same flags, so the persisted values are
 * loaded once and then kept in sync through DASHBOARD_VISIBILITY_CHANGED_EVENT
 * rather than re-read on every render.
 */
export function useDashboardVisibility(): DashboardVisibility {
  const [dashboardHeaderHidden, setDashboardHeaderHidden] = useState(false);
  const [calendarHidden, setCalendarHidden] = useState(false);
  const [slackCtaHidden, setSlackCtaHidden] = useState(false);

  useEffect(() => {
    void getDashboardHeaderHidden().then(setDashboardHeaderHidden);
    void getCalendarHidden().then(setCalendarHidden);
    void getSlackCtaHidden().then(setSlackCtaHidden);
  }, []);

  useEffect(() => {
    const handleVisibilityChanged = (event: Event) => {
      const detail = (event as CustomEvent<DashboardVisibilityChangedDetail>).detail;
      if (!detail) return;
      if (detail.key === 'dashboardHeader') setDashboardHeaderHidden(detail.hidden);
      if (detail.key === 'calendar') setCalendarHidden(detail.hidden);
      if (detail.key === 'slackCta') setSlackCtaHidden(detail.hidden);
    };

    window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    return () =>
      window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
  }, []);

  const hideDashboardHeader = useCallback(() => {
    setDashboardHeaderHidden(true);
    void persistDashboardHeaderHidden(true);
  }, []);

  const hideSlackCta = useCallback(() => {
    setSlackCtaHidden(true);
    void persistSlackCtaHidden(true);
  }, []);

  const hideCalendar = useCallback(() => {
    setCalendarHidden(true);
    void persistCalendarHidden(true);
  }, []);

  return {
    dashboardHeaderHidden,
    calendarHidden,
    slackCtaHidden,
    hideDashboardHeader,
    hideCalendar,
    hideSlackCta,
    setDashboardHeaderHidden,
    setCalendarHidden,
    setSlackCtaHidden,
  };
}
