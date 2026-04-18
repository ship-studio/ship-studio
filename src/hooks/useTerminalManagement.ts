/**
 * Terminal tab state — per project.
 *
 * Slice 4: each project that's been opened keeps its own tab list alive
 * until the session is explicitly closed. `useTerminalManagement` now
 * stores `Map<projectPath, ProjectTerminalState>` and exposes the CURRENT
 * project's slice through the same scalar API consumers already use.
 * Terminal React components are rendered for every active session; the
 * non-current ones get `display: none` from WorkspaceView so their xterm
 * instances (and the PTY processes they drive) keep running in the
 * background for multitasking.
 *
 * @module hooks/useTerminalManagement
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { TerminalHandle } from '../components/Terminal';
import { getAgentById, getDefaultAgentId } from '../lib/agent';
import type { AgentConfig } from '../lib/agent';
import { trackEvent } from '../lib/analytics';
import { logger } from '../lib/logger';

/** Maximum number of terminal tabs allowed per project */
const MAX_TERMINAL_TABS = 5;

/** A terminal tab with its own agent assignment. */
export interface TerminalTab {
  id: number;
  agentId: string;
  /** Unique session ID (UUID) for resuming agent conversations */
  sessionId: string;
  /** Whether this tab should resume a previous session on spawn */
  shouldResume?: boolean;
}

interface ProjectTerminalState {
  tabs: TerminalTab[];
  activeTabId: number;
  /** Monotonic counter so new tab ids stay unique per project */
  counter: number;
  /** Bumps on resetTerminalsForProject — used to force xterm remount */
  sessionEpoch: number;
}

/** A session (project) that should have its terminal components rendered. */
export interface TerminalSessionView {
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: number;
  sessionEpoch: number;
}

export interface UseTerminalManagementReturn {
  /** Current project's tab list (empty array when no project is open). */
  terminalTabs: TerminalTab[];
  /** Currently active tab id within the current project. */
  activeTerminalTab: number;
  /** Epoch for the current project — bumped on resets, used for xterm key. */
  terminalSessionId: number;
  /** Every active session — render Terminal components for all of them,
   *  hide non-current via CSS so PTYs stay alive. */
  allSessions: TerminalSessionView[];
  /** Refs for every mounted Terminal, keyed by `${projectPath}::${tabId}`. */
  terminalRefsMap: React.MutableRefObject<Map<string, TerminalHandle | null>>;
  maxTerminalTabs: number;
  setActiveTerminalTab: (tabId: number) => void;
  addTerminalTab: (agentId?: string) => void;
  closeTerminalTab: (tabId: number) => void;
  /** Destroy every tab + PTY for a specific project (explicit close). */
  closeAllTerminalsForProject: (projectPath: string) => void;
  /** Destroy every tab + PTY for every project (window close). */
  killAllTerminals: () => void;
  /** Reset the CURRENT project's tab list to a single default tab. */
  resetTerminals: () => void;
  getActiveTerminalRef: () => TerminalHandle | null;
  focusActiveTerminal: () => void;
  pasteToActiveTerminal: (text: string) => void;
  switchTabAgent: (tabId: number, agentId: string) => void;
  getActiveTabAgent: () => AgentConfig;
  /** Seed a project's tabs from persisted state. Idempotent — no-op if
   *  the project already has tabs tracked (prevents clobbering running
   *  sessions on re-entry). */
  restoreTerminalTabs: (
    projectPath: string,
    tabs: Array<{ agentId: string; sessionId: string }>,
    activeIndex: number
  ) => void;
  /** Ensure there's a default tab list for a freshly-opened project
   *  that has no persisted state. */
  ensureProjectSeeded: (projectPath: string) => void;
}

function makeDefaultState(): ProjectTerminalState {
  return {
    tabs: [{ id: 1, agentId: getDefaultAgentId(), sessionId: crypto.randomUUID() }],
    activeTabId: 1,
    counter: 1,
    sessionEpoch: 1,
  };
}

/**
 * Hook for managing per-project terminal tab state.
 *
 * Pass `currentProjectPath` so scalar getters (`terminalTabs`,
 * `activeTerminalTab`, `terminalSessionId`) reflect the focused project.
 * Mutations without an explicit path target the current project.
 */
export function useTerminalManagement(
  currentProjectPath: string | null
): UseTerminalManagementReturn {
  const statesRef = useRef<Map<string, ProjectTerminalState>>(new Map());
  const terminalRefsMap = useRef<Map<string, TerminalHandle | null>>(new Map());

  // Bump to force scalar re-read after map mutations.
  const [epoch, setEpoch] = useState(0);
  const bump = useCallback(() => setEpoch((v) => v + 1), []);

  // Sync ref during render so mutation closures always see the latest
  // currentProjectPath without waiting for an effect commit.
  const currentPathRef = useRef<string | null>(currentProjectPath);
  currentPathRef.current = currentProjectPath;

  const getOrCreate = useCallback((path: string): ProjectTerminalState => {
    let s = statesRef.current.get(path);
    if (!s) {
      s = makeDefaultState();
      statesRef.current.set(path, s);
    }
    return s;
  }, []);

  const getCurrent = useCallback((): ProjectTerminalState | null => {
    const path = currentPathRef.current;
    if (!path) return null;
    return statesRef.current.get(path) ?? null;
  }, []);

  // Derived scalars for the focused project.
  const currentState = useMemo(
    () => (currentProjectPath ? (statesRef.current.get(currentProjectPath) ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- epoch is the reactivity trigger
    [currentProjectPath, epoch]
  );

  const terminalTabs = currentState?.tabs ?? [];
  const activeTerminalTab = currentState?.activeTabId ?? 1;
  const terminalSessionId = currentState?.sessionEpoch ?? 1;

  const allSessions = useMemo<TerminalSessionView[]>(() => {
    void epoch;
    const out: TerminalSessionView[] = [];
    for (const [projectPath, s] of statesRef.current.entries()) {
      out.push({
        projectPath,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        sessionEpoch: s.sessionEpoch,
      });
    }
    return out;
  }, [epoch]);

  const refKey = (path: string, tabId: number) => `${path}::${tabId}`;

  const killProjectPtys = useCallback((path: string) => {
    for (const [key, ref] of terminalRefsMap.current.entries()) {
      if (key.startsWith(`${path}::`)) {
        ref?.kill();
        terminalRefsMap.current.delete(key);
      }
    }
  }, []);

  const setActiveTerminalTab = useCallback(
    (tabId: number) => {
      const s = getCurrent();
      if (!s) return;
      s.activeTabId = tabId;
      bump();
    },
    [bump, getCurrent]
  );

  const addTerminalTab = useCallback(
    (agentId?: string) => {
      const path = currentPathRef.current;
      if (!path) return;
      const s = getOrCreate(path);
      if (s.tabs.length >= MAX_TERMINAL_TABS) {
        logger.warn('[TerminalMgmt] Max tabs reached', { max: MAX_TERMINAL_TABS });
        return;
      }
      s.counter += 1;
      const newTabId = s.counter;
      const sessionId = crypto.randomUUID();
      const resolvedAgent = agentId ?? getDefaultAgentId();
      s.tabs = [...s.tabs, { id: newTabId, agentId: resolvedAgent, sessionId }];
      s.activeTabId = newTabId;
      bump();
      void trackEvent('terminal_tab_added', {
        tab_count: s.tabs.length,
        agent_id: resolvedAgent,
        $screen_name: 'Workspace',
      });
    },
    [bump, getOrCreate]
  );

  const closeTerminalTab = useCallback(
    (tabId: number) => {
      const path = currentPathRef.current;
      if (!path) return;
      const s = statesRef.current.get(path);
      if (!s || s.tabs.length <= 1) return;

      const ref = terminalRefsMap.current.get(refKey(path, tabId));
      if (ref) ref.kill();
      terminalRefsMap.current.delete(refKey(path, tabId));

      const closedIdx = s.tabs.findIndex((t) => t.id === tabId);
      s.tabs = s.tabs.filter((t) => t.id !== tabId);
      if (tabId === s.activeTabId) {
        const newActiveIdx = Math.max(0, closedIdx - 1);
        s.activeTabId = s.tabs[newActiveIdx].id;
      }
      bump();
      void trackEvent('terminal_tab_closed', { $screen_name: 'Workspace' });
    },
    [bump]
  );

  const closeAllTerminalsForProject = useCallback(
    (projectPath: string) => {
      killProjectPtys(projectPath);
      statesRef.current.delete(projectPath);
      bump();
    },
    [bump, killProjectPtys]
  );

  const killAllTerminals = useCallback(() => {
    terminalRefsMap.current.forEach((ref) => ref?.kill());
    terminalRefsMap.current.clear();
    statesRef.current.clear();
    bump();
  }, [bump]);

  const resetTerminals = useCallback(() => {
    const path = currentPathRef.current;
    if (!path) return;
    killProjectPtys(path);
    statesRef.current.set(path, makeDefaultState());
    bump();
  }, [bump, killProjectPtys]);

  const getActiveTerminalRef = useCallback(() => {
    const s = getCurrent();
    const path = currentPathRef.current;
    if (!s || !path) return null;
    return terminalRefsMap.current.get(refKey(path, s.activeTabId)) ?? null;
  }, [getCurrent]);

  const focusActiveTerminal = useCallback(() => {
    getActiveTerminalRef()?.focus();
  }, [getActiveTerminalRef]);

  const pasteToActiveTerminal = useCallback(
    (text: string) => {
      getActiveTerminalRef()?.paste(text);
    },
    [getActiveTerminalRef]
  );

  const switchTabAgent = useCallback(
    (tabId: number, agentId: string) => {
      const path = currentPathRef.current;
      if (!path) return;
      const s = statesRef.current.get(path);
      if (!s) return;

      const ref = terminalRefsMap.current.get(refKey(path, tabId));
      if (ref) ref.kill();
      terminalRefsMap.current.delete(refKey(path, tabId));

      s.tabs = s.tabs.map((t) =>
        t.id === tabId ? { ...t, agentId, sessionId: crypto.randomUUID(), shouldResume: false } : t
      );
      s.sessionEpoch += 1;
      bump();
      void trackEvent('agent_switched', { agent_id: agentId, $screen_name: 'Workspace' });
    },
    [bump]
  );

  const getActiveTabAgent = useCallback((): AgentConfig => {
    const s = getCurrent();
    if (!s) return getAgentById(getDefaultAgentId());
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? getAgentById(tab.agentId) : getAgentById(getDefaultAgentId());
  }, [getCurrent]);

  const restoreTerminalTabs = useCallback(
    (
      projectPath: string,
      tabs: Array<{ agentId: string; sessionId: string }>,
      activeIndex: number
    ) => {
      if (tabs.length === 0) return;
      // Idempotent: if the project already has state with live tabs, do not
      // clobber — those PTYs are our hot multitasking sessions.
      if (statesRef.current.has(projectPath)) {
        return;
      }
      const restoredTabs: TerminalTab[] = tabs.map((t, i) => ({
        id: i + 1,
        agentId: t.agentId,
        sessionId: t.sessionId,
        shouldResume: true,
      }));
      const activeId = restoredTabs[Math.min(activeIndex, restoredTabs.length - 1)]?.id ?? 1;
      statesRef.current.set(projectPath, {
        tabs: restoredTabs,
        activeTabId: activeId,
        counter: restoredTabs.length,
        sessionEpoch: 1,
      });
      bump();
      logger.info('[TerminalMgmt] Restored tabs from saved state', {
        projectPath,
        tabCount: restoredTabs.length,
        activeId,
      });
    },
    [bump]
  );

  const ensureProjectSeeded = useCallback(
    (projectPath: string) => {
      if (statesRef.current.has(projectPath)) return;
      statesRef.current.set(projectPath, makeDefaultState());
      bump();
    },
    [bump]
  );

  return {
    terminalTabs,
    activeTerminalTab,
    terminalSessionId,
    allSessions,
    terminalRefsMap,
    maxTerminalTabs: MAX_TERMINAL_TABS,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    closeAllTerminalsForProject,
    killAllTerminals,
    resetTerminals,
    getActiveTerminalRef,
    focusActiveTerminal,
    pasteToActiveTerminal,
    switchTabAgent,
    getActiveTabAgent,
    restoreTerminalTabs,
    ensureProjectSeeded,
  };
}
