import { useCallback, useEffect, useState } from 'react';

import {
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  type DashboardVisibilityChangedDetail,
  getCalendarHidden,
  setCalendarHidden as persistCalendarHidden,
  getDashboardHeaderHidden,
  setDashboardHeaderHidden as persistDashboardHeaderHidden,
} from '../lib/settings';

export interface DashboardVisibility {
  dashboardHeaderHidden: boolean;
  calendarHidden: boolean;
  hideDashboardHeader: () => void;
  hideCalendar: () => void;
  /** Raw setters for surfaces that persist the flag themselves (SettingsModal). */
  setDashboardHeaderHidden: (hidden: boolean) => void;
  setCalendarHidden: (hidden: boolean) => void;
}

/**
 * Per-section dismissal state for the dashboard (header card, GitHub calendar,
 * and calendar).
 *
 * The settings modal can toggle the same flags, so the persisted values are
 * loaded once and then kept in sync through DASHBOARD_VISIBILITY_CHANGED_EVENT
 * rather than re-read on every render.
 */
export function useDashboardVisibility(): DashboardVisibility {
  const [dashboardHeaderHidden, setDashboardHeaderHidden] = useState(false);
  const [calendarHidden, setCalendarHidden] = useState(false);

  useEffect(() => {
    void getDashboardHeaderHidden().then(setDashboardHeaderHidden);
    void getCalendarHidden().then(setCalendarHidden);
  }, []);

  useEffect(() => {
    const handleVisibilityChanged = (event: Event) => {
      const detail = (event as CustomEvent<DashboardVisibilityChangedDetail>).detail;
      if (!detail) return;
      if (detail.key === 'dashboardHeader') setDashboardHeaderHidden(detail.hidden);
      if (detail.key === 'calendar') setCalendarHidden(detail.hidden);
    };

    window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    return () =>
      window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
  }, []);

  const hideDashboardHeader = useCallback(() => {
    setDashboardHeaderHidden(true);
    void persistDashboardHeaderHidden(true);
  }, []);

  const hideCalendar = useCallback(() => {
    setCalendarHidden(true);
    void persistCalendarHidden(true);
  }, []);

  return {
    dashboardHeaderHidden,
    calendarHidden,
    hideDashboardHeader,
    hideCalendar,
    setDashboardHeaderHidden,
    setCalendarHidden,
  };
}
