/**
 * Custom hook for managing terminal tabs and sessions.
 *
 * Extracted from App.tsx to reduce component complexity. This hook encapsulates
 * all terminal tab state and logic, which is self-contained and frequently used
 * throughout the workspace UI.
 *
 * Provides state and callbacks for creating, closing, and switching between
 * terminal tabs, as well as killing all terminal processes.
 *
 * @module hooks/useTerminalManagement
 */

import { useState, useRef, useCallback } from 'react';
import type { TerminalHandle } from '../components/Terminal';
import { getAgentById, getDefaultAgentId } from '../lib/agent';
import type { AgentConfig } from '../lib/agent';
import { trackEvent } from '../lib/analytics';
import { logger } from '../lib/logger';

/** Maximum number of terminal tabs allowed */
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

/** Return type for useTerminalManagement hook */
export interface UseTerminalManagementReturn {
  /** Array of terminal tabs */
  terminalTabs: TerminalTab[];
  /** Currently active terminal tab ID */
  activeTerminalTab: number;
  /** Session ID that changes when project changes (forces terminal remount) */
  terminalSessionId: number;
  /** Map of tab IDs to terminal refs */
  terminalRefsMap: React.MutableRefObject<Map<number, TerminalHandle | null>>;
  /** Maximum number of terminal tabs allowed */
  maxTerminalTabs: number;
  /** Set the active terminal tab */
  setActiveTerminalTab: (tabId: number) => void;
  /** Add a new terminal tab */
  addTerminalTab: () => void;
  /** Close a terminal tab by ID */
  closeTerminalTab: (tabId: number) => void;
  /** Kill all terminal processes */
  killAllTerminals: () => void;
  /** Reset terminals for a new project */
  resetTerminals: () => void;
  /** Get the ref for the active terminal */
  getActiveTerminalRef: () => TerminalHandle | null;
  /** Focus the active terminal */
  focusActiveTerminal: () => void;
  /** Paste text into the active terminal */
  pasteToActiveTerminal: (text: string) => void;
  /** Switch the agent for a specific tab (kills PTY and remounts) */
  switchTabAgent: (tabId: number, agentId: string) => void;
  /** Get the agent config for the currently active tab */
  getActiveTabAgent: () => AgentConfig;
  /** Restore terminal tabs from saved state (used when reopening a project) */
  restoreTerminalTabs: (
    tabs: Array<{ agentId: string; sessionId: string }>,
    activeIndex: number
  ) => void;
}

/**
 * Hook for managing terminal tabs and sessions.
 *
 * @example
 * ```tsx
 * const {
 *   terminalTabs,
 *   activeTerminalTab,
 *   addTerminalTab,
 *   closeTerminalTab,
 *   focusActiveTerminal
 * } = useTerminalManagement();
 *
 * // Add a new tab
 * addTerminalTab();
 *
 * // Close a specific tab
 * closeTerminalTab(tabId);
 *
 * // Focus the active terminal
 * focusActiveTerminal();
 * ```
 *
 * @returns Terminal management state and control functions
 */
export function useTerminalManagement(): UseTerminalManagementReturn {
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([
    { id: 1, agentId: getDefaultAgentId(), sessionId: crypto.randomUUID() },
  ]);
  const [activeTerminalTab, setActiveTerminalTab] = useState(1);
  const [terminalSessionId, setTerminalSessionId] = useState(1);
  const terminalRefsMap = useRef<Map<number, TerminalHandle | null>>(new Map());
  const terminalTabCounterRef = useRef(1);

  const killAllTerminals = useCallback(() => {
    const tabCount = terminalRefsMap.current.size;
    logger.info('[TerminalMgmt] Killing all terminals', { tabCount });
    terminalRefsMap.current.forEach((ref, tabId) => {
      logger.info('[TerminalMgmt] Killing terminal', { tabId });
      ref?.kill();
    });
    terminalRefsMap.current.clear();
    logger.info('[TerminalMgmt] All terminals killed');
  }, []);

  const addTerminalTab = useCallback(() => {
    if (terminalTabs.length >= MAX_TERMINAL_TABS) {
      logger.warn('[TerminalMgmt] Max tabs reached', { max: MAX_TERMINAL_TABS });
      return;
    }
    const newTabId = ++terminalTabCounterRef.current;
    const sessionId = crypto.randomUUID();
    logger.info('[TerminalMgmt] Adding new tab', {
      tabId: newTabId,
      sessionId,
      totalTabs: terminalTabs.length + 1,
    });
    setTerminalTabs((prev) => [...prev, { id: newTabId, agentId: getDefaultAgentId(), sessionId }]);
    setActiveTerminalTab(newTabId);
    void trackEvent('terminal_tab_added', {
      tab_count: terminalTabs.length + 1,
      $screen_name: 'Workspace',
    });
  }, [terminalTabs.length]);

  const closeTerminalTab = useCallback(
    (tabId: number) => {
      // Don't close if it's the last tab
      if (terminalTabs.length <= 1) return;

      // Kill the PTY process BEFORE removing from state to prevent orphaned processes
      const ref = terminalRefsMap.current.get(tabId);
      if (ref) {
        ref.kill();
      }

      setTerminalTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabId);
        // If we're closing the active tab, switch to the previous one or the first
        if (tabId === activeTerminalTab) {
          const closedIndex = prev.findIndex((t) => t.id === tabId);
          const newActiveIndex = Math.max(0, closedIndex - 1);
          setActiveTerminalTab(newTabs[newActiveIndex].id);
        }
        return newTabs;
      });
      // Clean up the ref
      terminalRefsMap.current.delete(tabId);
      void trackEvent('terminal_tab_closed', { $screen_name: 'Workspace' });
    },
    [terminalTabs, activeTerminalTab]
  );

  const resetTerminals = useCallback(() => {
    killAllTerminals();
    terminalTabCounterRef.current = 1;
    setTerminalTabs([{ id: 1, agentId: getDefaultAgentId(), sessionId: crypto.randomUUID() }]);
    setActiveTerminalTab(1);
    setTerminalSessionId((prev) => prev + 1);
  }, [killAllTerminals]);

  const getActiveTerminalRef = useCallback(() => {
    return terminalRefsMap.current.get(activeTerminalTab) ?? null;
  }, [activeTerminalTab]);

  const focusActiveTerminal = useCallback(() => {
    terminalRefsMap.current.get(activeTerminalTab)?.focus();
  }, [activeTerminalTab]);

  const pasteToActiveTerminal = useCallback(
    (text: string) => {
      terminalRefsMap.current.get(activeTerminalTab)?.paste(text);
    },
    [activeTerminalTab]
  );

  const switchTabAgent = useCallback((tabId: number, agentId: string) => {
    // Kill the existing PTY for this tab
    const ref = terminalRefsMap.current.get(tabId);
    if (ref) {
      ref.kill();
    }
    terminalRefsMap.current.delete(tabId);

    // Update the tab's agent with a fresh session ID
    setTerminalTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, agentId, sessionId: crypto.randomUUID(), shouldResume: false } : t
      )
    );
    void trackEvent('agent_switched', { agent_id: agentId, $screen_name: 'Workspace' });

    // Increment session ID to force remount of the terminal
    setTerminalSessionId((prev) => prev + 1);
  }, []);

  const getActiveTabAgent = useCallback((): AgentConfig => {
    const tab = terminalTabs.find((t) => t.id === activeTerminalTab);
    return tab ? getAgentById(tab.agentId) : getAgentById(getDefaultAgentId());
  }, [terminalTabs, activeTerminalTab]);

  const restoreTerminalTabs = useCallback(
    (tabs: Array<{ agentId: string; sessionId: string }>, activeIndex: number) => {
      if (tabs.length === 0) return;
      killAllTerminals();
      const restoredTabs: TerminalTab[] = tabs.map((t, i) => ({
        id: i + 1,
        agentId: t.agentId,
        sessionId: t.sessionId,
        shouldResume: true,
      }));
      terminalTabCounterRef.current = restoredTabs.length;
      setTerminalTabs(restoredTabs);
      const activeId = restoredTabs[Math.min(activeIndex, restoredTabs.length - 1)]?.id ?? 1;
      setActiveTerminalTab(activeId);
      setTerminalSessionId((prev) => prev + 1);
      logger.info('[TerminalMgmt] Restored tabs from saved state', {
        tabCount: restoredTabs.length,
        activeId,
      });
    },
    [killAllTerminals]
  );

  return {
    terminalTabs,
    activeTerminalTab,
    terminalSessionId,
    terminalRefsMap,
    maxTerminalTabs: MAX_TERMINAL_TABS,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    killAllTerminals,
    resetTerminals,
    getActiveTerminalRef,
    focusActiveTerminal,
    pasteToActiveTerminal,
    switchTabAgent,
    getActiveTabAgent,
    restoreTerminalTabs,
  };
}
