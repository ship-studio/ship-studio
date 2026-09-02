import { useEffect, useState } from 'react';
import {
  listStudioExchanges,
  mergeExchangeSnapshot,
  onStudioExchangeUpdated,
  upsertExchange,
  type StudioExchange,
} from '../lib/studioTalk';
import { logger } from '../lib/logger';

/**
 * Live view of the cross-project exchange registry, newest first.
 * Subscribes before fetching the snapshot so no update is lost; event
 * payloads win over the snapshot on conflict (they're at least as fresh).
 */
export function useStudioExchanges(): StudioExchange[] {
  const [exchanges, setExchanges] = useState<StudioExchange[]>([]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    onStudioExchangeUpdated((exchange) => {
      setExchanges((prev) => upsertExchange(prev, exchange));
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
        // Snapshot only after the subscription is live — the merge keeps
        // event-sourced entries on top of anything the snapshot returns.
        return listStudioExchanges();
      })
      .then((snapshot) => {
        if (!disposed) setExchanges((prev) => mergeExchangeSnapshot(prev, snapshot));
      })
      .catch((err) => {
        logger.warn('[StudioTalk] Failed to load exchanges', { error: String(err) });
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return exchanges;
}
