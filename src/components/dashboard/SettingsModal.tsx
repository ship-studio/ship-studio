/**
 * SettingsModal - app-level settings accessible from the dashboard.
 *
 * Currently contains:
 * - Analytics opt-out toggle
 *
 * @module components/SettingsModal
 */

import { useState, useEffect, useCallback } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { getAnalyticsEnabled, setAnalyticsEnabled, trackEvent } from '../../lib/analytics';
import {
  getCalendarHidden,
  setCalendarHidden,
  getSlackCtaHidden,
  setSlackCtaHidden,
  getTerminalGpuEnabled,
  setTerminalGpuEnabled,
} from '../../lib/settings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCalendarHiddenChange?: (hidden: boolean) => void;
  onSlackCtaHiddenChange?: (hidden: boolean) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  onCalendarHiddenChange,
  onSlackCtaHiddenChange,
}: SettingsModalProps) {
  const [analyticsEnabled, setLocalAnalyticsEnabled] = useState(true);
  const [calendarVisible, setLocalCalendarVisible] = useState(true);
  const [slackCtaVisible, setLocalSlackCtaVisible] = useState(true);
  const [terminalGpuEnabled, setLocalTerminalGpuEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      const [enabled, calHidden, slackHidden, gpuEnabled] = await Promise.all([
        getAnalyticsEnabled(),
        getCalendarHidden(),
        getSlackCtaHidden(),
        getTerminalGpuEnabled(),
      ]);
      if (!cancelled) {
        setLocalAnalyticsEnabled(enabled);
        setLocalCalendarVisible(!calHidden);
        setLocalSlackCtaVisible(!slackHidden);
        setLocalTerminalGpuEnabled(gpuEnabled);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    const newValue = !analyticsEnabled;
    setLocalAnalyticsEnabled(newValue);
    void setAnalyticsEnabled(newValue);
    if (newValue) {
      // Track re-enable (this fires before the backend disables, so it gets sent)
      void trackEvent('analytics_enabled', { $screen_name: 'Settings' });
    }
  }, [analyticsEnabled]);

  const handleCalendarToggle = useCallback(() => {
    const newVisible = !calendarVisible;
    setLocalCalendarVisible(newVisible);
    void setCalendarHidden(!newVisible);
    void trackEvent('calendar_visibility_toggled', {
      visible: newVisible,
      $screen_name: 'Settings',
    });
    onCalendarHiddenChange?.(!newVisible);
  }, [calendarVisible, onCalendarHiddenChange]);

  const handleSlackCtaToggle = useCallback(() => {
    const newVisible = !slackCtaVisible;
    setLocalSlackCtaVisible(newVisible);
    void setSlackCtaHidden(!newVisible);
    onSlackCtaHiddenChange?.(!newVisible);
  }, [slackCtaVisible, onSlackCtaHiddenChange]);

  const handleTerminalGpuToggle = useCallback(() => {
    const newEnabled = !terminalGpuEnabled;
    setLocalTerminalGpuEnabled(newEnabled);
    void setTerminalGpuEnabled(newEnabled);
    void trackEvent('terminal_gpu_toggled', {
      enabled: newEnabled,
      $screen_name: 'Settings',
    });
  }, [terminalGpuEnabled]);

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Settings" className="settings-modal">
      <div className="settings-modal-body">
        <div className="settings-section">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Activity calendar</span>
              <span className="settings-row-description">
                Show your GitHub contribution graph on the dashboard.
              </span>
            </div>
            <button
              className={`settings-toggle ${calendarVisible ? 'on' : 'off'}`}
              onClick={handleCalendarToggle}
              disabled={loading}
              role="switch"
              aria-checked={calendarVisible}
            >
              <span className="settings-toggle-track">
                <span className="settings-toggle-thumb" />
              </span>
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Community banner</span>
              <span className="settings-row-description">
                Show the Slack community invite on the dashboard.
              </span>
            </div>
            <button
              className={`settings-toggle ${slackCtaVisible ? 'on' : 'off'}`}
              onClick={handleSlackCtaToggle}
              disabled={loading}
              role="switch"
              aria-checked={slackCtaVisible}
            >
              <span className="settings-toggle-track">
                <span className="settings-toggle-thumb" />
              </span>
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Terminal GPU acceleration</span>
              <span className="settings-row-description">
                Use GPU rendering for faster, smoother terminals. Turn off if agent output looks
                garbled or fragmented (a known issue on some macOS beta builds). Applies to newly
                opened terminals.
              </span>
            </div>
            <button
              className={`settings-toggle ${terminalGpuEnabled ? 'on' : 'off'}`}
              onClick={handleTerminalGpuToggle}
              disabled={loading}
              role="switch"
              aria-checked={terminalGpuEnabled}
            >
              <span className="settings-toggle-track">
                <span className="settings-toggle-thumb" />
              </span>
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Usage analytics</span>
              <span className="settings-row-description">
                Help improve Ship Studio by sharing usage data like feature usage, and errors.
              </span>
            </div>
            <button
              className={`settings-toggle ${analyticsEnabled ? 'on' : 'off'}`}
              onClick={handleToggle}
              disabled={loading}
              role="switch"
              aria-checked={analyticsEnabled}
            >
              <span className="settings-toggle-track">
                <span className="settings-toggle-thumb" />
              </span>
            </button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
