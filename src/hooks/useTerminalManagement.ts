/**
 * Terminal tab state — per project. Owns the agent-terminal tab lists (and
 * split-pane layout) for every open session, keyed by project path.
 *
 * Lifecycle of a project's slice: seed (`ensureProjectSeeded` creates one
 * default tab, or `restoreTerminalTabs` rebuilds from persisted backend state
 * with `shouldResume: true`) → mutate (add/close tabs up to 5, switch agent —
 * which kills the PTY and mints a fresh session ID, split-pane enable/resize/
 * remove) → teardown (`closeAllTerminalsForProject` on explicit session close,
 * `killAllTerminals` on window close). Each project keeps its tabs alive until
 * explicitly closed (Slice 4 hot sessions): Terminal components are rendered
 * for every session in `allSessions`, with non-current ones hidden via
 * `display: none` by WorkspaceView so xterm + PTYs keep running.
 *
 * State lives in a `Map<projectPath, ProjectTerminalState>` ref; the CURRENT
 * project's slice is exposed through scalars (`terminalTabs`,
 * `activeTerminalTab`, `splitPaneTabIds`, …) re-derived via an epoch counter.
 * Consumed by App.tsx, which threads it into WorkspaceView,
 * TerminalSplitHeaders, and useProjectLifecycle (tab save/restore on switch).
 *
 * Boundaries: no Tauri calls of its own — PTYs are driven through
 * `TerminalHandle` refs (`terminalRefsMap`, keyed `${projectPath}::${tabId}`);
 * persistence (`get/set_terminal_state`) is the caller's job.
 *
 * Gotchas: `restoreTerminalTabs` is deliberately idempotent — if the project
 * already has in-memory state, restoring would clobber live hot-session PTYs,
 * so it no-ops. Split-pane sizes always re-sum to 100: closing/removing a pane
 * redistributes its share across survivors, and `setSplitPaneSizes` clamps to
 * a 12% minimum then renormalizes.
 *
 * @module hooks/useTerminalManagement
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { TerminalHandle } from '../components/terminal/Terminal';
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
  /** Tab ids visible side-by-side in split view, one per pane.
   *  `null` = split view disabled (single-pane, default). Only meaningful
   *  in focus mode with >=2 tabs; UI enforces those preconditions. */
  splitPaneTabIds: number[] | null;
  /** Width of each split pane as a percentage of the container, one per
   *  pane. Sums to 100. `null` when split is off. */
  splitPaneSizes: number[] | null;
}

/** Minimum pane width as a percentage of the container. Below this the
 *  agent name + chevron starts truncating uncomfortably. */
const MIN_SPLIT_PANE_PERCENT = 12;

/** Dispatch a window resize event so xterm's FitAddon refits to the new
 *  pane width. Matches the 50ms delay `SplitPane` uses on collapse, so
 *  the DOM has committed the new layout before refit runs. */
function dispatchTerminalResize(): void {
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}

/** A session (project) that should have its terminal components rendered. */
export interface TerminalSessionView {
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: number;
  sessionEpoch: number;
  splitPaneTabIds: number[] | null;
  splitPaneSizes: number[] | null;
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
  /** Relaunch a tab's agent with a fresh session (used after it exits).
   *  Defaults to the current project; pass a path to target a background one. */
  restartTerminalTab: (tabId: number, projectPath?: string) => void;
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
  /** Current project's split-pane assignment, or null when split is off. */
  splitPaneTabIds: number[] | null;
  /** Width of each split pane as percentage of container, sums to 100. */
  splitPaneSizes: number[] | null;
  /** Turn on side-by-side view; initializes with the current active tab
   *  plus the next available tab. No-op if fewer than 2 tabs exist. */
  enableSplitView: () => void;
  /** Turn off side-by-side view and return to single-pane. */
  disableSplitView: () => void;
  /** Replace the tab assigned to a given pane index. */
  setSplitPaneTab: (paneIndex: number, tabId: number) => void;
  /** Append a new pane showing `tabId` (or the first unused tab). */
  addSplitPane: (tabId?: number) => void;
  /** Remove the pane at `paneIndex`. If only one pane remains, disable split. */
  removeSplitPane: (paneIndex: number) => void;
  /** Replace the pane width percentages. Caller must ensure they sum to
   *  100 and each is >= MIN_SPLIT_PANE_PERCENT. */
  setSplitPaneSizes: (sizes: number[]) => void;
}

function makeDefaultState(): ProjectTerminalState {
  return {
    tabs: [{ id: 1, agentId: getDefaultAgentId(), sessionId: crypto.randomUUID() }],
    activeTabId: 1,
    counter: 1,
    sessionEpoch: 1,
    splitPaneTabIds: null,
    splitPaneSizes: null,
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
  const splitPaneTabIds = currentState?.splitPaneTabIds ?? null;
  const splitPaneSizes = currentState?.splitPaneSizes ?? null;

  const allSessions = useMemo<TerminalSessionView[]>(() => {
    void epoch;
    const out: TerminalSessionView[] = [];
    for (const [projectPath, s] of statesRef.current.entries()) {
      out.push({
        projectPath,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        sessionEpoch: s.sessionEpoch,
        splitPaneTabIds: s.splitPaneTabIds,
        splitPaneSizes: s.splitPaneSizes,
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
      if (s.activeTabId === tabId) return; // no-op when already active
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
      // Drop the closed tab from split panes; disable split if the
      // remaining pane count would fall below 2 (or no tabs left to show).
      // Sizes shrink with the panes — redistribute the closed pane's
      // share equally across survivors so widths still sum to 100.
      if (s.splitPaneTabIds && s.splitPaneSizes) {
        const removedIdx = s.splitPaneTabIds.indexOf(tabId);
        const remainingIds = s.splitPaneTabIds.filter((id) => id !== tabId);
        if (remainingIds.length >= 2 && removedIdx >= 0) {
          const removedShare = s.splitPaneSizes[removedIdx] ?? 0;
          const remainingSizes = s.splitPaneSizes.filter((_, i) => i !== removedIdx);
          const bonus = removedShare / remainingSizes.length;
          s.splitPaneTabIds = remainingIds;
          s.splitPaneSizes = remainingSizes.map((sz) => sz + bonus);
        } else {
          s.splitPaneTabIds = null;
          s.splitPaneSizes = null;
        }
        dispatchTerminalResize();
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

  const restartTerminalTab = useCallback(
    (tabId: number, projectPath?: string) => {
      const path = projectPath ?? currentPathRef.current;
      if (!path) return;
      const s = statesRef.current.get(path);
      if (!s) return;

      // No-op while the agent is still running: restart only recovers a tab
      // whose process has exited. This guards every entry point (in-terminal
      // Enter, toolbar, palette) so a stray "Restart" can't kill a live agent
      // and drop its conversation. A missing ref means nothing is mounted to
      // kill, so we let the relaunch proceed.
      const ref = terminalRefsMap.current.get(refKey(path, tabId));
      if (ref && !ref.isExited()) return;

      // Kill the (exited) PTY, then mint a fresh session id so the relaunch
      // never collides with the prior conversation's id. Same agent — only the
      // session changes. Bumping sessionEpoch forces a clean xterm remount,
      // matching switchTabAgent.
      if (ref) ref.kill();
      terminalRefsMap.current.delete(refKey(path, tabId));

      s.tabs = s.tabs.map((t) =>
        t.id === tabId ? { ...t, sessionId: crypto.randomUUID(), shouldResume: false } : t
      );
      s.sessionEpoch += 1;
      bump();
      void trackEvent('terminal_tab_restarted', { $screen_name: 'Workspace' });
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
        splitPaneTabIds: null,
        splitPaneSizes: null,
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

  const enableSplitView = useCallback(() => {
    const s = getCurrent();
    if (!s || s.tabs.length < 2) return;
    const active = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];
    const other = s.tabs.find((t) => t.id !== active.id);
    if (!other) return;
    s.splitPaneTabIds = [active.id, other.id];
    s.splitPaneSizes = [50, 50];
    bump();
    dispatchTerminalResize();
    void trackEvent('split_view_enabled', {
      pane_count: 2,
      $screen_name: 'Workspace',
    });
  }, [bump, getCurrent]);

  const disableSplitView = useCallback(() => {
    const s = getCurrent();
    if (!s || s.splitPaneTabIds === null) return;
    s.splitPaneTabIds = null;
    s.splitPaneSizes = null;
    bump();
    dispatchTerminalResize();
    void trackEvent('split_view_disabled', { $screen_name: 'Workspace' });
  }, [bump, getCurrent]);

  const setSplitPaneTab = useCallback(
    (paneIndex: number, tabId: number) => {
      const s = getCurrent();
      if (!s || !s.splitPaneTabIds) return;
      if (paneIndex < 0 || paneIndex >= s.splitPaneTabIds.length) return;
      if (!s.tabs.some((t) => t.id === tabId)) return;
      // No-op when the pane already shows this tab — saves a render and
      // makes the menu-click case ergonomic.
      if (s.splitPaneTabIds[paneIndex] === tabId) return;
      // Avoid duplicate panes — if this tab is already in another pane,
      // swap them so each agent appears at most once.
      const existingIdx = s.splitPaneTabIds.indexOf(tabId);
      const next = [...s.splitPaneTabIds];
      if (existingIdx >= 0) {
        next[existingIdx] = next[paneIndex];
      }
      next[paneIndex] = tabId;
      s.splitPaneTabIds = next;
      bump();
    },
    [bump, getCurrent]
  );

  const addSplitPane = useCallback(
    (tabId?: number) => {
      const s = getCurrent();
      if (!s) return;
      const currentIds = s.splitPaneTabIds ?? [];
      if (currentIds.length >= s.tabs.length) return; // no more agents to show
      let target = tabId;
      if (target === undefined || currentIds.includes(target)) {
        const unused = s.tabs.find((t) => !currentIds.includes(t.id));
        target = unused?.id;
      }
      if (target === undefined) return;
      const nextIds = [...currentIds, target];
      // Carve the new pane's share off the existing panes proportionally.
      // `each = 100/nextLen` keeps panes equal-width after a manual add;
      // this matches user intuition ("I added a pane, they're all equal
      // again") and avoids drift from many adds/removes.
      const equalShare = 100 / nextIds.length;
      s.splitPaneTabIds = nextIds;
      s.splitPaneSizes = nextIds.map(() => equalShare);
      bump();
      dispatchTerminalResize();
    },
    [bump, getCurrent]
  );

  const removeSplitPane = useCallback(
    (paneIndex: number) => {
      const s = getCurrent();
      if (!s || !s.splitPaneTabIds || !s.splitPaneSizes) return;
      if (paneIndex < 0 || paneIndex >= s.splitPaneTabIds.length) return;
      const removedTabId = s.splitPaneTabIds[paneIndex];
      const removedShare = s.splitPaneSizes[paneIndex];
      const nextIds = s.splitPaneTabIds.filter((_, i) => i !== paneIndex);
      const nextSizes = s.splitPaneSizes.filter((_, i) => i !== paneIndex);
      if (nextIds.length >= 2) {
        // Redistribute the removed share equally so widths still sum to 100.
        const bonus = removedShare / nextSizes.length;
        s.splitPaneTabIds = nextIds;
        s.splitPaneSizes = nextSizes.map((sz) => sz + bonus);
      } else {
        s.splitPaneTabIds = null;
        s.splitPaneSizes = null;
      }
      // If the removed pane held the active tab, hand focus to a surviving
      // pane's tab. Without this, the single-pane fallback re-renders
      // showing the agent the user just dismissed.
      if (removedTabId === s.activeTabId) {
        const survivor = nextIds[0] ?? s.tabs[0]?.id;
        if (survivor !== undefined) s.activeTabId = survivor;
      }
      bump();
      dispatchTerminalResize();
    },
    [bump, getCurrent]
  );

  const setSplitPaneSizes = useCallback(
    (sizes: number[]) => {
      const s = getCurrent();
      if (!s || !s.splitPaneTabIds) return;
      if (sizes.length !== s.splitPaneTabIds.length) return;
      // Caller is responsible for clamping; defend anyway so a buggy
      // caller can't push a pane to 0% (would freeze its xterm).
      const clamped = sizes.map((sz) => Math.max(MIN_SPLIT_PANE_PERCENT, sz));
      const total = clamped.reduce((a, b) => a + b, 0);
      // Renormalize to 100 in case clamping changed the sum.
      s.splitPaneSizes = clamped.map((sz) => (sz * 100) / total);
      bump();
      // Frequent drag updates — skip the resize dispatch here; the
      // caller (drag handler) emits it on mouseup.
    },
    [bump, getCurrent]
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
    restartTerminalTab,
    getActiveTabAgent,
    restoreTerminalTabs,
    ensureProjectSeeded,
    splitPaneTabIds,
    splitPaneSizes,
    enableSplitView,
    disableSplitView,
    setSplitPaneTab,
    addSplitPane,
    removeSplitPane,
    setSplitPaneSizes,
  };
}
