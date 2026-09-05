/**
 * Preview/code/branch surface for the full workspace layout.
 *
 * The parent owns tab state and domain data; this component owns the right
 * pane's view composition, including floating preview controls and branch tabs.
 */

import type { RefObject } from 'react';
import type {
  PluginAppActions,
  PluginProjectData,
  PluginThemeData,
} from '../../contexts/PluginContext';
import type { DevServerUnexpectedExit } from '../../hooks/useDevServer';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { Project } from '../../lib/project';
import type { ProjectType } from '../../lib/static-server';
import { BranchPRTabContainer, type BranchPRTabContainerProps } from './BranchPRTabContainer';
import { CodeTab } from '../code/CodeTab';
import type { HealthTabPanelRef } from '../code/HealthTabPanel';
import { PluginSlot } from '../plugins/PluginSlot';
import { Preview, type InspectTab, type PreviewHandle } from '../preview/Preview';
import { DeviceMirror } from '../preview/DeviceMirror';
import { ShopifySetup } from '../shopify/ShopifySetup';

/** Props for the web preview, mobile mirror, and code-side workspace pane. */
export interface WorkspacePreviewPaneProps {
  currentProject: Project;
  previewRef: RefObject<PreviewHandle | null>;
  workspaceTab: 'preview' | 'code' | 'branches' | 'prs';
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  hasPreview: boolean;
  projectTypeResolved: boolean;
  previewConnectionEnabled: boolean;
  projectType: ProjectType;
  isWebProject: boolean;
  mobilePreviewAvailable: boolean;
  setCurrentPreviewPage: (page: string) => void;
  devServerPort: number;
  handlePreviewReady: () => void;
  isCropMode: boolean;
  handleCropStart: () => void;
  handleCropComplete: (filePath: string | null) => void;
  handleCropCancel: () => void;
  isBranchSwitching: boolean;
  isRestartingDevServer: boolean;
  sendToClaude: (text: string) => unknown;
  showPreviewLogs: boolean;
  togglePreviewLogs: () => void;
  devServerOutput: string;
  devServerOutputVersion: number;
  onDevServerInput: (data: string) => void;
  onDevServerResize: (cols: number, rows: number) => void;
  inspectTab: InspectTab;
  setInspectTab: (tab: InspectTab) => void;
  healthPanelRef: RefObject<HealthTabPanelRef | null>;
  handleHealthOutput: (data: string) => void;
  needsInstall: { packageManager: string } | null;
  devServerUnexpectedExit: DevServerUnexpectedExit | null;
  handleRestartDevServer: () => Promise<void>;
  onRunInstall: () => void;
  openInCode: (file: string, line: number) => void;
  codeTarget: { file: string; line: number } | null;
  canUndo: boolean;
  canRedo: boolean;
  undoTitle: string;
  redoTitle: string;
  undoSnapshot: () => void | Promise<void>;
  redoSnapshot: () => void | Promise<void>;
  elementTreeVisible: boolean;
  elementTreePinned: boolean;
  toggleElementTreePinned: () => void;
  closeElementTree: () => void;
  setElementTreePreviewAvailable: (available: boolean) => void;
  variablesPanelVisible: boolean;
  variablesPanelPinned: boolean;
  toggleVariablesPanelPinned: () => void;
  closeVariablesPanel: () => void;
  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
  getSlotPlugins: (slot: string) => LoadedPlugin[];
  shopify: {
    showGate: boolean;
    markReady: () => void;
    connect: () => void;
  };
  branchTabs: Omit<
    BranchPRTabContainerProps,
    | 'workspaceTab'
    | 'setWorkspaceTab'
    | 'hasPreview'
    | 'projectTypeResolved'
    | 'projectPath'
    | 'onSendToAgent'
  >;
}

/** Renders the active preview-side surface for the current project and workspace mode. */
export function WorkspacePreviewPane(props: WorkspacePreviewPaneProps) {
  const {
    currentProject,
    previewRef,
    workspaceTab,
    setWorkspaceTab,
    hasPreview,
    projectTypeResolved,
    previewConnectionEnabled,
    projectType,
    isWebProject,
    mobilePreviewAvailable,
    setCurrentPreviewPage,
    devServerPort,
    handlePreviewReady,
    isCropMode,
    handleCropStart,
    handleCropComplete,
    handleCropCancel,
    isBranchSwitching,
    isRestartingDevServer,
    sendToClaude,
    showPreviewLogs,
    togglePreviewLogs,
    devServerOutput,
    devServerOutputVersion,
    onDevServerInput,
    onDevServerResize,
    inspectTab,
    setInspectTab,
    healthPanelRef,
    handleHealthOutput,
    needsInstall,
    devServerUnexpectedExit,
    handleRestartDevServer,
    onRunInstall,
    openInCode,
    codeTarget,
    canUndo,
    canRedo,
    undoTitle,
    redoTitle,
    undoSnapshot,
    redoSnapshot,
    elementTreeVisible,
    elementTreePinned,
    toggleElementTreePinned,
    closeElementTree,
    setElementTreePreviewAvailable,
    variablesPanelVisible,
    variablesPanelPinned,
    toggleVariablesPanelPinned,
    closeVariablesPanel,
    pluginProject,
    pluginActions,
    pluginTheme,
    getSlotPlugins,
    shopify,
    branchTabs,
  } = props;
  const {
    integrations,
    branches,
    openPRs,
    currentBranch,
    handleBranchSwitch,
    handleRestartDevServer: handleBranchRestartDevServer,
    setShowSubmitReview,
    fetchBranchInfo,
    handleResolveConflicts,
    handleGitHubConnect,
    createBranchRequest,
    ...worktreeProps
  } = branchTabs;
  const previewSlotPlugins = getSlotPlugins('preview');
  const previewSurfaceVisible = isWebProject || !projectTypeResolved;

  return (
    <div className="preview-pane">
      {/* The .preview-tabs-bar that used to live here was
    lifted up to the workspace-main level so it spans
    the full workspace width. Tab switching behavior
    is unchanged — the content below still swaps
    based on `workspaceTab`. */}

      {/* Tab content */}
      {workspaceTab === 'preview' && previewSurfaceVisible && isWebProject && shopify.showGate && (
        <ShopifySetup
          key={currentProject.path}
          projectPath={currentProject.path}
          onSendToAgent={sendToClaude}
          onReady={shopify.markReady}
          onConnected={shopify.connect}
        />
      )}
      {workspaceTab === 'preview' && previewSurfaceVisible && !shopify.showGate && (
        <div style={{ flex: 1, display: 'flex' }}>
          <Preview
            key={`${currentProject.path}-${devServerPort}`}
            ref={previewRef}
            port={devServerPort}
            projectPath={currentProject.path}
            isStaticProject={projectType === 'statichtml'}
            previewConnectionEnabled={previewConnectionEnabled}
            projectType={projectType}
            onServerReady={handlePreviewReady}
            onPageChange={setCurrentPreviewPage}
            isCropMode={isCropMode}
            onCropStart={handleCropStart}
            onCropComplete={handleCropComplete}
            onCropCancel={handleCropCancel}
            isBranchSwitching={isBranchSwitching}
            isDevServerRestarting={isRestartingDevServer}
            onSendToClaude={sendToClaude}
            showLogs={showPreviewLogs}
            onToggleLogs={togglePreviewLogs}
            devServerOutput={devServerOutput}
            devServerOutputVersion={devServerOutputVersion}
            onDevServerInput={onDevServerInput}
            onDevServerResize={onDevServerResize}
            inspectTab={inspectTab}
            onInspectTabChange={setInspectTab}
            healthPanelRef={healthPanelRef}
            onHealthOutput={handleHealthOutput}
            needsInstall={needsInstall}
            devServerUnexpectedExit={devServerUnexpectedExit}
            onRestartDevServer={() => void handleRestartDevServer()}
            onRunInstall={onRunInstall}
            onOpenInCode={openInCode}
            canUndo={canUndo}
            canRedo={canRedo}
            undoTitle={undoTitle}
            redoTitle={redoTitle}
            onUndo={() => void undoSnapshot()}
            onRedo={() => void redoSnapshot()}
            elementTreeVisible={elementTreeVisible}
            elementTreePinned={elementTreePinned}
            onToggleElementTreePin={toggleElementTreePinned}
            onCloseElementTree={closeElementTree}
            onElementTreeAvailabilityChange={setElementTreePreviewAvailable}
            variablesPanelVisible={variablesPanelVisible}
            variablesPanelPinned={variablesPanelPinned}
            onToggleVariablesPanelPin={toggleVariablesPanelPinned}
            onCloseVariablesPanel={closeVariablesPanel}
            previewPlugins={
              previewSlotPlugins.length > 0 ? (
                <PluginSlot
                  name="preview"
                  plugins={previewSlotPlugins}
                  project={pluginProject}
                  actions={pluginActions}
                  theme={pluginTheme}
                />
              ) : null
            }
          />
        </div>
      )}
      {workspaceTab === 'preview' && mobilePreviewAvailable && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <DeviceMirror
            key={currentProject.path}
            projectName={currentProject.name}
            projectPath={currentProject.path}
            onSendToAgent={sendToClaude}
          />
        </div>
      )}
      {workspaceTab === 'code' && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
          <CodeTab
            projectPath={currentProject.path}
            onSendToAgent={sendToClaude}
            revealTarget={codeTarget}
          />
        </div>
      )}
      <BranchPRTabContainer
        workspaceTab={workspaceTab}
        setWorkspaceTab={setWorkspaceTab}
        hasPreview={hasPreview}
        projectTypeResolved={projectTypeResolved}
        integrations={integrations}
        branches={branches}
        openPRs={openPRs}
        currentBranch={currentBranch}
        projectPath={currentProject.path}
        handleBranchSwitch={handleBranchSwitch}
        handleRestartDevServer={handleBranchRestartDevServer}
        setShowSubmitReview={setShowSubmitReview}
        fetchBranchInfo={fetchBranchInfo}
        handleResolveConflicts={handleResolveConflicts}
        handleGitHubConnect={handleGitHubConnect}
        onSendToAgent={sendToClaude}
        createBranchRequest={createBranchRequest}
        {...worktreeProps}
      />
    </div>
  );
}
