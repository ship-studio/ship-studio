/**
 * Starts and closes agent tabs, and shows projects, when an agent or remote
 * access asks.
 *
 * The server side (src-tauri/src/remote_access) can't touch tabs itself —
 * they belong to the workspace's terminal model — so `start_agent` and
 * `close_agent` emit `remote-start-agent` / `remote-close-agent` to the window
 * that owns the project (or the main window) and then watch the PTY registry
 * for the result. This hook is the other half.
 *
 * - **Start** and **close** never touch the window: the tab is spawned or
 *   closed in the background (lib/backgroundSessions) and the project's tab
 *   list adopts or drops it, whichever project is showing. The user sees the
 *   new tab when they next open the project, conversation and all. Start is
 *   spawn-not-paste, as for the Inbox (see useWorkflowHandoff).
 * - **Show** opens the project, for remote access's screenshot when no dev
 *   server is running (`remote-show-project`). Ship Studio's own agents never
 *   send it.
 * - **Focus** opens the project with one tab selected: "Open session" on an
 *   agent's session card (`openAgentSession`), which the user clicked.
 *
 * Nobody may be looking when one of these fails, so a failure is simply not
 * acting: the Rust side times out and tells whoever asked.
 *
 * @module hooks/useRemoteAgentControl
 */

import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../lib/logger';
import { basename } from '../lib/paths';
import type { Project } from '../lib/project';
import {
  closeInBackground,
  startInBackground,
  type BackgroundResult,
  type BackgroundTabs,
} from '../lib/backgroundSessions';

/** Matches the Rust side's own wait, so neither outlives the other. */
const GIVE_UP_MS = 60_000;

/** What opens a project in the window: the user's "Open session", or remote access. */
export type RemoteRequest =
  /** Just bring the project up, so its preview can be screenshotted. */
  | { kind: 'show'; projectPath: string; receivedAt: number }
  /** Open the project with this session's tab selected. */
  | { kind: 'focus'; projectPath: string; sessionId: string; receivedAt: number };

/** "Open session" from an agent's chat: the project, with that tab showing. */
const focusListeners = new Set<(request: RemoteRequest) => void>();
export function openAgentSession(projectPath: string, sessionId: string): void {
  const request: RemoteRequest = { kind: 'focus', projectPath, sessionId, receivedAt: Date.now() };
  focusListeners.forEach((listener) => listener(request));
}

interface TabRef {
  id: number;
  sessionId: string;
}

interface WorkspaceState {
  currentProjectPath: string | null;
  /** True while the workspace (not the dashboard) is showing. */
  inWorkspace: boolean;
  terminalTabs: readonly TabRef[];
}

/** The slice of the workspace's terminal bundle this needs. */
interface TerminalControls extends BackgroundTabs {
  terminalTabs: readonly TabRef[];
  setActiveTerminalTab: (tabId: number) => void;
}

export type RemoteStep =
  | { do: 'idle' }
  | { do: 'wait' }
  | { do: 'focus'; tabId: number }
  | { do: 'shown' }
  | { do: 'drop'; reason: 'expired' };

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
  const showing = state.inWorkspace && state.currentProjectPath === pending.projectPath;
  if (pending.kind === 'show') return showing ? { do: 'shown' } : { do: 'wait' };
  if (!showing || state.terminalTabs.length === 0) return { do: 'wait' };
  const tab = state.terminalTabs.find((t) => t.sessionId === pending.sessionId);
  // A closed session still opens its project; there's just no tab to pick.
  return tab ? { do: 'focus', tabId: tab.id } : { do: 'shown' };
}

function report(kind: 'start' | 'close', projectPath: string, run: Promise<BackgroundResult>) {
  run
    .then((result) => {
      if (!result.ok) {
        logger.warn('[Remote] Did not act on a remote request', {
          projectPath,
          kind,
          reason: result.reason,
        });
      }
    })
    .catch((err: unknown) => {
      logger.warn('[Remote] A background tab request failed', {
        projectPath,
        kind,
        error: String(err),
      });
    });
}

export function useRemoteAgentControl(
  currentProjectPath: string | null,
  inWorkspace: boolean,
  terminals: TerminalControls,
  openProject: (project: Project) => void | Promise<void>
): void {
  const { terminalTabs, setActiveTerminalTab } = terminals;
  // Background work outlives the render that started it; it reads the
  // terminal model as it is when it gets there.
  const terminalsRef = useRef<BackgroundTabs>(terminals);
  useEffect(() => {
    terminalsRef.current = terminals;
  });

  // A queue, not a slot: two requests can arrive while a project is still
  // opening, and the second must not silently replace the first.
  const [queue, setQueue] = useState<RemoteRequest[]>([]);
  const pending = queue[0] ?? null;
  const enqueue = (request: RemoteRequest) => setQueue((q) => [...q, request]);
  // Finish the head of the queue — only if it's still the one we acted on.
  const finish = (done: RemoteRequest) => setQueue((q) => (q[0] === done ? q.slice(1) : q));

  useEffect(() => {
    // A proxy that always reads the latest terminal model.
    const live: BackgroundTabs = {
      get maxTerminalTabs() {
        return terminalsRef.current.maxTerminalTabs;
      },
      tabsForProject: (path) => terminalsRef.current.tabsForProject(path),
      adoptTerminalTab: (path, tab) => terminalsRef.current.adoptTerminalTab(path, tab),
      closeTerminalTab: (id, path) => terminalsRef.current.closeTerminalTab(id, path),
    };
    const unlistenStart = listen<{ projectPath: string; prompt: string; sessionId: string }>(
      'remote-start-agent',
      ({ payload: { projectPath, prompt, sessionId } }) => {
        logger.info('[Remote] Starting an agent tab in the background', { projectPath });
        report('start', projectPath, startInBackground(live, projectPath, sessionId, prompt));
      }
    );
    const unlistenClose = listen<{ projectPath: string; sessionId: string }>(
      'remote-close-agent',
      ({ payload: { projectPath, sessionId } }) => {
        logger.info('[Remote] Closing an agent tab', { projectPath });
        report('close', projectPath, closeInBackground(live, projectPath, sessionId));
      }
    );
    const unlistenShow = listen<{ projectPath: string }>('remote-show-project', (event) => {
      const { projectPath } = event.payload;
      logger.info('[Remote] Asked to show a project', { projectPath });
      enqueue({ kind: 'show', projectPath, receivedAt: Date.now() });
    });
    focusListeners.add(enqueue);
    return () => {
      focusListeners.delete(enqueue);
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
    const step = remoteStep(pending, { currentProjectPath, inWorkspace, terminalTabs }, Date.now());
    if (step.do === 'focus') {
      setActiveTerminalTab(step.tabId);
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
  }, [pending, currentProjectPath, inWorkspace, terminalTabs, setActiveTerminalTab]);

  // A request that is waiting needs something to re-check the clock even if
  // nothing else re-renders, or it would never expire.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => finish(pending), GIVE_UP_MS + 1_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
}
