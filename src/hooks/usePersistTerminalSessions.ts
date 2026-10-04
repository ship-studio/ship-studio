/**
 * Keep `.shipstudio/project.json` in step with the in-memory agent tabs.
 *
 * `useTerminalManagement` owns the tab lists and deliberately does not touch
 * the disk. This hook is the writer: every change to `allSessions` persists,
 * and quit flushes the same snapshot (issue #1073).
 *
 * @module hooks/usePersistTerminalSessions
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  persistTerminalSessions,
  registerTerminalSessionSource,
  type TerminalSessionSnapshot,
} from '../lib/terminalStatePersistence';

export function usePersistTerminalSessions(sessions: readonly TerminalSessionSnapshot[]): void {
  const sessionsRef = useRef(sessions);
  // Quit reads this ref from outside React. The assignment waits until the
  // render commits: a layout effect still runs before the browser can take
  // the next click, and a discarded render cannot leak tabs that never
  // became the screen (issue #1073).
  useLayoutEffect(() => {
    sessionsRef.current = sessions;
  });

  useEffect(() => {
    registerTerminalSessionSource(() => sessionsRef.current);
    return () => registerTerminalSessionSource(null);
  }, []);

  useEffect(() => {
    void persistTerminalSessions(sessions);
  }, [sessions]);
}
