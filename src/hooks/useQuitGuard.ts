/**
 * The quit guard: every way of quitting Ship Studio on purpose — ⌘Q, the
 * menu bar's Quit, the palette, and closing a window while agents work —
 * arrives here, asks the backend what a quit would interrupt, and opens the
 * confirmation with that answer.
 *
 * The backend brings the main window forward before asking (it may have been
 * hidden), except for a menu-bar Quit with nothing to interrupt, which quits
 * straight away: a deliberate menu choice needs no second question.
 *
 * The updater's restart is separate and unchanged: it waits for working agents
 * on its own (`UpdateBanner`).
 *
 * @module hooks/useQuitGuard
 */

import { useCallback, useEffect, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  QUIT_REQUEST_EVENT,
  getQuitCheck,
  keepRunningInBackground,
  type QuitCheck,
} from '../lib/agentsDesktop';
import { quitAppWithTracking } from '../lib/appLifecycle';
import { logger } from '../lib/logger';

export function useQuitGuard() {
  /** Open with what a quit would interrupt (null when that couldn't be asked). */
  const [asking, setAsking] = useState<{ check: QuitCheck | null } | null>(null);

  useEffect(() => {
    let alive = true;
    const ask = async (fromMenuBar: boolean) => {
      const check = await getQuitCheck().catch((error: unknown) => {
        logger.warn('[quit] agents_quit_check failed', { error: String(error) });
        return null;
      });
      if (!alive) return;
      if (fromMenuBar && check && check.working.length === 0 && check.waiting.length === 0) {
        void quitAppWithTracking();
        return;
      }
      setAsking({ check });
    };
    const onRequest = () => void ask(false);
    window.addEventListener(QUIT_REQUEST_EVENT, onRequest);
    const unlisten = getCurrentWebviewWindow().listen<{ fromMenuBar?: boolean } | null>(
      'confirm-quit',
      (event) => void ask(event.payload?.fromMenuBar === true)
    );
    return () => {
      alive = false;
      window.removeEventListener(QUIT_REQUEST_EVENT, onRequest);
      void unlisten.then((fn) => fn());
    };
  }, []);

  const cancel = useCallback(() => setAsking(null), []);
  const quit = useCallback(() => void quitAppWithTracking(), []);
  const keepRunning = useCallback(() => {
    setAsking(null);
    keepRunningInBackground().catch((error: unknown) =>
      logger.warn('[quit] keep running in background failed', { error: String(error) })
    );
  }, []);

  return { asking, cancel, quit, keepRunning };
}
