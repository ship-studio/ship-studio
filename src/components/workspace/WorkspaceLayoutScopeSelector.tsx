import { ElementLinkIcon, WorkspacePanelUnlinkIcon } from '@/components/icons';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { usePanelDock } from '../../contexts/PanelDockContext';
import type { LayoutScope } from '../../lib/workspaceLayoutStore';

/** The scope and linked mode controls shared by both Panel Layout menus. */
export function WorkspaceLayoutScopeSelector() {
  const { layoutScope, setLayoutScope, singlePanelModeEnabled, toggleSinglePanelMode } =
    usePanelDock();
  const LinkIcon = singlePanelModeEnabled ? ElementLinkIcon : WorkspacePanelUnlinkIcon;

  return (
    <div className="workspace-layout-menu__scope">
      <span className="workspace-layout-menu__scope-label">Layout applies to</span>
      <div className="workspace-layout-menu__scope-controls">
        <Tabs
          value={layoutScope}
          size="default"
          mode="navigation"
          onValueChange={(next) => setLayoutScope(next as LayoutScope)}
          className="workspace-layout-menu__scope-tabs"
        >
          <TabsList aria-label="Layout applies to">
            <TabsTab value="project">This project</TabsTab>
            <TabsTab value="global">All projects</TabsTab>
          </TabsList>
        </Tabs>
        <ToggleButton
          variant="ghost"
          leftIcon={<LinkIcon size={16} />}
          className="workspace-layout-menu__linked-toggle"
          title={singlePanelModeEnabled ? 'Unlink toolbar panels' : 'Link toolbar panels'}
          aria-label="Linked mode"
          pressed={singlePanelModeEnabled}
          onClick={toggleSinglePanelMode}
        />
      </div>
    </div>
  );
}
