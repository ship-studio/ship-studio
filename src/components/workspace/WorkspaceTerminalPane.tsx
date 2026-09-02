/**
 * Agent/terminal dock for the full workspace layout.
 *
 * The parent owns terminal state and workspace orchestration; this component
 * owns the terminal pane's layout, split-pane rendering, and footer actions.
 */

import type { CSSProperties, MutableRefObject } from 'react';
import { getAgentById, type AgentConfig } from '../../lib/agent';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import {
  type PluginAppActions,
  type PluginProjectData,
  type PluginThemeData,
} from '../../contexts/PluginContext';
import { sessionRegistry } from '../../lib/sessionRegistry';
import { kbd } from '../../lib/shortcuts';
import type { Project } from '../../lib/project';
import type { TerminalTab } from '../../hooks/useTerminalManagement';
import { Terminal } from '../terminal/Terminal';
import type { AgentStatus, TerminalHandle } from '../terminal/Terminal';
import { StaleEnvBanner } from '../terminal/StaleEnvBanner';
import { DevServerLogs } from '../terminal/DevServerLogs';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { DockablePanel } from '../primitives/DockablePanel';
import { Spinner } from '../primitives/Spinner';
import {
  CameraIcon,
  CloseIcon,
  CropIcon,
  PinIcon,
  RedoIcon,
  SplitViewIcon,
  UndoIcon,
} from '@/components/icons';
import { ToolbarDropdown } from './ToolbarDropdown';
import { TerminalSplitDividers } from './TerminalSplitDividers';
import { TerminalSplitHeaders } from './TerminalSplitHeaders';

interface TerminalSessionView {
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: number;
  sessionEpoch: number;
}

/** Props for the agent terminal dock, tabs, splits, and session controls. */
export interface WorkspaceTerminalPaneProps {
  currentProject: Project;
  allSessions: TerminalSessionView[];
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  setActiveTerminalTab: (id: number) => void;
  terminalRefsMap: MutableRefObject<Map<string, TerminalHandle | null>>;
  tabTitles: Map<number, string>;
  autoAcceptMode: boolean;
  getActiveTabAgent: () => AgentConfig;
  handleTerminalExit: (code: number | null) => void;
  createTabStatusHandler: (
    projectPath: string,
    tabId: number
  ) => (status: AgentStatus, title: string) => void;
  handleTabTitleChange: (projectPath: string, tabId: number) => (title: string) => void;
  restartTerminalTab: (tabId: number, projectPath?: string) => void;
  showHealthLogs: boolean;
  healthOutput: string;
  healthOutputVersion: number;
  sendToClaude: (text: string) => void;
  isPreviewHidden: boolean;
  isAgentPanelHidden: boolean;
  agentPanelPinned: boolean;
  toggleAgentPanelPinned: () => void;
  toggleAgentPanel: () => void;
  splitPaneTabIds: number[] | null;
  splitPaneSizes: number[] | null;
  isSplitActive: boolean;
  canSplit: boolean;
  enableSplitView: () => void;
  disableSplitView: () => void;
  setSplitPaneTab: (paneIndex: number, tabId: number) => void;
  addSplitPane: (tabId?: number) => void;
  removeSplitPane: (paneIndex: number) => void;
  setSplitPaneSizes: (sizes: number[]) => void;
  canUndo: boolean;
  canRedo: boolean;
  undoSnapshot: () => void | Promise<void>;
  redoSnapshot: () => void | Promise<void>;
  undoTitle: string;
  redoTitle: string;
  isWebProject: boolean;
  /**
   * Whether there is actually a web preview on screen to capture — the
   * Preview tab is selected and the preview pane isn't collapsed. Gates the
   * screenshot/crop buttons so they can't silently no-op.
   */
  isPreviewCaptureAvailable: boolean;
  isCapturing: boolean;
  isCropMode: boolean;
  isCropCapturing: boolean;
  setIsCropMode: (mode: boolean) => void;
  handleCaptureScreenshot: () => Promise<void>;
  onNotificationSettings: () => void;
  onSkills: () => void;
  onMcp: () => void;
  onAutoAcceptToggle: () => void;
  onHelp: () => void;
  terminalPlugins: LoadedPlugin[];
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
}

const AGENT_PANEL_FLOATING_SIZE = { width: 560, height: 680 };

/** Renders and coordinates the workspace agent terminal pane. */
export function WorkspaceTerminalPane(props: WorkspaceTerminalPaneProps) {
  const {
    currentProject,
    allSessions,
    terminalTabs,
    activeTerminalTab,
    setActiveTerminalTab,
    terminalRefsMap,
    tabTitles,
    autoAcceptMode,
    getActiveTabAgent,
    handleTerminalExit,
    createTabStatusHandler,
    handleTabTitleChange,
    restartTerminalTab,
    showHealthLogs,
    healthOutput,
    healthOutputVersion,
    sendToClaude,
    isPreviewHidden,
    isAgentPanelHidden,
    agentPanelPinned,
    toggleAgentPanelPinned,
    toggleAgentPanel,
    splitPaneTabIds,
    splitPaneSizes,
    isSplitActive,
    canSplit,
    enableSplitView,
    disableSplitView,
    setSplitPaneTab,
    addSplitPane,
    removeSplitPane,
    setSplitPaneSizes,
    canUndo,
    canRedo,
    undoSnapshot,
    redoSnapshot,
    undoTitle,
    redoTitle,
    isWebProject,
    isPreviewCaptureAvailable,
    isCapturing,
    isCropMode,
    isCropCapturing,
    setIsCropMode,
    handleCaptureScreenshot,
    onNotificationSettings,
    onSkills,
    onMcp,
    onAutoAcceptToggle,
    onHelp,
    terminalPlugins,
    pluginProject,
    pluginActions,
    pluginTheme,
  } = props;

  return (
    <DockablePanel
      docked={agentPanelPinned || isPreviewHidden}
      visible={!isAgentPanelHidden}
      ariaLabel="Agent panel"
      positionKey="agentPanelFloatingPosition"
      sizeKey="agentPanelFloatingSize"
      floatingSize={AGENT_PANEL_FLOATING_SIZE}
      initialPosition={() => ({
        left: Math.max(24, Math.round(window.innerWidth * 0.08)),
        top: 96,
      })}
      placeholderClassName="agent-panel-dock"
      surfaceClassName="dockable-panel__surface--agent"
    >
      <div className="terminal-pane">
        <div className="workspace-terminal-view">
          <div className="terminal-agent-header panel-heading-pair" data-dockable-drag-handle>
            <span className="terminal-agent-header__identity">
              <span className="panel-heading-pair-title">Agent</span>
              <span className="panel-heading-pair-meta">{getActiveTabAgent().displayName}</span>
            </span>
            {!isPreviewHidden && (
              <span className="terminal-agent-header__actions">
                <ToggleButton
                  variant="ghost"
                  size="compact"
                  className="button--icon-only panel-pin-toggle"
                  onClick={toggleAgentPanelPinned}
                  title={
                    agentPanelPinned ? 'Unpin — float over the workspace' : 'Pin to the window'
                  }
                  aria-label={
                    agentPanelPinned ? 'Unpin Agent panel' : 'Pin Agent panel to the window'
                  }
                  pressed={agentPanelPinned}
                  leftIcon={<PinIcon size={13} />}
                />
                <IconButton
                  variant="ghost"
                  size="compact"
                  onClick={toggleAgentPanel}
                  title="Close Agent panel"
                  aria-label="Close Agent panel"
                  icon={<CloseIcon size={14} />}
                />
              </span>
            )}
          </div>
          <StaleEnvBanner projectPath={currentProject.path} />
          <div
            className={`terminal-content${isSplitActive ? ' split' : ''}`}
            data-education-id="claude-terminal"
          >
            {isSplitActive && currentProject && splitPaneTabIds && splitPaneSizes && (
              <>
                <TerminalSplitHeaders
                  panes={splitPaneTabIds}
                  sizes={splitPaneSizes}
                  tabs={terminalTabs}
                  tabTitles={tabTitles}
                  onSelectTab={setSplitPaneTab}
                  onRemovePane={removeSplitPane}
                  onAddPane={() => addSplitPane()}
                  canAddPane={splitPaneTabIds.length < terminalTabs.length}
                />
                <TerminalSplitDividers sizes={splitPaneSizes} onResize={setSplitPaneSizes} />
              </>
            )}
            {allSessions.flatMap((session) =>
              session.tabs.map((tab) => {
                const isCurrentProject = session.projectPath === currentProject.path;
                const paneIdx =
                  isSplitActive && isCurrentProject && splitPaneTabIds
                    ? splitPaneTabIds.indexOf(tab.id)
                    : -1;
                const inSplitPane = paneIdx >= 0;
                const isVisible =
                  isCurrentProject &&
                  !showHealthLogs &&
                  (isSplitActive ? inSplitPane : activeTerminalTab === tab.id);
                const refKey = `${session.projectPath}::${tab.id}`;
                // Anchor both edges to percentages computed from
                // splitPaneSizes — guarantees the last pane's
                // right edge hits exactly 100% (no rounding
                // drift). Reserve 4px next to each drag handle
                // so the 8px handle sits in clean space. Then
                // add a 12px content gutter on every edge so
                // xterm has the same breathing room from the
                // pane chrome that single-pane mode gives it
                // from the sidebar. Opencode is full-bleed by
                // design (its TUI fills the viewport) — skip
                // the content gutter for it.
                let paneStyle: CSSProperties | undefined;
                if (inSplitPane && splitPaneSizes) {
                  const leftPct = splitPaneSizes.slice(0, paneIdx).reduce((a, b) => a + b, 0);
                  const rightPct = splitPaneSizes.slice(paneIdx + 1).reduce((a, b) => a + b, 0);
                  const leftAbutsHandle = paneIdx > 0;
                  const rightAbutsHandle = paneIdx < splitPaneSizes.length - 1;
                  const gutter = tab.agentId === 'opencode' ? 0 : 12;
                  const leftOffset = (leftAbutsHandle ? 4 : 0) + gutter;
                  const rightOffset = (rightAbutsHandle ? 4 : 0) + gutter;
                  paneStyle = {
                    left: `calc(${leftPct}% + ${leftOffset}px)`,
                    right: `calc(${rightPct}% + ${rightOffset}px)`,
                    top: 'var(--split-pane-header-height)',
                  };
                }
                // Background projects use the same `.terminal-tab-content`
                // visibility-based hide (position: absolute + visibility: hidden).
                // `display: none` would zero out xterm's container dims and leave
                // the renderer desynced when the tab became visible again.
                return (
                  <div
                    key={`session-${session.sessionEpoch}-${refKey}`}
                    className={`terminal-tab-content ${isVisible ? 'active' : ''}${
                      inSplitPane ? ' in-pane' : ''
                    }`}
                    data-agent-id={tab.agentId}
                    data-pane-idx={inSplitPane ? paneIdx : undefined}
                    style={paneStyle}
                    onMouseDownCapture={
                      inSplitPane && tab.id !== activeTerminalTab
                        ? () => setActiveTerminalTab(tab.id)
                        : undefined
                    }
                  >
                    <Terminal
                      ref={(ref) => {
                        if (ref) {
                          terminalRefsMap.current.set(refKey, ref);
                        } else {
                          terminalRefsMap.current.delete(refKey);
                        }
                      }}
                      agent={getAgentById(tab.agentId)}
                      projectPath={session.projectPath}
                      onSpawn={(pid) => {
                        sessionRegistry.patchTerminalTab(session.projectPath, tab.id, {
                          status: 'running',
                          pid,
                          exitCode: null,
                        });
                      }}
                      onExit={(code) => {
                        handleTerminalExit(code);
                        sessionRegistry.patchTerminalTab(session.projectPath, tab.id, {
                          status: code === 0 || code === null ? 'exited' : 'crashed',
                          pid: null,
                          exitCode: code,
                        });
                      }}
                      autoAcceptMode={autoAcceptMode}
                      onStatusChange={createTabStatusHandler(session.projectPath, tab.id)}
                      onTitleChange={handleTabTitleChange(session.projectPath, tab.id)}
                      sessionName={tab.sessionId}
                      isActive={isVisible}
                      shouldResume={tab.shouldResume}
                      onRequestRestart={() => restartTerminalTab(tab.id, session.projectPath)}
                    />
                  </div>
                );
              })
            )}
            {showHealthLogs && (
              <div className="terminal-tab-content active">
                <DevServerLogs
                  output={healthOutput}
                  outputVersion={healthOutputVersion}
                  onSendToAgent={sendToClaude}
                />
              </div>
            )}
          </div>
        </div>

        <div
          className={`terminal-pane-footer${isPreviewHidden ? ' terminal-pane-footer--focus' : ''}`}
        >
          <div className="terminal-pane-footer-left">
            <IconButton
              variant="ghost"
              icon={<UndoIcon size={12} />}
              onClick={() => void undoSnapshot()}
              disabled={!canUndo}
              title={undoTitle}
              aria-label="Undo"
            />
            <IconButton
              variant="ghost"
              icon={<RedoIcon size={12} />}
              onClick={() => void redoSnapshot()}
              disabled={!canRedo}
              title={redoTitle}
              aria-label="Redo"
            />
          </div>

          <div className="terminal-pane-footer-center">
            {/* Screenshot actions only make sense when the Preview
        tab has a web preview to capture. The project being a web project
        isn't enough — with Code/Branches/PRs showing (or the preview pane
        collapsed) there is no iframe to grab, so capture would no-op
        silently and crop mode would latch on with nothing to crop. */}
            {isWebProject && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => void handleCaptureScreenshot()}
                  disabled={isCapturing || isCropMode || !isPreviewCaptureAvailable}
                  title={
                    isPreviewCaptureAvailable
                      ? `Screenshot preview for Claude (${kbd('mod', 'shift', 'S')})`
                      : 'Open the Preview tab to capture a screenshot'
                  }
                  data-education-id="screenshot-button"
                >
                  {isCapturing ? (
                    <Spinner size="sm" style={{ color: 'var(--accent-active)' }} />
                  ) : (
                    <CameraIcon size={14} />
                  )}
                  <span className="capture-label-full">Full Screenshot</span>
                  <span className="capture-shortcut">{kbd('mod', 'shift', 'S')}</span>
                </Button>
                <ToggleButton
                  variant="ghost"
                  pressed={isCropMode}
                  onClick={() => setIsCropMode(!isCropMode)}
                  // Still clickable while crop mode is already on, so a mode
                  // latched before the tab changed can always be switched off.
                  disabled={
                    isCapturing || isCropCapturing || (!isPreviewCaptureAvailable && !isCropMode)
                  }
                  title={
                    isPreviewCaptureAvailable || isCropMode
                      ? `Crop screenshot for Claude (${kbd('mod', 'shift', 'C')})`
                      : 'Open the Preview tab to crop a screenshot'
                  }
                  data-education-id="crop-button"
                >
                  {isCropCapturing ? (
                    <Spinner size="sm" style={{ color: 'var(--accent-active)' }} />
                  ) : (
                    <CropIcon size={14} />
                  )}
                  <span className="capture-label-full">Crop Screenshot</span>
                  <span className="capture-shortcut">{kbd('mod', 'shift', 'C')}</span>
                </ToggleButton>
              </>
            )}
          </div>

          <div className="terminal-pane-footer-right">
            {canSplit && (
              <ToggleButton
                variant="ghost"
                type="button"
                pressed={isSplitActive}
                onClick={() => (isSplitActive ? disableSplitView() : enableSplitView())}
                title={isSplitActive ? 'Exit side-by-side view' : 'View agents side by side'}
                aria-label="Toggle side-by-side view"
              >
                <SplitViewIcon aria-hidden="true" />
                <span>Split</span>
                <span
                  className={`toggle-pill-switch ${isSplitActive ? 'is-on' : ''}`}
                  aria-hidden
                />
              </ToggleButton>
            )}
            <ToolbarDropdown
              agent={getActiveTabAgent()}
              autoAcceptMode={autoAcceptMode}
              onNotificationSettings={onNotificationSettings}
              onSkills={onSkills}
              onMcp={onMcp}
              onAutoAcceptToggle={onAutoAcceptToggle}
              onHelp={onHelp}
              terminalPlugins={terminalPlugins}
              pluginProject={pluginProject}
              pluginActions={pluginActions}
              pluginTheme={pluginTheme}
            />
          </div>
        </div>
      </div>
    </DockablePanel>
  );
}
