/**
 * WorkspaceConnectModal — connect a (non-default) workspace's GitHub / Codex /
 * Opencode login via a backend-owned PTY.
 *
 * The sibling of {@link ClaudeConnectModal}, for the config-dir logins. It runs
 * the service's own login CLI under the workspace's isolated env (so creds land
 * in the workspace's config dir) and streams it into an embedded terminal. There
 * is no token to scrape, so **process exit 0 is the success signal** — at which
 * point we auto-close and refresh. A "Done" button is the manual safety net, and
 * a non-zero exit offers "Start over".
 */

import { useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { WorkspaceConnectTerminal } from './WorkspaceConnectTerminal';
import type { WorkspaceConnectService } from '../../lib/accounts';

const SERVICE_META: Record<WorkspaceConnectService, { label: string; instructions: string }> = {
  github: {
    label: 'GitHub',
    instructions:
      'A browser window will open — authorize there, then return here. This finishes on its own when you’re signed in.',
  },
  codex: {
    label: 'Codex',
    instructions:
      'A browser window will open — sign in to Codex, then return here. This finishes on its own when you’re signed in.',
  },
  opencode: {
    label: 'Opencode',
    instructions:
      'Follow the prompts in the terminal to choose a provider and sign in. This finishes on its own when you’re done.',
  },
};

export function WorkspaceConnectModal({
  accountId,
  workspaceName,
  service,
  onSuccess,
  onClose,
}: {
  accountId: string;
  workspaceName: string;
  service: WorkspaceConnectService;
  onSuccess: () => void;
  onClose: () => void;
}) {
  // A fresh session id per attempt so "Start over" spawns a new PTY.
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [exited, setExited] = useState(false);
  // Latch success so we don't also show the "didn't finish" state on exit.
  const succeededRef = useRef(false);
  const meta = SERVICE_META[service];

  const restart = () => {
    succeededRef.current = false;
    setExited(false);
    setSessionId(crypto.randomUUID());
  };

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={`Connect ${meta.label}`}
      className="agents-panel-terminal-modal"
    >
      <div className="connect-modal-terminal-phase">
        <p className="connect-modal-instructions">
          Signing in <strong>{workspaceName}</strong> to {meta.label}. {meta.instructions}
        </p>
        <div className="agents-panel-terminal-body">
          <WorkspaceConnectTerminal
            key={sessionId}
            sessionId={sessionId}
            accountId={accountId}
            service={service}
            onExit={(code) => {
              if (code === 0) {
                succeededRef.current = true;
                onSuccess();
              } else if (!succeededRef.current) {
                setExited(true);
              }
            }}
          />
        </div>
        <div className="connect-modal-actions">
          {exited ? (
            <>
              <span className="connect-modal-muted">Login didn’t finish.</span>
              <Button variant="secondary" onClick={restart}>
                Start over
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}
