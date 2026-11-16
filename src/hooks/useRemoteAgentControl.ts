/**
 * Starts and closes agent tabs, and switches projects, when remote access
 * asks.
 *
 * The remote server (src-tauri/src/remote_access) can't touch tabs itself —
 * they belong to the workspace's terminal model — so `start_agent` and
 * `close_agent` emit `remote-start-agent` / `remote-close-agent` to the window
 * that owns the project (or the main window) and then watch the PTY registry
 * for the result. This hook is the other half: open the project if it isn't
 * the current one, wait for its terminals to be seeded, then do exactly what
 * the user's own click would.
 *
 * - **Start** adds a tab whose CLI *starts with* the prompt — the same
 *   spawn-not-paste delivery the Inbox uses (see useWorkflowHandoff).
 * - **Show** only opens the project, so its preview comes up for a
 *   screenshot (`remote-show-project`).
 * - **Close** is the tab's ×: `closeTerminalTab`, which also kills the PTY
 *   and tidies split panes. The last tab is never closed — the workspace
 *   always keeps one.
 *
 * Nobody is at the computer to see a failure here, so a failure is simply
 * not acting: the Rust side times out and tells the remote assistant, which
 * is the only place anyone is looking.
 *
 * @module hooks/useRemoteAgentControl
 */

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../lib/logger';
import { basename } from '../lib/paths';
import type { Project } from '../lib/project';

/** Matches the Rust side's own wait, so neither outlives the other. */
const GIVE_UP_MS = 60_000;

export type RemoteRequest =
  | {
      kind: 'start';
      projectPath: string;
      prompt: string;
      /** Chosen by the backend so it can wait for exactly this tab. */
      sessionId: string;
      receivedAt: number;
    }
  | { kind: 'close'; projectPath: string; sessionId: string; receivedAt: number }
  /** Just bring the project up, so its preview can be screenshotted. */
  | { kind: 'show'; projectPath: string; receivedAt: number };

interface TabRef {
  id: number;
  sessionId: string;
}

interface WorkspaceState {
  currentProjectPath: string | null;
  /** True while the workspace (not the dashboard) is showing. */
  inWorkspace: boolean;
  terminalTabs: readonly TabRef[];
  maxTerminalTabs: number;
}

/** The slice of the workspace's terminal bundle this needs. */
interface TerminalControls {
  terminalTabs: readonly TabRef[];
  maxTerminalTabs: number;
  addTerminalTab: (
    agentId?: string,
    options?: { initialPrompt?: string; projectPath?: string; sessionId?: string }
  ) => void;
  closeTerminalTab: (tabId: number) => void;
}

export type RemoteStep =
  | { do: 'idle' }
  | { do: 'wait' }
  | { do: 'start' }
  | { do: 'close'; tabId: number }
  | { do: 'shown' }
  | { do: 'drop'; reason: 'expired' | 'no_room' | 'no_such_tab' | 'last_tab' };

/**
 * What to do with a pending request given the workspace's state. Pure so the
 * rules can be tested without mounting the app.
 */
export function remoteStep(
  pending: RemoteRequest | null,
  state: WorkspaceState,
  now: number
): RemoteStep {
  if (!pending) return { do: 'idle' };
  if (now - pending.receivedAt > GIVE_UP_MS) return { do: 'drop', reason: 'expired' };
  if (pending.kind === 'show') {
    const showing = state.inWorkspace && state.currentProjectPath === pending.projectPath;
    return showing ? { do: 'shown' } : { do: 'wait' };
  }
  const tabs = state.terminalTabs;
  const ready =
    state.inWorkspace && state.currentProjectPath === pending.projectPath && tabs.length > 0;
  if (!ready) return { do: 'wait' };

  if (pending.kind === 'start') {
    if (state.maxTerminalTabs > 0 && tabs.length >= state.maxTerminalTabs) {
      return { do: 'drop', reason: 'no_room' };
    }
    return { do: 'start' };
  }
  const tab = tabs.find((t) => t.sessionId === pending.sessionId);
  if (!tab) return { do: 'drop', reason: 'no_such_tab' };
  if (tabs.length <= 1) return { do: 'drop', reason: 'last_tab' };
  return { do: 'close', tabId: tab.id };
}

export function useRemoteAgentControl(
  currentProjectPath: string | null,
  inWorkspace: boolean,
  { terminalTabs, maxTerminalTabs, addTerminalTab, closeTerminalTab }: TerminalControls,
  openProject: (project: Project) => void | Promise<void>
): void {
  // A queue, not a slot: two requests can arrive while a project is still
  // opening, and the second must not silently replace the first (the backend
  // would then wait a full minute for a tab that was never asked for).
  const [queue, setQueue] = useState<RemoteRequest[]>([]);
  const pending = queue[0] ?? null;
  const enqueue = (request: RemoteRequest) => setQueue((q) => [...q, request]);
  // Finish the head of the queue — only if it's still the one we acted on.
  const finish = (done: RemoteRequest) => setQueue((q) => (q[0] === done ? q.slice(1) : q));

  useEffect(() => {
    const unlistenStart = listen<{ projectPath: string; prompt: string; sessionId: string }>(
      'remote-start-agent',
      (event) => {
        const { projectPath, prompt, sessionId } = event.payload;
        logger.info('[Remote] Asked to start an agent', { projectPath });
        enqueue({ kind: 'start', projectPath, prompt, sessionId, receivedAt: Date.now() });
      }
    );
    const unlistenClose = listen<{ projectPath: string; sessionId: string }>(
      'remote-close-agent',
      (event) => {
        const { projectPath, sessionId } = event.payload;
        logger.info('[Remote] Asked to close an agent', { projectPath });
        enqueue({ kind: 'close', projectPath, sessionId, receivedAt: Date.now() });
      }
    );
    const unlistenShow = listen<{ projectPath: string }>('remote-show-project', (event) => {
      const { projectPath } = event.payload;
      logger.info('[Remote] Asked to show a project', { projectPath });
      enqueue({ kind: 'show', projectPath, receivedAt: Date.now() });
    });
    return () => {
      void unlistenStart.then((fn) => fn());
      void unlistenClose.then((fn) => fn());
      void unlistenShow.then((fn) => fn());
    };
  }, []);

  // Open the project once per request; re-opening on every render would fight
  // the user (or another request) for the window.
  const pendingPath = pending?.projectPath ?? null;
  const needsOpen = pendingPath !== null && (!inWorkspace || currentProjectPath !== pendingPath);
  useEffect(() => {
    if (!needsOpen || !pendingPath || !pending) return;
    const request = pending;
    void Promise.resolve(
      openProject({ name: basename(pendingPath), path: pendingPath, thumbnail: null })
    ).catch((err: unknown) => {
      logger.warn('[Remote] Could not open the project for a remote request', {
        projectPath: pendingPath,
        error: String(err),
      });
      finish(request);
    });
    // Only when the head of the queue changes — not on every render while it
    // waits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const step = remoteStep(
      pending,
      { currentProjectPath, inWorkspace, terminalTabs, maxTerminalTabs },
      Date.now()
    );
    if (step.do === 'start' && pending.kind === 'start') {
      addTerminalTab(undefined, {
        initialPrompt: pending.prompt,
        projectPath: pending.projectPath,
        sessionId: pending.sessionId,
      });
      finish(pending);
    } else if (step.do === 'close') {
      closeTerminalTab(step.tabId);
      finish(pending);
    } else if (step.do === 'shown') {
      finish(pending);
    } else if (step.do === 'drop') {
      logger.warn('[Remote] Did not act on a remote request', {
        projectPath: pending.projectPath,
        kind: pending.kind,
        reason: step.reason,
      });
      finish(pending);
    }
  }, [
    pending,
    currentProjectPath,
    inWorkspace,
    terminalTabs,
    maxTerminalTabs,
    addTerminalTab,
    closeTerminalTab,
  ]);

  // A request that is waiting needs something to re-check the clock even if
  // nothing else re-renders, or it would never expire.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => finish(pending), GIVE_UP_MS + 1_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
}
