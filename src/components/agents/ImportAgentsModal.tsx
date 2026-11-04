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

import { useEffect, useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { useOpenModal } from '../../contexts/ModalContext';
import { getImportPrompt } from '../../lib/agents';
import { useAgentsList } from '../../lib/agentsStore';
import { getRemoteAccessStatus } from '../../lib/remoteAccess';
import { ImportPastePanel, type ImportResult } from './ImportPastePanel';
import { ImportDone, ImportStep, MessageCard } from './ImportParts';

type ImportPath = 'paste' | 'connected';

interface ImportAgentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Closes the modal and opens this agent's conversation. */
  onOpenAgent: (agentId: string) => void;
}

function ConnectedPanel({ connected, onClose }: { connected: boolean; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const openModal = useOpenModal();

  useEffect(() => {
    void getImportPrompt()
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, []);

  return (
    <>
      <div className="agents-import__body">
        <p className="agents-import__lede">
          An assistant connected to Ship Studio can send its agents over itself, with their
          instructions and what they remember.
        </p>
        <ol className="agents-import-steps">
          <ImportStep
            n={1}
            state={connected ? 'done' : 'current'}
            title="Connect it to Ship Studio"
            folded={connected}
            aside={connected && 'Remote access is on'}
          >
            <div className="agents-import__inline">
              <span>It reaches this Mac through Remote access.</span>
              <Button variant="secondary" size="compact" onClick={() => openModal('remoteAccess')}>
                Set up Remote access…
              </Button>
            </div>
          </ImportStep>
          <ImportStep n={2} state={connected ? 'current' : 'todo'} title="Send it this message">
            <MessageCard message={prompt} />
          </ImportStep>
        </ol>
      </div>
      <footer className="agents-import__footer">
        <p className="agents-import__note">
          Your agents appear in the list as soon as it&apos;s done. Running it again updates them
          rather than making copies.
        </p>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </footer>
    </>
  );
}

export function ImportAgentsModal({ isOpen, onClose, onOpenAgent }: ImportAgentsModalProps) {
  const [path, setPath] = useState<ImportPath>('paste');
  const [connected, setConnected] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const main = useAgentsList().find((a) => a.isMain);
  // The done state opens quiet after a pointer-driven import: focus goes to
  // its body, not the button, so no ring appears on something nobody tabbed
  // to (as Dropdown's `quietOpen`). A keyboard import focuses the button.
  const byPointer = useRef(false);
  const doneRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const pointer = () => (byPointer.current = true);
    const key = () => (byPointer.current = false);
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [isOpen]);
  const done = result !== null;
  useEffect(() => {
    if (!done) return;
    const target = byPointer.current ? doneRef.current : (openRef.current ?? doneRef.current);
    target?.focus({ preventScroll: true });
  }, [done]);
  // The done state belongs to this opening only.
  const close = () => {
    setResult(null);
    onClose();
  };

  // Each time it opens: paste works anywhere, so it leads unless remote access is on.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    void getRemoteAccessStatus()
      .then((s) => {
        if (!live) return;
        setConnected(s.enabled);
        setPath(s.enabled ? 'connected' : 'paste');
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isOpen]);

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={close}
      title={result ? undefined : 'Import agents'}
      ariaLabel={result ? 'Agents imported' : undefined}
      className="agents-import"
    >
      {result ? (
        <>
          <div className="agents-import__body" ref={doneRef} tabIndex={-1}>
            <ImportDone summary={result.summary} agents={result.agents} />
          </div>
          <footer className="agents-import__footer agents-import__footer--done">
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
            {main && (
              <Button
                variant="primary"
                ref={openRef}
                onClick={() => {
                  setResult(null);
                  onOpenAgent(main.id);
                }}
              >
                Open {main.name}
              </Button>
            )}
          </footer>
        </>
      ) : (
        <Tabs value={path} onValueChange={(v) => setPath(v as ImportPath)}>
          <TabsList
            className="agents-import__tabs"
            appearance="underline"
            aria-label="How to import"
          >
            <TabsTab value="paste">Paste a reply</TabsTab>
            <TabsTab value="connected">Connected assistant</TabsTab>
          </TabsList>
          <TabsPanel value="paste">
            <ImportPastePanel onCancel={close} onDone={setResult} />
          </TabsPanel>
          <TabsPanel value="connected">
            <ConnectedPanel connected={connected} onClose={close} />
          </TabsPanel>
        </Tabs>
      )}
    </ModalFrame>
  );
}
