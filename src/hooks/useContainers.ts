import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listProjectContainers,
  restartContainer,
  startContainer,
  stopContainer,
  type ContainerEngineStatus,
  type ContainerInfo,
} from '../lib/containers';
import { usePolling } from './usePolling';
import { logger } from '../lib/logger';

const POLL_INTERVAL_MS = 5000;

interface UseContainersReturn {
  /** Containers attributed to the project (running first). */
  containers: ContainerInfo[];
  /** Engine availability from the last successful scan. */
  engine: ContainerEngineStatus;
  /** Ids with a start/stop/restart currently in flight. */
  pendingIds: ReadonlySet<string>;
  /** Lifecycle actions. They re-scan on completion and THROW on failure —
   *  callers surface the error (toast) per the palette contract. */
  startProjectContainer: (containerId: string) => Promise<void>;
  stopProjectContainer: (containerId: string) => Promise<void>;
  restartProjectContainer: (containerId: string) => Promise<void>;
}

/**
 * Detect and track the Docker containers that belong to a project — the
 * container-side sibling of the dev-server tracking. Polls `docker ps`
 * (label-filtered in the backend) while a project is open; polling backs off
 * exponentially on errors via `usePolling`.
 */
export function useContainers(projectPath: string | null): UseContainersReturn {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [engine, setEngine] = useState<ContainerEngineStatus>('ok');
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // Guards a stale poll response from a previous project overwriting the
  // freshly-reset state after a project switch.
  const pathRef = useRef(projectPath);
  pathRef.current = projectPath;

  useEffect(() => {
    setContainers([]);
    setEngine('ok');
    setPendingIds(new Set());
  }, [projectPath]);

  const refresh = useCallback(async () => {
    if (!projectPath) return;
    const result = await listProjectContainers(projectPath);
    if (pathRef.current !== projectPath) return;
    setEngine(result.engine);
    setContainers(result.containers);
  }, [projectPath]);

  usePolling(refresh, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: projectPath !== null,
    name: 'containers',
  });

  const runAction = useCallback(
    async (containerId: string, action: (path: string, id: string) => Promise<void>) => {
      if (!projectPath) return;
      setPendingIds((prev) => new Set(prev).add(containerId));
      try {
        await action(projectPath, containerId);
        // Fire-and-forget refresh failure: the 5s poll self-heals, and the
        // action itself already succeeded.
        await refresh().catch((err) => {
          logger.debug('container refresh after action failed', { error: String(err) });
        });
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(containerId);
          return next;
        });
      }
    },
    [projectPath, refresh]
  );

  const startProjectContainer = useCallback(
    (containerId: string) => runAction(containerId, startContainer),
    [runAction]
  );
  const stopProjectContainer = useCallback(
    (containerId: string) => runAction(containerId, stopContainer),
    [runAction]
  );
  const restartProjectContainer = useCallback(
    (containerId: string) => runAction(containerId, restartContainer),
    [runAction]
  );

  return {
    containers,
    engine,
    pendingIds,
    startProjectContainer,
    stopProjectContainer,
    restartProjectContainer,
  };
}
