/**
 * Puts the window back on Agents after an agent used a project in it.
 *
 * An agent works on a project through its real workspace tabs, and a tab
 * only starts (and a preview only renders) while the project is showing. So
 * when an agent starts a session or takes a screenshot, the window switches
 * to that project, the same as for remote access. If you were reading Agents
 * in that window, that switch was the agent's doing, not yours: the backend
 * brackets the call with `agents-session-begin` / `-end`, and at the end the
 * window goes back to Agents, unless you've since gone somewhere else.
 *
 * @module hooks/useAgentsReturn
 */

import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

/** Calls in flight per project that began while Agents was showing. */
export type Borrowed = ReadonlyMap<string, number>;

export function agentsReturnStep(
  borrowed: Borrowed,
  event: 'begin' | 'end',
  projectPath: string,
  view: string,
  currentPath: string | null
): { borrowed: Borrowed; goBack: boolean } {
  const next = new Map(borrowed);
  const count = next.get(projectPath) ?? 0;
  if (event === 'begin') {
    // Only a call that found you in Agents (or joins one that did) borrows.
    if (view === 'agents' || count > 0) next.set(projectPath, count + 1);
    return { borrowed: next, goBack: false };
  }
  if (count === 0) return { borrowed, goBack: false };
  if (count > 1) {
    next.set(projectPath, count - 1);
    return { borrowed: next, goBack: false };
  }
  next.delete(projectPath);
  return { borrowed: next, goBack: view === 'workspace' && currentPath === projectPath };
}

export function useAgentsReturn(
  view: string,
  currentPath: string | null,
  goToAgents: () => void
): void {
  const state = useRef({ view, currentPath, goToAgents });
  useEffect(() => {
    state.current = { view, currentPath, goToAgents };
  }, [view, currentPath, goToAgents]);
  const borrowed = useRef<Borrowed>(new Map());

  useEffect(() => {
    const on = (event: 'begin' | 'end') =>
      listen<{ projectPath: string }>(`agents-session-${event}`, ({ payload }) => {
        const { view: now, currentPath: path, goToAgents: back } = state.current;
        const step = agentsReturnStep(borrowed.current, event, payload.projectPath, now, path);
        borrowed.current = step.borrowed;
        if (step.goBack) back();
      });
    const unlisten = [on('begin'), on('end')];
    return () => unlisten.forEach((u) => void u.then((fn) => fn()));
  }, []);
}
