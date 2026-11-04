/**
 * Agents mode: the whole window becomes a chat app. Your agents on the left,
 * the one you're talking to on the right. Every agent is a Claude Code
 * session on this Mac; the Chief of Staff manages the rest.
 *
 * @module components/agents/AgentsView
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentsSidebar } from './AgentsSidebar';
import { AgentChat } from './AgentChat';
import { AgentEditorModal } from './AgentEditorModal';
import { ImportAgentsModal } from './ImportAgentsModal';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import {
  deleteAgent,
  focusAgent,
  markAgentUnread,
  sortAgents,
  updateAgent,
  type Agent,
} from '../../lib/agents';
import { refreshAgents, useAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useOpenModal } from '../../contexts/ModalContext';
import { useAgentsIntents } from '../../commands/useAgentsCommands';

const SELECTED_KEY = 'shipstudio.agents.selected';

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function writeSelected(id: string) {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    /* per-viewer convenience only */
  }
}

interface AgentsViewProps {
  onGoProjects: () => void;
}

export function AgentsView({ onGoProjects }: AgentsViewProps) {
  const { agents, loaded, error, engineReady } = useAgents();
  const { showToast } = useOptionalToast();
  const openModal = useOpenModal();
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  const [editor, setEditor] = useState<{ open: boolean; agent: Agent | null }>({
    open: false,
    agent: null,
  });
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  // The last agent you had open, else the Chief of Staff.
  const selected =
    (selectedId && agentsById.get(selectedId)) ||
    agents.find((a) => a.isMain) ||
    sortAgents(agents)[0] ||
    null;

  useEffect(() => {
    if (!selected) return;
    writeSelected(selected.id);
    void focusAgent(selected.id);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving Agents mode: nothing is on screen any more, so new replies count as unread.
  useEffect(() => () => void focusAgent(null), []);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        await refreshAgents();
      } catch (err) {
        showToast(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [showToast]
  );

  const openNew = useCallback(() => setEditor({ open: true, agent: null }), []);
  const openImport = useCallback(() => setImportOpen(true), []);
  useAgentsIntents({ onNewAgent: openNew, onImportAgents: openImport });

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    await run(() => deleteAgent(deleting.id));
    if (selectedId === deleting.id) setSelectedId(null);
    setDeleteBusy(false);
    setDeleting(null);
    setEditor({ open: false, agent: null });
  };

  return (
    <div className="app workspace workspace-home agents-mode">
      <div className="agents-layout">
        <AgentsSidebar
          agents={agents}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          onNew={openNew}
          onImport={openImport}
          onGoProjects={onGoProjects}
          onTogglePin={(a) => void run(() => updateAgent(a.id, { pinned: !a.pinned }))}
          onToggleHidden={(a) => void run(() => updateAgent(a.id, { hidden: !a.hidden }))}
          onMarkUnread={(a) => {
            if (a.id === selectedId) setSelectedId(null);
            void run(() => markAgentUnread(a.id));
          }}
          onEdit={(a) => setEditor({ open: true, agent: a })}
          onDelete={setDeleting}
        />

        <main className="agents-main">
          {!engineReady && (
            <div className="agents-banner" role="status">
              <span>Agents run on Claude Code, and it isn&apos;t installed on this Mac yet.</span>
              <Button variant="primary" size="compact" onClick={() => openModal('settings')}>
                Set up Claude Code
              </Button>
            </div>
          )}
          {error && !loaded ? (
            <div className="agents-main__state">{error}</div>
          ) : !loaded || !selected ? (
            <div className="agents-main__state">
              <Spinner />
            </div>
          ) : (
            <AgentChat
              key={selected.id}
              agent={selected}
              agentsById={agentsById}
              onOpenAgent={setSelectedId}
              onEditAgent={(a) => setEditor({ open: true, agent: a })}
            />
          )}
        </main>
      </div>

      <AgentEditorModal
        key={editor.open ? (editor.agent?.id ?? 'new') : 'closed'}
        isOpen={editor.open}
        agent={editor.agent}
        onClose={() => setEditor({ open: false, agent: null })}
        onSaved={(id) => {
          void refreshAgents();
          setSelectedId(id);
        }}
        onDelete={setDeleting}
      />
      <ImportAgentsModal isOpen={importOpen} onClose={() => setImportOpen(false)} />
      {deleting && (
        <ProjectActionConfirmModal
          title={`Delete ${deleting.name}?`}
          body={<p>Its memory and its whole conversation are deleted with it.</p>}
          hint="This can't be undone."
          loading={deleteBusy}
          confirmLabel="Delete"
          loadingLabel="Deleting…"
          confirmVariant="danger"
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
