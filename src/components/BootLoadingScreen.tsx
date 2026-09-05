/**
 * Boot loading screen with a hang watchdog.
 *
 * Shown while the app decides its initial view (setup checks, CLI probes).
 * Every boot gate carries its own timeout, but as a last line of defense: if
 * we are somehow still stuck here after {@link BOOT_WATCHDOG_MS}, swap the
 * progress bar for an explanation and a Restart button instead of waiting
 * forever (#173).
 *
 * @module components/BootLoadingScreen
 */

import { useEffect, useState } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { Button } from './primitives/Button';
import { Progress } from './primitives/Progress';
import { logger } from '../lib/logger';

/** How long the loading view may spin before we assume boot is wedged. */
export const BOOT_WATCHDOG_MS = 25_000;

interface BootLoadingScreenProps {
  /** Current startup gate progress, expressed as a percentage. */
  progress?: number;
}

export function BootLoadingScreen({ progress = 0 }: BootLoadingScreenProps) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      logger.error('Boot watchdog fired: still on loading view after timeout', {
        timeoutMs: BOOT_WATCHDOG_MS,
      });
      setTimedOut(true);
    }, BOOT_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, []);

  const handleRestart = async () => {
    try {
      await relaunch();
    } catch (err) {
      // In dev mode relaunch might not work — fall back to a reload.
      logger.error('Relaunch failed, trying reload', {
        error: err instanceof Error ? err.message : String(err),
      });
      window.location.reload();
    }
  };

  return (
    <div className="app loading">
      <img src="/ship_studio_full.png" alt="Ship Studio" className="app-logo" />
      {timedOut ? (
        <div className="boot-watchdog">
          <p>
            Ship Studio is taking longer than expected to start. A startup check may be stuck —
            restarting usually fixes this.
          </p>
          <Button variant="primary" onClick={() => void handleRestart()}>
            Restart Ship Studio
          </Button>
          <p className="boot-watchdog-hint">
            If this keeps happening, check the logs at ~/Library/Logs/ShipStudio/ and reach out on
            Slack.
          </p>
        </div>
      ) : (
        <Progress value={progress} aria-label="Starting Ship Studio" className="boot-progress" />
      )}
    </div>
  );
}
