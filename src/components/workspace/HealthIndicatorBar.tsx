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
import { CompactIcon, PanelRightIcon, PanelLeftIcon } from '../icons';

export interface HealthIndicatorBarProps {
  projectPath: string;
  healthPanelRef: RefObject<CodeHealthPanelRef | null>;
  onAskClaude: (text: string) => void;
  onHealthOutput: (data: string) => void;

  isWebProject: boolean;
  isPreviewHidden: boolean;
  devServerPort: number;

  onEnterCompactMode: () => Promise<void>;
  onShowPreview: () => void;
  /** Current sidebar visibility in the workspace. Ignored on home/
   *  projects view since that view always renders the sidebar. */
  isSidebarHidden: boolean;
  /** Flip sidebar visibility. */
  onToggleSidebar: () => void;
}

export function HealthIndicatorBar({
  projectPath,
  healthPanelRef,
  onAskClaude,
  onHealthOutput,
  isWebProject,
  isPreviewHidden,
  devServerPort,
  onEnterCompactMode,
  onShowPreview,
  isSidebarHidden,
  onToggleSidebar,
}: HealthIndicatorBarProps) {
  // Only the sidebar toggle lives in this top toolbar. Restart / project
  // settings moved one row down into `.terminal-tabs-bar` alongside the
  // health-logs + kebab controls, so the health panel row stays minimal.
  const toolbarLeft = (
    <button
      className="show-preview-btn icon-only"
      onClick={onToggleSidebar}
      title={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
      aria-label={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
      data-education-id="toggle-sidebar"
    >
      <PanelLeftIcon size={12} />
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
