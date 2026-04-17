/**
 * Hook for dev server lifecycle management.
 *
 * Manages dev server start/stop/restart, output buffering,
 * health check output, and project type detection.
 */

import { useState, useRef, useCallback } from 'react';
import {
  startDevServer,
  DevServerHandle,
  getCustomDevCommand,
  setCustomDevCommand as setCustomDevCommandApi,
} from '../lib/project';
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
import type { CodeHealthPanelRef } from '../components/CodeHealthPanel';

export function useDevServer() {
  const devServerRef = useRef<DevServerHandle | null>(null);
  const [devServerPort, setDevServerPort] = useState(3000);
  const [projectType, setProjectType] = useState<ProjectType>('unknown');
  const [isRestartingDevServer, setIsRestartingDevServer] = useState(false);
  const [customDevCommand, setCustomDevCommand] = useState<string | null>(null);

  // Dev server output buffering
  const devServerOutputRef = useRef<string>('');
  const [devServerOutputVersion, setDevServerOutputVersion] = useState(0);

  // Health check output buffering
  const healthOutputRef = useRef<string>('');
  const [healthOutputVersion, setHealthOutputVersion] = useState(0);
  const healthPanelRef = useRef<CodeHealthPanelRef>(null);

  // Throttle refs for output version updates (limit re-renders to ~3/sec)
  const devServerThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const devServerPendingRef = useRef(false);
  const healthThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthPendingRef = useRef(false);

  // Suppression flag: when true, output handlers skip state updates.
  // This prevents leaked PTY onData listeners from causing infinite re-renders
  // after the dev server is stopped (pty.kill() doesn't remove event listeners).
  const outputSuppressedRef = useRef(false);

  // Handle health check output
  const handleHealthOutput = useCallback((output: string) => {
    healthOutputRef.current += output;
    if (healthOutputRef.current.length > 100000) {
      healthOutputRef.current = healthOutputRef.current.slice(-100000);
    }
    if (!healthThrottleRef.current) {
      setHealthOutputVersion((v) => v + 1);
      healthThrottleRef.current = setTimeout(() => {
        healthThrottleRef.current = null;
        if (healthPendingRef.current) {
          healthPendingRef.current = false;
          setHealthOutputVersion((v) => v + 1);
        }
      }, 300);
    } else {
      healthPendingRef.current = true;
    }
  }, []);

  // Create the output callback for dev server
  const createOutputHandler = useCallback(() => {
    return (data: string) => {
      // Skip state updates if server has been stopped (prevents leaked PTY listeners
      // from causing infinite re-renders after back-navigation)
      if (outputSuppressedRef.current) return;
      devServerOutputRef.current += data;
      if (devServerOutputRef.current.length > 100000) {
        devServerOutputRef.current = devServerOutputRef.current.slice(-100000);
      }
      if (!devServerThrottleRef.current) {
        setDevServerOutputVersion((v) => v + 1);
        devServerThrottleRef.current = setTimeout(() => {
          devServerThrottleRef.current = null;
          if (devServerPendingRef.current) {
            devServerPendingRef.current = false;
            if (!outputSuppressedRef.current) {
              setDevServerOutputVersion((v) => v + 1);
            }
          }
        }, 300);
      } else {
        devServerPendingRef.current = true;
      }
    };
  }, []);

  // Clear output buffers
  const clearOutputBuffers = useCallback(() => {
    devServerOutputRef.current = '';
    setDevServerOutputVersion(0);
    healthOutputRef.current = '';
    setHealthOutputVersion(0);
  }, []);

  // Detect project type and start appropriate server
  const startServerForProject = useCallback(
    async (projectPath: string, projectName: string, port: number, windowLabel: string) => {
      // Re-enable output handling for the new server
      outputSuppressedRef.current = false;
      let detectedType: ProjectType = 'unknown';
      try {
        detectedType = await detectProjectType(projectPath);
      } catch {
        logger.warn('[OpenProject] Failed to detect project type, defaulting to unknown');
      }
      setProjectType(detectedType);
      void trackEvent('project_type_detected', {
        project_type: detectedType,
        project_name: projectName,
        $screen_name: 'Workspace',
      });
      logger.info(`[OpenProject] Detected project type: ${detectedType}`);

      if (detectedType === 'generic') {
        // Generic projects: check for a custom dev command
        let cmd: string | null = null;
        try {
          cmd = await getCustomDevCommand(projectPath);
        } catch {
          // Ignore - no custom command configured
        }
        setCustomDevCommand(cmd);

        if (cmd) {
          try {
            clearOutputBuffers();
            void trackEvent('dev_server_started', {
              project_type: 'generic',
              port,
              project_name: projectName,
              $screen_name: 'Workspace',
            });
            devServerRef.current = await startDevServer(
              projectPath,
              port,
              windowLabel,
              createOutputHandler(),
              cmd
            );
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
          const staticPort = await startStaticServer(windowLabel, projectPath);
          setDevServerPort(staticPort);
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
          clearOutputBuffers();
          void trackEvent('dev_server_started', {
            project_type: detectedType,
            port,
            project_name: projectName,
            $screen_name: 'Workspace',
          });
          devServerRef.current = await startDevServer(
            projectPath,
            port,
            windowLabel,
            createOutputHandler()
          );
        } catch (error) {
          logger.error('Failed to start dev server', { error });
        }
      }

      return detectedType;
    },
    [clearOutputBuffers, createOutputHandler]
  );

  // Stop dev server or static server
  const stopServer = useCallback(async () => {
    // Suppress output handler BEFORE stopping — prevents leaked PTY onData
    // listeners from calling setDevServerOutputVersion after stop
    outputSuppressedRef.current = true;

    // Clear any pending throttle timers
    if (devServerThrottleRef.current) {
      clearTimeout(devServerThrottleRef.current);
      devServerThrottleRef.current = null;
    }
    devServerPendingRef.current = false;
    if (healthThrottleRef.current) {
      clearTimeout(healthThrottleRef.current);
      healthThrottleRef.current = null;
    }
    healthPendingRef.current = false;

    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }
    const windowLabel = getWindowLabel();
    try {
      await stopStaticServer(windowLabel);
    } catch {
      // Ignore - may not have been started
    }
    setProjectType('unknown');
  }, []);

  // Restart dev server
  const handleRestartDevServer = useCallback(
    async (projectPath: string, portOverride?: number) => {
      setIsRestartingDevServer(true);

      const effectivePort = portOverride ?? devServerPort;

      const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
        return Promise.race([
          promise,
          new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
        ]);
      };
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const stopAndRestart = async (customCmd?: string) => {
        if (devServerRef.current) {
          try {
            await withTimeout(devServerRef.current.stop(), 5000, undefined);
          } catch (e) {
            logger.warn('Error stopping dev server, continuing with restart', { error: e });
          }
          devServerRef.current = null;
        }
        clearOutputBuffers();
        await delay(500);
        devServerRef.current = await withTimeout(
          startDevServer(
            projectPath,
            effectivePort,
            getWindowLabel(),
            createOutputHandler(),
            customCmd
          ),
          10000,
          null as unknown as DevServerHandle
        );
        if (!devServerRef.current) {
          logger.error('Failed to start dev server: spawn timed out');
        }
      };

      try {
        if (projectType === 'generic') {
          if (!customDevCommand) return;
          await stopAndRestart(customDevCommand);
        } else if (projectType === 'statichtml') {
          const windowLabel = getWindowLabel();
          try {
            await stopStaticServer(windowLabel);
          } catch {
            // Ignore
          }
          await delay(300);
          const newPort = await startStaticServer(windowLabel, projectPath);
          setDevServerPort(newPort);
        } else {
          try {
            await withTimeout(invoke('kill_port', { port: effectivePort }), 5000, undefined);
          } catch {
            // Ignore if nothing to kill
          }
          try {
            await withTimeout(invoke('clear_project_cache', { projectPath }), 10000, undefined);
          } catch {
            // Non-critical
          }
          await stopAndRestart();
        }
        void trackEvent('dev_server_restarted', {
          project_type: projectType,
          $screen_name: 'Workspace',
        });
      } catch (error) {
        logger.error('Failed to restart dev server', { error });
      } finally {
        setIsRestartingDevServer(false);
      }
    },
    [projectType, devServerPort, customDevCommand, clearOutputBuffers, createOutputHandler]
  );

  // Persist a custom dev command, stop old server, start new (or clear)
  const saveCustomDevCommand = useCallback(
    async (projectPath: string, command: string | null) => {
      try {
        await setCustomDevCommandApi(projectPath, command);
      } catch (e) {
        logger.error('Failed to save custom dev command', { error: e });
      }
      setCustomDevCommand(command);
      void trackEvent('custom_dev_command_saved', {
        has_command: !!command,
        $screen_name: 'Workspace',
      });

      // Stop current dev server if running
      if (devServerRef.current) {
        try {
          await devServerRef.current.stop();
        } catch {
          // Ignore
        }
        devServerRef.current = null;
      }

      // Start new server if command is set
      if (command) {
        try {
          clearOutputBuffers();
          devServerRef.current = await startDevServer(
            projectPath,
            devServerPort,
            getWindowLabel(),
            createOutputHandler(),
            command
          );
        } catch (e) {
          logger.error('Failed to start custom dev server', { error: e });
        }
      }
    },
    [devServerPort, clearOutputBuffers, createOutputHandler]
  );

  return {
    // Refs
    devServerRef,
    healthPanelRef,

    // State
    devServerPort,
    setDevServerPort,
    projectType,
    setProjectType,
    isRestartingDevServer,
    customDevCommand,
    setCustomDevCommand,
    devServerOutputRef,
    devServerOutputVersion,
    healthOutputRef,
    healthOutputVersion,

    // Handlers
    handleHealthOutput,
    handleRestartDevServer,
    startServerForProject,
    stopServer,
    clearOutputBuffers,
    saveCustomDevCommand,
  };
}
