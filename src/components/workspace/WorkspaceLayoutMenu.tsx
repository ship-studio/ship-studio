/**
 * The Layout menu: every arrangement move, without a drag.
 *
 * A drag is the fast way to move a panel and it is nobody's *only* way. This
 * menu does all of it from the keyboard — which side each panel is on, docked
 * or floating, one step left or right — and holds the two operations a drag
 * cannot express at all: making the current arrangement your default, and
 * giving a project back to it.
 *
 * @module components/workspace/WorkspaceLayoutMenu
 */

import { ChevronIcon, PanelLayoutIcon, PinIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { usePanelDock } from '../../contexts/PanelDockContext';
import {
  LAYOUT_PRESETS,
  PANEL_META,
  PREVIEW,
  indexOf,
  isDocked,
  type PanelId,
} from '../../lib/workspaceLayout';

/** Panels in the order they appear, so the menu reads like the workspace. */
function railPanels(order: readonly (PanelId | typeof PREVIEW)[]): PanelId[] {
  return order.filter((item): item is PanelId => item !== PREVIEW);
}

export function WorkspaceLayoutMenu() {
  const {
    layout,
    isCustomised,
    differsFromDefault,
    nudge,
    setDocked,
    applyPreset,
    saveAsDefault,
    resetToDefault,
  } = usePanelDock();

  const previewAt = indexOf(layout, PREVIEW);

  return (
    <Dropdown
      portal
      align="right"
      menuClassName="workspace-layout-menu"
      // The same shape as every other button in the workspace toolbar, and the
      // same shape as the other menu in it: a default-variant `MenuButton`
      // with a 16px `leftIcon` and a 10px chevron for its child. It was a
      // `variant="ghost"` trigger with the icon as a child, which meant no
      // control surface at all — a bare icon sitting in a row of boxes.
      trigger={(p) => (
        <MenuButton
          expanded={Boolean(p['aria-expanded'])}
          title="Panel layout"
          aria-label="Panel layout"
          data-workspace-panel="layout"
          leftIcon={<PanelLayoutIcon size={16} />}
          {...p}
        >
          <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
        </MenuButton>
      )}
    >
      <div className="workspace-layout-menu__section">Panels</div>
      {railPanels(layout.order).map((panel) => {
        const at = indexOf(layout, panel);
        const docked = isDocked(layout, panel);
        return (
          <div key={panel} className="workspace-layout-menu__row">
            <span className="workspace-layout-menu__name">{PANEL_META[panel].label}</span>
            <span className="workspace-layout-menu__where">
              {docked ? (at < previewAt ? 'Left' : 'Right') : 'Floating'}
            </span>
            <span className="workspace-layout-menu__moves">
              <button
                type="button"
                className="workspace-layout-menu__move workspace-layout-menu__move--left"
                onClick={() => nudge(panel, -1)}
                disabled={at === 0}
                title={`Move ${PANEL_META[panel].label} left`}
                aria-label={`Move ${PANEL_META[panel].label} left`}
              >
                <ChevronIcon size={12} />
              </button>
              <button
                type="button"
                className="workspace-layout-menu__move workspace-layout-menu__move--right"
                onClick={() => nudge(panel, 1)}
                disabled={at === layout.order.length - 1}
                title={`Move ${PANEL_META[panel].label} right`}
                aria-label={`Move ${PANEL_META[panel].label} right`}
              >
                <ChevronIcon size={12} />
              </button>
              <button
                type="button"
                className={`workspace-layout-menu__move workspace-layout-menu__move--pin${
                  docked ? ' is-on' : ''
                }`}
                onClick={() => setDocked(panel, !docked)}
                aria-pressed={docked}
                title={
                  docked
                    ? `Float ${PANEL_META[panel].label} over the workspace`
                    : `Dock ${PANEL_META[panel].label} into the workspace`
                }
                aria-label={
                  docked ? `Float ${PANEL_META[panel].label}` : `Dock ${PANEL_META[panel].label}`
                }
              >
                <PinIcon size={12} />
              </button>
            </span>
          </div>
        );
      })}

      <DropdownDivider />
      {/* A row rather than a list of described items. They are four starting
          points, not four commands, and stacking them with their descriptions
          pushed the two things below — save-as-default and reset — under the
          menu's scroll line, which is where the useful half of a menu goes to
          be never found. The description is the tooltip. */}
      <div className="workspace-layout-menu__section">Start from</div>
      <div className="workspace-layout-menu__presets">
        {LAYOUT_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant="secondary"
            size="compact"
            title={preset.description}
            onClick={() => applyPreset(preset)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <DropdownDivider />
      <DropdownItem onSelect={saveAsDefault} disabled={!differsFromDefault}>
        Save as my default layout
      </DropdownItem>
      {/* Disabled rather than hidden when the project has no arrangement of its
          own: "there is nothing to reset" is a useful thing to be able to see,
          and a menu whose items move around is harder to use than one whose
          items are sometimes greyed. */}
      <DropdownItem onSelect={resetToDefault} disabled={!isCustomised}>
        Reset this project to the default
      </DropdownItem>
    </Dropdown>
  );
}
