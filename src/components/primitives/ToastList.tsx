/**
 * Shared toast list — the single rendering of the app's toast notifications.
 *
 * Previously duplicated inline in App.tsx (twice) and WorkspaceModals.tsx.
 * Error toasts persist until dismissed (see useToasts) and carry a Copy
 * button so the full error text can be pasted into Slack/a bug report
 * instead of screenshotted.
 */

import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { SuccessIcon, InfoIcon, CloseIcon, CopyIcon } from '../icons';
import type { Toast } from '../../hooks/useToasts';

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
      {toast.type === 'error' && (
        <button
          className="toast-copy"
          onClick={() => void copy(toast.message)}
          title="Copy the full error text"
        >
          <CopyIcon size={12} />
          {isCopied ? 'Copied' : 'Copy'}
        </button>
      )}
      <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

export function ToastList({ toasts, onDismiss }: ToastListProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
