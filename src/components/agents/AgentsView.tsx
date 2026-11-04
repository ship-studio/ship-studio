/**
 * Agents mode: the home sidebar lists your agents instead of your projects,
 * and the rest of the window is the conversation with the one you picked.
 * Every agent is a Claude Code session on this Mac; the Chief of Staff
 * manages the rest.
 *
 * Switching agents keeps the current conversation on screen until the next
 * one's messages are in, so a switch is one swap rather than a blank beat.
 *
 * Keys: ⌘N new agent; ⌥⌘↑ / ⌥⌘↓ or ⌘[ / ⌘] previous / next agent; ⌘J the
 * next agent that needs you (a card, or a turn that didn't finish); ⌘F
 * search, Esc to put it away; Esc twice in an empty composer stops a working
 * agent (AgentChat); ⌘K "Open <agent>", "Stop <agent>", "What's in flight"
 * (the cross-agent overview, reachable only from there), and Allow / Deny for
 * the oldest card waiting on you.
 *
 * @module components/agents/AgentsView
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { HomeSidebar } from '../workspace/HomeSidebar';
import { AgentsSidebar } from './AgentsSidebar';
import { AgentsSearchPopover, AgentsTopSearch } from './AgentsSearchBox';
import { EngineSignInModal, type EngineSetup } from './EngineSignInModal';
import { AgentChat } from './AgentChat';
import { AgentsTeamView } from './AgentsTeamView';
import { AgentEditorModal } from './AgentEditorModal';
import { AgentProjectsProvider } from './AgentProject';
import { ImportAgentsModal } from './ImportAgentsModal';
import { AgentAppsModal } from './AgentAppsModal';
import { ProjectActionConfirmModal } from '../dashboard/ProjectActionConfirmModal';
import { Spinner } from '../primitives/Spinner';
import {
  answerApproval,
  deleteAgent,
  focusAgent,
  markAgentUnread,
  needsAttention,
  needsYou,
  sortAgents,
  stopAgent,
  TEAM_ID,
  updateAgent,
  type Agent,
  type AgentEngine,
  type SearchHit,
} from '../../lib/agents';
import {
  getAgentsSnapshot,
  loadMessages,
  refreshAgents,
  useAgentsList,
  useAgentsSelector,
} from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAgentsIntents } from '../../commands/useAgentsCommands';
import { useCommands } from '../../commands/useCommands';
import { AgentsModeIcon, CheckIcon, CloseIcon } from '@/components/icons';
import { kbd } from '../../lib/shortcuts';

const SELECTED_KEY = 'shipstudio.agents.selected';

function readSelected(): string | null {
  try {
    // "What's in flight" is a ⌘K detour, never where Agents reopens.
    const id = localStorage.getItem(SELECTED_KEY);
    return id === TEAM_ID ? null : id;
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

/** Leaving for a project (a chip, a change card) goes the way the sidebar's project rows do. */
export function AgentsView(props: AgentsViewProps) {
  return (
    <AgentProjectsProvider onOpenProject={props.sidebarProps.onSelectProject}>
      <AgentsModeView {...props} />
    </AgentProjectsProvider>
  );
}

/** The open chat's composer; a no-op while none is on screen. */
function focusComposer() {
  document.querySelector<HTMLElement>('.agent-composer__input')?.focus({ preventScroll: true });
}

function AgentsModeView({ isCompact, sidebarProps }: AgentsViewProps) {
  // Slices, not the whole store: a reply streaming anywhere must not re-render the view.
  const agents = useAgentsList();
  const loaded = useAgentsSelector((s) => s.loaded);
  const error = useAgentsSelector((s) => s.error);
  const engines = useAgentsSelector((s) => s.engines);
  const { showToast } = useOptionalToast();
  const [selectedId, setSelectedId] = useState<string | null>(readSelected);
  const [editor, setEditor] = useState<{ open: boolean; agent: Agent | null }>({
    open: false,
    agent: null,
  });
  const [importOpen, setImportOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  /** The message a search result asked a chat to show; only that agent's chat takes it. */
  const [jump, setJump] = useState<{ agentId: string; messageId: string } | null>(null);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  // "What's in flight" (⌘K only), else the last agent you had open, else the Chief of Staff.
  const teamOpen = selectedId === TEAM_ID;
  const selected = teamOpen
    ? null
    : (selectedId && agentsById.get(selectedId)) ||
      agents.find((a) => a.isMain) ||
      sortAgents(agents)[0] ||
      null;

  // The conversation on screen: the selected one once its messages are in,
  // until then whichever was there before.
  const [shownId, setShownId] = useState<string | null>(null);
  const selectedKey = selected?.id ?? null;
  const selectedReady = useAgentsSelector(
    (s) => selectedKey !== null && s.messages[selectedKey] !== undefined
  );
  if (selectedReady && selectedKey !== null && shownId !== selectedKey) setShownId(selectedKey);
  const shown = (shownId && agentsById.get(shownId)) || null;

  // Opening an agent on purpose (a dialog, ⌘K, ⌘J, a notification) puts you
  // in its composer. A chat focuses it when it mounts, but a dialog closing
  // restores focus to its trigger, and an agent already on screen doesn't
  // mount again; so this asks once more, a frame later, and again when the
  // chat it asked for arrives.
  const [focusAsk, setFocusAsk] = useState(0);
  const openAgent = useCallback((id: string) => {
    setSelectedId(id);
    setFocusAsk((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!focusAsk) return;
    const frame = requestAnimationFrame(focusComposer);
    return () => cancelAnimationFrame(frame);
  }, [focusAsk, shown?.id]);

  useEffect(() => {
    if (!selected) {
      // On "What's in flight" no conversation is on screen, so replies still count as unread.
      if (teamOpen) void focusAgent(null);
      return;
    }
    writeSelected(selected.id);
    void focusAgent(selected.id);
    if (!getAgentsSnapshot().messages[selected.id]) void loadMessages(selected.id);
  }, [selected?.id, teamOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const openApps = useCallback(() => setAppsOpen(true), []);
  // The sidebar's top field searches conversations. With no sidebar to hold
  // it (compact, or the rail collapsed) it comes up over the chat instead.
  const popoverSearch = isCompact || sidebarProps.isSidebarHidden;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Claude Code's terminal: installing (then signing in), or only signing in. */
  const [engineSetup, setEngineSetup] = useState<EngineSetup | null>(null);
  /** The search hit last opened, marked in the results. */
  const [currentHit, setCurrentHit] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Agent | null>(null);
  const searchOpen = query.trim().length > 0 || (popoverSearch && popoverOpen);
  const closeSearch = useCallback(() => {
    setPopoverOpen(false);
    setQuery('');
    focusComposer();
  }, []);
  // Focus lands before the next key does: the field is there (or mounted
  // synchronously) by the time this returns, so nothing typed is lost.
  const focusSearch = useCallback(() => {
    if (popoverSearch) flushSync(() => setPopoverOpen(true));
    searchRef.current?.focus({ preventScroll: true });
    searchRef.current?.select();
  }, [popoverSearch]);
  const search = useMemo(() => ({ query, setQuery, close: closeSearch }), [query, closeSearch]);

  // ⌘F searches every conversation, wherever focus is in Agents mode. Esc
  // anywhere puts search away, unless something on top (a dialog, a menu,
  // the composer) already took it.
  const searchKeys = useRef({ searchOpen, closeSearch, focusSearch });
  useEffect(() => {
    searchKeys.current = { searchOpen, closeSearch, focusSearch };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { searchOpen, closeSearch, focusSearch } = searchKeys.current;
      if (e.key === 'Escape') {
        if (!searchOpen || e.defaultPrevented) return;
        if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
        e.preventDefault();
        closeSearch();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f')
        return;
      e.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  /** The composer's Esc closes search first, rather than stopping the agent. */
  const escapeSearch = useCallback(() => {
    if (!searchKeys.current.searchOpen) return false;
    searchKeys.current.closeSearch();
    return true;
  }, []);

  const openMessage = useCallback((agentId: string, messageId: string) => {
    setSelectedId(agentId);
    setJump({ agentId, messageId });
  }, []);
  const openHit = useCallback(
    (hit: SearchHit) => {
      setCurrentHit(hit.messageId);
      openMessage(hit.agentId, hit.messageId);
    },
    [openMessage]
  );
  const clearJump = useCallback(() => setJump(null), []);
  useAgentsIntents({
    onNewAgent: openNew,
    onImportAgents: openImport,
    onApps: openApps,
    onOpenAgent: openAgent,
    onSearch: focusSearch,
  });

  // The order you see in the sidebar, for previous / next.
  const order = sortAgents(agents).filter((a) => !a.hidden || showHidden || a.id === selected?.id);
  /** The next agent after the one open that needs you, wrapping; null if none does. */
  const nextNeedingYou = useCallback((): Agent | null => {
    const list = sortAgents(agents).filter((a) => !a.hidden);
    const from = list.findIndex((a) => a.id === selected?.id);
    for (let i = 1; i <= list.length; i++) {
      const a = list[(from + i + list.length) % list.length];
      if (needsAttention(a) && a.id !== selected?.id) return a;
    }
    return null;
  }, [agents, selected?.id]);
  const keys = useRef({ order, selected, openNew, nextNeedingYou, showToast });
  useEffect(() => {
    keys.current = { order, selected, openNew, nextNeedingYou, showToast };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      // Leave every key alone while a dialog owns the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;
      const { order, selected, openNew, nextNeedingYou, showToast } = keys.current;
      if (event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        openNew();
        return;
      }
      if (event.key.toLowerCase() === 'j' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        const next = nextNeedingYou();
        // Said, so the key never seems broken.
        if (next) openAgent(next.id);
        else showToast('No other agent needs you right now', 'info');
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
  }, [openAgent]);

  // The oldest card waiting on you, on the first agent (sidebar order) with one.
  const waitingOn = sortAgents(agents).find((a) => !a.hidden && needsYou(a)) ?? null;
  const topCard = useAgentsSelector((s) =>
    waitingOn
      ? (s.messages[waitingOn.id] ?? []).find((m) => m.approval?.status === 'pending')
      : undefined
  );
  useEffect(() => {
    if (waitingOn && !getAgentsSnapshot().messages[waitingOn.id]) void loadMessages(waitingOn.id);
  }, [waitingOn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const answerTop = useCallback(
    (allow: boolean) => {
      if (!waitingOn || !topCard?.approval) return;
      answerApproval(waitingOn.id, topCard.approval.requestId, allow).catch((err: unknown) =>
        showToast(formatCommandError(asCommandError(err)), 'error')
      );
    },
    [waitingOn, topCard, showToast]
  );

  useCommands(
    () => [
      {
        id: 'agents.nextNeedingYou',
        title: 'Open the next agent that needs you',
        icon: <AgentsModeIcon size={14} />,
        category: 'navigation',
        shortcut: kbd('mod', 'J'),
        keywords: ['agents', 'approval', 'waiting', 'failed', 'unread', 'jump'],
        when: () => agents.some((a) => !a.hidden && needsAttention(a)),
        run: () => {
          const next = nextNeedingYou();
          if (next) openAgent(next.id);
        },
      },
      ...(waitingOn && topCard?.approval
        ? [
            {
              id: 'agents.allowTop',
              title: `Allow ${waitingOn.name}: ${topCard.approval.title}`,
              icon: <CheckIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'approve', 'approval', 'yes', topCard.approval.detail],
              run: () => answerTop(true),
            },
            {
              id: 'agents.denyTop',
              title: `Deny ${waitingOn.name}: ${topCard.approval.title}`,
              icon: <CloseIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'decline', 'approval', 'no', topCard.approval.detail],
              run: () => answerTop(false),
            },
          ]
        : []),
      ...agents
        .filter((a) => a.status.state !== 'idle')
        .map((a) => ({
          id: `agents.stop.${a.id}`,
          title: `Stop ${a.name}`,
          icon: <CloseIcon size={14} />,
          category: 'action' as const,
          keywords: ['agents', 'cancel', 'halt', 'kill', 'interrupt'],
          run: () => setStopping(a),
        })),
    ],
    [agents, waitingOn, topCard, answerTop, nextNeedingYou, openAgent]
  );

  const confirmStop = async () => {
    if (!stopping) return;
    const agent = stopping;
    setStopping(null);
    try {
      await stopAgent(agent.id);
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    await run(() => deleteAgent(deleting.id));
    if (selectedId === deleting.id) setSelectedId(null);
    setDeleteBusy(false);
    setDeleting(null);
    setEditor({ open: false, agent: null });
  };

  // Stable, so a status event re-renders only the sidebar row it changed.
  const actions = useMemo(
    () => ({
      onTogglePin: (a: Agent) => void run(() => updateAgent(a.id, { pinned: !a.pinned })),
      onToggleHidden: (a: Agent) => void run(() => updateAgent(a.id, { hidden: !a.hidden })),
      onToggleMuted: (a: Agent) => void run(() => updateAgent(a.id, { muted: !a.muted })),
      onMarkUnread: (a: Agent) => {
        const { order, selected } = keys.current;
        if (a.id === selected?.id) {
          // Step off it, or opening it again would mark it read straight away.
          const other = order.find((o) => o.id !== a.id);
          if (other) setSelectedId(other.id);
        }
        void run(() => markAgentUnread(a.id));
      },
      onEdit: (a: Agent) => setEditor({ open: true, agent: a }),
      onDelete: setDeleting,
    }),
    [run]
  );
  const toggleShowHidden = useCallback(() => setShowHidden((v) => !v), []);
  const signIn = useCallback(
    (engine: AgentEngine) => setEngineSetup({ engine, step: 'sign-in' }),
    []
  );

  return (
    <div className="app workspace workspace-home agents-mode">
      <div className={`projects-with-rail${isCompact ? ' is-compact' : ''}`} key="view-agents">
        {!isCompact && (
          <HomeSidebar
            {...sidebarProps}
            activeNav="agents"
            searchContent={
              <AgentsTopSearch
                search={search}
                field={searchRef}
                collapsed={sidebarProps.isSidebarHidden}
                onOpen={focusSearch}
              />
            }
            listContent={
              <AgentsSidebar
                agents={agents}
                selectedId={selected?.id ?? null}
                showHidden={showHidden}
                onToggleShowHidden={toggleShowHidden}
                onSelect={setSelectedId}
                onNew={openNew}
                onImport={openImport}
                actions={actions}
                query={popoverSearch ? '' : query}
                searchRef={searchRef}
                onOpenHit={openHit}
                currentHit={currentHit}
              />
            }
          />
        )}

        <main className="agents-main">
          {popoverSearch && (
            <AgentsSearchPopover
              search={search}
              open={popoverOpen}
              field={searchRef}
              onOpenHit={openHit}
            />
          )}
          {error && !loaded ? (
            <div className="agents-main__state">{error}</div>
          ) : teamOpen ? (
            <AgentsTeamView
              onOpenAgent={openAgent}
              onOpenMessage={openMessage}
              onSignIn={signIn}
              compact={
                isCompact
                  ? {
                      agents,
                      onGoHome: sidebarProps.onGoHome,
                      onGoProjects: sidebarProps.onGoProjects,
                    }
                  : undefined
              }
            />
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
              onSetUpEngine={() =>
                setEngineSetup({
                  engine: shown.engine,
                  // Codex can be installed and only need signing in.
                  step: engines.find((e) => e.id === shown.engine)?.installed
                    ? 'sign-in'
                    : 'install',
                })
              }
              onSignIn={() => signIn(shown.engine)}
              onImport={openImport}
              onEscape={escapeSearch}
              compact={
                isCompact
                  ? {
                      agents,
                      onGoHome: sidebarProps.onGoHome,
                      onGoProjects: sidebarProps.onGoProjects,
                    }
                  : undefined
              }
              {...actions}
              jumpTo={jump?.agentId === shown.id ? jump.messageId : null}
              onJumped={clearJump}
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
          openAgent(id);
        }}
        onDelete={setDeleting}
        onOpenApps={openApps}
      />
      <ImportAgentsModal
        isOpen={importOpen}
        onClose={(imported) => {
          setImportOpen(false);
          // The note that opened it may have gone with the import; land in the chat.
          if (imported) setFocusAsk((n) => n + 1);
        }}
        onOpenAgent={(id) => {
          setImportOpen(false);
          openAgent(id);
        }}
      />
      <AgentAppsModal isOpen={appsOpen} onClose={() => setAppsOpen(false)} />
      {engineSetup && <EngineSignInModal {...engineSetup} onClose={() => setEngineSetup(null)} />}
      {stopping && (
        <ProjectActionConfirmModal
          title={`Stop ${stopping.name}?`}
          body={<p>What it’s doing now ends here, and anything queued for it is dropped.</p>}
          hint="Its conversation is kept."
          loading={false}
          confirmLabel="Stop"
          loadingLabel="Stopping…"
          confirmVariant="danger"
          onCancel={() => setStopping(null)}
          onConfirm={() => void confirmStop()}
        />
      )}
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
