import { useEffect, useRef, type ReactNode, type MouseEvent } from 'react';

interface ModalFrameProps {
  isOpen: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** If false, disables overlay click + ESC dismissal (for in-flight destructive ops). */
  dismissable?: boolean;
  /** Optional class appended to the content container for width/tone overrides. */
  className?: string;
  /** Render a close "×" in the header. Ignored when no title is provided. */
  showCloseButton?: boolean;
  /** aria-label for accessible dismissal. */
  ariaLabel?: string;
}

export function ModalFrame({
  isOpen,
  onClose,
  title,
  children,
  dismissable = true,
  className,
  showCloseButton = true,
  ariaLabel,
}: ModalFrameProps) {
  useEffect(() => {
    if (!isOpen || !dismissable) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, dismissable, onClose]);

  // Only dismiss when the press STARTED on the overlay. A click fires on the
  // overlay when a text-selection drag begins inside the modal and the mouse
  // releases outside it — closing then would throw away unsaved input.
  const pressBeganOnOverlay = useRef(false);

  if (!isOpen) return null;

  const handleOverlayMouseDown = (e: MouseEvent) => {
    pressBeganOnOverlay.current = e.target === e.currentTarget;
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (dismissable && pressBeganOnOverlay.current && e.target === e.currentTarget) onClose();
    pressBeganOnOverlay.current = false;
  };

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className="modal-frame-overlay"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
    >
      <div className={`modal-frame-content${className ? ` ${className}` : ''}`} onClick={stop}>
        {title !== undefined && (
          <div className="modal-frame-header">
            <div className="modal-frame-title">{title}</div>
            {showCloseButton && (
              <button
                type="button"
                className="modal-frame-close"
                onClick={onClose}
                title="Close dialog"
                aria-label="Close dialog"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
