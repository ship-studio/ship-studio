/**
 * Keep `.shipstudio/project.json` in step with the in-memory agent tabs.
 *
 * `useTerminalManagement` owns the tab lists and deliberately does not touch
 * the disk. This hook is the writer: every committed change persists, and
 * quit flushes the live tab store instead of that snapshot (issue #1073).
 *
 * @module hooks/usePersistTerminalSessions
 */

import { useEffect } from 'react';
import {
  persistTerminalSessions,
  registerTerminalSessionSource,
  type TerminalSessionSnapshot,
} from '../lib/terminalStatePersistence';

export function usePersistTerminalSessions(
  sessions: readonly TerminalSessionSnapshot[],
  readLiveSessions: () => readonly TerminalSessionSnapshot[]
): void {
  // Quit must read the tab store, not the last committed snapshot. A handoff
  // can add a tab and schedule a render; closing the window before that
  // render commits would otherwise save the previous list (issue #1073).
  useEffect(() => {
    registerTerminalSessionSource(readLiveSessions);
    return () => registerTerminalSessionSource(null);
  }, [readLiveSessions]);

  useEffect(() => {
    void persistTerminalSessions(sessions);
  }, [sessions]);
}
