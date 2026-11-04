/**
 * Agents mode: the home sidebar lists your agents instead of your projects,
 * and the rest of the window is the conversation with the one you picked.
 * Every agent is a Claude Code session on this Mac; the Chief of Staff
 * manages the rest.
 *
 * Switching agents keeps the current conversation on screen until the next
 * one's messages are in, so a switch is one swap rather than a blank beat.
 *
 * Keys: ⌘N new agent; ⌥⌘↑ / ⌥⌘↓ or ⌘[ / ⌘] previous / next agent; Esc in an
 * empty composer stops a working agent (AgentChat); ⌘K "Open <agent>".
 *
 * @module components/agents/AgentsView
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { HomeSidebar } from '../workspace/HomeSidebar';
import { AgentsAddMenu, AgentsSidebar } from './AgentsSidebar';
import { AgentChat } from './AgentChat';
import { AgentEditorModal } from './AgentEditorModal';
import { ImportAgentsModal } from './ImportAgentsModal';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { Spinner } from '../primitives/Spinner';
import {
  deleteAgent,
  focusAgent,
  markAgentUnread,
  sortAgents,
  updateAgent,
  type Agent,
} from '../../lib/agents';
import { getAgentsSnapshot, loadMessages, refreshAgents, useAgents } from '../../lib/agentsStore';
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
  isCompact: boolean;
  sidebarProps: Omit<ComponentProps<typeof HomeSidebar>, 'activeNav' | 'listContent'>;
}

export function AgentsView({ isCompact, sidebarProps }: AgentsViewProps) {
  const { agents, loaded, error, messages } = useAgents();
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
  const [showHidden, setShowHidden] = useState(false);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  // The last agent you had open, else the Chief of Staff.
  const selected =
    (selectedId && agentsById.get(selectedId)) ||
    agents.find((a) => a.isMain) ||
    sortAgents(agents)[0] ||
    null;

  // The conversation on screen: the selected one once its messages are in,
  // until then whichever was there before.
  const [shownId, setShownId] = useState<string | null>(null);
  const selectedReady = selected !== null && messages[selected.id] !== undefined;
  if (selectedReady && shownId !== selected.id) setShownId(selected.id);
  const shown = (shownId && agentsById.get(shownId)) || null;

  useEffect(() => {
    if (!selected) return;
    writeSelected(selected.id);
    void focusAgent(selected.id);
    if (!getAgentsSnapshot().messages[selected.id]) void loadMessages(selected.id);
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
  useAgentsIntents({ onNewAgent: openNew, onImportAgents: openImport, onOpenAgent: setSelectedId });

  // The order you see in the sidebar, for previous / next.
  const order = sortAgents(agents).filter((a) => !a.hidden || showHidden || a.id === selected?.id);
  const keys = useRef({ order, selected, openNew });
  useEffect(() => {
    keys.current = { order, selected, openNew };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      // Leave every key alone while a dialog owns the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;
      const { order, selected, openNew } = keys.current;
      if (event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        openNew();
        return;
      }
      const step =
        (event.altKey && event.key === 'ArrowUp') || event.key === '['
          ? -1
          : (event.altKey && event.key === 'ArrowDown') || event.key === ']'
            ? 1
            : 0;
      if (step === 0 || order.length === 0) return;
      event.preventDefault();
      const index = order.findIndex((a) => a.id === selected?.id);
      const next = order[(index + step + order.length) % order.length];
      setSelectedId(next.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    await run(() => deleteAgent(deleting.id));
    if (selectedId === deleting.id) setSelectedId(null);
    setDeleteBusy(false);
    setDeleting(null);
    setEditor({ open: false, agent: null });
  };

  const actions = {
    onTogglePin: (a: Agent) => void run(() => updateAgent(a.id, { pinned: !a.pinned })),
    onToggleHidden: (a: Agent) => void run(() => updateAgent(a.id, { hidden: !a.hidden })),
    onMarkUnread: (a: Agent) => {
      if (a.id === selected?.id) {
        // Step off it, or opening it again would mark it read straight away.
        const other = order.find((o) => o.id !== a.id);
        if (other) setSelectedId(other.id);
      }
      void run(() => markAgentUnread(a.id));
    },
    onEdit: (a: Agent) => setEditor({ open: true, agent: a }),
    onDelete: setDeleting,
  };

  return (
    <div className="app workspace workspace-home agents-mode">
      <div className={`projects-with-rail${isCompact ? ' is-compact' : ''}`} key="view-agents">
        {!isCompact && (
          <HomeSidebar
            {...sidebarProps}
            activeNav="agents"
            agentsNavAction={<AgentsAddMenu onNew={openNew} onImport={openImport} />}
            listContent={
              <AgentsSidebar
                agents={agents}
                selectedId={selected?.id ?? null}
                showHidden={showHidden}
                onToggleShowHidden={() => setShowHidden((v) => !v)}
                onSelect={setSelectedId}
                {...actions}
              />
            }
          />
        )}

        <main className="agents-main">
          {error && !loaded ? (
            <div className="agents-main__state">{error}</div>
          ) : !shown ? (
            <div className="agents-main__state">
              <Spinner />
            </div>
          ) : (
            <AgentChat
              key={shown.id}
              agent={shown}
              agentsById={agentsById}
              onOpenAgent={setSelectedId}
              onSetUpEngine={() => openModal('settings')}
              compact={isCompact ? { agents, onGoHome: sidebarProps.onGoHome } : undefined}
              {...actions}
            />
          )}
        </main>
      </div>

      <AgentEditorModal
        key={editor.open ? (editor.agent?.id ?? 'new') : 'closed'}
        isOpen={editor.open}
        agent={editor.agent}
        takenColors={agents.map((a) => a.color)}
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
