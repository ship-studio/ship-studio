import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';

interface QuitConfirmModalProps {
  onCancel: () => void;
  onQuit: () => void;
}

/**
 * Cmd+Q confirmation. Rendered by every top-level view branch in App.tsx, so
 * it lives at the component root alongside the other app-global chrome.
 */
export function QuitConfirmModal({ onCancel, onQuit }: QuitConfirmModalProps) {
  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      ariaLabel="Quit Ship Studio"
      showCloseButton={false}
      className="quit-confirm-modal"
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter') onQuit();
        }}
      >
        <p>Are you sure you want to quit Ship Studio?</p>
        <div className="quit-confirm-actions">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onQuit} autoFocus>
            Quit
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
