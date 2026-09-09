/**
 * Where the workspace's panels are, as data.
 *
 * The workspace is a **rail**: one ordered row of docked panels with the
 * preview somewhere in it. Everything about an arrangement — which side a panel
 * is on, what it sits next to, how wide it is, whether it is a column or a
 * floating window — is this one object, and every change to it is a pure
 * function here.
 *
 * The single ordered array is deliberate. A `left: PanelId[]` / `right:
 * PanelId[]` pair can disagree with itself (the same panel in both, or in
 * neither) and makes "move this one step right" a special case at the boundary.
 * With `preview` as an ordinary member of one list, which side a panel is on is
 * a comparison of two indices, and every move is a splice.
 *
 * Nothing here reads or writes storage, or touches the DOM — see
 * `workspaceLayoutStore.ts` for persistence and `dockDrag.ts` for turning a
 * pointer into an index.
 *
 * @module lib/workspaceLayout
 */

/** A panel that can be arranged. The preview is the seventh surface and is not one. */
export type PanelId = 'agent' | 'navigator' | 'variables' | 'editor' | 'team';

/** The centre of the rail. Present in `order` exactly once, and never floats. */
export const PREVIEW = 'preview' as const;

export type RailItem = PanelId | typeof PREVIEW;

export interface WorkspaceLayout {
  /** The rail, left to right. Contains `preview` exactly once. */
  order: RailItem[];
  /** Panels shown as a movable window instead of as a column. */
  floating: PanelId[];
  /** Docked width in px. Absent means "use the panel's default". */
  widths: Partial<Record<PanelId, number>>;
}

interface PanelMeta {
  /** What the panel is called wherever it is named — menus, drag chip, commands. */
  label: string;
  /** Narrower than this and the panel is not usable, so the rail refuses. */
  minWidth: number;
  /** Wider than this and it is the workspace rather than a panel beside it. */
  maxWidth: number;
  /** Width before anybody has dragged its edge. */
  defaultWidth: number;
}

/**
 * Per-panel constants. The min/max/default numbers are the ones each panel
 * already used for its own docked width, kept so nothing resizes itself on
 * first run — see the constants they came from in `Preview.tsx`,
 * the old `useTeamPanelWidth` hook and `panelSizing.ts`.
 */
export const PANEL_META: Record<PanelId, PanelMeta> = {
  agent: { label: 'Agent', minWidth: 260, maxWidth: 900, defaultWidth: 420 },
  navigator: { label: 'Navigator', minWidth: 180, maxWidth: 480, defaultWidth: 240 },
  variables: { label: 'Variables', minWidth: 180, maxWidth: 480, defaultWidth: 240 },
  editor: { label: 'Edit', minWidth: 220, maxWidth: 560, defaultWidth: 300 },
  team: { label: 'Team', minWidth: 320, maxWidth: 720, defaultWidth: 420 },
};

export const PANEL_IDS = Object.keys(PANEL_META) as PanelId[];

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PANEL_META, value);
}

/**
 * The arrangement Ship Studio has always had, written down.
 *
 * Team, then Agent on the left; Variables and Navigator between the agent and
 * the canvas; Edit on the right. Team, Variables and Edit float, because that
 * is what their pin toggles defaulted to. An install upgrading from the old
 * per-panel flags starts from its own equivalent instead — see
 * `layoutFromLegacyPreferences`.
 */
export const DEFAULT_LAYOUT: WorkspaceLayout = Object.freeze({
  order: ['team', 'agent', 'variables', 'navigator', PREVIEW, 'editor'],
  floating: ['team', 'variables', 'editor'],
  widths: {},
}) as WorkspaceLayout;

/**
 * Where a panel goes when a layout has never heard of it.
 *
 * A build that adds a panel must place it somewhere in every saved layout, and
 * the honest place is the one the default puts it in — appending everything new
 * to the far right would put a new panel on the wrong side of the preview for
 * anyone whose panels are all on the left.
 */
function defaultIndexOf(panel: PanelId): number {
  return DEFAULT_LAYOUT.order.indexOf(panel);
}

export function clampPanelWidth(panel: PanelId, width: number): number {
  const { minWidth, maxWidth } = PANEL_META[panel];
  return Math.round(Math.max(minWidth, Math.min(maxWidth, width)));
}

/**
 * Turn anything at all into a layout that renders.
 *
 * Total by design: this reads a preference that may have been written by an
 * older build, a newer one, a half-finished write, or a person with a JSON
 * editor. None of those may cost somebody their workspace, so every one of them
 * resolves to something usable rather than throwing.
 *
 * Repairs, in order: unknown and duplicate entries dropped, panels this build
 * knows about but the saved layout doesn't inserted at their default position,
 * exactly one `preview` guaranteed, floating narrowed to real panels, widths
 * clamped.
 */
export function normalizeLayout(input: unknown): WorkspaceLayout {
  // No preference at all is different from an empty one. `{ floating: [] }` is
  // somebody who docked everything; `null` is somebody who has never said, and
  // owes them the default rather than an arrangement nobody chose.
  const raw = (
    input === null || typeof input !== 'object' || Array.isArray(input) ? DEFAULT_LAYOUT : input
  ) as Partial<WorkspaceLayout>;

  const seen = new Set<RailItem>();
  const order: RailItem[] = [];
  for (const item of Array.isArray(raw.order) ? raw.order : []) {
    if (item !== PREVIEW && !isPanelId(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    order.push(item);
  }

  // A panel this build knows about that the saved layout has never seen. Insert
  // it beside the neighbour it has in the default arrangement, so a new panel
  // lands where it was designed to be rather than at an end.
  for (const panel of PANEL_IDS) {
    if (seen.has(panel)) continue;
    const target = defaultIndexOf(panel);
    let at = order.length;
    for (let i = 0; i < order.length; i += 1) {
      const other = order[i];
      const otherTarget =
        other === PREVIEW ? DEFAULT_LAYOUT.order.indexOf(PREVIEW) : defaultIndexOf(other);
      if (otherTarget > target) {
        at = i;
        break;
      }
    }
    order.splice(at, 0, panel);
    seen.add(panel);
  }

  if (!seen.has(PREVIEW)) {
    // No centre at all. Put it back where the default has it rather than at an
    // end, which would silently move every panel to one side.
    order.splice(Math.min(DEFAULT_LAYOUT.order.indexOf(PREVIEW), order.length), 0, PREVIEW);
  }

  const floating = PANEL_IDS.filter((panel) =>
    Array.isArray(raw.floating) ? raw.floating.includes(panel) : false
  );

  const widths: WorkspaceLayout['widths'] = {};
  const rawWidths = (raw.widths ?? {}) as Record<string, unknown>;
  for (const panel of PANEL_IDS) {
    const value = Number(rawWidths[panel]);
    if (Number.isFinite(value) && value > 0) widths[panel] = clampPanelWidth(panel, value);
  }

  return { order, floating, widths };
}

/** The rail position of a panel, or the preview. */
export function indexOf(layout: WorkspaceLayout, item: RailItem): number {
  return layout.order.indexOf(item);
}

export function isFloating(layout: WorkspaceLayout, panel: PanelId): boolean {
  return layout.floating.includes(panel);
}

export function isDocked(layout: WorkspaceLayout, panel: PanelId): boolean {
  return !isFloating(layout, panel);
}

/** Which side of the preview a panel sits on — meaningful docked or not. */
export function sideOf(layout: WorkspaceLayout, panel: PanelId): 'left' | 'right' {
  return indexOf(layout, panel) < indexOf(layout, PREVIEW) ? 'left' : 'right';
}

/** The docked panels in rail order, which is what `WorkspaceDock` lays out. */
export function dockedPanels(layout: WorkspaceLayout): PanelId[] {
  return layout.order.filter((item): item is PanelId => item !== PREVIEW && isDocked(layout, item));
}

export function widthOf(layout: WorkspaceLayout, panel: PanelId, fallback?: number): number {
  return layout.widths[panel] ?? fallback ?? PANEL_META[panel].defaultWidth;
}

/**
 * Move a panel to a slot in the rail.
 *
 * `to` is a **gap** index against the current order — 0 is before everything,
 * `order.length` after everything — which is what a drop indicator between two
 * slots means, and what `dropIndexAt` returns. Removing the panel first would
 * shift every gap after it by one, so the removal is compensated for here
 * rather than at each call site.
 *
 * Docks the panel: dropping something onto the rail is the gesture for putting
 * it there, and leaving it floating over the slot it just claimed would be a
 * move that visibly did nothing.
 */
export function movePanel(layout: WorkspaceLayout, panel: PanelId, to: number): WorkspaceLayout {
  const from = indexOf(layout, panel);
  if (from === -1) return layout;

  const target = Math.max(0, Math.min(to, layout.order.length));
  const order = layout.order.filter((item) => item !== panel);
  order.splice(target > from ? target - 1 : target, 0, panel);

  return {
    ...layout,
    order,
    floating: layout.floating.filter((id) => id !== panel),
  };
}

/** One slot along, skipping nothing — the keyboard equivalent of a short drag. */
export function nudgePanel(
  layout: WorkspaceLayout,
  panel: PanelId,
  direction: -1 | 1
): WorkspaceLayout {
  const from = indexOf(layout, panel);
  if (from === -1) return layout;
  const to = from + direction;
  if (to < 0 || to >= layout.order.length) return layout;
  const order = [...layout.order];
  [order[from], order[to]] = [order[to], order[from]];
  return { ...layout, order };
}

export function setFloating(
  layout: WorkspaceLayout,
  panel: PanelId,
  floating: boolean
): WorkspaceLayout {
  if (isFloating(layout, panel) === floating) return layout;
  return {
    ...layout,
    // Its place in `order` is kept either way. That is what makes floating
    // reversible: re-docking returns the panel to the slot it left instead of
    // dropping it at an end for you to drag back.
    floating: floating ? [...layout.floating, panel] : layout.floating.filter((id) => id !== panel),
  };
}

export function setPanelWidth(
  layout: WorkspaceLayout,
  panel: PanelId,
  width: number
): WorkspaceLayout {
  return { ...layout, widths: { ...layout.widths, [panel]: clampPanelWidth(panel, width) } };
}

export function layoutsEqual(a: WorkspaceLayout, b: WorkspaceLayout): boolean {
  if (a.order.length !== b.order.length || a.order.some((item, i) => item !== b.order[i])) {
    return false;
  }
  if (a.floating.length !== b.floating.length) return false;
  if (a.floating.some((panel) => !b.floating.includes(panel))) return false;
  return PANEL_IDS.every((panel) => a.widths[panel] === b.widths[panel]);
}

// ============ Presets ============

export interface LayoutPreset {
  id: string;
  label: string;
  /** What arrangement this is *for* — shown under the name in the menu. */
  description: string;
  layout: WorkspaceLayout;
}

/**
 * Starting points, not modes. Applying one writes an ordinary layout you can
 * then drag; nothing stays "in" a preset, and nothing snaps back to it.
 */
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
      order: ['agent', PREVIEW, 'navigator', 'variables', 'editor', 'team'],
      floating: ['navigator', 'variables', 'editor', 'team'],
      widths: {},
    }),
  },
  {
    id: 'design',
    label: 'Design',
    description: 'Navigator and Edit docked either side of the canvas.',
    layout: normalizeLayout({
      order: ['navigator', PREVIEW, 'editor', 'variables', 'agent', 'team'],
      floating: ['team'],
      widths: {},
    }),
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Team beside the preview, agent ready on the right.',
    layout: normalizeLayout({
      order: ['team', PREVIEW, 'agent', 'navigator', 'variables', 'editor'],
      floating: ['navigator', 'variables', 'editor'],
      widths: {},
    }),
  },
];

// ============ Migration ============

/** The per-panel preferences flexible panels replaced. */
export interface LegacyPanelPreferences {
  agentPinned: boolean;
  navigatorPinned: boolean;
  variablesPinned: boolean;
  editorPinned: boolean;
  teamPinned: boolean;
  widths: Partial<Record<PanelId, number>>;
}

/**
 * The layout an existing install already had.
 *
 * Before this there was no order to remember — the order was in the stylesheet,
 * and the only thing a person had chosen was which panels were docked and how
 * wide they were. So the migration keeps exactly that: the old fixed order,
 * their pins, their widths. An upgrade opens on the workspace they left.
 */
export function layoutFromLegacyPreferences(prefs: LegacyPanelPreferences): WorkspaceLayout {
  const pinned: Record<PanelId, boolean> = {
    agent: prefs.agentPinned,
    navigator: prefs.navigatorPinned,
    variables: prefs.variablesPinned,
    editor: prefs.editorPinned,
    team: prefs.teamPinned,
  };
  return normalizeLayout({
    order: DEFAULT_LAYOUT.order,
    floating: PANEL_IDS.filter((panel) => !pinned[panel]),
    widths: prefs.widths,
  });
}
