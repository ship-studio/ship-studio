/**
 * The Layout menu: every arrangement move, without a drag.
 *
 * A drag is the fast way to move a panel and it is nobody's *only* way. This
 * menu does all of it from the keyboard — which side each panel is on, docked
 * or floating, one step left or right — and holds the two operations a drag
 * cannot express at all: making the current arrangement your default, and
 * giving a project back to it.
 *
 * @module components/workspace/WorkspaceLayoutMenuLegacy
 */

import { ChevronIcon, DragHandleIcon, PanelLayoutIcon, PinIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { DragSortHandle, DragSortItem, DragSortScope } from '../primitives/DragSort';
import { usePanelDock } from '../../contexts/PanelDockContext';
import { WorkspaceLayoutScopeSelector } from './WorkspaceLayoutScopeSelector';
import { WorkspaceLayoutMenuSlides } from './WorkspaceLayoutMenuSlides';
import {
  LAYOUT_PRESETS,
  PANEL_META,
  PREVIEW,
  type PanelId,
  type RailItem,
} from '../../lib/workspaceLayout';

interface LegacyMenuLayout {
  order: RailItem[];
  floating: PanelId[];
}

/** Project the v2 structure into the exact flat view the backup menu used. */
function projectLegacyLayout(value: unknown): LegacyMenuLayout {
  if (!value || typeof value !== 'object') return { order: [PREVIEW], floating: [] };
  const source = value as { order?: unknown; columns?: unknown; floating?: unknown };
  if (Array.isArray(source.order)) {
    return {
      order: source.order.filter(
        (item): item is RailItem => item === PREVIEW || typeof item === 'string'
      ),
      floating: Array.isArray(source.floating)
        ? source.floating.filter((item): item is PanelId => typeof item === 'string')
        : [],
    };
  }
  const order: RailItem[] = [];
  if (Array.isArray(source.columns)) {
    for (const rawColumn of source.columns) {
      if (!rawColumn || typeof rawColumn !== 'object') continue;
      const column = rawColumn as { kind?: unknown; panels?: unknown };
      if (column.kind === 'preview') {
        order.push(PREVIEW);
        continue;
      }
      if (!Array.isArray(column.panels)) continue;
      for (const placement of column.panels) {
        const panel =
          typeof placement === 'string'
            ? placement
            : placement && typeof placement === 'object'
              ? (placement as { panel?: unknown }).panel
              : undefined;
        if (typeof panel === 'string') order.push(panel as PanelId);
      }
    }
  }
  return {
    order: order.includes(PREVIEW) ? order : [...order, PREVIEW],
    floating: Array.isArray(source.floating)
      ? source.floating.filter((item): item is PanelId => typeof item === 'string')
      : [],
  };
}

interface PanelLayoutRowContentProps {
  panel: PanelId;
  docked: boolean;
  at: number;
  previewAt: number;
  lastIndex: number;
  interactive: boolean;
  reorderable: boolean;
  onToggleDock?: () => void;
  onNudge?: (delta: -1 | 1) => void;
}

function PanelLayoutRowContent({
  panel,
  docked,
  at,
  previewAt,
  lastIndex,
  interactive,
  reorderable,
  onToggleDock,
  onNudge,
}: PanelLayoutRowContentProps) {
  const label = PANEL_META[panel].label;
  const pin = interactive ? (
    <button
      type="button"
      className={`workspace-layout-menu__move workspace-layout-menu__move--pin${
        docked ? ' is-on' : ''
      }`}
      onClick={onToggleDock}
      aria-pressed={docked}
      title={docked ? `Float ${label} over the workspace` : `Dock ${label} into the workspace`}
      aria-label={docked ? `Float ${label}` : `Dock ${label}`}
    >
      <PinIcon size={12} />
    </button>
  ) : (
    <span
      className={`workspace-layout-menu__move workspace-layout-menu__move--pin${
        docked ? ' is-on' : ''
      }`}
      aria-hidden="true"
    >
      <PinIcon size={12} />
    </span>
  );
  const moves = interactive ? (
    <>
      <button
        type="button"
        className="workspace-layout-menu__move workspace-layout-menu__move--left"
        onClick={() => onNudge?.(-1)}
        disabled={!reorderable || at === 0}
        title={`Move ${label} left`}
        aria-label={`Move ${label} left`}
      >
        <ChevronIcon size={12} />
      </button>
      <button
        type="button"
        className="workspace-layout-menu__move workspace-layout-menu__move--right"
        onClick={() => onNudge?.(1)}
        disabled={!reorderable || at === lastIndex}
        title={`Move ${label} right`}
        aria-label={`Move ${label} right`}
      >
        <ChevronIcon size={12} />
      </button>
    </>
  ) : (
    <>
      <span
        className="workspace-layout-menu__move workspace-layout-menu__move--left"
        aria-hidden="true"
      >
        <ChevronIcon size={12} />
      </span>
      <span
        className="workspace-layout-menu__move workspace-layout-menu__move--right"
        aria-hidden="true"
      >
        <ChevronIcon size={12} />
      </span>
    </>
  );

  return (
    <>
      <span className="workspace-layout-menu__heading">
        {pin}
        <span className="workspace-layout-menu__name">{label}</span>
      </span>
      <span className="workspace-layout-menu__where">
        {docked ? (at < previewAt ? 'Left' : 'Right') : 'Floating'}
      </span>
      <span className="workspace-layout-menu__moves">{moves}</span>
    </>
  );
}

function PanelLayoutRowOverlay({
  panel,
  docked,
  at,
  previewAt,
  lastIndex,
}: Omit<PanelLayoutRowContentProps, 'interactive' | 'onToggleDock' | 'onNudge'>) {
  return (
    <div
      className="workspace-layout-menu__row workspace-layout-menu__row--overlay"
      data-drag-sort-overlay-content="true"
      aria-hidden="true"
    >
      <span className="workspace-layout-menu__drag-handle-ghost">
        <DragHandleIcon size={14} />
      </span>
      <PanelLayoutRowContent
        panel={panel}
        docked={docked}
        at={at}
        previewAt={previewAt}
        lastIndex={lastIndex}
        interactive={false}
        reorderable={false}
      />
    </div>
  );
}

export function WorkspaceLayoutMenuLegacy() {
  const {
    layout,
    layoutScope,
    isCustomised,
    differsFromDefault,
    nudge,
    setOrder,
    setDocked,
    applyPreset,
    saveAsDefault,
    resetToDefault,
  } = usePanelDock();
  const menuLayout = projectLegacyLayout(layout);
  const hasStackedColumns = layout.columns.some(
    (column) => column.kind === 'panels' && column.panels.length > 1
  );

  const previewAt = menuLayout.order.indexOf(PREVIEW);
  const commitProjectedOrder = (move: { projectedOrder?: readonly (string | number)[] }) => {
    if (!hasStackedColumns && move.projectedOrder) setOrder(move.projectedOrder as RailItem[]);
  };
  const hasLeftDockedPanel = menuLayout.order.some(
    (item) =>
      item !== PREVIEW &&
      !menuLayout.floating.includes(item) &&
      menuLayout.order.indexOf(item) < previewAt
  );
  const hasRightDockedPanel = menuLayout.order.some(
    (item) =>
      item !== PREVIEW &&
      !menuLayout.floating.includes(item) &&
      menuLayout.order.indexOf(item) > previewAt
  );
  const showSideDivider = hasLeftDockedPanel && hasRightDockedPanel;

  return (
    <Dropdown
      portal
      align="right"
      menuClassName="workspace-layout-menu workspace-layout-menu--spatial workspace-layout-menu--legacy"
      trigger={(p) => (
        <MenuButton
          variant="ghost"
          expanded={Boolean(p['aria-expanded'])}
          title="Panel layout"
          aria-label="Panel layout"
          data-workspace-panel="layout"
          leftIcon={<PanelLayoutIcon size={16} />}
          rightIcon={<ChevronIcon />}
          {...p}
        />
      )}
    >
      <div className="workspace-layout-menu__title">Panel Layout</div>
      <DragSortScope
        axis="vertical"
        items={menuLayout.order}
        label="Panel layout"
        onMove={commitProjectedOrder}
      >
        <WorkspaceLayoutScopeSelector />
        <DropdownDivider />
        <WorkspaceLayoutMenuSlides>
          <div className="workspace-layout-menu__scroll-body" data-layout-scroll-body="true">
            <div className="workspace-layout-menu__section">Panels</div>
            {menuLayout.order.map((item, itemIndex) => {
              if (item === PREVIEW) {
                return (
                  <DragSortItem
                    key={item}
                    id={item}
                    index={itemIndex}
                    label="Preview"
                    disabled
                    className={`workspace-layout-menu__row workspace-layout-menu__row--preview${
                      showSideDivider ? ' is-boundary' : ''
                    }`}
                  >
                    <span className="workspace-layout-menu__preview-label">Preview</span>
                  </DragSortItem>
                );
              }
              const panel = item;
              const at = menuLayout.order.indexOf(panel);
              const docked = !menuLayout.floating.includes(panel);
              return (
                <DragSortItem
                  key={panel}
                  id={panel}
                  index={itemIndex}
                  label={PANEL_META[panel].label}
                  disabled={hasStackedColumns}
                  className="workspace-layout-menu__row"
                  overlay={
                    <PanelLayoutRowOverlay
                      panel={panel}
                      docked={docked}
                      at={at}
                      previewAt={previewAt}
                      lastIndex={menuLayout.order.length - 1}
                      reorderable={false}
                    />
                  }
                >
                  <DragSortHandle label={`Move ${PANEL_META[panel].label} panel`} />
                  <PanelLayoutRowContent
                    panel={panel}
                    docked={docked}
                    at={at}
                    previewAt={previewAt}
                    lastIndex={menuLayout.order.length - 1}
                    interactive
                    reorderable={!hasStackedColumns}
                    onToggleDock={() => setDocked(panel, !docked)}
                    onNudge={(delta) => nudge(panel, delta)}
                  />
                </DragSortItem>
              );
            })}
          </div>
        </WorkspaceLayoutMenuSlides>

        <div className="workspace-layout-menu__footer" data-layout-footer="true">
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
                variant="default"
                size="default"
                title={preset.description}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <DropdownDivider />
          {layoutScope === 'project' && (
            <>
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
            </>
          )}
        </div>
      </DragSortScope>
    </Dropdown>
  );
}
