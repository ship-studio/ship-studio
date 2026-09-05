/**
 * Sidebar update indicator and release-specific update modal.
 *
 * The compact indicator lives immediately above the project/sidebar footer
 * actions. Hovering or focusing reveals the release titles; selecting it opens
 * the full notes and update controls.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  checkForUpdate,
  downloadAndInstall,
  restartApp,
  type UpdateHandle,
  type UpdateInfo,
} from '../lib/updater';
import { trackEvent, trackError } from '../lib/analytics';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';
import { usePolling } from '../hooks/usePolling';
import { AlertIcon, CloseIcon, DownloadIcon, ResetIcon } from '@/components/icons';
import { Button } from './primitives/Button';
import { IconButton } from './primitives/IconButton';
import { ModalFrame } from './primitives/ModalFrame';
import { Spinner } from './primitives/Spinner';
import '../styles/features/update-banner.css';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFERRED_UPDATE_KEY = 'shipstudio_deferred_update';

type AvailableUpdate = { update: UpdateHandle; info: UpdateInfo };
type UpdateStatus = 'idle' | 'downloading' | 'ready' | 'error';

export interface ReleaseNote {
  title: string;
  detail?: string;
}

function cleanInlineMarkdown(value: string): string {
  return (
    value
      .replace(/^#{1,6}\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      // Unbalanced leftovers (a bold marker split across lines, a stray
      // backtick) must never reach the UI verbatim.
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Parse only the available version's bullets from the updater's Markdown body. */
export function parseReleaseNotes(body: string | undefined, version: string): ReleaseNote[] {
  if (!body?.trim()) return [];

  const lines = body.split(/\r?\n/);
  const versionHeading = new RegExp(`^#{1,6}\\s+.*v?${version.replace(/\./g, '\\.')}\\b`, 'i');
  const matchingHeadingIndex = lines.findIndex((line) => versionHeading.test(line.trim()));
  const start = matchingHeadingIndex >= 0 ? matchingHeadingIndex + 1 : 0;
  const notes: ReleaseNote[] = [];
  // Some releases ship prose instead of bullets. Without this, every such line
  // was dropped and the modal claimed there was nothing to say.
  const hasBullets = lines.slice(start).some((line) => /^(?:[-*+]|•)\s+/.test(line.trim()));

  let previousLineWasBlank = true;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^#{1,6}\s+/.test(line)) {
      if (notes.length > 0 || matchingHeadingIndex >= 0) break;
      previousLineWasBlank = true;
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|•)\s+(.+)$/);
    if (bullet) {
      const content = bullet[1].trim();
      const emphasized = content.match(/^\*\*(.+?)\*\*\s*(?:[-–—:]\s*)?(.*)$/);
      if (emphasized) {
        notes.push({
          title: cleanInlineMarkdown(emphasized[1]),
          detail: cleanInlineMarkdown(emphasized[2]) || undefined,
        });
      } else {
        const separated = content.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        notes.push({
          title: cleanInlineMarkdown(separated?.[1] ?? content),
          detail: separated ? cleanInlineMarkdown(separated[2]) : undefined,
        });
      }
      previousLineWasBlank = false;
      continue;
    }

    if (!line) {
      previousLineWasBlank = true;
      continue;
    }

    // A wrapped continuation line belongs to the note above it. In a
    // bullet-less body a blank line starts a new note instead.
    if (notes.length > 0 && (hasBullets || !previousLineWasBlank)) {
      const current = notes[notes.length - 1];
      current.detail = cleanInlineMarkdown([current.detail, line].filter(Boolean).join(' '));
      previousLineWasBlank = false;
      continue;
    }

    if (!hasBullets) {
      const separated = line.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      notes.push({
        title: cleanInlineMarkdown(separated?.[1] ?? line),
        detail: separated ? cleanInlineMarkdown(separated[2]) : undefined,
      });
    }
    previousLineWasBlank = false;
  }

  return notes;
}

export function UpdateBanner() {
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deferred, setDeferred] = useState(false);

  const check = useCallback(async () => {
    try {
      const result = await checkForUpdate();
      if (!result) {
        setAvailableUpdate(null);
        return;
      }

      setDeferred(sessionStorage.getItem(DEFERRED_UPDATE_KEY) === result.info.version);
      setAvailableUpdate(result);
    } catch {
      logger.warn('[UpdateBanner] Check failed');
    }
  }, []);

  usePolling(check, {
    intervalMs: UPDATE_CHECK_INTERVAL_MS,
    maxIntervalMs: UPDATE_CHECK_INTERVAL_MS,
    name: 'app-update-check',
  });

  const releaseNotes = useMemo(
    () => parseReleaseNotes(availableUpdate?.info.body, availableUpdate?.info.version ?? ''),
    [availableUpdate]
  );

  const handleUpdate = useCallback(async () => {
    if (!availableUpdate) return;

    setStatus('downloading');
    setProgress(0);
    setError(null);
    setModalOpen(false);
    void trackEvent('update_started', {
      version: availableUpdate.info.version,
      $screen_name: 'Project Sidebar',
    });

    try {
      await downloadAndInstall(availableUpdate.update, setProgress);
      void trackEvent('update_downloaded', {
        version: availableUpdate.info.version,
        $screen_name: 'Project Sidebar',
      });
      setStatus('ready');
    } catch (err: unknown) {
      logger.warn('[UpdateBanner] Download failed');
      trackError('update_download', err, 'Project Sidebar');
      setStatus('error');
      setError(formatCommandError(asCommandError(err)));
    }
  }, [availableUpdate]);

  const handleRestart = useCallback(async () => {
    try {
      const result = await restartApp();
      if (result === 'simulated') {
        setStatus('idle');
        setProgress(0);
      }
    } catch (err) {
      const detail = formatCommandError(asCommandError(err));
      logger.warn('[UpdateBanner] Restart failed', { error: detail });
      trackError('app_restart', err, 'Project Sidebar');
      setStatus('error');
      setError(`Couldn't restart the app: ${detail}. Please quit and reopen Ship Studio manually.`);
    }
  }, []);

  const handleLater = useCallback(() => {
    if (!availableUpdate) return;
    void trackEvent('update_deferred', {
      version: availableUpdate.info.version,
      $screen_name: 'Project Sidebar',
    });
    sessionStorage.setItem(DEFERRED_UPDATE_KEY, availableUpdate.info.version);
    setDeferred(true);
    setModalOpen(false);
  }, [availableUpdate]);

  if (!availableUpdate || deferred) return null;

  const version = availableUpdate.info.version;
  const indicatorLabel =
    status === 'downloading'
      ? 'Downloading…'
      : status === 'ready'
        ? 'Click to restart'
        : status === 'error'
          ? 'Update needs attention'
          : 'Update available';

  return (
    <>
      <div className={`update-indicator update-indicator--${status}`}>
        {status === 'downloading' && (
          <span
            className="update-indicator-progress-fill"
            style={{ width: `${progress}%` }}
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          className="update-indicator-details"
          onClick={() => setModalOpen(true)}
          disabled={status === 'downloading' || status === 'ready'}
          aria-label={`View what's new in version ${version}`}
        >
          <span className="update-indicator-details-inner">
            <span className="update-indicator-version">Version {version} — view changes</span>
            {releaseNotes.length > 0 && (
              <span className="update-indicator-notes">
                {releaseNotes.map((note, index) => (
                  <span className="update-indicator-note" key={`${note.title}-${index}`}>
                    {note.title}
                  </span>
                ))}
              </span>
            )}
          </span>
        </button>
        <div className="update-indicator-summary">
          <button
            type="button"
            className="update-indicator-update-action"
            onClick={() =>
              void (status === 'ready'
                ? handleRestart()
                : status !== 'downloading' && handleUpdate())
            }
            disabled={status === 'downloading'}
            aria-label={
              status === 'ready'
                ? `Restart to apply version ${version}`
                : status === 'downloading'
                  ? `Downloading version ${version}`
                  : status === 'error'
                    ? `Retry update to version ${version}`
                    : `Update Ship Studio to version ${version}`
            }
          >
            <span className="update-indicator-icon" aria-hidden="true">
              {status === 'downloading' ? (
                <Spinner size="sm" />
              ) : status === 'ready' ? (
                <ResetIcon size={14} />
              ) : status === 'idle' ? (
                <>
                  <span className="update-indicator-icon-default">
                    <AlertIcon size={14} />
                  </span>
                  <span className="update-indicator-icon-expanded">
                    <DownloadIcon size={14} />
                  </span>
                </>
              ) : (
                <DownloadIcon size={14} />
              )}
            </span>
            {status === 'idle' ? (
              <span className="update-indicator-label update-indicator-label-swap">
                <span className="update-indicator-label-default">Update available</span>
                <span className="update-indicator-label-expanded">Install now</span>
              </span>
            ) : (
              <span className="update-indicator-label">{indicatorLabel}</span>
            )}
          </button>
          {(status === 'idle' || status === 'error') && (
            <IconButton
              variant="ghost"
              size="default"
              className="update-indicator-dismiss"
              icon={<CloseIcon size={14} />}
              onClick={handleLater}
              title="Dismiss update until next launch"
              aria-label="Dismiss update until next launch"
            />
          )}
          {status === 'downloading' && (
            <span
              className="update-indicator-progress-value"
              aria-label={`${progress}% downloaded`}
            >
              {progress}%
            </span>
          )}
        </div>
      </div>

      <ModalFrame
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`What's New in v${version}`}
        className="update-details-modal"
        dismissable={status !== 'downloading'}
        showCloseButton={status !== 'downloading'}
      >
        <div className="update-details-body">
          {releaseNotes.length > 0 ? (
            <ul className="update-details-list">
              {releaseNotes.map((note, index) => (
                <li key={`${note.title}-${index}`}>
                  <h3>{note.title}</h3>
                  {note.detail && <p>{note.detail}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="update-details-empty">This version is ready to install.</p>
          )}

          {status === 'downloading' && (
            <div
              className="update-details-progress"
              aria-label={`Downloading update: ${progress}%`}
            >
              <div className="update-details-progress-track">
                <div className="update-details-progress-bar" style={{ width: `${progress}%` }} />
              </div>
              <span>{progress}%</span>
            </div>
          )}

          {status === 'error' && error && (
            <p className="update-details-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="update-details-actions">
          {(status === 'idle' || status === 'error') && (
            <Button variant="secondary" onClick={handleLater}>
              Later
            </Button>
          )}
          {status === 'idle' && (
            <Button variant="primary" onClick={() => void handleUpdate()}>
              Update Now
            </Button>
          )}
          {status === 'downloading' && (
            <Button variant="primary" disabled leftIcon={<Spinner size="sm" />}>
              Updating…
            </Button>
          )}
          {status === 'ready' && (
            <Button variant="primary" onClick={() => void handleRestart()}>
              Restart to Apply
            </Button>
          )}
          {status === 'error' && (
            <Button variant="primary" onClick={() => void handleUpdate()}>
              Retry Update
            </Button>
          )}
        </div>
      </ModalFrame>
    </>
  );
}
