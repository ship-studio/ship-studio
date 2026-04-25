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

  // Crop selection state
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const cropOverlayRef = useRef<HTMLDivElement>(null);

  // Shared helper: capture the current window and return the temp file path
  const captureWindowScreenshot = useCallback(async (): Promise<string | null> => {
    const { getScreenshotableWindows, getWindowScreenshot } =
      await import('tauri-plugin-screenshots-api');

    const windows = await getScreenshotableWindows();
    const ourWindow = windows.find(
      (w) =>
        w.title?.toLowerCase().includes('ship studio') || w.title?.toLowerCase().includes('tauri')
    );

    if (!ourWindow) {
      return null;
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
        if (!tempPath) return null;

        const rect = iframeWrapperRef.current.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // Account for macOS title bar in window screenshot
        const TITLE_BAR_HEIGHT = 31;

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
        logger.error('[Preview] Viewport capture failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!opts?.silent) {
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
    [projectPath, captureWindowScreenshot, isCapturing]
  );

  // Full-page capture using Playwright (scrolls page to trigger lazy content, then captures)
  // Uses currentPage (tracked via proxy) so it captures the actual visible page,
  // even if the user navigated via in-iframe links.
  const captureFullPage = useCallback(async (): Promise<string | null> => {
    if (isCapturing) return null;

    setIsCapturing(true);
    try {
      const captureUrl = `${baseUrl}${currentPage === '/' ? '' : currentPage}?_cb=${Date.now()}&shipstudio=1`;
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
      void trackEvent('screenshot_captured', {
        mode: 'fullpage',
        success: false,
        fell_back: true,
      });
      // Fall back to viewport capture; suppress its own tracking event.
      return captureForClaude({ silent: true });
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, projectPath, baseUrl, currentPage, captureForClaude]);

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
        if (!tempPath) return null;

        // Get the iframe's position relative to the window
        const iframeRect = iframeWrapperRef.current.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // Account for macOS title bar in window screenshot
        const TITLE_BAR_HEIGHT = 31;

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
        logger.error('[Preview] Region capture failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [projectPath, captureWindowScreenshot]
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
