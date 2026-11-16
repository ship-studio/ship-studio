/**
 * The workspace panel arrangement as data.
 *
 * A layout is an ordered row of columns. The preview is one special column;
 * every other column contains one or more vertically ordered panel
 * placements. A panel is present in the structure even while it is floating
 * (or temporarily closed by its feature), so docking is reversible and does
 * not lose its position or its split ratio.
 *
 * This module is deliberately pure. Persistence lives in
 * `workspaceLayoutStore.ts`; pointer geometry lives in `dockDrag.ts`.
 *
 * @module lib/workspaceLayout
 */

export const LAYOUT_VERSION = 2 as const;

/** A panel that can be arranged. Preview is the unstackable centre surface. */
export type PanelId = 'agent' | 'navigator' | 'variables' | 'editor' | 'team' | 'assets';

export const PREVIEW = 'preview' as const;

export type RailItem = PanelId | typeof PREVIEW;

/** A panel's relative share of its containing column's height. */
export interface PanelPlacement {
  panel: PanelId;
  weight: number;
}

export interface PanelColumn {
  kind: 'panels';
  panels: PanelPlacement[];
  /** Docked width in px. Missing means use the column's default width. */
  width?: number;
}

export interface PreviewColumn {
  kind: 'preview';
}

export type WorkspaceColumn = PanelColumn | PreviewColumn;

export interface WorkspaceLayout {
  version: typeof LAYOUT_VERSION;
  /** Left-to-right columns. Exactly one item has `kind: 'preview'`. */
  columns: WorkspaceColumn[];
  /** Panels shown as movable windows instead of in their docked column. */
  floating: PanelId[];
}

export interface PanelMeta {
  /** What the panel is called in menus, drag chips, and commands. */
  label: string;
  /** Narrower than this and the panel is not usable. */
  minWidth: number;
  /** Wider than this and it should be workspace rather than a side panel. */
  maxWidth: number;
  /** Width before anybody has dragged the column edge. */
  defaultWidth: number;
  /** Smallest useful height when the panel shares a column. */
  minHeight: number;
}

/**
 * Per-panel constants. Width values are the limits used by the old rail. The
 * height values are intentionally conservative; a panel's own body remains
 * responsible for scrolling inside these limits.
 */
export const PANEL_META: Record<PanelId, PanelMeta> = {
  agent: { label: 'Agent', minWidth: 260, maxWidth: 900, defaultWidth: 420, minHeight: 180 },
  navigator: {
    label: 'Elements',
    minWidth: 180,
    maxWidth: 480,
    defaultWidth: 240,
    minHeight: 160,
  },
  variables: {
    label: 'Variables',
    minWidth: 180,
    maxWidth: 480,
    defaultWidth: 240,
    minHeight: 160,
  },
  editor: { label: 'Edit', minWidth: 220, maxWidth: 560, defaultWidth: 300, minHeight: 180 },
  team: { label: 'Team', minWidth: 320, maxWidth: 720, defaultWidth: 420, minHeight: 240 },
  assets: { label: 'Assets', minWidth: 220, maxWidth: 560, defaultWidth: 300, minHeight: 180 },
};

export const PANEL_IDS = Object.keys(PANEL_META) as PanelId[];

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PANEL_META, value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** The arrangement the workspace has always opened with, now expressed as v2. */
export const DEFAULT_LAYOUT: WorkspaceLayout = {
  version: LAYOUT_VERSION,
  columns: [
    { kind: 'panels', panels: [{ panel: 'assets', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'team', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
    { kind: 'preview' },
    { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
  ],
  floating: ['team', 'variables', 'editor'],
};

function defaultColumnIndexOf(panel: PanelId): number {
  return DEFAULT_LAYOUT.columns.findIndex(
    (column) =>
      column.kind === 'panels' && column.panels.some((placement) => placement.panel === panel)
  );
}

function defaultPreviewIndex(): number {
  return DEFAULT_LAYOUT.columns.findIndex((column) => column.kind === 'preview');
}

export function clampPanelWidth(panel: PanelId, width: number): number {
  const { minWidth, maxWidth } = PANEL_META[panel];
  return Math.round(Math.max(minWidth, Math.min(maxWidth, width)));
}

export function columnWidthBounds(column: PanelColumn): {
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
} {
  const panels = column.panels.map((placement) => placement.panel);
  if (panels.length === 0) {
    return { minWidth: 0, maxWidth: Number.POSITIVE_INFINITY, defaultWidth: 0 };
  }
  return {
    minWidth: Math.max(...panels.map((panel) => PANEL_META[panel].minWidth)),
    maxWidth: Math.min(...panels.map((panel) => PANEL_META[panel].maxWidth)),
    defaultWidth: Math.max(...panels.map((panel) => PANEL_META[panel].defaultWidth)),
  };
}

export function clampColumnWidth(column: PanelColumn, width: number): number {
  const { minWidth, maxWidth } = columnWidthBounds(column);
  return Math.round(Math.max(minWidth, Math.min(maxWidth, width)));
}

function normalizeWeights(placements: PanelPlacement[]): PanelPlacement[] {
  if (placements.length === 0) return [];
  const values = placements.map((placement) => positiveNumber(placement.weight) ?? 1);
  const total = values.reduce((sum, value) => sum + value, 0);
  return placements.map((placement, index) => ({
    panel: placement.panel,
    weight: values[index] / total,
  }));
}

function cloneColumn(column: WorkspaceColumn): WorkspaceColumn {
  return column.kind === 'preview'
    ? { kind: 'preview' }
    : {
        kind: 'panels',
        panels: column.panels.map((placement) => ({ ...placement })),
        ...(column.width === undefined ? {} : { width: column.width }),
      };
}

function cloneColumns(columns: WorkspaceColumn[]): WorkspaceColumn[] {
  return columns.map(cloneColumn);
}

function normalizeFloating(value: unknown): PanelId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<PanelId>();
  const result: PanelId[] = [];
  for (const item of value) {
    if (!isPanelId(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function migrateLegacyFlat(input: Record<string, unknown>): WorkspaceLayout {
  const order: unknown[] = Array.isArray(input.order) ? input.order : [];
  const widths = isObject(input.widths) ? input.widths : {};
  const columns: WorkspaceColumn[] = [];
  const seen = new Set<RailItem>();
  for (const item of order) {
    if (item !== PREVIEW && !isPanelId(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    if (item === PREVIEW) {
      columns.push({ kind: 'preview' });
      continue;
    }
    const width = positiveNumber(widths[item]);
    const column: PanelColumn = { kind: 'panels', panels: [{ panel: item, weight: 1 }] };
    if (width !== undefined) column.width = clampPanelWidth(item, width);
    columns.push(column);
  }
  return {
    version: LAYOUT_VERSION,
    columns,
    floating: normalizeFloating(input.floating),
  };
}

/**
 * Turn any saved value into a complete, renderable v2 layout.
 *
 * Old `{ order, floating, widths }` values become singleton columns. v2
 * values are repaired by dropping unknown/duplicate panels, empty columns,
 * invalid widths and weights, then inserting missing panels at their default
 * column and guaranteeing one preview column. Every known panel remains in a
 * column even while floating, which is what makes closing/floating reversible.
 */
export function normalizeLayout(input: unknown): WorkspaceLayout {
  if (!isObject(input)) return normalizeLayout(DEFAULT_LAYOUT);

  const hasColumns = Array.isArray(input.columns);
  const candidate = hasColumns ? input : migrateLegacyFlat(input);
  const rawColumns = Array.isArray(candidate.columns) ? candidate.columns : [];
  const seen = new Set<PanelId>();
  const columns: WorkspaceColumn[] = [];
  let previewSeen = false;

  for (const rawColumn of rawColumns) {
    if (!isObject(rawColumn)) continue;
    if (rawColumn.kind === 'preview') {
      if (previewSeen) continue;
      previewSeen = true;
      columns.push({ kind: 'preview' });
      continue;
    }
    if (rawColumn.kind !== 'panels' || !Array.isArray(rawColumn.panels)) continue;
    const placements: PanelPlacement[] = [];
    for (const rawPlacement of rawColumn.panels) {
      if (!isObject(rawPlacement) || !isPanelId(rawPlacement.panel) || seen.has(rawPlacement.panel))
        continue;
      seen.add(rawPlacement.panel);
      placements.push({
        panel: rawPlacement.panel,
        weight: positiveNumber(rawPlacement.weight) ?? 1,
      });
    }
    if (placements.length === 0) continue;
    const column: PanelColumn = { kind: 'panels', panels: normalizeWeights(placements) };
    const rawWidth = positiveNumber(rawColumn.width);
    if (rawWidth !== undefined) column.width = clampColumnWidth(column, rawWidth);
    columns.push(column);
  }

  // Insert any panel this version knows about at the corresponding default
  // column. New panels use a singleton column, preserving the old invariant
  // that a newly introduced panel cannot accidentally join someone's stack.
  for (const panel of PANEL_IDS) {
    if (seen.has(panel)) continue;
    const target = defaultColumnIndexOf(panel);
    let at = columns.length;
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const representative =
        column.kind === 'preview'
          ? defaultPreviewIndex()
          : defaultColumnIndexOf(column.panels[0].panel);
      if (representative > target) {
        at = index;
        break;
      }
    }
    columns.splice(at, 0, { kind: 'panels', panels: [{ panel, weight: 1 }] });
    seen.add(panel);
  }

  if (!previewSeen) {
    let at = columns.length;
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const representative =
        column.kind === 'preview'
          ? defaultPreviewIndex()
          : defaultColumnIndexOf(column.panels[0].panel);
      if (representative > defaultPreviewIndex()) {
        at = index;
        break;
      }
    }
    columns.splice(at, 0, { kind: 'preview' });
  }

  return {
    version: LAYOUT_VERSION,
    columns,
    floating: normalizeFloating(hasColumns ? input.floating : candidate.floating),
  };
}

export interface PanelPlacementLocation {
  columnIndex: number;
  panelIndex: number;
  placement: PanelPlacement;
  column: PanelColumn;
}

/** Find a panel in the structural layout, including while it is floating. */
export function findPanelPlacement(
  layout: WorkspaceLayout,
  panel: PanelId
): PanelPlacementLocation | undefined {
  for (let columnIndex = 0; columnIndex < layout.columns.length; columnIndex += 1) {
    const column = layout.columns[columnIndex];
    if (column.kind !== 'panels') continue;
    const panelIndex = column.panels.findIndex((placement) => placement.panel === panel);
    if (panelIndex !== -1)
      return { columnIndex, panelIndex, placement: column.panels[panelIndex], column };
  }
  return undefined;
}

export function columnIndexOf(layout: WorkspaceLayout, panel: PanelId): number {
  return findPanelPlacement(layout, panel)?.columnIndex ?? -1;
}

export function indexOf(layout: WorkspaceLayout, item: RailItem): number {
  if (item === PREVIEW) return layout.columns.findIndex((column) => column.kind === 'preview');
  return columnIndexOf(layout, item);
}

export function isFloating(layout: WorkspaceLayout, panel: PanelId): boolean {
  return layout.floating.includes(panel);
}

export function isDocked(layout: WorkspaceLayout, panel: PanelId): boolean {
  return !isFloating(layout, panel);
}

/** Which side of the preview contains a panel's remembered placement. */
export function sideOf(layout: WorkspaceLayout, panel: PanelId): 'left' | 'right' {
  return columnIndexOf(layout, panel) < indexOf(layout, PREVIEW) ? 'left' : 'right';
}

/** Docked panel ids in left-to-right, then top-to-bottom order. */
export function dockedPanels(layout: WorkspaceLayout): PanelId[] {
  return layout.columns.flatMap((column) =>
    column.kind === 'panels'
      ? column.panels
          .filter((placement) => isDocked(layout, placement.panel))
          .map((placement) => placement.panel)
      : []
  );
}

export function visibleDockedPanels(
  layout: WorkspaceLayout,
  visible?: Iterable<PanelId>
): PanelId[] {
  const visibleSet = visible === undefined ? undefined : new Set(visible);
  return dockedPanels(layout).filter((panel) => visibleSet === undefined || visibleSet.has(panel));
}

/** A render projection; omitted panels retain their source placement in layout. */
export function visibleColumns(
  layout: WorkspaceLayout,
  visible?: Iterable<PanelId>
): WorkspaceColumn[] {
  const visibleSet = visible === undefined ? undefined : new Set(visible);
  return layout.columns.flatMap((column) => {
    if (column.kind === 'preview') return [cloneColumn(column)];
    const panels = column.panels.filter(
      (placement) =>
        isDocked(layout, placement.panel) &&
        (visibleSet === undefined || visibleSet.has(placement.panel))
    );
    return panels.length === 0
      ? []
      : [
          {
            kind: 'panels' as const,
            panels: panels.map((placement) => ({ ...placement })),
            ...(column.width === undefined ? {} : { width: column.width }),
          },
        ];
  });
}

export function widthOf(layout: WorkspaceLayout, panel: PanelId, fallback?: number): number {
  const location = findPanelPlacement(layout, panel);
  if (!location) return fallback ?? PANEL_META[panel].defaultWidth;
  return location.column.width ?? fallback ?? columnWidthBounds(location.column).defaultWidth;
}

export function columnWidthOf(
  layout: WorkspaceLayout,
  columnIndex: number,
  fallback?: number
): number {
  const column = layout.columns[columnIndex];
  if (!column || column.kind === 'preview') return fallback ?? 0;
  return column.width ?? fallback ?? columnWidthBounds(column).defaultWidth;
}

function withColumns(layout: WorkspaceLayout, columns: WorkspaceColumn[]): WorkspaceLayout {
  return { ...layout, columns };
}

function normalizedWeightsForColumn(
  column: PanelColumn,
  placements: PanelPlacement[]
): PanelColumn {
  const next: PanelColumn = { kind: 'panels', panels: normalizeWeights(placements) };
  if (column.width !== undefined) next.width = clampColumnWidth(next, column.width);
  return next;
}

function removePanelFromColumns(
  columns: WorkspaceColumn[],
  panel: PanelId
): { columns: WorkspaceColumn[]; source?: PanelPlacementLocation } {
  const sourceIndex = columns.findIndex(
    (column) =>
      column.kind === 'panels' && column.panels.some((placement) => placement.panel === panel)
  );
  if (sourceIndex === -1) return { columns };
  const sourceColumn = columns[sourceIndex];
  if (sourceColumn.kind === 'preview') return { columns };
  const panelIndex = sourceColumn.panels.findIndex((placement) => placement.panel === panel);
  const source: PanelPlacementLocation = {
    columnIndex: sourceIndex,
    panelIndex,
    placement: sourceColumn.panels[panelIndex],
    column: sourceColumn,
  };
  const remaining = sourceColumn.panels.filter((placement) => placement.panel !== panel);
  const next = [...columns];
  if (remaining.length === 0) next.splice(sourceIndex, 1);
  else next[sourceIndex] = normalizedWeightsForColumn(sourceColumn, remaining);
  return { columns: next, source };
}

/** Move a panel into a new singleton column at a horizontal column gap. */
export function movePanelToColumnGap(
  layout: WorkspaceLayout,
  panel: PanelId,
  columnGap: number
): WorkspaceLayout {
  const location = findPanelPlacement(layout, panel);
  if (!location) return layout;
  const gap = Math.max(0, Math.min(Math.trunc(columnGap), layout.columns.length));
  const sourceWidth = location.column.width;
  const sourceWasSingleton = location.column.panels.length === 1;
  if (sourceWasSingleton && (gap === location.columnIndex || gap === location.columnIndex + 1)) {
    return isFloating(layout, panel) ? setFloating(layout, panel, false) : layout;
  }
  const removed = removePanelFromColumns(cloneColumns(layout.columns), panel);
  if (!removed.source) return layout;
  let insertion = gap;
  if (sourceWasSingleton && removed.source.columnIndex < gap) insertion -= 1;
  insertion = Math.max(0, Math.min(insertion, removed.columns.length));
  const singleton: PanelColumn = { kind: 'panels', panels: [{ panel, weight: 1 }] };
  if (sourceWidth !== undefined) singleton.width = clampColumnWidth(singleton, sourceWidth);
  removed.columns.splice(insertion, 0, singleton);
  return {
    ...withColumns(layout, removed.columns),
    floating: layout.floating.filter((id) => id !== panel),
  };
}

/** Move a docked panel column before or after another column, including across Preview. */
export function moveColumn(
  layout: WorkspaceLayout,
  columnIndex: number,
  targetColumnIndex: number,
  position: 'before' | 'after'
): WorkspaceLayout {
  const source = layout.columns[columnIndex];
  const target = layout.columns[targetColumnIndex];
  if (
    columnIndex < 0 ||
    targetColumnIndex < 0 ||
    !source ||
    !target ||
    source.kind === 'preview' ||
    target.kind === 'preview' ||
    columnIndex === targetColumnIndex
  ) {
    return layout;
  }

  const columns = cloneColumns(layout.columns);
  const [moved] = columns.splice(columnIndex, 1);
  if (!moved || moved.kind === 'preview') return layout;

  let insertion = targetColumnIndex - (columnIndex < targetColumnIndex ? 1 : 0);
  if (position === 'after') insertion += 1;
  columns.splice(Math.max(0, Math.min(insertion, columns.length)), 0, moved);
  return withColumns(layout, columns);
}

/** Move a docked panel column to a horizontal column gap, including an empty side. */
export function moveColumnToGap(layout: WorkspaceLayout, columnIndex: number, columnGap: number) {
  const source = layout.columns[columnIndex];
  if (!source || source.kind === 'preview') return layout;
  const gap = Math.max(0, Math.min(Math.trunc(columnGap), layout.columns.length));
  if (gap === columnIndex || gap === columnIndex + 1) return layout;

  const columns = cloneColumns(layout.columns);
  const [moved] = columns.splice(columnIndex, 1);
  if (!moved || moved.kind === 'preview') return layout;
  const insertion = gap - (columnIndex < gap ? 1 : 0);
  columns.splice(Math.max(0, Math.min(insertion, columns.length)), 0, moved);
  return withColumns(layout, columns);
}

/** Move a panel before or after another panel, sharing the target's column. */
export function stackPanel(
  layout: WorkspaceLayout,
  panel: PanelId,
  target: PanelId,
  position: 'before' | 'after'
): WorkspaceLayout {
  if (panel === target) return layout;
  const sourceLocation = findPanelPlacement(layout, panel);
  const targetLocation = findPanelPlacement(layout, target);
  if (!sourceLocation || !targetLocation) return layout;
  if (sourceLocation.columnIndex === targetLocation.columnIndex) {
    const reordered = reorderPanelInStack(
      layout,
      panel,
      position === 'before' ? targetLocation.panelIndex : targetLocation.panelIndex + 1
    );
    return isFloating(layout, panel)
      ? { ...reordered, floating: reordered.floating.filter((id) => id !== panel) }
      : reordered;
  }
  const removed = removePanelFromColumns(cloneColumns(layout.columns), panel);
  if (!removed.source) return layout;
  const destinationIndex = removed.columns.findIndex(
    (column) =>
      column.kind === 'panels' && column.panels.some((placement) => placement.panel === target)
  );
  if (destinationIndex === -1) return layout;
  const destination = removed.columns[destinationIndex];
  if (destination.kind === 'preview') return layout;
  const targetIndex = destination.panels.findIndex((placement) => placement.panel === target);
  const targetPlacement = destination.panels[targetIndex];
  const placements = [...destination.panels];
  placements.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, {
    panel,
    weight: targetPlacement.weight,
  });
  removed.columns[destinationIndex] = normalizedWeightsForColumn(destination, placements);
  return {
    ...withColumns(layout, removed.columns),
    floating: layout.floating.filter((id) => id !== panel),
  };
}

/** Reorder a panel within its existing vertical stack by panel index. */
export function reorderPanelInStack(
  layout: WorkspaceLayout,
  panel: PanelId,
  panelIndex: number
): WorkspaceLayout {
  const location = findPanelPlacement(layout, panel);
  if (!location || location.column.panels.length < 2) return layout;
  const target = Math.max(0, Math.min(Math.trunc(panelIndex), location.column.panels.length - 1));
  if (target === location.panelIndex) return layout;
  const columns = cloneColumns(layout.columns);
  const column = columns[location.columnIndex];
  if (column.kind === 'preview') return layout;
  const placements = [...column.panels];
  const [moved] = placements.splice(location.panelIndex, 1);
  placements.splice(target, 0, moved);
  columns[location.columnIndex] = normalizedWeightsForColumn(column, placements);
  return withColumns(layout, columns);
}

export const reorderInStack = reorderPanelInStack;

/** Descriptive alias used by the drag/drop layer for a vertical move. */
export const movePanelWithinStack = reorderPanelInStack;

/** Pull a stacked panel into a singleton column beside its source column. */
export function unstackPanel(
  layout: WorkspaceLayout,
  panel: PanelId,
  position: 'before' | 'after' = 'after'
): WorkspaceLayout {
  const location = findPanelPlacement(layout, panel);
  if (!location || location.column.panels.length < 2) return layout;
  const columns = cloneColumns(layout.columns);
  const sourceColumn = columns[location.columnIndex];
  if (sourceColumn.kind === 'preview') return layout;
  columns[location.columnIndex] = normalizedWeightsForColumn(
    sourceColumn,
    sourceColumn.panels.filter((placement) => placement.panel !== panel)
  );
  const singleton: PanelColumn = { kind: 'panels', panels: [{ panel, weight: 1 }] };
  if (sourceColumn.width !== undefined)
    singleton.width = clampColumnWidth(singleton, sourceColumn.width);
  columns.splice(location.columnIndex + (position === 'after' ? 1 : 0), 0, singleton);
  return {
    ...withColumns(layout, columns),
    floating: layout.floating.filter((id) => id !== panel),
  };
}

/** Resize one adjacent divider while preserving the rest of a multi-panel stack. */
export function setAdjacentPanelWeights(
  layout: WorkspaceLayout,
  columnIndex: number,
  beforePanel: PanelId,
  afterPanel: PanelId,
  beforeWeight: number,
  afterWeight: number
): WorkspaceLayout {
  const column = layout.columns[columnIndex];
  if (column?.kind !== 'panels') return layout;
  const beforeIndex = column.panels.findIndex((placement) => placement.panel === beforePanel);
  const afterIndex = column.panels.findIndex((placement) => placement.panel === afterPanel);
  if (beforeIndex === -1 || afterIndex !== beforeIndex + 1) return layout;
  const before = positiveNumber(beforeWeight);
  const after = positiveNumber(afterWeight);
  if (before === undefined || after === undefined) return layout;
  const currentTotal = column.panels[beforeIndex].weight + column.panels[afterIndex].weight;
  const ratio = before / (before + after);
  const columns = cloneColumns(layout.columns);
  const next = columns[columnIndex];
  if (next.kind === 'preview') return layout;
  next.panels[beforeIndex].weight = currentTotal * ratio;
  next.panels[afterIndex].weight = currentTotal * (1 - ratio);
  return withColumns(layout, columns);
}

/** Alias that makes the vertical nature explicit at call sites. */
export const setAdjacentVerticalWeights = setAdjacentPanelWeights;

/** Set supplied weights and normalize the containing column. */
export function setPanelWeights(
  layout: WorkspaceLayout,
  columnIndex: number,
  weights: Partial<Record<PanelId, number>>
): WorkspaceLayout {
  const column = layout.columns[columnIndex];
  if (column?.kind !== 'panels') return layout;
  const placements = column.panels.map((placement) => ({
    panel: placement.panel,
    weight: positiveNumber(weights[placement.panel]) ?? placement.weight,
  }));
  return withColumns(
    layout,
    layout.columns.map((item, index) =>
      index === columnIndex ? normalizedWeightsForColumn(column, placements) : cloneColumn(item)
    )
  );
}

/** Compatibility alias for the pre-v2 horizontal move operation. */
export function movePanel(layout: WorkspaceLayout, panel: PanelId, to: number): WorkspaceLayout {
  return movePanelToColumnGap(layout, panel, to);
}

/** Nudge a panel's column one slot horizontally. */
export function nudgePanel(
  layout: WorkspaceLayout,
  panel: PanelId,
  direction: -1 | 1
): WorkspaceLayout {
  const location = findPanelPlacement(layout, panel);
  if (!location) return layout;
  const destination = location.columnIndex + direction;
  if (destination < 0 || destination >= layout.columns.length) return layout;
  return movePanelToColumnGap(
    layout,
    panel,
    direction < 0 ? location.columnIndex - 1 : location.columnIndex + 2
  );
}

export function setFloating(
  layout: WorkspaceLayout,
  panel: PanelId,
  floating: boolean
): WorkspaceLayout {
  if (isFloating(layout, panel) === floating) return layout;
  return {
    ...layout,
    floating: floating ? [...layout.floating, panel] : layout.floating.filter((id) => id !== panel),
  };
}

export function setColumnWidth(
  layout: WorkspaceLayout,
  columnIndex: number,
  width: number
): WorkspaceLayout {
  const column = layout.columns[columnIndex];
  if (column?.kind !== 'panels') return layout;
  const columns = cloneColumns(layout.columns);
  const next = columns[columnIndex];
  if (next.kind === 'preview') return layout;
  next.width = clampColumnWidth(next, width);
  return withColumns(layout, columns);
}

/** Compatibility wrapper for the old per-panel width operation. */
export function setPanelWidth(
  layout: WorkspaceLayout,
  panel: PanelId,
  width: number
): WorkspaceLayout {
  const location = findPanelPlacement(layout, panel);
  return location ? setColumnWidth(layout, location.columnIndex, width) : layout;
}

export function layoutsEqual(a: WorkspaceLayout, b: WorkspaceLayout): boolean {
  if (a.version !== b.version || a.columns.length !== b.columns.length) return false;
  for (let index = 0; index < a.columns.length; index += 1) {
    const left = a.columns[index];
    const right = b.columns[index];
    if (left.kind !== right.kind) return false;
    if (left.kind === 'preview' || right.kind === 'preview') continue;
    if (left.width !== right.width || left.panels.length !== right.panels.length) return false;
    for (let panelIndex = 0; panelIndex < left.panels.length; panelIndex += 1) {
      const leftPlacement = left.panels[panelIndex];
      const rightPlacement = right.panels[panelIndex];
      if (
        leftPlacement.panel !== rightPlacement.panel ||
        leftPlacement.weight !== rightPlacement.weight
      )
        return false;
    }
  }
  if (a.floating.length !== b.floating.length) return false;
  return a.floating.every((panel) => b.floating.includes(panel));
}

// ============ Presets ============

export interface LayoutPreset {
  id: string;
  label: string;
  description: string;
  layout: WorkspaceLayout;
}

function singleton(panel: PanelId, width?: number): PanelColumn {
  return {
    kind: 'panels',
    panels: [{ panel, weight: 1 }],
    ...(width === undefined ? {} : { width }),
  };
}

function stack(...panels: PanelId[]): PanelColumn {
  return { kind: 'panels', panels: panels.map((panel) => ({ panel, weight: 1 / panels.length })) };
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Agent on the left, preview beside it.',
    layout: normalizeLayout(DEFAULT_LAYOUT),
  },
  {
    id: 'focus',
    label: 'Focus',
    description: 'Just the agent and the preview. Everything else floats.',
    layout: normalizeLayout({
      version: LAYOUT_VERSION,
      columns: [
        singleton('agent'),
        { kind: 'preview' },
        singleton('navigator'),
        singleton('variables'),
        singleton('editor'),
        singleton('team'),
      ],
      floating: ['navigator', 'variables', 'editor', 'team'],
    }),
  },
  {
    id: 'design',
    label: 'Design',
    description: 'Elements and Edit docked either side of the canvas.',
    layout: normalizeLayout({
      version: LAYOUT_VERSION,
      columns: [
        singleton('navigator'),
        { kind: 'preview' },
        singleton('editor'),
        singleton('variables'),
        singleton('agent'),
        singleton('team'),
      ],
      floating: ['team'],
    }),
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Team beside the preview, agent ready on the right.',
    layout: normalizeLayout({
      version: LAYOUT_VERSION,
      columns: [
        singleton('team'),
        { kind: 'preview' },
        singleton('agent'),
        singleton('navigator'),
        singleton('variables'),
        singleton('editor'),
      ],
      floating: ['navigator', 'variables', 'editor'],
    }),
  },
  {
    id: 'stacked',
    label: 'Stacked',
    description: 'Agent and Elements share a column with an equal split.',
    layout: normalizeLayout({
      version: LAYOUT_VERSION,
      columns: [
        singleton('team'),
        stack('agent', 'navigator'),
        singleton('variables'),
        { kind: 'preview' },
        singleton('editor'),
      ],
      floating: ['team', 'variables', 'editor'],
    }),
  },
];

// ============ Migration from pre-rail preferences ============

export interface LegacyPanelPreferences {
  agentPinned: boolean;
  navigatorPinned: boolean;
  variablesPinned: boolean;
  editorPinned: boolean;
  teamPinned: boolean;
  widths: Partial<Record<PanelId, number>>;
}

/** Convert the old pin flags into the v2 default singleton columns. */
export function layoutFromLegacyPreferences(prefs: LegacyPanelPreferences): WorkspaceLayout {
  const pinned: Record<PanelId, boolean> = {
    agent: prefs.agentPinned,
    navigator: prefs.navigatorPinned,
    variables: prefs.variablesPinned,
    editor: prefs.editorPinned,
    team: prefs.teamPinned,
    assets: true,
  };
  const columns = cloneColumns(DEFAULT_LAYOUT.columns);
  for (const column of columns) {
    if (column.kind !== 'panels' || column.panels.length !== 1) continue;
    const panel = column.panels[0].panel;
    const width = positiveNumber(prefs.widths?.[panel]);
    if (width !== undefined) column.width = clampPanelWidth(panel, width);
  }
  return normalizeLayout({
    version: LAYOUT_VERSION,
    columns,
    floating: PANEL_IDS.filter((panel) => !pinned[panel]),
  });
}
