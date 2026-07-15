/**
 * ThumbnailConsentModal - first-run explainer shown before the first automatic
 * project-thumbnail capture (#160).
 *
 * macOS surfaces window screenshots as a "record audio and screen content"
 * permission prompt, which is alarming with zero context. This modal explains
 * what the capture is (a single local image of Ship Studio's own window) and
 * lets the user opt in or out BEFORE the OS prompt can appear. Manual
 * screenshot-button captures are intentionally not gated by this modal.
 *
 * @module components/preview/ThumbnailConsentModal
 */

import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';

interface ThumbnailConsentModalProps {
  isOpen: boolean;
  /** "Allow thumbnails" — persists opt-in and runs the deferred capture. */
  onAllow: () => void;
  /** "No thumbnails" — persists opt-out; auto-capture never runs. */
  onDeny: () => void;
  /** ESC / overlay click — no persisted answer, ask again next launch. */
  onDismiss: () => void;
}

export function ThumbnailConsentModal({
  isOpen,
  onAllow,
  onDeny,
  onDismiss,
}: ThumbnailConsentModalProps) {
  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onDismiss}
      title="Preview thumbnails"
      className="thumbnail-consent-modal"
    >
      <div className="thumbnail-consent-body">
        <p>
          Ship Studio takes a screenshot of its own preview window to show a thumbnail for each
          project on your dashboard.
        </p>
        <p>
          macOS calls this &ldquo;recording screen content&rdquo;, so it may ask for permission.
          Nothing is recorded or sent anywhere &mdash; it&rsquo;s a single image of Ship
          Studio&rsquo;s own window, saved locally inside your project.
        </p>
        <div className="thumbnail-consent-actions">
          <Button variant="ghost" onClick={onDeny}>
            No thumbnails
          </Button>
          <Button variant="primary" onClick={onAllow}>
            Allow thumbnails
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
