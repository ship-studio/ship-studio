/**
 * Hook for managing screenshot capture state and handlers.
 *
 * Encapsulates: viewport capture, full-page capture, crop mode,
 * screenshot preview, periodic thumbnail capture, and retry logic.
 */

import { useState, useRef, useCallback, useEffect, type RefObject } from 'react';
import type { PreviewHandle } from '../components/preview/Preview';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { getThumbnailsEnabled, setThumbnailsEnabled } from '../lib/settings';
import { decideAutoCapture, isPermissionDenialError } from '../lib/thumbnailGate';
import { asCommandError, formatCommandError } from '../lib/errors';
import { captureThumbnailFromPreview } from '../lib/previewSnapshot';

/** Backend rejection meaning the project's root directory no longer exists
 *  (deleted, renamed, or moved while its session stayed hot). Permanent for
 *  this path — retrying can never succeed. */
function isProjectGoneError(error: unknown): boolean {
  return formatCommandError(asCommandError(error)).includes(
    'Invalid path in validate_project_path'
  );
}

/** Backend rejection meaning a capture for this project is already running
 *  (the backend's per-project in-flight guard, issue #387). Not a failure —
 *  the periodic timer will try again; retrying immediately would just keep
 *  bouncing off the guard and end in a logged "failed after retries". */
function isCaptureInFlightError(error: unknown): boolean {
  return formatCommandError(asCommandError(error)).includes('already in progress');
}

/** Delay after page load before capturing screenshot (8 seconds to allow Next.js/Vite to fully compile) */
const SCREENSHOT_DELAY_MS = 8000;
/** Maximum number of retry attempts for thumbnail capture */
const SCREENSHOT_MAX_RETRIES = 5;
/** Delay between retry attempts (3 seconds) */
const SCREENSHOT_RETRY_DELAY_MS = 3000;
/** Interval between automatic screenshot captures (5 minutes) */
const SCREENSHOT_INTERVAL_MS = 5 * 60 * 1000;

interface UseScreenshotManagementParams {
  previewRef: RefObject<PreviewHandle | null>;
  /** The current project's dev-server port, or null when no port is
   *  affirmatively known for it. Capture writes into the project's own
   *  `.shipstudio/thumbnail.png`, so a guessed/fallback port here would
   *  screenshot whatever server happens to answer it — possibly another
   *  project's — and file it under the wrong project. Null skips capture. */
  devServerPort: number | null;
  pasteToActiveTerminal: (text: string) => void;
  currentProjectPathRef: RefObject<string | null>;
}

export function useScreenshotManagement({
  previewRef,
  devServerPort,
  pasteToActiveTerminal,
  currentProjectPathRef,
}: UseScreenshotManagementParams) {
  // Read the port through a ref at capture time. The 5-minute interval and
  // its retry timers hold long-lived closures — a closed-over port would go
  // stale the moment the server moves, and the stale port may belong to a
  // different project by then.
  const devServerPortRef = useRef(devServerPort);
  devServerPortRef.current = devServerPort;
  // Capture state
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCropMode, setIsCropMode] = useState(false);
  const [isCropCapturing, setIsCropCapturing] = useState(false);
  const [isFullPageCapturing, setIsFullPageCapturing] = useState(false);

  // Screenshot preview state
  const [screenshotPreviewPath, setScreenshotPreviewPath] = useState<string | null>(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);

  // Refs for periodic capture and session tracking
  const screenshotIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureSessionIdRef = useRef<number>(0);

  // First-run consent for auto-capture (#160). The macOS "record screen
  // content" prompt must never appear without context, so the first automatic
  // capture is deferred behind an in-app explainer. Manual captures (camera
  // button, crop) are intentionally NOT gated — a user clicking the camera has
  // clear intent, and that click is an obvious cause for the OS prompt.
  const [showThumbnailConsent, setShowThumbnailConsent] = useState(false);
  const pendingConsentCaptureRef = useRef<{ projectPath: string; sessionId: number } | null>(null);
  // Dismissing the explainer without answering (ESC / overlay click) defers
  // the question for this session instead of nagging every 5 minutes.
  const consentDeferredThisSessionRef = useRef(false);

  // Capture viewport screenshot and paste path into terminal
  const handleCaptureScreenshot = useCallback(async () => {
    if (isCapturing || !previewRef.current) return;

    setIsCapturing(true);
    try {
      const filePath = await previewRef.current.captureForClaude();
      if (filePath) {
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        pasteToActiveTerminal(quotedPath);
        setScreenshotPreviewPath(filePath);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, previewRef, pasteToActiveTerminal]);

  // Capture full page screenshot
  const handleCaptureFullPage = useCallback(async () => {
    if (isFullPageCapturing || !previewRef.current) return;

    setIsFullPageCapturing(true);
    try {
      const filePath = await previewRef.current.captureFullPage();
      if (filePath) {
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        pasteToActiveTerminal(quotedPath);
        setScreenshotPreviewPath(filePath);
      }
    } finally {
      setIsFullPageCapturing(false);
    }
  }, [isFullPageCapturing, previewRef, pasteToActiveTerminal]);

  // Crop mode handlers
  const handleCropStart = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(true);
  }, []);

  const handleCropComplete = useCallback(
    (filePath: string | null) => {
      setIsCropCapturing(false);
      if (filePath) {
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        pasteToActiveTerminal(quotedPath);
        setScreenshotPreviewPath(filePath);
      }
    },
    [pasteToActiveTerminal]
  );

  const handleCropCancel = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(false);
  }, []);

  // Background thumbnail capture with retry logic
  const captureScreenshot = useCallback(
    async (projectPath: string, sessionId: number, attempt: number = 1) => {
      if (captureSessionIdRef.current !== sessionId) {
        logger.info('[Thumbnail] Skipping - session cancelled (project changed)', {
          expectedSession: sessionId,
          currentSession: captureSessionIdRef.current,
        });
        return;
      }
      if (!previewRef.current?.isServerReady()) {
        logger.info('[Thumbnail] Skipping - dev server not ready');
        return;
      }
      if (currentProjectPathRef.current !== projectPath) {
        logger.info('[Thumbnail] Skipping - project mismatch', {
          expected: projectPath,
          current: currentProjectPathRef.current,
        });
        return;
      }
      const port = devServerPortRef.current;
      if (port === null) {
        logger.info('[Thumbnail] Skipping - no port affirmatively known for project', {
          projectPath,
        });
        return;
      }
      const decision = decideAutoCapture(await getThumbnailsEnabled());
      if (decision === 'skip') {
        logger.info('[Thumbnail] Skipping - thumbnails disabled in Settings');
        return;
      }
      if (decision === 'ask') {
        if (!consentDeferredThisSessionRef.current) {
          logger.info('[Thumbnail] Deferring - asking for thumbnail consent first');
          pendingConsentCaptureRef.current = { projectPath, sessionId };
          setShowThumbnailConsent(true);
        }
        return;
      }
      // Preferred path: snapshot the preview straight out of the app's own
      // webview — no headless browser, none of its failure modes. Falls
      // through to the headless path when unavailable (non-macOS, preview
      // hidden/covered, backend error). Never throws.
      if (await captureThumbnailFromPreview(projectPath)) {
        logger.info('[Thumbnail] Captured via native webview snapshot', {
          projectPath,
          attempt,
        });
        return;
      }
      try {
        logger.info('[Thumbnail] Capturing now', {
          projectPath,
          port,
          attempt,
          sessionId,
        });
        await invoke('capture_project_thumbnail', {
          projectPath,
          url: `http://localhost:${port}`,
        });
        logger.info('Thumbnail captured successfully', { projectPath, attempt });
      } catch (error) {
        if (isCaptureInFlightError(error)) {
          logger.info('[Thumbnail] Skipping - a capture for this project is already in progress');
          return;
        }
        if (isPermissionDenialError(error)) {
          // Denied at the OS level. Persist the opt-out so background capture
          // never re-triggers the macOS prompt; re-enable via Settings →
          // Project thumbnails (after allowing Ship Studio in System Settings
          // → Privacy & Security → Screen Recording).
          logger.error('[Thumbnail] Permission denied - disabling auto-capture', { error });
          void setThumbnailsEnabled(false);
          return;
        }
        if (isProjectGoneError(error)) {
          // The project's folder vanished while its session stayed hot —
          // retrying can't succeed, and the 5-minute interval would re-burn
          // 5 attempts forever with no user-facing signal (issue #300).
          // Cancel the session and stop the schedule for this project;
          // reopening it goes through the dashboard's missing-folder
          // recovery (#266).
          logger.warn('[Thumbnail] Project folder no longer exists — stopping auto-capture', {
            projectPath,
          });
          captureSessionIdRef.current++;
          if (screenshotIntervalRef.current) {
            clearInterval(screenshotIntervalRef.current);
            screenshotIntervalRef.current = null;
          }
          return;
        }
        if (captureSessionIdRef.current !== sessionId) {
          logger.info('[Thumbnail] Skipping retry - session cancelled');
          return;
        }
        if (attempt < SCREENSHOT_MAX_RETRIES) {
          logger.info('[Thumbnail] Capture failed, will retry', {
            error,
            attempt,
            maxRetries: SCREENSHOT_MAX_RETRIES,
            retryInMs: SCREENSHOT_RETRY_DELAY_MS,
          });
          setTimeout(() => {
            void captureScreenshot(projectPath, sessionId, attempt + 1);
          }, SCREENSHOT_RETRY_DELAY_MS);
        } else {
          logger.error('Failed to capture thumbnail after retries', {
            error,
            attempts: attempt,
          });
        }
      }
    },
    [previewRef, currentProjectPathRef]
  );

  // Called when preview server signals it's ready
  const handlePreviewReady = useCallback(
    (projectPath: string) => {
      const sessionId = ++captureSessionIdRef.current;
      logger.info('[Thumbnail] Preview ready, scheduling capture', {
        projectPath,
        sessionId,
        delayMs: SCREENSHOT_DELAY_MS,
      });
      setTimeout(() => {
        void captureScreenshot(projectPath, sessionId);
      }, SCREENSHOT_DELAY_MS);
    },
    [captureScreenshot]
  );

  // User answered the thumbnail explainer. Persist the choice, then run the
  // deferred capture on "Allow" (its session guards handle project changes).
  const resolveThumbnailConsent = useCallback(
    async (allowed: boolean) => {
      setShowThumbnailConsent(false);
      const pending = pendingConsentCaptureRef.current;
      pendingConsentCaptureRef.current = null;
      // Persist before capturing — captureScreenshot re-reads the consent.
      await setThumbnailsEnabled(allowed);
      void trackEvent('thumbnail_consent_answered', { allowed });
      if (allowed && pending) {
        void captureScreenshot(pending.projectPath, pending.sessionId);
      }
    },
    [captureScreenshot]
  );

  // Explainer dismissed without an answer: don't persist anything, just stop
  // asking until the next launch (auto-capture stays deferred meanwhile).
  const dismissThumbnailConsent = useCallback(() => {
    setShowThumbnailConsent(false);
    pendingConsentCaptureRef.current = null;
    consentDeferredThisSessionRef.current = true;
  }, []);

  // Start periodic screenshot interval for a project
  const startScreenshotInterval = useCallback(
    (projectPath: string) => {
      if (screenshotIntervalRef.current) {
        clearInterval(screenshotIntervalRef.current);
      }
      screenshotIntervalRef.current = setInterval(() => {
        if (currentProjectPathRef.current === projectPath) {
          void captureScreenshot(projectPath, captureSessionIdRef.current);
        }
      }, SCREENSHOT_INTERVAL_MS);
    },
    [captureScreenshot, currentProjectPathRef]
  );

  // Clear screenshot interval and cancel pending captures
  const clearScreenshotInterval = useCallback(() => {
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }
    captureSessionIdRef.current++;
  }, []);

  // Pause screenshot interval when window is backgrounded, resume when visible
  const pausedProjectPathRef = useRef<string | null>(null);
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Pause: remember which project was being captured, then clear
        if (screenshotIntervalRef.current) {
          pausedProjectPathRef.current = currentProjectPathRef.current;
          clearInterval(screenshotIntervalRef.current);
          screenshotIntervalRef.current = null;
        }
      } else {
        // Resume: restart interval if we had one paused
        const projectPath = pausedProjectPathRef.current;
        if (projectPath && currentProjectPathRef.current === projectPath) {
          pausedProjectPathRef.current = null;
          screenshotIntervalRef.current = setInterval(() => {
            if (currentProjectPathRef.current === projectPath) {
              void captureScreenshot(projectPath, captureSessionIdRef.current);
            }
          }, SCREENSHOT_INTERVAL_MS);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [captureScreenshot, currentProjectPathRef]);

  return {
    // State
    isCapturing,
    isCropMode,
    setIsCropMode,
    isCropCapturing,
    isFullPageCapturing,
    screenshotPreviewPath,
    setScreenshotPreviewPath,
    showScreenshotModal,
    setShowScreenshotModal,

    // Handlers
    handleCaptureScreenshot,
    handleCaptureFullPage,
    handleCropStart,
    handleCropComplete,
    handleCropCancel,
    handlePreviewReady,

    // First-run consent for auto-capture (#160)
    showThumbnailConsent,
    resolveThumbnailConsent,
    dismissThumbnailConsent,

    // Interval management (for handleSelectProject / handleBackToProjects)
    startScreenshotInterval,
    clearScreenshotInterval,
  };
}
