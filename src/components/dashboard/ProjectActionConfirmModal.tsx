import type { ReactNode } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';

interface ProjectActionConfirmModalProps {
  title: string;
  body: ReactNode;
  hint: string;
  loading: boolean;
  confirmLabel: string;
  loadingLabel: string;
  confirmVariant: 'primary' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
}

/** Shared confirmation dialog for project and folder actions. */
export function ProjectActionConfirmModal({
  title,
  body,
  hint,
  loading,
  confirmLabel,
  loadingLabel,
  confirmVariant,
  onCancel,
  onConfirm,
}: ProjectActionConfirmModalProps) {
  return (
    <ModalFrame isOpen onClose={onCancel} title={title} showCloseButton={false}>
      <div style={{ padding: 'var(--spacing-xl)' }}>
        <p>{body}</p>
        <p className="hint">{hint}</p>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={loading}>
            {loading ? loadingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
