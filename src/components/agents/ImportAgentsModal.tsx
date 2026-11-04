/**
 * Import an agent setup from another assistant.
 *
 * Only the other assistant knows its own agents, instructions and memory, so
 * the import runs from its side: it calls Ship Studio's `import_agents` tool
 * over the remote access connector it already uses. This screen hands the
 * user the one message to send it, and gets the connector set up if it isn't.
 *
 * @module components/agents/ImportAgentsModal
 */

import { useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOpenModal } from '../../contexts/ModalContext';
import { getImportPrompt } from '../../lib/agents';

interface ImportAgentsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ImportAgentsModal({ isOpen, onClose }: ImportAgentsModalProps) {
  const [prompt, setPrompt] = useState('');
  const openModal = useOpenModal();
  const { copy, isCopied } = useCopyToClipboard();

  useEffect(() => {
    if (isOpen)
      void getImportPrompt()
        .then(setPrompt)
        .catch(() => setPrompt(''));
  }, [isOpen]);

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title="Import your agents"
      className="agents-import"
    >
      <div className="agents-import__body">
        <p>
          Bring over the agents you already have in Grok Bot, or in any assistant connected to Ship
          Studio. They arrive with their instructions and what they remember, and then run on Claude
          Code on this Mac.
        </p>
        <ol className="agents-import__steps">
          <li>
            <div className="agents-import__step">
              <span>Connect it to Ship Studio, if you haven&apos;t already.</span>
              <Button variant="secondary" size="compact" onClick={() => openModal('remoteAccess')}>
                Remote access…
              </Button>
            </div>
          </li>
          <li>Send it this message:</li>
        </ol>
        <blockquote className="agents-import__prompt">{prompt}</blockquote>
        <p className="agents-import__note">
          Your agents show up here as soon as it&apos;s done. Running it again updates them rather
          than making copies. Connections that assistant has (its email, calendar and so on)
          don&apos;t come across: here, agents use what this computer and Claude Code are connected
          to.
        </p>
        <div className="agents-import__actions">
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" onClick={() => void copy(prompt)} disabled={!prompt}>
            {isCopied ? 'Copied' : 'Copy message'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
