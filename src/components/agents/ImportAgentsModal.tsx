/**
 * Import an agent setup from another assistant.
 *
 * Only the other assistant knows its own agents, instructions and memory, so
 * it does the harvesting, one of two ways:
 * - Paste: it writes its agents out as JSON and the user pastes the reply
 *   here. Needs nothing set up, so it's the default while remote access is off.
 * - Connected assistant: it calls Ship Studio's `import_agents` tool over the
 *   remote access connector. The default once remote access is on.
 *
 * Both end in the same merge (`agents/import.rs`).
 *
 * @module components/agents/ImportAgentsModal
 */

import { useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOpenModal } from '../../contexts/ModalContext';
import { getImportPrompt } from '../../lib/agents';
import { getRemoteAccessStatus } from '../../lib/remoteAccess';
import { ImportPastePanel } from './ImportPastePanel';

type ImportPath = 'paste' | 'connected';

interface ImportAgentsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function ConnectedPanel({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const openModal = useOpenModal();
  const { copy, isCopied } = useCopyToClipboard();

  useEffect(() => {
    void getImportPrompt()
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, []);

  return (
    <div className="agents-import__body">
      <p>
        If Grok Bot or another assistant is connected to Ship Studio, it can send its agents over
        itself, with their instructions and what they remember.
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
  );
}

export function ImportAgentsModal({ isOpen, onClose }: ImportAgentsModalProps) {
  const [path, setPath] = useState<ImportPath>('paste');

  // Each time it opens: paste works anywhere, so it leads unless remote access is on.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    void getRemoteAccessStatus()
      .then((s) => live && setPath(s.enabled ? 'connected' : 'paste'))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isOpen]);

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Import agents" className="agents-import">
      <Tabs value={path} onValueChange={(v) => setPath(v as ImportPath)}>
        <TabsList className="agents-import__tabs" appearance="underline" aria-label="How to import">
          <TabsTab value="paste">Paste</TabsTab>
          <TabsTab value="connected">Connected assistant</TabsTab>
        </TabsList>
        <TabsPanel value="paste">
          <ImportPastePanel onClose={onClose} />
        </TabsPanel>
        <TabsPanel value="connected">
          <ConnectedPanel onClose={onClose} />
        </TabsPanel>
      </Tabs>
    </ModalFrame>
  );
}
