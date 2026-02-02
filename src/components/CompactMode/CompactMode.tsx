/**
 * Compact Mode - Minimal floating interface for Ship Studio.
 *
 * A compact interface that shows the actual Claude Code terminal
 * in a smaller, always-on-top window. Designed for laptop users and multi-tasking.
 *
 * Layout:
 * - Header: Window controls (pin + expand) on right, space for macOS traffic lights on left
 * - Main: Claude Code terminal (flex, resizable)
 * - Footer: Action buttons (health, assets, env, branch, PR, publish)
 *
 * The project name is shown in the window title bar instead of the header.
 *
 * @module components/CompactMode
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, TerminalHandle } from '../Terminal';
import { CompactInfoBar } from './CompactInfoBar';
import { CompactActionsRow } from './CompactActionsRow';
import { exitCompactMode, setAlwaysOnTop, startWindowDrag, setWindowTitle } from '../../lib/window';
import { logger } from '../../lib/logger';
import '../../styles/compact-mode.css';

export interface CompactModeProps {
  /** Current project path */
  projectPath: string;
  /** Current project name */
  projectName: string;
  /** Current dev server port */
  devServerPort: number;
  /** Dev server health status: 'healthy' | 'unhealthy' | 'starting' */
  serverHealth: 'healthy' | 'unhealthy' | 'starting';
  /** Current git branch name */
  currentBranch: string | null;
  /** Whether there are uncommitted changes */
  hasUncommittedChanges: boolean;
  /** PR status for current branch */
  prStatus: 'none' | 'open' | 'merged' | 'closed';
  /** GitHub connection status */
  isGitHubConnected: boolean;
  /** Whether to run Claude in auto-accept mode */
  autoAcceptMode?: boolean;
  /** Callback when exiting compact mode */
  onExitCompactMode: () => void;
  /** Callback to restart dev server */
  onRestartServer: () => void;
  /** Callback to open assets panel */
  onOpenAssets: () => void;
  /** Callback to open .env editor */
  onOpenEnvEditor: () => void;
  /** Callback to open create repo modal */
  onCreateRepo: () => void;
  /** Callback to switch branch */
  onSwitchBranch: () => void;
  /** Callback to create PR */
  onCreatePR: () => void;
  /** Callback to publish */
  onPublish: () => void;
  /** Callback when terminal exits */
  onTerminalExit?: (code: number | null) => void;
}

export function CompactMode({
  projectPath,
  projectName,
  serverHealth,
  currentBranch,
  hasUncommittedChanges,
  prStatus,
  isGitHubConnected,
  autoAcceptMode = false,
  onExitCompactMode,
  onRestartServer,
  onOpenAssets,
  onOpenEnvEditor,
  onCreateRepo,
  onSwitchBranch,
  onCreatePR,
  onPublish,
  onTerminalExit,
}: CompactModeProps) {
  const [isPinned, setIsPinned] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<TerminalHandle>(null);

  // Set window title to include project name
  useEffect(() => {
    setWindowTitle(`Ship Studio - ${projectName}`).catch((error) => {
      logger.error('Failed to set window title', { error });
    });
  }, [projectName]);

  // Handle pin toggle
  const handlePinToggle = useCallback(async () => {
    const newPinned = !isPinned;
    setIsPinned(newPinned);
    try {
      await setAlwaysOnTop(newPinned);
    } catch (error) {
      logger.error('Failed to toggle always on top', { error });
      setIsPinned(!newPinned);
    }
  }, [isPinned]);

  // Handle expand to full mode
  const handleExpandToFull = useCallback(async () => {
    try {
      await exitCompactMode();
      onExitCompactMode();
    } catch (error) {
      logger.error('Failed to exit compact mode', { error });
    }
  }, [onExitCompactMode]);

  // Handle drag start (only from draggable areas, not terminal or buttons)
  const handleDragStart = useCallback(async (e: React.MouseEvent) => {
    // Guard against non-Element targets (e.g., text nodes, SVG internals)
    if (!(e.target instanceof Element)) {
      return;
    }
    if (e.target.closest('button') || e.target.closest('.compact-terminal')) {
      return;
    }
    try {
      await startWindowDrag();
    } catch (error) {
      logger.error('Failed to start drag', { error });
    }
  }, []);

  // Helper to exit compact mode before triggering a modal action
  const exitAndTrigger = useCallback(
    async (action: () => void) => {
      try {
        await exitCompactMode();
        onExitCompactMode();
        setTimeout(action, 100);
      } catch (error) {
        logger.error('Failed to exit compact mode', { error });
      }
    },
    [onExitCompactMode]
  );

  // Wrapped handlers that exit compact mode first
  const handleOpenAssets = useCallback(
    () => void exitAndTrigger(onOpenAssets),
    [exitAndTrigger, onOpenAssets]
  );
  const handleOpenEnvEditor = useCallback(
    () => void exitAndTrigger(onOpenEnvEditor),
    [exitAndTrigger, onOpenEnvEditor]
  );
  const handleCreateRepo = useCallback(
    () => void exitAndTrigger(onCreateRepo),
    [exitAndTrigger, onCreateRepo]
  );
  const handleSwitchBranch = useCallback(
    () => void exitAndTrigger(onSwitchBranch),
    [exitAndTrigger, onSwitchBranch]
  );
  const handleCreatePR = useCallback(
    () => void exitAndTrigger(onCreatePR),
    [exitAndTrigger, onCreatePR]
  );
  const handlePublish = useCallback(
    () => void exitAndTrigger(onPublish),
    [exitAndTrigger, onPublish]
  );

  return (
    <div ref={containerRef} className="compact-mode" onMouseDown={(e) => void handleDragStart(e)}>
      {/* Header: Info bar with window controls */}
      <CompactInfoBar
        isPinned={isPinned}
        onPinToggle={() => void handlePinToggle()}
        onExpandToFull={() => void handleExpandToFull()}
      />

      {/* Main content: Terminal */}
      <div className="compact-terminal">
        <Terminal
          ref={terminalRef}
          projectPath={projectPath}
          autoAcceptMode={autoAcceptMode}
          onExit={onTerminalExit}
        />
      </div>

      {/* Footer: Action buttons */}
      <CompactActionsRow
        serverHealth={serverHealth}
        currentBranch={currentBranch}
        hasUncommittedChanges={hasUncommittedChanges}
        prStatus={prStatus}
        isGitHubConnected={isGitHubConnected}
        onRestartServer={onRestartServer}
        onOpenAssets={handleOpenAssets}
        onOpenEnvEditor={handleOpenEnvEditor}
        onCreateRepo={handleCreateRepo}
        onSwitchBranch={handleSwitchBranch}
        onCreatePR={handleCreatePR}
        onPublish={handlePublish}
      />
    </div>
  );
}
