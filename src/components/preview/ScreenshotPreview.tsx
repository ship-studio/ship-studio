/**
 * Screenshot preview components for showing captured screenshots.
 *
 * Provides:
 * - ScreenshotToast: A toast notification with thumbnail that appears after capture
 * - ScreenshotPreviewModal: A modal to view the full screenshot
 *
 * @module components/ScreenshotPreview
 */

import { useEffect, useState } from 'react';
import { getScreenshotBase64 } from '../../lib/ide';
import { CameraIcon, CloseIcon } from '../icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { logger } from '../../lib/logger';

/** Duration to show the toast before auto-dismiss (ms) */
const TOAST_DURATION_MS = 5000;

interface ScreenshotToastProps {
  /** Path to the screenshot file */
  filePath: string;
  /** Callback when toast is dismissed (auto or manual) */
  onDismiss: () => void;
  /** Callback when user clicks to view full preview */
  onViewFull: () => void;
}

/**
 * Toast notification that shows a thumbnail of the captured screenshot.
 * Auto-dismisses after TOAST_DURATION_MS, or can be clicked to view full preview.
 */
export function ScreenshotToast({ filePath, onDismiss, onViewFull }: ScreenshotToastProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  // Load image as base64 on mount
  useEffect(() => {
    getScreenshotBase64(filePath)
      .then(setImageSrc)
      .catch((err) =>
        logger.error('Failed to load screenshot', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
  }, [filePath]);

  // Auto-dismiss after timeout
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(onDismiss, 300); // Wait for fade animation
    }, TOAST_DURATION_MS);

    return () => clearTimeout(timer);
  }, [onDismiss]);

  const handleClick = () => {
    onViewFull();
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsVisible(false);
    setTimeout(onDismiss, 300);
  };

  return (
    <div
      className={`screenshot-toast ${isVisible ? 'visible' : 'hiding'}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick();
        }
      }}
    >
      <div className="screenshot-toast-thumbnail">
        {imageSrc ? (
          <img src={imageSrc} alt="Screenshot preview" />
        ) : (
          <div className="screenshot-toast-loading" />
        )}
      </div>
      <div className="screenshot-toast-content">
        <div className="screenshot-toast-title">
          <CameraIcon size={14} />
          <span>Screenshot captured</span>
        </div>
        <div className="screenshot-toast-hint">Click to preview</div>
      </div>
      <button className="screenshot-toast-close" onClick={handleClose} title="Dismiss">
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

interface ScreenshotPreviewModalProps {
  /** Path to the screenshot file */
  filePath: string;
  /** Callback when modal is closed */
  onClose: () => void;
}

/**
 * Modal that displays the full screenshot for detailed viewing.
 */
export function ScreenshotPreviewModal({ filePath, onClose }: ScreenshotPreviewModalProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  // Load image as base64 on mount
  useEffect(() => {
    getScreenshotBase64(filePath)
      .then(setImageSrc)
      .catch((err) =>
        logger.error('Failed to load screenshot', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
  }, [filePath]);

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title="Screenshot Preview"
      className="screenshot-preview-modal"
    >
      <div className="screenshot-preview-content">
        {imageSrc ? (
          <img src={imageSrc} alt="Full screenshot" />
        ) : (
          <div className="screenshot-modal-loading">Loading...</div>
        )}
      </div>
      <div className="screenshot-preview-footer">
        <span className="screenshot-preview-path">{filePath.split('/').pop()}</span>
      </div>
    </ModalFrame>
  );
}
