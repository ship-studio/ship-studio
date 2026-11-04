/**
 * Agents mode: the home sidebar lists your agents instead of your projects,
 * and the rest of the window is the conversation with the one you picked.
 * Every agent is a Claude Code session on this Mac; the Chief of Staff
 * manages the rest.
 *
 * @module components/agents/AgentsView
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { HomeSidebar } from '../workspace/HomeSidebar';
import { AgentsSidebar } from './AgentsSidebar';
import { AgentsSearchPopover } from './AgentsSearchBox';
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
  type SearchHit,
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
  isCompact: boolean;
  sidebarProps: Omit<ComponentProps<typeof HomeSidebar>, 'activeNav' | 'listContent'>;
}

export function AgentsView({ isCompact, sidebarProps }: AgentsViewProps) {
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
  const [showHidden, setShowHidden] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  /** The message a search result asked the chat to show. */
  const [jumpTo, setJumpTo] = useState<string | null>(null);

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
  // Search is put away until asked for: the header button, ⌘F, the palette.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Bumped to (re)focus the field, including when it is already open. */
  const [focusTick, setFocusTick] = useState(0);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
  }, []);
  const focusSearch = useCallback(() => {
    setSearchOpen(true);
    setFocusTick((n) => n + 1);
  }, []);
  const toggleSearch = useCallback(() => {
    if (searchOpen) closeSearch();
    else focusSearch();
  }, [searchOpen, closeSearch, focusSearch]);
  useEffect(() => {
    if (focusTick === 0) return;
    // After the commit that un-inerts (or mounts) the field.
    const frame = requestAnimationFrame(() => {
      searchRef.current?.focus({ preventScroll: true });
      searchRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTick]);
  const search = useMemo(
    () => ({ open: searchOpen, query, setQuery, close: closeSearch }),
    [searchOpen, query, closeSearch]
  );
  useAgentsIntents({ onNewAgent: openNew, onImportAgents: openImport, onSearch: focusSearch });

  // ⌘F searches every conversation, wherever focus is in Agents mode — and in
  // compact mode too, where the field comes up over the chat.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f')
        return;
      e.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusSearch]);

  const openHit = useCallback((hit: SearchHit) => {
    setSelectedId(hit.agentId);
    setJumpTo(hit.messageId);
  }, []);
  const clearJump = useCallback(() => setJumpTo(null), []);

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
      <div className={`projects-with-rail${isCompact ? ' is-compact' : ''}`} key="view-agents">
        {!isCompact && (
          <HomeSidebar
            {...sidebarProps}
            activeNav="agents"
            listContent={
              <AgentsSidebar
                agents={agents}
                selectedId={selected?.id ?? null}
                showHidden={showHidden}
                onToggleShowHidden={() => setShowHidden((v) => !v)}
                onSelect={setSelectedId}
                onNew={openNew}
                onImport={openImport}
                onTogglePin={(a) => void run(() => updateAgent(a.id, { pinned: !a.pinned }))}
                onToggleHidden={(a) => void run(() => updateAgent(a.id, { hidden: !a.hidden }))}
                onMarkUnread={(a) => {
                  if (a.id === selectedId) setSelectedId(null);
                  void run(() => markAgentUnread(a.id));
                }}
                onEdit={(a) => setEditor({ open: true, agent: a })}
                onDelete={setDeleting}
                search={search}
                onToggleSearch={toggleSearch}
                searchRef={searchRef}
                onOpenHit={openHit}
              />
            }
          />
        )}

        <main className="agents-main">
          {isCompact && (
            <AgentsSearchPopover search={search} field={searchRef} onOpenHit={openHit} />
          )}
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
              jumpTo={jumpTo}
              onJumped={clearJump}
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
