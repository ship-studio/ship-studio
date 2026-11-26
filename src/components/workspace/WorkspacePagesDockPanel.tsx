/** Workspace rail adapter for the Pages panel content. */

import type { ProjectType } from '../../lib/static-server';
import { usePanelDockBinding } from '../../contexts/PanelDockContext';
import { DockablePanel } from '../primitives/DockablePanel';
import { PagesPanel } from '../pages/PagesPanel';

interface WorkspacePagesDockPanelProps {
  projectPath: string;
  projectType: ProjectType;
  currentRoute: string;
  selectedTemplateRoute: string | null;
  visible: boolean;
  docked: boolean;
  onToggleDocked: () => void;
  onClose: () => void;
  onOpenPage: (route: string) => void;
  onOpenSourceFile: (filePath: string) => void;
  onOpenDuplicatedPage: (route: string) => Promise<'opened' | 'not-ready' | 'cancelled'>;
}

/** Places the Pages feature in the persistent, rearrangeable workspace rail. */
export function WorkspacePagesDockPanel({
  projectPath,
  projectType,
  currentRoute,
  selectedTemplateRoute,
  visible,
  docked,
  onToggleDocked,
  onClose,
  onOpenPage,
  onOpenSourceFile,
  onOpenDuplicatedPage,
}: WorkspacePagesDockPanelProps) {
  const dock = usePanelDockBinding('pages');
  const contentVisible = visible && !dock?.focusMode;

  return (
    <DockablePanel
      dock={dock}
      docked={docked}
      visible={visible}
      ariaLabel="Pages panel"
      positionKey="pagesPanelFloatingPosition"
      sizeKey="pagesPanelFloatingSize"
      floatingSize={{ width: 360, height: 680 }}
      initialPosition={() => ({ left: Math.max(24, window.innerWidth - 384), top: 96 })}
      surfaceClassName="dockable-panel__surface--preview"
    >
      {contentVisible && (
        <PagesPanel
          projectPath={projectPath}
          projectType={projectType}
          currentRoute={currentRoute}
          selectedTemplateRoute={selectedTemplateRoute}
          onOpenPage={onOpenPage}
          onOpenSourceFile={onOpenSourceFile}
          onOpenDuplicatedPage={onOpenDuplicatedPage}
          pinned={docked}
          onTogglePin={onToggleDocked}
          onClose={onClose}
        />
      )}
    </DockablePanel>
  );
}
