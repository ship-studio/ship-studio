import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  LAYOUT_PRESETS,
  PANEL_IDS,
  PANEL_META,
  PREVIEW,
  dockedPanels,
  isFloating,
  layoutFromLegacyPreferences,
  layoutsEqual,
  movePanel,
  normalizeLayout,
  nudgePanel,
  setFloating,
  setPanelWidth,
  sideOf,
  widthOf,
  type WorkspaceLayout,
} from './workspaceLayout';

/**
 * A layout exactly as written, without repair.
 *
 * `normalizeLayout` deliberately fills in every panel it knows about, so using
 * it to build fixtures would bury the three-item order a test is about under
 * three more panels it does not care about.
 */
const layout = (partial: Partial<WorkspaceLayout>): WorkspaceLayout => ({
  order: partial.order ?? [...DEFAULT_LAYOUT.order],
  floating: partial.floating ?? [],
  widths: partial.widths ?? {},
});

describe('normalizeLayout', () => {
  it('gives an empty preference the arrangement Ship Studio has always had', () => {
    expect(normalizeLayout(null)).toEqual(normalizeLayout(DEFAULT_LAYOUT));
    expect(normalizeLayout(undefined).order).toEqual(DEFAULT_LAYOUT.order);
  });

  it('keeps every panel exactly once, whatever the input claimed', () => {
    // A duplicate is not a second copy of a panel — there is only one Agent
    // panel — so the rail can only honour the first mention.
    const result = normalizeLayout({
      order: ['agent', 'agent', PREVIEW, 'agent'],
      floating: [],
      widths: {},
    });
    expect(result.order.filter((item) => item === 'agent')).toHaveLength(1);
    expect(result.order.filter((item) => item === PREVIEW)).toHaveLength(1);
    expect(new Set(result.order).size).toBe(result.order.length);
  });

  it('drops ids it does not recognise instead of rendering an empty column for them', () => {
    const result = normalizeLayout({
      order: ['agent', 'ghost-panel', PREVIEW],
      floating: ['ghost-panel'],
      widths: { 'ghost-panel': 300 },
    } as unknown);
    expect(result.order).not.toContain('ghost-panel');
    expect(result.floating).not.toContain('ghost-panel');
    expect(result.widths).not.toHaveProperty('ghost-panel');
  });

  it('places a panel the saved layout has never seen where the default puts it', () => {
    // The upgrade case: a layout written before `variables` existed must not
    // strand it at an end, on the wrong side of the preview.
    const result = normalizeLayout({
      order: ['team', 'agent', 'navigator', PREVIEW, 'editor'],
      floating: [],
      widths: {},
    });
    expect(result.order).toContain('variables');
    expect(result.order.indexOf('variables')).toBeLessThan(result.order.indexOf(PREVIEW));
    expect(result.order.indexOf('variables')).toBeLessThan(result.order.indexOf('navigator'));
  });

  it('restores a missing preview to the middle rather than to an end', () => {
    // Dropping it at an end would silently move every panel to one side.
    const result = normalizeLayout({ order: ['agent', 'navigator', 'editor'], floating: [] });
    const at = result.order.indexOf(PREVIEW);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(result.order.length - 1);
  });

  it('clamps a width to what the panel can actually be used at', () => {
    const result = normalizeLayout({ order: DEFAULT_LAYOUT.order, widths: { navigator: 5000 } });
    expect(result.widths.navigator).toBe(PANEL_META.navigator.maxWidth);

    const narrow = normalizeLayout({ order: DEFAULT_LAYOUT.order, widths: { navigator: 1 } });
    expect(narrow.widths.navigator).toBe(PANEL_META.navigator.minWidth);
  });

  it('ignores a width that is not a usable number', () => {
    const result = normalizeLayout({
      widths: { navigator: 'wide', variables: NaN, editor: -10 },
    } as unknown);
    expect(result.widths.navigator).toBeUndefined();
    expect(result.widths.variables).toBeUndefined();
    expect(result.widths.editor).toBeUndefined();
  });

  it('survives shapes no version of this app ever wrote', () => {
    for (const junk of [42, 'layout', [], { order: 'agent' }, { floating: 3 }]) {
      const result = normalizeLayout(junk as unknown);
      expect(result.order).toContain(PREVIEW);
      expect(result.order).toHaveLength(PANEL_IDS.length + 1);
    }
  });
});

describe('sideOf', () => {
  it('reads the side off the one order, so the two can never disagree', () => {
    const l = layout({ order: ['agent', PREVIEW, 'editor'] });
    expect(sideOf(l, 'agent')).toBe('left');
    expect(sideOf(l, 'editor')).toBe('right');
  });
});

describe('movePanel', () => {
  it('moves a panel to the right of the preview', () => {
    const before = layout({ order: ['agent', PREVIEW, 'editor'] });
    const after = movePanel(before, 'agent', before.order.length);
    expect(sideOf(after, 'agent')).toBe('right');
    expect(after.order.indexOf(PREVIEW)).toBe(0);
  });

  it('treats the target as a gap in the current order, not in the order minus the panel', () => {
    // Dragging left-to-right past one neighbour must land after that neighbour.
    // Removing first and then splicing at the raw index lands *before* it, which
    // is the classic off-by-one that makes a drag feel like it did nothing.
    const before = layout({ order: ['agent', 'navigator', PREVIEW, 'editor'] });
    const after = movePanel(before, 'agent', 2);
    expect(after.order).toEqual(['navigator', 'agent', PREVIEW, 'editor']);
  });

  it('is a no-op when dropped back where it already was', () => {
    const before = layout({ order: ['agent', 'navigator', PREVIEW, 'editor'] });
    expect(movePanel(before, 'navigator', 1).order).toEqual(before.order);
    expect(movePanel(before, 'navigator', 2).order).toEqual(before.order);
  });

  it('docks a floating panel, because dropping it in the rail is asking for it there', () => {
    const before = layout({ order: ['agent', PREVIEW, 'editor'], floating: ['editor'] });
    const after = movePanel(before, 'editor', 0);
    expect(isFloating(after, 'editor')).toBe(false);
    expect(after.order[0]).toBe('editor');
  });

  it('clamps a target beyond either end instead of losing the panel', () => {
    const before = layout({ order: ['agent', PREVIEW, 'editor'] });
    expect(movePanel(before, 'editor', -5).order[0]).toBe('editor');
    expect(movePanel(before, 'agent', 99).order[before.order.length - 1]).toBe('agent');
  });
});

describe('nudgePanel', () => {
  it('swaps with the neighbour in that direction', () => {
    const before = layout({ order: ['agent', 'navigator', PREVIEW] });
    expect(nudgePanel(before, 'navigator', -1).order).toEqual(['navigator', 'agent', PREVIEW]);
    expect(nudgePanel(before, 'navigator', 1).order).toEqual(['agent', PREVIEW, 'navigator']);
  });

  it('stops at the ends', () => {
    const before = layout({ order: ['agent', PREVIEW, 'editor'] });
    expect(nudgePanel(before, 'agent', -1).order).toEqual(before.order);
    expect(nudgePanel(before, 'editor', 1).order).toEqual(before.order);
  });
});

describe('setFloating', () => {
  it('keeps the panel in the rail order so re-docking returns it to its slot', () => {
    // This is the whole reason floating is reversible. Removing it from `order`
    // would make "dock it again" land the panel at an end.
    const before = layout({ order: ['agent', 'navigator', PREVIEW, 'editor'] });
    const floated = setFloating(before, 'navigator', true);
    expect(floated.order).toEqual(before.order);
    expect(dockedPanels(floated)).not.toContain('navigator');

    const redocked = setFloating(floated, 'navigator', false);
    expect(redocked.order.indexOf('navigator')).toBe(1);
    expect(dockedPanels(redocked)).toContain('navigator');
  });

  it('is idempotent', () => {
    const l = layout({ order: DEFAULT_LAYOUT.order, floating: ['team'] });
    expect(setFloating(l, 'team', true)).toBe(l);
    expect(setFloating(l, 'agent', false)).toBe(l);
  });
});

describe('widths', () => {
  it('falls back to the panel default until somebody drags an edge', () => {
    const l = layout({ order: DEFAULT_LAYOUT.order });
    expect(widthOf(l, 'navigator')).toBe(PANEL_META.navigator.defaultWidth);
    expect(widthOf(l, 'navigator', 420)).toBe(420);
    expect(widthOf(setPanelWidth(l, 'navigator', 300), 'navigator', 420)).toBe(300);
  });

  it('clamps on write as well as on read', () => {
    const l = layout({ order: DEFAULT_LAYOUT.order });
    expect(setPanelWidth(l, 'editor', 10_000).widths.editor).toBe(PANEL_META.editor.maxWidth);
  });
});

describe('layoutsEqual', () => {
  it('ignores the order floating was recorded in', () => {
    const a = layout({ order: DEFAULT_LAYOUT.order, floating: ['team', 'editor'] });
    const b = layout({ order: DEFAULT_LAYOUT.order, floating: ['editor', 'team'] });
    expect(layoutsEqual(a, b)).toBe(true);
  });

  it('notices a reorder, a float and a resize', () => {
    const base = layout({ order: DEFAULT_LAYOUT.order });
    expect(layoutsEqual(base, movePanel(base, 'agent', 0))).toBe(false);
    expect(layoutsEqual(base, setFloating(base, 'agent', true))).toBe(false);
    expect(layoutsEqual(base, setPanelWidth(base, 'agent', 500))).toBe(false);
  });
});

describe('presets', () => {
  it('are all real layouts', () => {
    for (const preset of LAYOUT_PRESETS) {
      expect(layoutsEqual(preset.layout, normalizeLayout(preset.layout))).toBe(true);
      expect(preset.layout.order).toContain(PREVIEW);
    }
  });

  it('Focus leaves only the agent beside the preview', () => {
    const focus = LAYOUT_PRESETS.find((preset) => preset.id === 'focus')!.layout;
    expect(dockedPanels(focus)).toEqual(['agent']);
  });

  it('Design puts the navigator and the editor either side of the canvas', () => {
    const design = LAYOUT_PRESETS.find((preset) => preset.id === 'design')!.layout;
    expect(sideOf(design, 'navigator')).toBe('left');
    expect(sideOf(design, 'editor')).toBe('right');
  });
});

describe('layoutFromLegacyPreferences', () => {
  it('reproduces the arrangement a default install was already showing', () => {
    // Agent and Navigator pinned, everything else floating — the pre-rail
    // defaults. An upgrade must not look rearranged.
    const migrated = layoutFromLegacyPreferences({
      agentPinned: true,
      navigatorPinned: true,
      variablesPinned: false,
      editorPinned: false,
      teamPinned: false,
      widths: {},
    });
    expect(dockedPanels(migrated)).toEqual(['agent', 'navigator']);
    expect(migrated.order).toEqual(DEFAULT_LAYOUT.order);
  });

  it('carries the widths people had already dragged', () => {
    const migrated = layoutFromLegacyPreferences({
      agentPinned: true,
      navigatorPinned: true,
      variablesPinned: true,
      editorPinned: true,
      teamPinned: true,
      widths: { navigator: 320, team: 500 },
    });
    expect(migrated.widths.navigator).toBe(320);
    expect(migrated.widths.team).toBe(500);
    expect(dockedPanels(migrated)).toHaveLength(PANEL_IDS.length);
  });
});
