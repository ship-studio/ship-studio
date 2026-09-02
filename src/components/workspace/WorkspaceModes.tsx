import { CodeIcon, EyeIcon, EyeOffIcon } from '@/components/icons';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { workspaceModeValue, type WorkspaceTab } from './workspaceViewState';

/** Props for the workspace preview, focus, code, branches, and pull-request mode controls. */
export interface WorkspaceModesProps {
  hasPreview: boolean;
  isPreviewHidden: boolean;
  workspaceTab: WorkspaceTab;
  setIsPreviewHidden: (hidden: boolean) => void;
  setIsAgentPanelHidden: (hidden: boolean) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  /** Fired when the Preview tab is picked. The parent starts the dev server
   *  if it isn't running, so selecting Preview always leads to a preview. */
  onSelectPreview?: () => void;
}

/** Renders the workspace mode tabs and focus toggle. */
export function WorkspaceModes({
  hasPreview,
  isPreviewHidden,
  workspaceTab,
  setIsPreviewHidden,
  setIsAgentPanelHidden,
  setWorkspaceTab,
  onSelectPreview,
}: WorkspaceModesProps) {
  return (
    <Tabs
      value={workspaceModeValue(isPreviewHidden, workspaceTab)}
      mode="navigation"
      className="workspace-tabs"
      onValueChange={(next) => {
        if (next === 'focus') {
          setIsAgentPanelHidden(false);
          setIsPreviewHidden(true);
          return;
        }
        setIsPreviewHidden(false);
        setWorkspaceTab(next as WorkspaceTab);
        if (next === 'preview') onSelectPreview?.();
      }}
    >
      <TabsList
        className="workspace-tabs-list"
        variant="stretch"
        appearance="underline"
        aria-label="Workspace mode"
      >
        {hasPreview && (
          <TabsTab
            value="preview"
            className="workspace-tab"
            leftIcon={<EyeIcon size={14} />}
            data-tooltip-disabled
            aria-label="Preview"
          >
            <span className="workspace-mode-label">Preview</span>
          </TabsTab>
        )}
        <TabsTab
          value="focus"
          className="workspace-tab"
          leftIcon={<EyeOffIcon size={14} />}
          title={isPreviewHidden ? 'Exit focus mode' : 'Hide preview — agent only'}
          aria-label="Focus"
        >
          <span className="workspace-mode-label">Focus</span>
        </TabsTab>
        <TabsTab
          value="code"
          className="workspace-tab"
          leftIcon={<CodeIcon size={14} />}
          title="Code"
          aria-label="Code"
        >
          <span className="workspace-mode-label">Code</span>
        </TabsTab>
      </TabsList>
    </Tabs>
  );
}
