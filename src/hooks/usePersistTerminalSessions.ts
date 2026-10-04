/**
 * Keep `.shipstudio/project.json` in step with the in-memory agent tabs.
 *
 * `useTerminalManagement` owns the tab lists and deliberately does not touch
 * the disk. This hook is the writer: every change to `allSessions` persists,
 * and quit flushes the same snapshot (issue #1073).
 *
 * @module hooks/usePersistTerminalSessions
 */

import { useEffect, useRef } from 'react';
import {
  persistTerminalSessions,
  registerTerminalSessionSource,
  type TerminalSessionSnapshot,
} from '../lib/terminalStatePersistence';

export function usePersistTerminalSessions(sessions: readonly TerminalSessionSnapshot[]): void {
  const sessionsRef = useRef(sessions);
  // Quit reads this ref from outside React and can arrive before effects run.
  // The snapshot has to be current during render, or the flush saves the
  // previous tabs (issue #1073).
  // eslint-disable-next-line react-hooks/refs -- quit flush must see this render's tabs
  sessionsRef.current = sessions;

  useEffect(() => {
    registerTerminalSessionSource(() => sessionsRef.current);
    return () => registerTerminalSessionSource(null);
  }, []);

  useEffect(() => {
    void persistTerminalSessions(sessions);
  }, [sessions]);
}
