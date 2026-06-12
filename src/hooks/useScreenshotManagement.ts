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
  devServerPort: number;
  pasteToActiveTerminal: (text: string) => void;
  currentProjectPathRef: RefObject<string | null>;
}

export function useScreenshotManagement({
  previewRef,
  devServerPort,
  pasteToActiveTerminal,
  currentProjectPathRef,
}: UseScreenshotManagementParams) {
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
      try {
        logger.info('[Thumbnail] Capturing now', {
          projectPath,
          port: devServerPort,
          attempt,
          sessionId,
        });
        await invoke('capture_project_thumbnail', {
          projectPath,
          url: `http://localhost:${devServerPort}`,
        });
        logger.info('Thumbnail captured successfully', { projectPath, attempt });
      } catch (error) {
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
    [devServerPort, previewRef, currentProjectPathRef]
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

    // Interval management (for handleSelectProject / handleBackToProjects)
    startScreenshotInterval,
    clearScreenshotInterval,
  };
}
