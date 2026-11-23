/**
 * The spatial Panel Layout editor.
 *
 * The editor is deliberately a vertical outline rather than a miniature
 * horizontal workspace. Columns stay in side order, Preview is a locked
 * divider between them, and each side has one explicit new-column target at
 * the end of its list. The model column index is kept on each card so
 * filtered floating-only columns never change the destination sent to
 * PanelDockContext.
 */

import {
  ChevronIcon,
  DragHandleIcon,
  MoreHorizontalIcon,
  PanelLayoutIcon,
  PinIcon,
  PlusIcon,
} from '@/components/icons';
import { Fragment, useEffect, useSyncExternalStore } from 'react';
import { Button } from '../primitives/Button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { MenuButton } from '../primitives/MenuButton';
import { DragSortHandle, DragSortItem, DragSortScope } from '../primitives/DragSort';
import { useDragSortContext } from '../../contexts/dragSortContextValue';
import { usePanelDock } from '../../contexts/PanelDockContext';
import { WorkspaceLayoutScopeSelector } from './WorkspaceLayoutScopeSelector';
import { WorkspaceLayoutMenuSlides } from './WorkspaceLayoutMenuSlides';
import type { DragSortSnapshot } from '../../lib/drag-sort/types';
import {
  LAYOUT_PRESETS,
  PANEL_IDS,
  PANEL_META,
  PREVIEW,
  type PanelId,
  type WorkspaceLayout,
} from '../../lib/workspaceLayout';

interface MenuColumn {
  id: string;
  sourceIndex: number;
  preview: boolean;
  panels: PanelId[];
  width?: number;
  side?: LayoutSide;
}

type LayoutSide = 'left' | 'right';
const PANEL_SORT_GROUP = 'panel-cards';
const COLUMN_SORT_GROUP = 'column-cards';

function isPanel(value: unknown): value is PanelId {
  return typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value);
}

function sideForSourceIndex(layout: WorkspaceLayout, sourceIndex: number): LayoutSide {
  const previewIndex = layout.columns.findIndex((column) => column.kind === 'preview');
  return sourceIndex < previewIndex ? 'left' : 'right';
}

function columnDragId(column: MenuColumn): string {
  return `workspace-layout-column-${column.panels.join('-')}`;
}

function newColumnId(side: LayoutSide): string {
  return `workspace-layout-new-column-${side}`;
}

function columnNewColumnId(side: LayoutSide): string {
  return `workspace-layout-column-drop-${side}`;
}

function sideDropZoneId(side: LayoutSide): string {
  return `workspace-layout-side-${side}`;
}

/** Hide floating-only columns while retaining their source model indices. */
function panelColumnFromModel(
  layout: WorkspaceLayout,
  sourceIndex: number
): MenuColumn | undefined {
  const column = layout.columns[sourceIndex];
  if (!column || column.kind === 'preview') return undefined;
  const panels = column.panels.map((placement) => placement.panel);
  return {
    id: `column-${panels.join('-')}`,
    sourceIndex,
    preview: false,
    panels,
    side: sideForSourceIndex(layout, sourceIndex),
    ...(column.width === undefined ? {} : { width: column.width }),
  };
}

function readColumns(layout: WorkspaceLayout): MenuColumn[] {
  return layout.columns.flatMap((column, sourceIndex): MenuColumn[] => {
    if (column.kind === 'preview') {
      return [{ id: `preview-${sourceIndex}`, sourceIndex, preview: true, panels: [] }];
    }

    const menuColumn = panelColumnFromModel(layout, sourceIndex);
    if (
      !menuColumn ||
      menuColumn.panels.length === 0 ||
      menuColumn.panels.every((panel) => layout.floating.includes(panel))
    )
      return [];

    return [menuColumn];
  });
}

function panelLabel(panel: PanelId): string {
  return panel === 'navigator' ? 'Elements' : PANEL_META[panel].label;
}

function visiblePanels(column: MenuColumn, floating: PanelId[]): PanelId[] {
  return column.panels.filter((panel) => !floating.includes(panel));
}

function panelTileId(panel: PanelId): string {
  return `workspace-layout-panel-${panel}`;
}

function panelFromDragId(value: string | number | null | undefined): PanelId | undefined {
  if (typeof value !== 'string' || !value.startsWith('workspace-layout-panel-')) return undefined;
  const panel = value.replace('workspace-layout-panel-', '');
  return isPanel(panel) ? panel : undefined;
}

function isCrossColumnPanelDrag(snapshot: DragSortSnapshot, layout: WorkspaceLayout): boolean {
  if (snapshot.phase !== 'dragging') return false;
  const activePanel = panelFromDragId(snapshot.activeId);
  const targetPanel = panelFromDragId(snapshot.targetId);
  if (!activePanel || !targetPanel || activePanel === targetPanel) return false;
  const activeColumn = layout.columns.find(
    (column) =>
      column.kind === 'panels' && column.panels.some((placement) => placement.panel === activePanel)
  );
  const targetColumn = layout.columns.find(
    (column) =>
      column.kind === 'panels' && column.panels.some((placement) => placement.panel === targetPanel)
  );
  return Boolean(activeColumn && targetColumn && activeColumn !== targetColumn);
}

function usePanelLayoutDragSnapshot(): DragSortSnapshot {
  const { manager } = useDragSortContext();
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
}

function overlay(panel: PanelId, floating: boolean) {
  return (
    <div
      className={`workspace-layout-menu__tile workspace-layout-menu__tile--overlay${floating ? ' workspace-layout-menu__tile--floating' : ''}`}
      data-drag-sort-overlay-content="true"
      aria-hidden="true"
    >
      <div className="workspace-layout-menu__panel-row">
        <span className="workspace-layout-menu__overlay-icon">
          <DragHandleIcon size={14} />
        </span>
        <span className="workspace-layout-menu__overlay-icon">
          <PinIcon size={12} />
        </span>
        <span className="workspace-layout-menu__tile-name">{panelLabel(panel)}</span>
        {!floating && (
          <span className="workspace-layout-menu__overlay-icon">
            <MoreHorizontalIcon size={14} />
          </span>
        )}
      </div>
    </div>
  );
}

function columnOverlay(column: MenuColumn, columnNumber: number, floating: PanelId[]) {
  return (
    <div
      className="workspace-layout-menu__column workspace-layout-menu__column--overlay"
      data-drag-sort-overlay-content="true"
      aria-hidden="true"
    >
      <div className="workspace-layout-menu__column-label-row">
        <span className="workspace-layout-menu__overlay-icon">
          <DragHandleIcon size={14} />
        </span>
        <span className="workspace-layout-menu__column-label">Column {columnNumber}</span>
      </div>
      {visiblePanels(column, floating).map((panel) => (
        <div className="workspace-layout-menu__tile" key={panel}>
          <div className="workspace-layout-menu__panel-row">
            <span className="workspace-layout-menu__overlay-icon">
              <PinIcon size={12} />
            </span>
            <span className="workspace-layout-menu__tile-name">{panelLabel(panel)}</span>
            <span className="workspace-layout-menu__overlay-icon">
              <MoreHorizontalIcon size={14} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function adjacentPanelColumn(
  columns: MenuColumn[],
  sourceIndex: number,
  direction: -1 | 1
): MenuColumn | undefined {
  const panelColumns = columns
    .filter((column) => !column.preview)
    .sort((left, right) => left.sourceIndex - right.sourceIndex);
  const currentIndex = panelColumns.findIndex((column) => column.sourceIndex === sourceIndex);
  return currentIndex < 0 ? undefined : panelColumns[currentIndex + direction];
}

interface PanelTileProps {
  panel: PanelId;
  column: MenuColumn;
  layout: WorkspaceLayout;
  index: number;
  sortIndex: number;
  columns: MenuColumn[];
  floatingPanels: PanelId[];
  floating: boolean;
  onAction: (action: string, panel: PanelId, columnIndex: number, index: number) => void;
}

function PanelTile({
  panel,
  column,
  layout,
  index,
  sortIndex,
  columns,
  floatingPanels,
  floating,
  onAction,
}: PanelTileProps) {
  const dragSnapshot = usePanelLayoutDragSnapshot();
  const visible = visiblePanels(column, floatingPanels);
  const visibleIndex = visible.indexOf(panel);
  const columnHasFloating = column.panels.some((item) => floatingPanels.includes(item));
  const canMoveUp = !floating && !columnHasFloating && visibleIndex > 0;
  const canMoveDown = !floating && !columnHasFloating && visibleIndex < visible.length - 1;
  const leftColumn = adjacentPanelColumn(columns, column.sourceIndex, -1);
  const rightColumn = adjacentPanelColumn(columns, column.sourceIndex, 1);
  const leftPanels = leftColumn ? visiblePanels(leftColumn, floatingPanels) : [];
  const rightPanels = rightColumn ? visiblePanels(rightColumn, floatingPanels) : [];
  const canStackLeft = Boolean(
    !floating &&
    leftColumn &&
    leftPanels.length === leftColumn.panels.length &&
    leftPanels.length > 0
  );
  const canStackRight = Boolean(
    !floating &&
    rightColumn &&
    rightPanels.length === rightColumn.panels.length &&
    rightPanels.length > 0
  );
  const canMoveToOwnColumn = !floating && column.panels.length > 1;
  const preserveColumnPositions = isCrossColumnPanelDrag(dragSnapshot, layout);

  return (
    <DragSortItem
      id={panelTileId(panel)}
      group={PANEL_SORT_GROUP}
      index={sortIndex}
      label={panelLabel(panel)}
      showTargetIndicator
      className={`workspace-layout-menu__tile${floating ? ' workspace-layout-menu__tile--floating' : ''}`}
      style={preserveColumnPositions ? { transform: 'none' } : undefined}
      overlay={overlay(panel, floating)}
    >
      <div className="workspace-layout-menu__panel-row">
        <DragSortHandle
          label={`Move ${panelLabel(panel)} panel`}
          visibility="hover"
          revealOn="item"
          className="workspace-layout-menu__hit-target"
          role="menuitem"
          data-layout-hit-target="true"
        />
        {floating ? (
          <>
            <IconButton
              variant="ghost"
              size="compact"
              className="workspace-layout-menu__icon-action workspace-layout-menu__move--pin panel-pin-toggle workspace-layout-menu__hit-target"
              icon={<PinIcon size={12} />}
              onClick={() => onAction('dock', panel, column.sourceIndex, index)}
              aria-pressed={false}
              title={`Dock ${panelLabel(panel)}`}
              aria-label={`Dock ${panelLabel(panel)}`}
              role="menuitem"
              data-layout-hit-target="true"
            />
            <span className="workspace-layout-menu__tile-name">{panelLabel(panel)}</span>
          </>
        ) : (
          <>
            <IconButton
              variant="ghost"
              size="compact"
              className="workspace-layout-menu__icon-action workspace-layout-menu__move--pin panel-pin-toggle workspace-layout-menu__hit-target is-on"
              icon={<PinIcon size={12} />}
              onClick={() => onAction('float', panel, column.sourceIndex, index)}
              aria-pressed
              title={`Float ${panelLabel(panel)}`}
              aria-label={`Float ${panelLabel(panel)}`}
              role="menuitem"
              data-layout-hit-target="true"
            />
            <span className="workspace-layout-menu__tile-name">{panelLabel(panel)}</span>
            <ContextMenu>
              <ContextMenuTrigger asChild openOnClick>
                <IconButton
                  variant="ghost"
                  size="compact"
                  className="workspace-layout-menu__more workspace-layout-menu__hit-target"
                  icon={<MoreHorizontalIcon size={14} />}
                  aria-haspopup="menu"
                  aria-label={`More options for ${panelLabel(panel)}`}
                  title={`More options for ${panelLabel(panel)}`}
                  role="menuitem"
                  data-layout-hit-target="true"
                />
              </ContextMenuTrigger>
              <ContextMenuContent aria-label={`Actions for ${panelLabel(panel)}`}>
                <ContextMenuItem
                  disabled={!canMoveUp}
                  aria-label={`Move ${panelLabel(panel)} up`}
                  onSelect={() => onAction('up', panel, column.sourceIndex, index)}
                >
                  <span className="workspace-layout-menu__context-icon workspace-layout-menu__context-icon--up">
                    <ChevronIcon size={12} />
                  </span>
                  <span>Move up</span>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!canMoveDown}
                  aria-label={`Move ${panelLabel(panel)} down`}
                  onSelect={() => onAction('down', panel, column.sourceIndex, index)}
                >
                  <span className="workspace-layout-menu__context-icon workspace-layout-menu__context-icon--down">
                    <ChevronIcon size={12} />
                  </span>
                  <span>Move down</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={!canMoveToOwnColumn}
                  aria-label={`Move ${panelLabel(panel)} to its own column left`}
                  onSelect={() => onAction('new-column-left', panel, column.sourceIndex, index)}
                >
                  <span className="workspace-layout-menu__context-icon workspace-layout-menu__context-icon--left">
                    <ChevronIcon size={12} />
                  </span>
                  <span>New column left</span>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!canMoveToOwnColumn}
                  aria-label={`Move ${panelLabel(panel)} to its own column right`}
                  onSelect={() => onAction('new-column-right', panel, column.sourceIndex, index)}
                >
                  <span className="workspace-layout-menu__context-icon workspace-layout-menu__context-icon--right">
                    <ChevronIcon size={12} />
                  </span>
                  <span>New column right</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={!canStackLeft}
                  aria-label={`Stack ${panelLabel(panel)} with column left`}
                  onSelect={() => onAction('stack-left', panel, column.sourceIndex, index)}
                >
                  <span>Stack with left</span>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!canStackRight}
                  aria-label={`Stack ${panelLabel(panel)} with column right`}
                  onSelect={() => onAction('stack-right', panel, column.sourceIndex, index)}
                >
                  <span>Stack with right</span>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </>
        )}
      </div>
    </DragSortItem>
  );
}

interface ColumnTileProps {
  column: MenuColumn;
  columnNumber: number;
  layout: WorkspaceLayout;
  sortIndex: number;
  columns: MenuColumn[];
  floatingPanels: PanelId[];
  panelSortIndex: (panel: PanelId) => number;
  onAction: (action: string, panel: PanelId, columnIndex: number, index: number) => void;
}

function ColumnTile({
  column,
  columnNumber,
  layout,
  sortIndex,
  columns,
  floatingPanels,
  panelSortIndex,
  onAction,
}: ColumnTileProps) {
  const dragSnapshot = usePanelLayoutDragSnapshot();
  const side = column.side ?? 'left';
  const visible = visiblePanels(column, floatingPanels);
  const activePanel = panelFromDragId(dragSnapshot.activeId);
  const targetPanel = panelFromDragId(dragSnapshot.targetId);
  const showPanelDropPlaceholder = Boolean(
    isCrossColumnPanelDrag(dragSnapshot, layout) &&
    activePanel &&
    targetPanel &&
    column.panels.includes(targetPanel) &&
    !column.panels.includes(activePanel)
  );
  const { manager } = useDragSortContext();
  const activeElement = activePanel
    ? (manager.getItem(panelTileId(activePanel))?.element ?? null)
    : null;
  const placeholderHeight = activeElement?.getBoundingClientRect().height;
  const placeholder = showPanelDropPlaceholder ? (
    <div
      className="workspace-layout-menu__panel-drop-placeholder"
      data-layout-panel-drop-placeholder="true"
      style={placeholderHeight ? { height: `${placeholderHeight}px` } : undefined}
      aria-hidden="true"
    />
  ) : null;

  const renderPanel = (panel: PanelId, index: number) => (
    <Fragment key={panel}>
      {showPanelDropPlaceholder && panel === targetPanel && dragSnapshot.placement === 'before'
        ? placeholder
        : null}
      <PanelTile
        panel={panel}
        column={column}
        layout={layout}
        index={index}
        sortIndex={panelSortIndex(panel)}
        columns={columns}
        floatingPanels={floatingPanels}
        floating={false}
        onAction={onAction}
      />
      {showPanelDropPlaceholder && panel === targetPanel && dragSnapshot.placement === 'after'
        ? placeholder
        : null}
    </Fragment>
  );
  return (
    <DragSortItem
      id={columnDragId(column)}
      group={COLUMN_SORT_GROUP}
      index={sortIndex}
      label={`${side === 'left' ? 'Left' : 'Right'} column ${columnNumber}`}
      activation="item"
      className="workspace-layout-menu__column-sort-item"
      overlay={columnOverlay(column, columnNumber, floatingPanels)}
    >
      <div
        className="workspace-layout-menu__column"
        data-column-index={columnNumber - 1}
        data-model-column-index={column.sourceIndex}
        data-layout-column-card="true"
      >
        <div className="workspace-layout-menu__column-label-row">
          <DragSortHandle
            label={`Move ${side === 'left' ? 'Left' : 'Right'} column ${columnNumber}`}
            visibility="hover"
            revealOn="item"
            className="workspace-layout-menu__hit-target"
            role="menuitem"
            data-layout-hit-target="true"
          />
          <span className="workspace-layout-menu__column-label">Column {columnNumber}</span>
        </div>
        {visible.map(renderPanel)}
      </div>
    </DragSortItem>
  );
}

function NewColumnDropZone({
  side,
  sortIndex,
  columnSortIndex,
}: {
  side: LayoutSide;
  sortIndex: number;
  columnSortIndex: number;
}) {
  const { manager } = useDragSortContext();
  const snapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot
  );
  const activeId = snapshot.activeId;
  const dragging = snapshot.phase === 'dragging' && typeof activeId === 'string';
  const panelTargetVisible = dragging && activeId.startsWith('workspace-layout-panel-');
  const columnTargetVisible = dragging && activeId.startsWith('workspace-layout-column-');
  const targetVisible = panelTargetVisible || columnTargetVisible;

  useEffect(() => {
    if (targetVisible) manager.remeasure();
  }, [manager, targetVisible]);

  if (!targetVisible) return null;

  const label = side === 'left' ? 'New left column' : 'New right column';
  return (
    <DragSortItem
      id={columnNewColumnId(side)}
      group={COLUMN_SORT_GROUP}
      index={columnSortIndex}
      label={`Create a new ${side} column`}
      targetOnly
      className="workspace-layout-menu__new-column-target"
    >
      {panelTargetVisible && (
        <DragSortItem
          id={newColumnId(side)}
          group={PANEL_SORT_GROUP}
          index={sortIndex}
          label={`Create a new ${side} column`}
          targetOnly
          className="workspace-layout-menu__new-column"
          data-layout-new-column={side}
        >
          <PlusIcon size={12} />
          <span>{label}</span>
        </DragSortItem>
      )}
    </DragSortItem>
  );
}

export function WorkspaceLayoutMenuNew() {
  const context = usePanelDock();
  const {
    layout,
    layoutScope,
    isCustomised,
    differsFromDefault,
    applyPreset,
    saveAsDefault,
    resetToDefault,
  } = context;
  const columns = readColumns(layout);
  const floating = layout.floating;

  const action = (name: string, panel: PanelId, sourceIndex: number, _index: number) => {
    if (name === 'float' || name === 'dock') {
      context.setFloating(panel, name === 'float');
      return;
    }
    if (name === 'up' || name === 'down') {
      const column = columns.find((item) => item.sourceIndex === sourceIndex);
      if (!column || column.preview) return;
      const visible = visiblePanels(column, floating);
      if (visible.length !== column.panels.length) return;
      const panelIndex = visible.indexOf(panel);
      const targetPanel = visible[panelIndex + (name === 'up' ? -1 : 1)];
      if (!targetPanel) return;
      const targetIndex = column.panels.indexOf(targetPanel);
      context.stackPanel(panel, sourceIndex, name === 'up' ? targetIndex : targetIndex + 1);
      return;
    }
    if (name === 'new-column-left' || name === 'new-column-right') {
      context.movePanelToColumnGap(panel, sourceIndex + (name === 'new-column-right' ? 1 : 0));
      return;
    }
    if (name === 'stack-left' || name === 'stack-right') {
      const target = adjacentPanelColumn(columns, sourceIndex, name === 'stack-left' ? -1 : 1);
      if (!target) return;
      const targetPanels = visiblePanels(target, floating);
      if (targetPanels.length !== target.panels.length) return;
      const targetPanel =
        name === 'stack-left' ? targetPanels[targetPanels.length - 1] : targetPanels[0];
      if (!targetPanel) return;
      const targetIndex = target.panels.indexOf(targetPanel);
      context.stackPanel(
        panel,
        target.sourceIndex,
        name === 'stack-left' ? targetIndex + 1 : targetIndex
      );
    }
  };

  const previewIndex = layout.columns.findIndex((column) => column.kind === 'preview');
  const leftColumns = columns.filter((column) => !column.preview && column.side === 'left');
  const rightColumns = columns.filter((column) => !column.preview && column.side === 'right');
  const dockedPanelIds = columns.flatMap((column) =>
    column.preview ? [] : visiblePanels(column, floating).map(panelTileId)
  );
  const panelSortIds = [...dockedPanelIds, ...floating.map(panelTileId)];
  const panelTargetIds = [newColumnId('left'), newColumnId('right')];
  const columnTargetIds = [
    sideDropZoneId('left'),
    columnNewColumnId('left'),
    sideDropZoneId('right'),
    columnNewColumnId('right'),
  ];
  const columnSortIds = [
    ...leftColumns.map(columnDragId),
    PREVIEW,
    ...rightColumns.map(columnDragId),
  ];
  const dragIds = [...columnSortIds, ...columnTargetIds, ...panelSortIds, ...panelTargetIds];
  const panelSortIndex = (panel: PanelId) => panelSortIds.indexOf(panelTileId(panel));
  const columnSortIndex = (column: MenuColumn) => columnSortIds.indexOf(columnDragId(column));

  const onPanelDragMove = (move: {
    activeId: string | number;
    targetId?: string | number;
    to: { placement?: string };
  }) => {
    const active = String(move.activeId).replace('workspace-layout-panel-', '') as PanelId;
    const targetId = move.targetId === undefined ? '' : String(move.targetId);
    if (!isPanel(active)) return;
    if (targetId === newColumnId('left') || targetId === newColumnId('right')) {
      const side = targetId.endsWith('-left') ? 'left' : 'right';
      context.movePanelToColumnGap(active, side === 'left' ? previewIndex : layout.columns.length);
      return;
    }
    const targetPanel = targetId.replace('workspace-layout-panel-', '') as PanelId;
    if (!isPanel(targetPanel)) return;
    const destinationIndex = layout.columns.findIndex(
      (column) =>
        column.kind === 'panels' &&
        column.panels.some((placement) => placement.panel === targetPanel)
    );
    const destination = layout.columns[destinationIndex];
    if (destinationIndex < 0 || !destination || destination.kind === 'preview') return;
    const targetIndex = destination.panels.findIndex(
      (placement) => placement.panel === targetPanel
    );
    const insertion = move.to.placement === 'before' ? targetIndex : targetIndex + 1;
    context.stackPanel(active, destinationIndex, insertion);
  };

  const onColumnDragMove = (move: {
    activeId: string | number;
    targetId?: string | number;
    to: { placement?: string };
  }) => {
    const activeId = String(move.activeId);
    const targetId = move.targetId === undefined ? '' : String(move.targetId);
    const active = columns.find((column) => !column.preview && columnDragId(column) === activeId);
    const target = columns.find((column) => !column.preview && columnDragId(column) === targetId);
    if (!active) return;
    const targetNewSide: LayoutSide | undefined =
      targetId === columnNewColumnId('left')
        ? 'left'
        : targetId === columnNewColumnId('right')
          ? 'right'
          : undefined;
    if (targetNewSide) {
      const sideColumns = targetNewSide === 'left' ? leftColumns : rightColumns;
      const lastColumn = sideColumns[sideColumns.length - 1];
      const gap = lastColumn
        ? lastColumn.sourceIndex + 1
        : targetNewSide === 'left'
          ? previewIndex
          : previewIndex + 1;
      context.moveColumnToGap(active.sourceIndex, gap);
      return;
    }
    const targetSide: LayoutSide | undefined =
      targetId === sideDropZoneId('left')
        ? 'left'
        : targetId === sideDropZoneId('right')
          ? 'right'
          : undefined;
    if (targetSide) {
      const sideColumns = targetSide === 'left' ? leftColumns : rightColumns;
      const firstColumn = sideColumns[0];
      if (firstColumn) {
        context.moveColumn(active.sourceIndex, firstColumn.sourceIndex, 'before');
      } else {
        context.moveColumnToGap(
          active.sourceIndex,
          targetSide === 'left' ? previewIndex : previewIndex + 1
        );
      }
      return;
    }
    if (!target) return;
    context.moveColumn(
      active.sourceIndex,
      target.sourceIndex,
      move.to.placement === 'before' ? 'before' : 'after'
    );
  };

  const onDragMove = (move: {
    activeId: string | number;
    targetId?: string | number;
    to: { placement?: string };
  }) => {
    if (String(move.activeId).startsWith('workspace-layout-column-')) {
      onColumnDragMove(move);
      return;
    }
    onPanelDragMove(move);
  };

  const renderSide = (side: LayoutSide, sideColumns: MenuColumn[]) => (
    <section className="workspace-layout-menu__side" data-layout-side={side}>
      <DragSortItem
        id={sideDropZoneId(side)}
        group={COLUMN_SORT_GROUP}
        index={side === 'left' ? 0 : columnSortIds.length}
        label={`${side === 'left' ? 'Left' : 'Right'} side`}
        activation="handle"
        targetOnly
        className="workspace-layout-menu__section"
        data-layout-side-drop-zone={side}
      >
        {side === 'left' ? 'Left' : 'Right'}
      </DragSortItem>
      <div className="workspace-layout-menu__side-list">
        {sideColumns.map((column, index) => (
          <ColumnTile
            key={column.id}
            column={column}
            columnNumber={index + 1}
            layout={layout}
            sortIndex={columnSortIndex(column)}
            columns={columns}
            floatingPanels={floating}
            panelSortIndex={panelSortIndex}
            onAction={action}
          />
        ))}
        <NewColumnDropZone
          side={side}
          sortIndex={panelSortIds.length}
          columnSortIndex={side === 'left' ? leftColumns.length : columnSortIds.length}
        />
      </div>
    </section>
  );

  const preview = columns.find((column) => column.preview);

  return (
    <Dropdown
      portal
      align="right"
      menuClassName="workspace-layout-menu workspace-layout-menu--spatial"
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
        collision="containment"
        items={dragIds}
        label="Panel layout"
        onMove={onDragMove}
      >
        <WorkspaceLayoutScopeSelector />
        <DropdownDivider />
        <WorkspaceLayoutMenuSlides>
          <div className="workspace-layout-menu__scroll-body" data-layout-scroll-body="true">
            <div
              className="workspace-layout-menu__canvas"
              data-layout-outline="true"
              role="group"
              aria-label="Workspace columns"
            >
              {renderSide('left', leftColumns)}
              {preview && (
                <DragSortItem
                  key={preview.id}
                  id={PREVIEW}
                  group={COLUMN_SORT_GROUP}
                  index={columnSortIds.indexOf(PREVIEW)}
                  label="Preview"
                  disabled
                  targetDisabled
                  className="workspace-layout-menu__column workspace-layout-menu__column--preview"
                  data-layout-preview-divider="true"
                  aria-label="Preview divider"
                >
                  <span className="workspace-layout-menu__preview-label">Preview</span>
                </DragSortItem>
              )}
              {renderSide('right', rightColumns)}
            </div>

            <div className="workspace-layout-menu__section">Floating</div>
            <div className="workspace-layout-menu__floating" aria-label="Floating panels">
              {floating.length === 0 ? (
                <span className="workspace-layout-menu__empty">No floating panels</span>
              ) : (
                floating.map((panel) => {
                  const sourceIndex = layout.columns.findIndex(
                    (column) =>
                      column.kind === 'panels' &&
                      column.panels.some((placement) => placement.panel === panel)
                  );
                  const source = panelColumnFromModel(layout, sourceIndex) ?? {
                    id: `floating-${panel}`,
                    sourceIndex: -1,
                    preview: false,
                    panels: [panel],
                  };
                  return (
                    <PanelTile
                      key={`floating-${panel}`}
                      panel={panel}
                      column={source}
                      layout={layout}
                      index={0}
                      sortIndex={panelSortIndex(panel)}
                      columns={columns}
                      floatingPanels={floating}
                      floating
                      onAction={action}
                    />
                  );
                })
              )}
            </div>
          </div>
        </WorkspaceLayoutMenuSlides>

        <div className="workspace-layout-menu__footer" data-layout-footer="true">
          <DropdownDivider />
          <div className="workspace-layout-menu__section">Start from</div>
          <div className="workspace-layout-menu__presets">
            {LAYOUT_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                variant="default"
                size="default"
                title={preset.description}
                onClick={() => applyPreset(preset)}
                className="workspace-layout-menu__hit-target"
                role="menuitem"
                data-layout-hit-target="true"
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
