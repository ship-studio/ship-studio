/**
 * Hook for managing preview screenshot capture and crop selection.
 *
 * Handles: window screenshot capture, viewport capture (captureForClaude),
 * full-page capture via Playwright, region capture, and crop selection
 * mouse/keyboard interactions.
 *
 * @module hooks/usePreviewCapture
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { useOptionalToast } from '../contexts/ToastContext';
import { isMac } from '../lib/setup';
import { setThumbnailsEnabled } from '../lib/settings';
import { isPermissionDenialError } from '../lib/thumbnailGate';
import { asCommandError, formatCommandError } from '../lib/errors';

/** Real underlying message for a capture failure (never "[object Object]"). */
const captureErrorMessage = (error: unknown): string => formatCommandError(asCommandError(error));

/**
 * A capture failure that looks like a macOS Screen Recording denial also
 * turns off background thumbnail capture, so the scary OS prompt is never
 * re-triggered on a timer. Re-enable via Settings → Project thumbnails.
 */
const stopAutoCaptureIfDenied = (error: unknown): void => {
  if (isPermissionDenialError(error)) {
    void setThumbnailsEnabled(false);
  }
};

interface UsePreviewCaptureParams {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Base URL of the preview server (e.g., "http://localhost:3000") */
  baseUrl: string;
  /** Current page route being previewed */
  currentPage: string;
  /** Whether crop selection mode is active */
  isCropMode?: boolean;
  /** Callback fired when user starts selecting a crop region */
  onCropStart?: () => void;
  /** Callback fired when crop capture completes (or fails with null) */
  onCropComplete?: (filePath: string | null) => void;
  /** Callback fired when user cancels crop mode (Escape key) */
  onCropCancel?: () => void;
}

export function usePreviewCapture({
  projectPath,
  baseUrl,
  currentPage,
  isCropMode,
  onCropStart,
  onCropComplete,
  onCropCancel,
}: UsePreviewCaptureParams) {
  const [isCapturing, setIsCapturing] = useState(false);
  const { showToast } = useOptionalToast();

  // Crop selection state
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  // The element whose on-screen rect a capture is cropped to. Normally the
  // preview's iframe wrapper; on the breakpoint canvas the preview points it at
  // the active frame, so a screenshot is of the breakpoint you're working at
  // rather than of the whole zoomed-out canvas. `getBoundingClientRect` already
  // reports the post-transform (visual) box, which is what the crop needs.
  const iframeWrapperRef = useRef<HTMLElement | null>(null);
  const cropOverlayRef = useRef<HTMLDivElement>(null);

  // Shared helper: capture the current window and return the temp file path
  const captureWindowScreenshot = useCallback(async (): Promise<string> => {
    const { getScreenshotableWindows, getWindowScreenshot } =
      await import('tauri-plugin-screenshots-api');

    const windows = await getScreenshotableWindows();
    const ourWindow = windows.find(
      (w) =>
        w.title?.toLowerCase().includes('ship studio') || w.title?.toLowerCase().includes('tauri')
    );

    if (!ourWindow) {
      // macOS omits window titles from the capturable-windows list when Screen
      // Recording permission is denied, so "our window is missing" is the
      // denial signature there. Throw the real reason instead of silently
      // returning null (the message doubles as the denial-detection signal).
      throw new Error(
        isMac()
          ? "Ship Studio's window isn't visible to macOS screen capture — Screen Recording " +
              'permission was likely denied. Allow Ship Studio in System Settings → ' +
              'Privacy & Security → Screen Recording, then try again.'
          : "Ship Studio's window wasn't found in the list of capturable windows."
      );
    }

    return await getWindowScreenshot(ourWindow.id);
  }, []);

  // Capture viewport screenshot by capturing the window and cropping to iframe bounds
  // This captures what's actually visible on screen (including any navigation the user did in the iframe)
  const captureForClaude = useCallback(
    // `silent` suppresses tracking when this is called from `captureFullPage`
    // as a fallback — the user's intent was a fullpage capture, the
    // `screenshot_captured` event for that intent already fired.
    async (opts?: { silent?: boolean }): Promise<string | null> => {
      if (isCapturing) {
        return null;
      }

      setIsCapturing(true);
      try {
        if (!iframeWrapperRef.current) return null;

        const tempPath = await captureWindowScreenshot();

        const rect = iframeWrapperRef.current.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // Account for the macOS overlay title bar in the window screenshot. Only
        // macOS uses an overlay title bar (`TitleBarStyle::Overlay`); Windows/Linux
        // use native decorations outside the captured webview, so no offset.
        // NOTE: the non-mac path is unverified on a real Windows capture.
        const TITLE_BAR_HEIGHT = isMac() ? 31 : 0;

        const finalPath = await invoke<string>('crop_and_save_screenshot', {
          projectPath,
          sourcePath: tempPath,
          x: Math.round(rect.left * dpr),
          y: Math.round((rect.top + TITLE_BAR_HEIGHT) * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
        });
        if (!opts?.silent) {
          void trackEvent('screenshot_captured', {
            mode: 'viewport',
            success: true,
            fell_back: false,
          });
        }
        return finalPath;
      } catch (error) {
        const message = captureErrorMessage(error);
        logger.error('[Preview] Viewport capture failed', { error: message });
        stopAutoCaptureIfDenied(error);
        if (!opts?.silent) {
          // Surface the real underlying error — "couldn't capture" alone is
          // undebuggable (and hides a denied Screen Recording permission).
          showToast(`Couldn't capture the preview: ${message}`, 'error');
          void trackEvent('screenshot_captured', {
            mode: 'viewport',
            success: false,
            fell_back: false,
          });
        }
        return null;
      } finally {
        setIsCapturing(false);
      }
    },
    [projectPath, captureWindowScreenshot, isCapturing, showToast]
  );

  // Full-page capture using Playwright (scrolls page to trigger lazy content, then captures)
  // Uses currentPage (tracked via proxy) so it captures the actual visible page,
  // even if the user navigated via in-iframe links.
  const captureFullPage = useCallback(async (): Promise<string | null> => {
    if (isCapturing) return null;

    setIsCapturing(true);
    try {
      const captureUrl = `${baseUrl}${currentPage === '/' ? '' : currentPage}`;
      const filePath = await invoke<string>('capture_fullpage_playwright', {
        projectPath,
        url: captureUrl,
      });
      void trackEvent('screenshot_captured', {
        mode: 'fullpage',
        success: true,
        fell_back: false,
      });
      return filePath;
    } catch (error) {
      logger.error('[Preview] Full page capture failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't fall back silently — the user asked for a full-page capture and
      // is about to receive a viewport-only image instead.
      showToast("Full-page capture isn't available — captured the visible area instead.", 'error');
      // Fall back to viewport capture; suppress its own tracking event so this
      // single fullpage event carries the whole story (including whether the
      // fallback actually produced a file).
      const fallbackPath = await captureForClaude({ silent: true });
      void trackEvent('screenshot_captured', {
        mode: 'fullpage',
        success: false,
        fell_back: true,
        fallback_success: fallbackPath !== null,
      });
      return fallbackPath;
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, projectPath, baseUrl, currentPage, captureForClaude, showToast]);

  // Capture a specific region of the preview
  const captureRegion = useCallback(
    async (
      regionX: number,
      regionY: number,
      regionWidth: number,
      regionHeight: number
    ): Promise<string | null> => {
      if (!iframeWrapperRef.current) {
        return null;
      }

      try {
        const tempPath = await captureWindowScreenshot();

        // Get the iframe's position relative to the window
        const iframeRect = iframeWrapperRef.current.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // Account for the macOS overlay title bar in the window screenshot. Only
        // macOS uses an overlay title bar (`TitleBarStyle::Overlay`); Windows/Linux
        // use native decorations outside the captured webview, so no offset.
        // NOTE: the non-mac path is unverified on a real Windows capture.
        const TITLE_BAR_HEIGHT = isMac() ? 31 : 0;

        // Calculate absolute position of the selection within the window
        const absoluteX = Math.round((iframeRect.left + regionX) * dpr);
        const absoluteY = Math.round((iframeRect.top + regionY + TITLE_BAR_HEIGHT) * dpr);
        const width = Math.round(regionWidth * dpr);
        const height = Math.round(regionHeight * dpr);

        // Crop to selection bounds and save
        const finalPath = await invoke<string>('crop_and_save_screenshot', {
          projectPath,
          sourcePath: tempPath,
          x: absoluteX,
          y: absoluteY,
          width,
          height,
        });

        return finalPath;
      } catch (error) {
        const message = captureErrorMessage(error);
        logger.error('[Preview] Region capture failed', { error: message });
        stopAutoCaptureIfDenied(error);
        showToast(`Couldn't capture the selection: ${message}`, 'error');
        return null;
      }
    },
    [projectPath, captureWindowScreenshot, showToast]
  );

  // Handle crop selection mouse events
  const handleCropMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cropOverlayRef.current) return;
    const rect = cropOverlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setSelectionStart({ x, y });
    setSelectionEnd({ x, y });
    setIsSelecting(true);
  }, []);

  const cropRafRef = useRef<number | null>(null);
  const handleCropMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelecting || !cropOverlayRef.current) return;
      if (cropRafRef.current !== null) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      cropRafRef.current = requestAnimationFrame(() => {
        cropRafRef.current = null;
        if (!cropOverlayRef.current) return;
        const rect = cropOverlayRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        const y = Math.max(0, Math.min(clientY - rect.top, rect.height));
        setSelectionEnd({ x, y });
      });
    },
    [isSelecting]
  );

  const handleCropMouseUp = useCallback(async () => {
    if (!isSelecting || !selectionStart || !selectionEnd) return;
    setIsSelecting(false);

    // Calculate selection bounds
    const x = Math.min(selectionStart.x, selectionEnd.x);
    const y = Math.min(selectionStart.y, selectionEnd.y);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);

    // Minimum selection size
    if (width < 10 || height < 10) {
      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    // Store bounds before resetting state
    const bounds = { x, y, width, height };

    // Reset selection state and notify parent immediately (hides overlay, shows loading)
    setSelectionStart(null);
    setSelectionEnd(null);
    onCropStart?.();

    // Capture the selected region
    const filePath = await captureRegion(bounds.x, bounds.y, bounds.width, bounds.height);

    // Notify parent with the result
    onCropComplete?.(filePath);
  }, [isSelecting, selectionStart, selectionEnd, captureRegion, onCropStart, onCropComplete]);

  // Handle escape key to cancel crop mode
  useEffect(() => {
    if (!isCropMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectionStart(null);
        setSelectionEnd(null);
        setIsSelecting(false);
        onCropCancel?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCropMode, onCropCancel]);

  // Reset selection when crop mode changes
  useEffect(() => {
    if (!isCropMode) {
      setSelectionStart(null);
      setSelectionEnd(null);
      setIsSelecting(false);
    }
  }, [isCropMode]);

  return {
    isCapturing,
    captureForClaude,
    captureFullPage,
    selectionStart,
    selectionEnd,
    isSelecting,
    iframeWrapperRef,
    cropOverlayRef,
    handleCropMouseDown,
    handleCropMouseMove,
    handleCropMouseUp,
  };
}
