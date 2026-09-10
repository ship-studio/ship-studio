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
import { asCommandError, formatCommandError } from '../lib/errors';

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
        error: formatCommandError(asCommandError(err)),
      });
      window.location.reload();
    }
  };

  return (
    <div className="app loading">
      <img src="/harbr-mark.svg" alt="Harbr" className="app-logo" />
      {timedOut ? (
        <div className="boot-watchdog">
          <p>
            Harbr is taking longer than expected to start. A startup check may be stuck — restarting
            usually fixes this.
          </p>
          <Button variant="primary" onClick={() => void handleRestart()}>
            Restart Harbr
          </Button>
          <p className="boot-watchdog-hint">
            If this keeps happening, check the logs at ~/Library/Logs/Harbr/.
          </p>
        </div>
      ) : (
        <Progress value={progress} aria-label="Starting Harbr" className="boot-progress" />
      )}
    </div>
  );
}
