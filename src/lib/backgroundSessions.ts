/**
 * Agent tabs started and closed without showing their project.
 *
 * Ship Studio's agents and remote access work in a project's real agent tabs.
 * A tab used to start only by opening its project in the window — so an agent
 * starting a session switched the user's window. Now the PTY is spawned here,
 * in the background, with exactly the command line a mounted tab would use
 * (`buildAgentSpawn`), and the project's tab list adopts it:
 *
 * - **Tracked in this window** (the project was opened this session): the tab
 *   joins its in-memory list. The active tab is left alone.
 * - **Not tracked:** the tab joins the project's saved tab list, which is what
 *   opening the project restores from. The Terminal that mounts then attaches
 *   to the live PTY (open is idempotent) and replays its scrollback, so the
 *   whole conversation is there.
 *
 * Nothing here changes what the window shows.
 *
 * @module lib/backgroundSessions
 */

import { buildAgentSpawn } from './agentSpawn';
import { getAgentById, getDefaultAgentId } from './agent';
import { killPtySession, openPtySession } from './ptySession';
import {
  getAutoAcceptMode,
  getTerminalState,
  setTerminalState,
  type SavedTerminalState,
} from './project';

/** A background tab's terminal size until a Terminal mounts and fits it. */
export const BACKGROUND_COLS = 120;
export const BACKGROUND_ROWS = 40;

interface Tab {
  id: number;
  sessionId: string;
}

/** The slice of the workspace's terminal state a background tab needs. */
export interface BackgroundTabs {
  maxTerminalTabs: number;
  tabsForProject: (projectPath: string) => readonly Tab[] | null;
  adoptTerminalTab: (projectPath: string, tab: { agentId: string; sessionId: string }) => boolean;
  closeTerminalTab: (tabId: number, projectPath?: string) => void;
}

export type BackgroundResult =
  | { ok: true }
  | { ok: false; reason: 'no_room' | 'last_tab' | 'no_such_tab' };

/** The saved tab list with `tab` added, keeping the active tab; null when full. */
export function savedWithTab(
  saved: SavedTerminalState | null,
  tab: { agent_id: string; session_id: string },
  max: number
): SavedTerminalState | null {
  const tabs = saved?.tabs ?? [];
  if (tabs.some((t) => t.session_id === tab.session_id)) return saved;
  if (tabs.length >= max) return null;
  return { tabs: [...tabs, tab], active_tab_index: saved?.active_tab_index ?? 0 };
}

/** The saved tab list without `sessionId`, the active tab still pointing at the same tab. */
export function savedWithoutTab(
  saved: SavedTerminalState,
  sessionId: string
): SavedTerminalState | null {
  const at = saved.tabs.findIndex((t) => t.session_id === sessionId);
  if (at < 0 || saved.tabs.length <= 1) return null;
  const active = saved.active_tab_index;
  return {
    tabs: saved.tabs.filter((_, i) => i !== at),
    // Like the tab's ×: closing the active tab selects the one before it.
    active_tab_index: active > at ? active - 1 : active === at ? Math.max(0, at - 1) : active,
  };
}

/** Start an agent tab in `projectPath` whose CLI opens with `prompt`. */
export async function startInBackground(
  terminals: BackgroundTabs,
  projectPath: string,
  sessionId: string,
  prompt: string
): Promise<BackgroundResult> {
  const max = terminals.maxTerminalTabs;
  const tracked = terminals.tabsForProject(projectPath);
  const saved = tracked ? null : await getTerminalState(projectPath).catch(() => null);
  const room = tracked ? tracked.length < max : (saved?.tabs.length ?? 0) < max;
  if (!room) return { ok: false, reason: 'no_room' };

  // The same agent a new tab gets ("+" in the tab bar).
  const agentId = getDefaultAgentId();
  const agent = getAgentById(agentId);
  const autoAccept = await getAutoAcceptMode(projectPath).catch(() => false);
  const spawn = await buildAgentSpawn({
    agent,
    projectPath,
    sessionName: sessionId,
    autoAccept,
    initialPrompt: prompt,
  });
  await openPtySession({
    sessionId,
    command: spawn.command,
    args: spawn.args,
    cwd: projectPath,
    env: spawn.env,
    cols: BACKGROUND_COLS,
    rows: BACKGROUND_ROWS,
    projectPath,
    agentId,
  });

  if (terminals.adoptTerminalTab(projectPath, { agentId, sessionId })) return { ok: true };
  // Not tracked in this window (or it filled up meanwhile): the saved list,
  // read fresh, is what the project's tabs are restored from when it opens.
  const latest = await getTerminalState(projectPath).catch(() => saved);
  const next = savedWithTab(latest, { agent_id: agentId, session_id: sessionId }, max);
  if (next) await setTerminalState(projectPath, next);
  return { ok: true };
}

/** Close an agent tab, the same as its ×, whether or not its project is showing. */
export async function closeInBackground(
  terminals: BackgroundTabs,
  projectPath: string,
  sessionId: string
): Promise<BackgroundResult> {
  const tracked = terminals.tabsForProject(projectPath);
  if (tracked) {
    const tab = tracked.find((t) => t.sessionId === sessionId);
    if (!tab) return { ok: false, reason: 'no_such_tab' };
    if (tracked.length <= 1) return { ok: false, reason: 'last_tab' };
    terminals.closeTerminalTab(tab.id, projectPath);
  } else {
    const saved = await getTerminalState(projectPath).catch(() => null);
    const next = saved && savedWithoutTab(saved, sessionId);
    if (next) await setTerminalState(projectPath, next);
  }
  // A Terminal that's mounted killed it already; one that isn't can't.
  await killPtySession(sessionId);
  return { ok: true };
}
