/**
 * UpdateBanner component that shows when an app update is available.
 *
 * Displays an inline banner with:
 * - New version information
 * - Release notes
 * - Update Now / Later buttons
 * - Download progress during update
 *
 * "Later" persists the dismissal for the session. The banner will
 * reappear on the next app launch.
 *
 * @module components/UpdateBanner
 */

import { useState, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Update } from '@tauri-apps/plugin-updater';
import { checkForUpdate, downloadAndInstall, restartApp, UpdateInfo } from '../lib/updater';
import { trackEvent, trackError } from '../lib/analytics';
import { logger } from '../lib/logger';
import { Button } from './primitives/Button';
import '../styles/features/update-banner.css';

/** How often to check for updates (1 hour) */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Session storage key for deferred updates */
const DEFERRED_UPDATE_KEY = 'shipstudio_deferred_update';

export function UpdateBanner() {
  const [updateAvailable, setUpdateAvailable] = useState<{
    update: Update;
    info: UpdateInfo;
  } | null>(null);
  const [status, setStatus] = useState<'idle' | 'downloading' | 'ready' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [deferred, setDeferred] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check for updates on mount and periodically
  useEffect(() => {
    const doCheck = async () => {
      try {
        const result = await checkForUpdate();
        if (result) {
          // Check if this version was deferred this session
          const deferredVersion = sessionStorage.getItem(DEFERRED_UPDATE_KEY);
          if (deferredVersion === result.info.version) {
            setDeferred(true);
          } else {
            setDeferred(false);
          }
          setUpdateAvailable(result);
        }
      } catch {
        logger.warn('[UpdateBanner] Check failed');
      }
    };

    // Check on mount (with delay to not block startup)
    const initialTimeout = setTimeout(() => void doCheck(), 5000);

    // Check periodically
    const interval = setInterval(() => void doCheck(), UPDATE_CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, []);

  const handleUpdate = useCallback(async () => {
    if (!updateAvailable) return;

    setStatus('downloading');
    setError(null);
    void trackEvent('update_started', {
      version: updateAvailable.info.version,
      $screen_name: 'Dashboard',
    });

    try {
      await downloadAndInstall(updateAvailable.update, (p) => {
        setProgress(p);
      });
      void trackEvent('update_downloaded', {
        version: updateAvailable.info.version,
        $screen_name: 'Dashboard',
      });
      setStatus('ready');
    } catch (err: unknown) {
      logger.warn('[UpdateBanner] Download failed');
      trackError('update_download', err, 'Dashboard');
      setStatus('error');
      // Extract as much error info as possible
      let errorMsg = 'Update failed';
      if (err instanceof Error) {
        errorMsg = err.message;
        // Include cause if available (ES2022+)
        const cause = (err as Error & { cause?: unknown }).cause;
        if (cause instanceof Error) {
          errorMsg += ` (${cause.message})`;
        } else if (typeof cause === 'string') {
          errorMsg += ` (${cause})`;
        }
      } else if (typeof err === 'string') {
        errorMsg = err;
      } else if (err && typeof err === 'object') {
        // Try to stringify the error object
        errorMsg = JSON.stringify(err);
      }
      setError(errorMsg);
    }
  }, [updateAvailable]);

  const handleRestart = useCallback(async () => {
    void trackEvent('update_restarted', { $screen_name: 'Dashboard' });
    try {
      await restartApp();
    } catch (err) {
      logger.warn('[UpdateBanner] Restart failed');
      trackError('app_restart', err, 'Dashboard');
      setError('Failed to restart. Please restart manually.');
    }
  }, []);

  // The banner occupies the top of the window (the macOS title-bar drag zone),
  // covering the usual drag region. Make it draggable like the app's other
  // top-of-window surfaces (dashboard, workspace header) so the window can still
  // be moved/maximized while an update is available. Buttons are excluded so
  // their clicks still work.
  const handleBannerDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleBannerDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);

  const handleLater = useCallback(() => {
    if (updateAvailable) {
      void trackEvent('update_deferred', {
        version: updateAvailable.info.version,
        $screen_name: 'Dashboard',
      });
      // Store in sessionStorage so it shows again on next app launch
      sessionStorage.setItem(DEFERRED_UPDATE_KEY, updateAvailable.info.version);
      setDeferred(true);
    }
  }, [updateAvailable]);

  // Don't render if no update or deferred
  if (!updateAvailable || deferred) {
    return null;
  }

  // Parse release notes - extract bullet points for the current version only
  const parseReleaseNotes = (body: string | undefined): string[] => {
    if (!body) return [];
    // Split by bullet points and filter out empty lines and old version notes
    const lines = body
      .split(/•/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Only take notes before the next version header
    const currentVersionNotes: string[] = [];
    for (const line of lines) {
      if (line.startsWith('##') || line.includes("What's New in v")) break;
      if (line) currentVersionNotes.push(line);
    }
    return currentVersionNotes;
  };

  const releaseNotes = parseReleaseNotes(updateAvailable.info.body);

  return (
    <div
      className="update-banner"
      onMouseDown={handleBannerDrag}
      onDoubleClick={handleBannerDoubleClick}
    >
      <div className="update-banner-header">
        <div className="update-banner-title">
          <span className="update-banner-badge">Update Available</span>
          <span className="update-banner-version">v{updateAvailable.info.version}</span>
        </div>
        {status === 'idle' && (
          <div className="update-banner-actions">
            <Button variant="secondary" size="sm" onClick={handleLater}>
              Later
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleUpdate()}>
              Update Now
            </Button>
          </div>
        )}
        {status === 'downloading' && (
          <div className="update-banner-progress-container">
            <div className="update-banner-progress">
              <div className="update-banner-progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <span className="update-banner-progress-text">{progress}%</span>
          </div>
        )}
        {status === 'ready' && (
          <Button variant="primary" size="sm" onClick={() => void handleRestart()}>
            Restart to Apply
          </Button>
        )}
        {status === 'error' && (
          <div className="update-banner-actions">
            <span className="update-banner-error">{error}</span>
            <Button variant="secondary" size="sm" onClick={() => void handleUpdate()}>
              Retry
            </Button>
          </div>
        )}
      </div>
      {releaseNotes.length > 0 && status === 'idle' && (
        <ul className="update-banner-notes">
          {releaseNotes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
