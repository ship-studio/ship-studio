import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { useAsyncState } from '../hooks/useAsyncState';
import { getRemoteAccessBrief } from '../lib/remoteAccess';
import { quitPrompt, type QuitCheck } from '../lib/agentsDesktop';

interface QuitConfirmModalProps {
  onCancel: () => void;
  onQuit: () => void;
  /** What a quit would interrupt; null while unknown (the plain question shows). */
  check?: QuitCheck | null;
  /** macOS: windows can hide while Ship Studio keeps running. */
  backgroundAvailable?: boolean;
  onKeepRunning?: () => void;
}

/**
 * ⌘Q (and the menu bar's Quit) confirmation. Rendered by every top-level view
 * branch in App.tsx, so it lives at the component root alongside the other
 * app-global chrome.
 *
 * With agents working or waiting on an approval it becomes the quit guard:
 * it names who would be stopped, and the safe choice is the default. Laid
 * out as a macOS alert with three choices is: stacked, default first, Cancel
 * last.
 */
export function QuitConfirmModal({
  onCancel,
  onQuit,
  check = null,
  backgroundAvailable = false,
  onKeepRunning,
}: QuitConfirmModalProps) {
  // Someone may be relying on this computer from their phone. Quitting is the
  // one thing that silently cuts them off, so say so here, where it's decided.
  const remote = useAsyncState(getRemoteAccessBrief, { immediate: true });
  const remoteOn = remote.data?.enabled === true;
  const prompt = quitPrompt(check, {
    backgroundAvailable: backgroundAvailable && onKeepRunning !== undefined,
  });
  const remoteLine = remoteOn && (
    <p className="quit-confirm-remote">
      Remote access is on. Quitting stops your assistant reaching this computer until Ship Studio is
      open again.
    </p>
  );

  if (prompt) {
    return (
      <ModalFrame
        isOpen
        onClose={onCancel}
        ariaLabel={prompt.title}
        showCloseButton={false}
        className="quit-confirm-modal quit-confirm-modal--guard"
      >
        <p className="quit-confirm-title">{prompt.title}</p>
        <p className="quit-confirm-body">{prompt.body}</p>
        {remoteLine}
        <div className="quit-confirm-actions quit-confirm-actions--stacked">
          {prompt.offerBackground && (
            <Button variant="primary" width="fill" onClick={onKeepRunning} autoFocus>
              Keep running in background
            </Button>
          )}
          <Button variant="danger" width="fill" onClick={onQuit}>
            Quit
          </Button>
          <Button
            variant="secondary"
            width="fill"
            onClick={onCancel}
            autoFocus={!prompt.offerBackground}
          >
            Cancel
          </Button>
        </div>
      </ModalFrame>
    );
  }

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
        {remoteLine}
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
