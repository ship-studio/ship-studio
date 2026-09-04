/**
 * Shared toast list — the single rendering of the app's toast notifications.
 *
 * Previously duplicated inline in App.tsx (twice) and WorkspaceModals.tsx.
 * Error toasts persist until dismissed (see useToasts) and carry a Copy
 * button so the full error text can be pasted into Slack/a bug report
 * instead of screenshotted.
 */

import { createPortal } from 'react-dom';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { SuccessIcon, InfoIcon, CloseIcon, CopyIcon } from '@/components/icons';
import type { Toast } from '../../hooks/useToasts';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { MODAL_INERT_EXEMPT_ATTR } from './ModalFrame';

interface ToastListProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  // Per-toast hook so each error toast gets its own "Copied" flag.
  const { copy, isCopied } = useCopyToClipboard();

  return (
    <div className={`toast toast-${toast.type}`}>
      <span className="toast-icon">
        {toast.type === 'success' ? <SuccessIcon size={16} /> : <InfoIcon size={16} />}
      </span>
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      {toast.type === 'error' && (
        <Button
          variant="ghost"
          size="compact"
          onClick={() => void copy(toast.message)}
          title="Copy the full error text"
          leftIcon={<CopyIcon size={12} />}
        >
          {isCopied ? 'Copied' : 'Copy'}
        </Button>
      )}
      <IconButton
        variant="ghost"
        size="compact"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        icon={<CloseIcon size={14} />}
      />
    </div>
  );
}

/**
 * Toasts render into a body-level host instead of inline, because ModalFrame
 * marks every other body child `inert` while a dialog is open — inline toasts
 * would be aria-hidden and their Copy/Dismiss buttons unclickable. The host
 * opts out of that sweep; the container is `position: fixed` either way, so
 * nothing moves visually.
 */
function ensureToastRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const existing = document.querySelector<HTMLElement>('[data-toast-root]');
  if (existing?.isConnected) return existing;

  const host = document.createElement('div');
  host.dataset.toastRoot = 'true';
  host.setAttribute(MODAL_INERT_EXEMPT_ATTR, '');
  document.body.appendChild(host);
  return host;
}

export function ToastList({ toasts, onDismiss }: ToastListProps) {
  if (toasts.length === 0) return null;
  const host = ensureToastRoot();
  if (!host) return null;

  return createPortal(
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    host
  );
}
