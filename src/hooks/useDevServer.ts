/**
 * Hook for dev server lifecycle management.
 *
 * Tracks one dev-server handle per project path so that pinned projects can
 * keep their servers running across project switches. External callers still
 * see a single "current project" scalar API — `devServerPort`, `projectType`,
 * `customDevCommand`, output buffers, etc. — which is derived from the map
 * keyed by the `currentProjectPath` argument.
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import {
  startDevServer,
  DevServerHandle,
  getCustomDevCommand,
  setCustomDevCommand as setCustomDevCommandApi,
  getWorkspaceSubpath,
  resolveWorkspacePath,
  checkDependenciesInstalled,
} from '../lib/project';
import { detectPackageManager } from '../lib/github';

/** Resolve the effective dev-server cwd for a project, logging any backend
 *  failure instead of silently swallowing it. A stale Tauri build (missing
 *  `get_workspace_subpath` command) would otherwise spawn dev servers from
 *  the wrong directory with no signal. Returns the repo root on failure. */
async function resolveDevServerCwd(projectPath: string): Promise<string> {
  try {
    const subpath = await getWorkspaceSubpath(projectPath);
    return resolveWorkspacePath(projectPath, subpath);
  } catch (err) {
    logger.error('[DevServer] getWorkspaceSubpath failed; using repo root as cwd', {
      projectPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return projectPath;
  }
}
import {
  detectProjectType,
  startStaticServer,
  stopStaticServer,
  ProjectType,
} from '../lib/static-server';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { getWindowLabel } from '../lib/window';
import type { HealthTabPanelRef } from '../components/HealthTabPanel';
import { stripAnsi } from '../lib/ansi';

/** All the per-project server state we track in the map. */
interface ProjectServerState {
  handle: DevServerHandle | null;
  port: number;
  type: ProjectType;
  customCommand: string | null;
  outputBuffer: string;
  healthBuffer: string;
  outputVersion: number;
  healthVersion: number;
  outputThrottleTimer: ReturnType<typeof setTimeout> | null;
  outputPending: boolean;
  healthThrottleTimer: ReturnType<typeof setTimeout> | null;
  healthPending: boolean;
  suppressed: boolean;
  /** Set when the dep check found `node_modules` missing — the dev server is
   *  intentionally not started; the Preview pane renders an install CTA
   *  instead. Null means deps are fine (or there's nothing to install). */
  needsInstall: { packageManager: string } | null;
  /** Carry-over of an incomplete trailing line between PTY chunks so the
   *  probe-line filter can match patterns split across chunk boundaries
   *  (the PTY emits chunks of arbitrary size — they are not line-aligned). */
  pendingOutputLine: string;
}

const DEFAULT_PORT = 3000;
const OUTPUT_BUFFER_MAX = 100_000;
const OUTPUT_THROTTLE_MS = 300;

function makeState(): ProjectServerState {
  return {
    handle: null,
    port: DEFAULT_PORT,
    type: 'unknown',
    customCommand: null,
    outputBuffer: '',
    healthBuffer: '',
    outputVersion: 0,
    healthVersion: 0,
    outputThrottleTimer: null,
    outputPending: false,
    healthThrottleTimer: null,
    healthPending: false,
    suppressed: false,
    needsInstall: null,
    pendingOutputLine: '',
  };
}

/* Lines that match this pattern are the dev server logging Ship Studio's
   own liveness probe (a `fetch('/')` every 10s from `usePreviewConnection`).
   Filtering them keeps the visible log focused on real traffic.

   Three shapes covered after ANSI stripping:
     - `GET /` or `HEAD /` followed by whitespace, end-of-line, or `HTTP`
       — Next.js, Vite, Express, etc. Anchored to the start of the line
       (allowing only timestamp / IP / bracket / quote prefix chars) so a
       narrative log line like "Last request was GET / 200" is NOT filtered.
     - `[200] /` or `[304] /` — bracketed-status format used by some custom
       dev-server loggers (seen in Webflow / Astro tooling).
     - `"GET / HTTP/1.1"` — Apache / morgan combined log format. Not anchored
       since the quoted request signature is distinctive enough on its own.

   The path is anchored on `/` followed by whitespace, EOL, `"`, or `HTTP`,
   so real requests like `/api/foo` or `/static/img.png` still pass through. */
export const PROBE_LINE_PATTERN =
  /^[^A-Za-z]*(?:(?:GET|HEAD)\s+\/(?:[\s"]|$|HTTP)|\[(?:200|304)\]\s+\/(?:\s|$))|"(?:GET|HEAD)\s+\/\s+HTTP/i;

export function isProbeLine(line: string): boolean {
  const stripped = stripAnsi(line).trim();
  if (!stripped) return false;
  return PROBE_LINE_PATTERN.test(stripped);
}

/** Split incoming PTY data into complete lines + a trailing partial.
 *  Filters out probe lines and returns the surviving content (with their
 *  newline terminators preserved) plus the new pending fragment. Exported
 *  for unit testing — not consumed elsewhere. */
export function filterProbeChunk(
  pendingLine: string,
  chunk: string
): { kept: string; pending: string } {
  const combined = pendingLine + chunk;
  const lastNewline = combined.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No complete line yet — keep buffering.
    return { kept: '', pending: combined };
  }
  const completeBlock = combined.slice(0, lastNewline + 1);
  const pending = combined.slice(lastNewline + 1);
  // `split('\n')` on a string ending in '\n' yields a trailing '' entry,
  // which becomes the trailing newline when re-joined. Filter probe lines
  // from the populated entries; pass everything else through verbatim.
  const kept = completeBlock
    .split('\n')
    .filter((line, i, arr) => {
      if (i === arr.length - 1 && line === '') return true;
      return !isProbeLine(line);
    })
    .join('\n');
  return { kept, pending };
}

export function useDevServer(currentProjectPath: string | null) {
  const statesRef = useRef<Map<string, ProjectServerState>>(new Map());
  // Sync the ref synchronously during render so handlers that fire between
  // a `setCurrentProject(...)` state update and the next committed render
  // still see the incoming path via the optional `projectPath` argument.
  const currentPathRef = useRef<string | null>(currentProjectPath);
  currentPathRef.current = currentProjectPath;

  const [isRestartingDevServer, setIsRestartingDevServer] = useState(false);

  // Bump on any state change that should cause the "current project" scalars
  // to re-read. Output from non-current projects accumulates silently.
  const [renderKey, setRenderKey] = useState(0);
  const bump = useCallback(() => setRenderKey((v) => v + 1), []);

  const healthPanelRef = useRef<HealthTabPanelRef>(null);

  const getOrCreateState = useCallback((path: string): ProjectServerState => {
    let s = statesRef.current.get(path);
    if (!s) {
      s = makeState();
      statesRef.current.set(path, s);
    }
    return s;
  }, []);

  const getState = useCallback((path: string | null): ProjectServerState | null => {
    if (!path) return null;
    return statesRef.current.get(path) ?? null;
  }, []);

  // ───────────── Current-project scalar views (backwards-compat API) ─────────────
  // `renderKey` is referenced here so these memos recompute when any mutation
  // bumps it.
  const activeState = useMemo(
    () => getState(currentProjectPath),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderKey is the reactivity trigger
    [currentProjectPath, renderKey]
  );

  const devServerPort = activeState?.port ?? DEFAULT_PORT;
  const projectType = activeState?.type ?? 'unknown';
  const customDevCommand = activeState?.customCommand ?? null;
  const needsInstall = activeState?.needsInstall ?? null;
  const devServerOutputVersion = activeState?.outputVersion ?? 0;
  const healthOutputVersion = activeState?.healthVersion ?? 0;

  // Synthetic refs so existing callers that read `devServerOutputRef.current`
  // (and `devServerRef.current` for beforeunload cleanup) keep working without
  // knowing about the map. The `.current` getter reads the latest state each
  // access — safe because callers read on demand, not once and cache.
  const devServerOutputRef = useMemo(
    () => ({
      get current() {
        return currentPathRef.current
          ? (statesRef.current.get(currentPathRef.current)?.outputBuffer ?? '')
          : '';
      },
      set current(_v: string) {
        /* setter kept for type compatibility; buffers are written through
           the output handler and `clearOutputBuffers`. */
      },
    }),
    []
  );

  const healthOutputRef = useMemo(
    () => ({
      get current() {
        return currentPathRef.current
          ? (statesRef.current.get(currentPathRef.current)?.healthBuffer ?? '')
          : '';
      },
      set current(_v: string) {
        /* setter kept for type compatibility */
      },
    }),
    []
  );

  const devServerRef = useMemo(
    () => ({
      get current(): DevServerHandle | null {
        return currentPathRef.current
          ? (statesRef.current.get(currentPathRef.current)?.handle ?? null)
          : null;
      },
      set current(v: DevServerHandle | null) {
        const path = currentPathRef.current;
        if (!path) return;
        const s = getOrCreateState(path);
        s.handle = v;
      },
    }),
    [getOrCreateState]
  );

  // ───────────── Per-project setters for "current project" ─────────────

  // Setters accept an optional `projectPath` so callers can write state for a
  // freshly-selected project before the `currentProjectPath` prop has made it
  // through React's render cycle. Omit the arg to target the current project.
  const setDevServerPort = useCallback(
    (port: number, projectPath?: string) => {
      const path = projectPath ?? currentPathRef.current;
      if (!path) return;
      const s = getOrCreateState(path);
      s.port = port;
      bump();
    },
    [bump, getOrCreateState]
  );

  const setProjectType = useCallback(
    (type: ProjectType, projectPath?: string) => {
      const path = projectPath ?? currentPathRef.current;
      if (!path) return;
      const s = getOrCreateState(path);
      s.type = type;
      bump();
    },
    [bump, getOrCreateState]
  );

  const setCustomDevCommand = useCallback(
    (command: string | null, projectPath?: string) => {
      const path = projectPath ?? currentPathRef.current;
      if (!path) return;
      const s = getOrCreateState(path);
      s.customCommand = command;
      bump();
    },
    [bump, getOrCreateState]
  );

  // ───────────── Output handling ─────────────

  const handleHealthOutput = useCallback(
    (output: string) => {
      // Health output always belongs to the current project (HealthTabPanel
      // is only mounted in the active workspace).
      const path = currentPathRef.current;
      if (!path) return;
      const s = getOrCreateState(path);
      s.healthBuffer += output;
      if (s.healthBuffer.length > OUTPUT_BUFFER_MAX) {
        s.healthBuffer = s.healthBuffer.slice(-OUTPUT_BUFFER_MAX);
      }
      if (!s.healthThrottleTimer) {
        s.healthVersion += 1;
        bump();
        s.healthThrottleTimer = setTimeout(() => {
          s.healthThrottleTimer = null;
          if (s.healthPending) {
            s.healthPending = false;
            s.healthVersion += 1;
            bump();
          }
        }, OUTPUT_THROTTLE_MS);
      } else {
        s.healthPending = true;
      }
    },
    [bump, getOrCreateState]
  );

  // Create an output handler bound to a specific project path. Dev server
  // output from background (pinned) projects accumulates into their buffer
  // without triggering a re-render of the active workspace.
  // Subscribe to the freshly-started dev server's PTY exit event so we can
  // flip `handle` back to null when the server process dies externally
  // (Next.js crash, user `kill`s the port, the child just exits). Without
  // this, `isServerRunning(path)` keeps reporting true, the sidebar shows
  // Dev server · running indefinitely, and the next project open incorrectly
  // decides to "reuse" a dead server. Idempotent — only clears state when
  // the map still points at the same handle we watched.
  const wireExitWatcher = useCallback(
    (projectPath: string, s: ProjectServerState) => {
      const handle = s.handle;
      if (!handle) return;
      try {
        handle.pty.onExit(({ exitCode }) => {
          const current = statesRef.current.get(projectPath);
          if (!current || current.handle !== handle) return;
          logger.warn('[useDevServer] dev server exited', {
            projectPath,
            exitCode: exitCode ?? null,
          });
          current.handle = null;
          bump();
        });
      } catch (e) {
        logger.warn('[useDevServer] failed to attach exit watcher', { error: String(e) });
      }
    },
    [bump]
  );

  const createOutputHandler = useCallback(
    (projectPath: string) => {
      return (data: string) => {
        const s = statesRef.current.get(projectPath);
        if (!s) return;
        if (s.suppressed) return;
        const { kept, pending } = filterProbeChunk(s.pendingOutputLine, data);
        s.pendingOutputLine = pending;
        if (!kept) return; // chunk was entirely buffered or entirely filtered
        s.outputBuffer += kept;
        if (s.outputBuffer.length > OUTPUT_BUFFER_MAX) {
          s.outputBuffer = s.outputBuffer.slice(-OUTPUT_BUFFER_MAX);
        }
        const isActive = projectPath === currentPathRef.current;
        if (!s.outputThrottleTimer) {
          s.outputVersion += 1;
          if (isActive) bump();
          s.outputThrottleTimer = setTimeout(() => {
            s.outputThrottleTimer = null;
            if (s.outputPending && !s.suppressed) {
              s.outputPending = false;
              s.outputVersion += 1;
              if (projectPath === currentPathRef.current) bump();
            }
          }, OUTPUT_THROTTLE_MS);
        } else {
          s.outputPending = true;
        }
      };
    },
    [bump]
  );

  // Clear the CURRENT project's output buffers (mirrors previous behavior —
  // clearOutputBuffers was only ever called while starting/restarting the
  // active project's server).
  const clearOutputBuffers = useCallback(() => {
    const path = currentPathRef.current;
    if (!path) return;
    const s = getOrCreateState(path);
    s.outputBuffer = '';
    s.healthBuffer = '';
    s.outputVersion = 0;
    s.healthVersion = 0;
    s.pendingOutputLine = '';
    bump();
  }, [bump, getOrCreateState]);

  /** After an install completes, drop the gate so a follow-up startServer
   *  call actually spawns the dev server. */
  const clearNeedsInstall = useCallback(
    (projectPath: string) => {
      const s = statesRef.current.get(projectPath);
      if (!s) return;
      s.needsInstall = null;
      bump();
    },
    [bump]
  );

  // ───────────── Lifecycle ─────────────

  const startServerForProject = useCallback(
    async (projectPath: string, projectName: string, port: number, windowLabel: string) => {
      const s = getOrCreateState(projectPath);
      // Re-enable output handling for the (possibly new) server on this path.
      s.suppressed = false;
      s.port = port;

      // For monorepo projects, dev server / project-type detection should run
      // against the picked workspace subdir. Git/PR ops still use the repo root.
      const cwd = await resolveDevServerCwd(projectPath);
      if (cwd !== projectPath) {
        logger.info('[OpenProject] Using workspace subpath as dev server cwd', {
          projectPath,
          cwd,
        });
      }

      // Detect project type FIRST so `isWebProject` is correct even when we
      // defer the dev server (the Preview pane gates on projectType ∉ {generic,
      // unknown} and the install CTA renders inside the Preview pane).
      let detectedType: ProjectType = 'unknown';
      try {
        detectedType = await detectProjectType(projectPath);
      } catch {
        logger.warn('[OpenProject] Failed to detect project type, defaulting to unknown');
      }
      s.type = detectedType;
      bump();

      // Now verify `node_modules` exists. If not, the dev server would fail
      // with "Cannot find module 'next'" — surface a Preview-pane install CTA
      // instead. Cleared by `clearNeedsInstall` after install succeeds.
      try {
        const depStatus = await checkDependenciesInstalled(projectPath);
        if (!depStatus.installed && depStatus.hasPackageJson) {
          const packageManager = await detectPackageManager(projectPath).catch((err) => {
            logger.warn(
              '[OpenProject] detectPackageManager failed; falling back to npm. This will be wrong for pnpm/yarn projects.',
              { error: err instanceof Error ? err.message : String(err) }
            );
            return 'npm';
          });
          s.needsInstall = { packageManager };
          bump();
          logger.info('[OpenProject] Dependencies missing; deferring dev server', {
            projectPath,
            packageManager,
            projectType: detectedType,
          });
          return detectedType;
        }
      } catch (err) {
        logger.warn('[OpenProject] Dependency check failed; attempting dev server anyway', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      s.needsInstall = null;

      void trackEvent('project_type_detected', {
        project_type: detectedType,
        project_name: projectName,
        $screen_name: 'Workspace',
      });
      logger.info(`[OpenProject] Detected project type: ${detectedType}`);

      if (detectedType === 'generic') {
        let cmd: string | null = null;
        try {
          cmd = await getCustomDevCommand(projectPath);
        } catch {
          /* no custom command configured */
        }
        s.customCommand = cmd;
        bump();

        if (cmd) {
          try {
            s.outputBuffer = '';
            s.healthBuffer = '';
            s.outputVersion = 0;
            s.healthVersion = 0;
            bump();
            void trackEvent('dev_server_started', {
              project_type: 'generic',
              port,
              project_name: projectName,
              $screen_name: 'Workspace',
            });
            s.handle = await startDevServer(
              cwd,
              port,
              windowLabel,
              createOutputHandler(projectPath),
              cmd
            );
            wireExitWatcher(projectPath, s);
            logger.info('[OpenProject] Generic project dev server started with custom command', {
              command: cmd,
            });
          } catch (error) {
            logger.error('Failed to start custom dev server for generic project', { error });
          }
        } else {
          logger.info('[OpenProject] Generic project detected, no custom dev command configured');
        }
      } else if (detectedType === 'statichtml') {
        try {
          const staticPort = await startStaticServer(windowLabel, cwd);
          s.port = staticPort;
          bump();
          void trackEvent('dev_server_started', {
            project_type: 'statichtml',
            port: staticPort,
            project_name: projectName,
            $screen_name: 'Workspace',
          });
          logger.info(`[OpenProject] Static server started on port ${staticPort}`);
        } catch (error) {
          logger.error('Failed to start static server', { error });
        }
      } else {
        try {
          s.outputBuffer = '';
          s.healthBuffer = '';
          s.outputVersion = 0;
          s.healthVersion = 0;
          bump();
          void trackEvent('dev_server_started', {
            project_type: detectedType,
            port,
            project_name: projectName,
            $screen_name: 'Workspace',
          });
          s.handle = await startDevServer(cwd, port, windowLabel, createOutputHandler(projectPath));
          wireExitWatcher(projectPath, s);
        } catch (error) {
          logger.error('Failed to start dev server', { error });
        }
      }

      // Warn when we start hoarding hot dev servers. Slice 5 will add a hard cap.
      if (statesRef.current.size > 3) {
        logger.warn(`[OpenProject] ${statesRef.current.size} dev servers alive`, {
          paths: Array.from(statesRef.current.keys()),
        });
      }

      return detectedType;
    },
    [bump, createOutputHandler, getOrCreateState, wireExitWatcher]
  );

  // Stop the dev/static server for a specific project (or the current project
  // if no path given). Safe to call when nothing is running.
  const stopServer = useCallback(
    async (projectPath?: string) => {
      const targetPath = projectPath ?? currentPathRef.current;
      if (!targetPath) return;
      const s = statesRef.current.get(targetPath);
      if (!s) return;

      // Suppress output BEFORE stopping — prevents leaked PTY onData listeners
      // from appending to a buffer that consumers think is "cleared."
      s.suppressed = true;

      if (s.outputThrottleTimer) {
        clearTimeout(s.outputThrottleTimer);
        s.outputThrottleTimer = null;
      }
      s.outputPending = false;
      if (s.healthThrottleTimer) {
        clearTimeout(s.healthThrottleTimer);
        s.healthThrottleTimer = null;
      }
      s.healthPending = false;

      if (s.handle) {
        try {
          await s.handle.stop();
        } catch (e) {
          logger.warn('[stopServer] handle.stop threw', { error: String(e), path: targetPath });
        }
        s.handle = null;
      }

      // Static server runs per-window, not per-project. If the stopped path
      // had a running static server, stopping it is correct. If it didn't,
      // this is a no-op and safely swallowed.
      try {
        await stopStaticServer(getWindowLabel());
      } catch {
        /* not started / already stopped */
      }

      s.type = 'unknown';
      bump();

      // Drop the entry entirely so the map doesn't leak for closed projects.
      // (Pinned-project guards in useProjectLifecycle make sure we don't call
      // stopServer for hot projects we intend to keep.)
      statesRef.current.delete(targetPath);
      bump();
    },
    [bump]
  );

  // Stop every running dev/static server. Used by beforeunload so no PTYs
  // leak when the window closes with multiple hot projects.
  const stopAllServers = useCallback(async () => {
    const paths = Array.from(statesRef.current.keys());
    await Promise.allSettled(paths.map((p) => stopServer(p)));
  }, [stopServer]);

  // Whether a dev server is currently tracked for the given project. Used by
  // `useProjectLifecycle` to decide whether to skip the cleanup + restart
  // pipeline on re-entering a pinned project whose server is still alive.
  const isServerRunning = useCallback((projectPath: string): boolean => {
    const s = statesRef.current.get(projectPath);
    return !!s && s.handle !== null;
  }, []);

  // Read-only accessor for the tracked project type of any project, current
  // or not. Returns 'unknown' when the project has no state.
  const getProjectType = useCallback(
    (projectPath: string): ProjectType => statesRef.current.get(projectPath)?.type ?? 'unknown',
    []
  );

  // ───────────── Restart ─────────────

  const handleRestartDevServer = useCallback(
    async (projectPath: string, portOverride?: number) => {
      setIsRestartingDevServer(true);
      const s = getOrCreateState(projectPath);
      const effectivePort = portOverride ?? s.port ?? DEFAULT_PORT;

      const cwd = await resolveDevServerCwd(projectPath);

      const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
        return Promise.race([
          promise,
          new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
        ]);
      };
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const stopAndRestart = async (customCmd?: string) => {
        if (s.handle) {
          try {
            await withTimeout(s.handle.stop(), 5000, undefined);
          } catch (e) {
            logger.warn('Error stopping dev server, continuing with restart', { error: e });
          }
          s.handle = null;
        }
        s.outputBuffer = '';
        s.healthBuffer = '';
        s.outputVersion = 0;
        s.healthVersion = 0;
        bump();
        await delay(500);
        s.handle = await withTimeout(
          startDevServer(
            cwd,
            effectivePort,
            getWindowLabel(),
            createOutputHandler(projectPath),
            customCmd
          ),
          10000,
          null as unknown as DevServerHandle
        );
        if (!s.handle) {
          logger.error('Failed to start dev server: spawn timed out');
        } else {
          wireExitWatcher(projectPath, s);
        }
      };

      try {
        if (s.type === 'generic') {
          if (!s.customCommand) return;
          await stopAndRestart(s.customCommand);
        } else if (s.type === 'statichtml') {
          const windowLabel = getWindowLabel();
          try {
            await stopStaticServer(windowLabel);
          } catch {
            /* Ignore */
          }
          await delay(300);
          const newPort = await startStaticServer(windowLabel, cwd);
          s.port = newPort;
          bump();
        } else {
          try {
            await withTimeout(invoke('kill_port', { port: effectivePort }), 5000, undefined);
          } catch {
            /* Ignore if nothing to kill */
          }
          try {
            await withTimeout(invoke('clear_project_cache', { projectPath }), 10000, undefined);
          } catch {
            /* Non-critical */
          }
          await stopAndRestart();
        }
        void trackEvent('dev_server_restarted', {
          project_type: s.type,
          $screen_name: 'Workspace',
        });
      } catch (error) {
        logger.error('Failed to restart dev server', { error });
      } finally {
        setIsRestartingDevServer(false);
      }
    },
    [bump, createOutputHandler, getOrCreateState, wireExitWatcher]
  );

  const saveCustomDevCommand = useCallback(
    async (projectPath: string, command: string | null) => {
      const s = getOrCreateState(projectPath);
      try {
        await setCustomDevCommandApi(projectPath, command);
      } catch (e) {
        logger.error('Failed to save custom dev command', { error: e });
      }
      s.customCommand = command;
      bump();
      void trackEvent('custom_dev_command_saved', {
        has_command: !!command,
        $screen_name: 'Workspace',
      });

      if (s.handle) {
        try {
          await s.handle.stop();
        } catch {
          /* Ignore */
        }
        s.handle = null;
      }

      if (command) {
        try {
          s.outputBuffer = '';
          s.healthBuffer = '';
          s.outputVersion = 0;
          s.healthVersion = 0;
          bump();
          const cwd = await resolveDevServerCwd(projectPath);
          s.handle = await startDevServer(
            cwd,
            s.port,
            getWindowLabel(),
            createOutputHandler(projectPath),
            command
          );
          wireExitWatcher(projectPath, s);
        } catch (e) {
          logger.error('Failed to start custom dev server', { error: e });
        }
      }
    },
    [bump, createOutputHandler, getOrCreateState, wireExitWatcher]
  );

  return {
    // Refs (synthetic — read current project's slot)
    devServerRef,
    healthPanelRef,
    devServerOutputRef,
    healthOutputRef,

    // Current-project scalars
    devServerPort,
    setDevServerPort,
    projectType,
    setProjectType,
    isRestartingDevServer,
    customDevCommand,
    setCustomDevCommand,
    devServerOutputVersion,
    healthOutputVersion,
    needsInstall,

    // Handlers
    handleHealthOutput,
    handleRestartDevServer,
    startServerForProject,
    stopServer,
    stopAllServers,
    isServerRunning,
    getProjectType,
    clearOutputBuffers,
    saveCustomDevCommand,
    clearNeedsInstall,
  };
}
