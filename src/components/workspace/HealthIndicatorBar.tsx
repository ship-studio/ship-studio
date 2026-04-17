/**
 * HealthIndicatorBar — renders the CodeHealthPanel with its left/right toolbar
 * button groups (restart server, project settings, compact mode, browser,
 * show/hide preview). Extracted from WorkspaceView.
 *
 * @module components/workspace/HealthIndicatorBar
 */

import type { RefObject } from 'react';
import { CodeHealthPanel } from '../CodeHealthPanel';
import type { CodeHealthPanelRef } from '../CodeHealthPanel';
import { BrowserDropdown } from '../BrowserDropdown';
import { ResetIcon, SettingsIcon, CompactIcon, PanelRightIcon } from '../icons';

export interface HealthIndicatorBarProps {
  projectPath: string;
  healthPanelRef: RefObject<CodeHealthPanelRef | null>;
  onAskClaude: (text: string) => void;
  onHealthOutput: (data: string) => void;

  isWebProject: boolean;
  customDevCommand: string | null;
  hasDevServer: boolean;
  projectType: string;
  isRestartingDevServer: boolean;
  isPreviewHidden: boolean;
  devServerPort: number;

  onRestartDevServer: () => Promise<void>;
  onOpenDevCommand: () => void;
  onOpenProjectSettings: () => void;
  onEnterCompactMode: () => Promise<void>;
  onShowPreview: () => void;
}

export function HealthIndicatorBar({
  projectPath,
  healthPanelRef,
  onAskClaude,
  onHealthOutput,
  isWebProject,
  customDevCommand,
  hasDevServer,
  projectType,
  isRestartingDevServer,
  isPreviewHidden,
  devServerPort,
  onRestartDevServer,
  onOpenDevCommand,
  onOpenProjectSettings,
  onEnterCompactMode,
  onShowPreview,
}: HealthIndicatorBarProps) {
  const toolbarLeft =
    isWebProject || customDevCommand ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="show-preview-btn icon-only"
          onClick={() => void onRestartDevServer()}
          disabled={isRestartingDevServer || (!hasDevServer && projectType !== 'statichtml')}
          title="Restart dev server"
          data-education-id="restart-server"
        >
          {isRestartingDevServer ? <div className="capture-spinner" /> : <ResetIcon size={12} />}
        </button>
        {!isWebProject && (
          <button
            className="show-preview-btn icon-only"
            onClick={onOpenDevCommand}
            title="Edit dev command"
          >
            <SettingsIcon size={12} />
          </button>
        )}
        <button
          className="show-preview-btn icon-only"
          data-education-id="project-settings-button"
          onClick={onOpenProjectSettings}
          title="Project settings"
        >
          <SettingsIcon size={12} />
        </button>
      </div>
    ) : (
      <button
        className="show-preview-btn icon-only"
        data-education-id="project-settings-button"
        onClick={onOpenProjectSettings}
        title="Project settings"
      >
        <SettingsIcon size={12} />
      </button>
    );

  const toolbarRight = isPreviewHidden ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {isWebProject && (
        <>
          <button
            className="show-preview-btn icon-only"
            onClick={() => void onEnterCompactMode()}
            title="Compact Mode"
            data-education-id="compact-button"
          >
            <CompactIcon size={12} />
          </button>
          <span data-education-id="browser-button">
            <BrowserDropdown
              url={`http://localhost:${devServerPort}`}
              buttonClassName="show-preview-btn icon-only"
              iconOnly
            />
          </span>
        </>
      )}
      <button
        className="show-preview-btn icon-only"
        onClick={onShowPreview}
        title="Show Panel"
        data-education-id="show-preview"
      >
        <PanelRightIcon size={12} />
      </button>
    </div>
  ) : undefined;

  return (
    <CodeHealthPanel
      ref={healthPanelRef}
      projectPath={projectPath}
      onAskClaude={onAskClaude}
      onHealthOutput={onHealthOutput}
      toolbarLeft={toolbarLeft}
      toolbarRight={toolbarRight}
    />
  );
}
