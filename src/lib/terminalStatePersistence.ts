/**
 * Persist agent-terminal tabs to `.shipstudio/project.json`.
 *
 * Switching projects and "Back to projects" used to be the only writers.
 * Quitting or crashing from inside a project never called them, so the tab
 * list lived only in memory and the next launch opened a blank session
 * (issue #1073). Tab changes write through as they happen, and app quit
 * flushes whatever is still dirty.
 *
 * @module lib/terminalStatePersistence
 */

import { logger } from './logger';
import { setTerminalState, type SavedTerminalTabPayload } from './project';
import { sessionRegistry } from './sessionRegistry';

export interface TerminalSessionSnapshot {
  projectPath: string;
  tabs: ReadonlyArray<{ id: number; agentId: string; sessionId: string }>;
  activeTabId: number;
}

export interface SavedTerminalState {
  tabs: SavedTerminalTabPayload[];
  active_tab_index: number;
}

export interface PersistDeps {
  write: (projectPath: string, state: SavedTerminalState) => Promise<void>;
  customTitles: (projectPath: string) => ReadonlyMap<number, string>;
  signatures: Map<string, string>;
}

/** Stable identity of a saved tab list. Equal signatures skip the disk write. */
export function terminalStateSignature(state: SavedTerminalState): string {
  const tabs = state.tabs
    .map((tab) => `${tab.agent_id}\t${tab.session_id}\t${tab.custom_title ?? ''}`)
    .join('\n');
  return `${state.active_tab_index}|${tabs}`;
}

/**
 * The payload `set_terminal_state` stores. `null` when there is nothing to
 * restore — an empty list would wipe a previous good save.
 */
export function buildSavedTerminalState(
  session: TerminalSessionSnapshot,
  customTitles: ReadonlyMap<number, string>
): SavedTerminalState | null {
  if (session.tabs.length === 0) return null;
  const activeIdx = session.tabs.findIndex((tab) => tab.id === session.activeTabId);
  return {
    tabs: session.tabs.map((tab) => ({
      agent_id: tab.agentId,
      session_id: tab.sessionId,
      custom_title: customTitles.get(tab.id),
    })),
    active_tab_index: Math.max(0, activeIdx),
  };
}

const signatures = new Map<string, string>();

function defaultDeps(): PersistDeps {
  return {
    write: setTerminalState,
    customTitles: (projectPath) => sessionRegistry.getCustomTitles(projectPath),
    signatures,
  };
}

let source: (() => readonly TerminalSessionSnapshot[]) | null = null;

/** Register the live tab lists so quit can flush them. `null` clears it. */
export function registerTerminalSessionSource(
  next: (() => readonly TerminalSessionSnapshot[]) | null
): void {
  source = next;
}

/**
 * Write each session whose tab list changed. Failures are logged and left
 * unsigned so the next change retries — a failed write must not look saved.
 */
export async function persistTerminalSessions(
  sessions: readonly TerminalSessionSnapshot[],
  deps: PersistDeps = defaultDeps()
): Promise<void> {
  await Promise.all(
    sessions.map(async (session) => {
      const saved = buildSavedTerminalState(session, deps.customTitles(session.projectPath));
      if (!saved) return;
      const signature = terminalStateSignature(saved);
      if (deps.signatures.get(session.projectPath) === signature) return;
      try {
        await deps.write(session.projectPath, saved);
        deps.signatures.set(session.projectPath, signature);
        logger.info('[TerminalState] Saved terminal tabs', {
          projectPath: session.projectPath,
          tabCount: saved.tabs.length,
        });
      } catch (err) {
        logger.warn('[TerminalState] Failed to save terminal tabs', {
          projectPath: session.projectPath,
          error: String(err),
        });
      }
    })
  );
}

/**
 * Write every live session even if this process already thinks it did.
 * Quit can race the debounced render that would have saved a just-added tab.
 */
export function flushTerminalSessions(deps: PersistDeps = defaultDeps()): Promise<void> {
  const sessions = source?.() ?? [];
  for (const session of sessions) deps.signatures.delete(session.projectPath);
  return persistTerminalSessions(sessions, deps);
}
