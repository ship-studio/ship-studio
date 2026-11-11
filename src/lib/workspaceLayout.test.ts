import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  LAYOUT_PRESETS,
  LAYOUT_VERSION,
  PANEL_IDS,
  PANEL_META,
  PREVIEW,
  columnWidthBounds,
  dockedPanels,
  findPanelPlacement,
  isFloating,
  layoutFromLegacyPreferences,
  layoutsEqual,
  moveColumn,
  moveColumnToGap,
  movePanelToColumnGap,
  normalizeLayout,
  reorderPanelInStack,
  setAdjacentPanelWeights,
  setColumnWidth,
  setFloating,
  sideOf,
  stackPanel,
  unstackPanel,
  visibleColumns,
  widthOf,
  type PanelId,
  type WorkspaceLayout,
} from './workspaceLayout';

const panelColumn = (...panels: PanelId[]) => ({
  kind: 'panels' as const,
  panels: panels.map((panel) => ({ panel, weight: 1 / panels.length })),
});

const layout = (
  columns: WorkspaceLayout['columns'],
  floating: PanelId[] = []
): WorkspaceLayout => ({
  version: LAYOUT_VERSION,
  columns,
  floating,
});

describe('normalizeLayout', () => {
  it('returns a complete v2 layout for an empty preference', () => {
    const result = normalizeLayout(null);
    expect(result.version).toBe(LAYOUT_VERSION);
    expect(result).toEqual(normalizeLayout(DEFAULT_LAYOUT));
    expect(result.columns.filter((column) => column.kind === 'preview')).toHaveLength(1);
  });

  it('migrates the old flat order/floating/widths shape to singleton columns', () => {
    const result = normalizeLayout({
      order: ['editor', 'agent', PREVIEW, 'navigator', 'variables', 'team'],
      floating: ['team'],
      widths: { agent: 600, navigator: 5000 },
    });
    expect(result.version).toBe(2);
    expect(
      result.columns.map((column) => (column.kind === 'preview' ? PREVIEW : column.panels[0].panel))
    ).toEqual(['assets', 'editor', 'agent', PREVIEW, 'navigator', 'variables', 'team']);
    expect(findPanelPlacement(result, 'agent')?.column.width).toBe(600);
    expect(findPanelPlacement(result, 'navigator')?.column.width).toBe(
      PANEL_META.navigator.maxWidth
    );
    expect(isFloating(result, 'team')).toBe(true);
  });

  it('repairs unknown ids, duplicates, empty columns, bad weights and duplicate previews', () => {
    const result = normalizeLayout({
      version: 2,
      columns: [
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 0 },
            { panel: 'ghost', weight: 3 },
          ],
        },
        { kind: 'panels', panels: [] },
        { kind: 'preview' },
        { kind: 'preview' },
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 3 },
            { panel: 'navigator', weight: 'bad' },
          ],
        },
      ],
      floating: ['ghost', 'agent', 'agent'],
    } as unknown);
    expect(result.columns.filter((column) => column.kind === 'preview')).toHaveLength(1);
    expect(
      result.columns.flatMap((column) =>
        column.kind === 'preview' ? [] : column.panels.map((item) => item.panel)
      )
    ).toHaveLength(PANEL_IDS.length);
    expect(new Set(dockedPanels(result)).size).toBe(PANEL_IDS.length - 1);
    const agent = findPanelPlacement(result, 'agent')!;
    expect(agent.placement.weight).toBe(1);
    expect(result.floating).toEqual(['agent']);
  });

  it('inserts missing panels at their default side without disturbing an existing stack', () => {
    const result = normalizeLayout({
      version: 2,
      columns: [
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 1 },
            { panel: 'navigator', weight: 1 },
          ],
        },
        { kind: 'preview' },
      ],
      floating: [],
    });
    expect(
      result.columns.find(
        (column) => column.kind === 'panels' && column.panels.some((item) => item.panel === 'agent')
      )
    ).toMatchObject({
      panels: [{ panel: 'agent' }, { panel: 'navigator' }],
    });
    expect(sideOf(result, 'variables')).toBe('left');
    expect(sideOf(result, 'editor')).toBe('right');
  });
});

describe('placement helpers', () => {
  it('finds placements and reads side from the preview column', () => {
    const result = layout([
      panelColumn('agent', 'navigator'),
      { kind: 'preview' },
      panelColumn('editor'),
    ]);
    expect(findPanelPlacement(result, 'navigator')).toMatchObject({
      columnIndex: 0,
      panelIndex: 1,
    });
    expect(sideOf(result, 'agent')).toBe('left');
    expect(sideOf(result, 'editor')).toBe('right');
    expect(dockedPanels(result)).toEqual(['agent', 'navigator', 'editor']);
  });

  it('projects visible docked columns without losing floating placement', () => {
    const result = layout(
      [panelColumn('agent', 'navigator'), { kind: 'preview' }, panelColumn('editor')],
      ['navigator']
    );
    expect(
      visibleColumns(result).map((column) =>
        column.kind === 'preview' ? PREVIEW : column.panels.map((item) => item.panel)
      )
    ).toEqual([['agent'], PREVIEW, ['editor']]);
    expect(findPanelPlacement(result, 'navigator')?.columnIndex).toBe(0);
    expect(dockedPanels(result)).toEqual(['agent', 'editor']);
  });
});

describe('stacking and column movement', () => {
  it('stacks before/after a target and docks the moved panel', () => {
    const before = layout(
      [panelColumn('agent'), { kind: 'preview' }, panelColumn('navigator', 'editor')],
      ['agent']
    );
    const after = stackPanel(before, 'agent', 'navigator', 'before');
    const column = after.columns[1];
    expect(column).toMatchObject({
      kind: 'panels',
      panels: [{ panel: 'agent' }, { panel: 'navigator' }, { panel: 'editor' }],
    });
    expect(isFloating(after, 'agent')).toBe(false);
    expect(after.columns).toHaveLength(2);
    expect(
      after.columns[1].kind === 'panels' && after.columns[1].panels.map((item) => item.weight)
    ).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('docks a floating panel when it is stacked into its remembered column', () => {
    const before = layout(
      [
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 0.5 },
            { panel: 'navigator', weight: 0.5 },
          ],
        },
        { kind: 'preview' },
      ],
      ['navigator']
    );
    const after = stackPanel(before, 'navigator', 'agent', 'before');
    expect(isFloating(after, 'navigator')).toBe(false);
    expect(after.columns[0]).toMatchObject({
      panels: [{ panel: 'navigator' }, { panel: 'agent' }],
    });
  });

  it('moves a panel to a column gap, preserving its source width', () => {
    const before = layout([
      { ...panelColumn('agent'), width: 500 },
      panelColumn('navigator'),
      { kind: 'preview' },
    ]);
    const after = movePanelToColumnGap(before, 'agent', 3);
    expect(
      after.columns.map((column) => (column.kind === 'preview' ? PREVIEW : column.panels[0].panel))
    ).toEqual(['navigator', PREVIEW, 'agent']);
    expect(findPanelPlacement(after, 'agent')?.column.width).toBe(500);
  });

  it('reorders within a stack while preserving the panel ratios', () => {
    const before = layout([
      {
        kind: 'panels',
        panels: [
          { panel: 'agent', weight: 0.2 },
          { panel: 'navigator', weight: 0.3 },
          { panel: 'editor', weight: 0.5 },
        ],
      },
      { kind: 'preview' },
    ]);
    const after = reorderPanelInStack(before, 'editor', 0);
    expect(after.columns[0]).toMatchObject({
      panels: [{ panel: 'editor' }, { panel: 'agent' }, { panel: 'navigator' }],
    });
    expect(
      after.columns[0].kind === 'panels' && after.columns[0].panels.map((item) => item.weight)
    ).toEqual([0.5, 0.2, 0.3]);
  });

  it('unstack creates a singleton column and inherits the source width', () => {
    const before = layout([
      {
        kind: 'panels',
        panels: [
          { panel: 'agent', weight: 0.5 },
          { panel: 'navigator', weight: 0.5 },
        ],
        width: 400,
      },
      { kind: 'preview' },
    ]);
    const after = unstackPanel(before, 'navigator', 'before');
    expect(after.columns[1]).toMatchObject({ panels: [{ panel: 'agent' }] });
    expect(after.columns[1].kind === 'panels' && after.columns[1].width).toBe(400);
    expect(after.columns[0]).toMatchObject({ panels: [{ panel: 'navigator' }], width: 400 });
  });
});

describe('widths and vertical ratios', () => {
  it('clamps a stack width to the intersection of its panel limits', () => {
    const result = layout([panelColumn('agent', 'navigator'), { kind: 'preview' }]);
    expect(
      columnWidthBounds(
        result.columns[0] as Extract<WorkspaceLayout['columns'][number], { kind: 'panels' }>
      )
    ).toEqual({
      minWidth: PANEL_META.agent.minWidth,
      maxWidth: PANEL_META.navigator.maxWidth,
      defaultWidth: PANEL_META.agent.defaultWidth,
    });
    const resized = setColumnWidth(result, 0, 1000);
    expect(widthOf(resized, 'agent')).toBe(PANEL_META.navigator.maxWidth);
  });

  it('changes only adjacent shares in a three-panel stack', () => {
    const before = layout([
      {
        kind: 'panels',
        panels: [
          { panel: 'agent', weight: 0.3 },
          { panel: 'navigator', weight: 0.3 },
          { panel: 'editor', weight: 0.4 },
        ],
      },
      { kind: 'preview' },
    ]);
    const after = setAdjacentPanelWeights(before, 0, 'agent', 'navigator', 0.2, 0.8);
    expect(
      after.columns[0].kind === 'panels' && after.columns[0].panels.map((item) => item.weight)
    ).toEqual([0.12, 0.48, 0.4]);
  });
});

describe('floating, equality and presets', () => {
  it('moves a whole column within its side without moving Preview', () => {
    const before = layout([
      panelColumn('agent'),
      panelColumn('navigator'),
      { kind: 'preview' },
      panelColumn('editor'),
      panelColumn('team'),
    ]);

    const after = moveColumn(before, 0, 1, 'after');
    expect(
      after.columns.map((column) => (column.kind === 'preview' ? PREVIEW : column.panels[0]?.panel))
    ).toEqual(['navigator', 'agent', PREVIEW, 'editor', 'team']);
    expect(moveColumn(after, 0, 2, 'after')).toEqual(after);
  });

  it('moves a whole column across Preview without splitting its stack', () => {
    const before = layout([
      panelColumn('agent', 'navigator'),
      { kind: 'preview' },
      panelColumn('editor', 'team'),
    ]);

    const after = moveColumn(before, 0, 2, 'after');

    expect(
      after.columns.map((column) =>
        column.kind === 'preview' ? PREVIEW : column.panels.map((item) => item.panel)
      )
    ).toEqual([PREVIEW, ['editor', 'team'], ['agent', 'navigator']]);
  });

  it('moves a whole column to an empty side gap without splitting its stack', () => {
    const before = layout([
      panelColumn('agent', 'navigator'),
      { kind: 'preview' },
      panelColumn('editor', 'team'),
    ]);

    const after = moveColumnToGap(before, 0, 3);

    expect(
      after.columns.map((column) =>
        column.kind === 'preview' ? PREVIEW : column.panels.map((item) => item.panel)
      )
    ).toEqual([PREVIEW, ['editor', 'team'], ['agent', 'navigator']]);
  });

  it('keeps a floating panel in its placement for reversible docking', () => {
    const before = layout([panelColumn('agent', 'navigator'), { kind: 'preview' }]);
    const floated = setFloating(before, 'navigator', true);
    expect(findPanelPlacement(floated, 'navigator')?.panelIndex).toBe(1);
    expect(setFloating(floated, 'navigator', false).columns).toEqual(before.columns);
  });

  it('compares columns, ratios and floating membership', () => {
    const before = normalizeLayout(DEFAULT_LAYOUT);
    expect(layoutsEqual(before, normalizeLayout(JSON.parse(JSON.stringify(before))))).toBe(true);
    expect(layoutsEqual(before, stackPanel(before, 'agent', 'navigator', 'after'))).toBe(false);
  });

  it('includes an explicit Agent + Elements stacked preset', () => {
    const preset = LAYOUT_PRESETS.find((item) => item.id === 'stacked')!;
    const stack = preset.layout.columns.find(
      (column) => column.kind === 'panels' && column.panels.some((item) => item.panel === 'agent')
    );
    expect(stack).toMatchObject({ panels: [{ panel: 'agent' }, { panel: 'navigator' }] });
    expect(preset.layout.version).toBe(LAYOUT_VERSION);
  });
});

describe('legacy panel preferences', () => {
  it('preserves pin state and old widths in singleton v2 columns', () => {
    const migrated = layoutFromLegacyPreferences({
      agentPinned: true,
      navigatorPinned: true,
      variablesPinned: false,
      editorPinned: false,
      teamPinned: false,
      widths: { navigator: 320, team: 500 },
    });
    expect(dockedPanels(migrated)).toEqual(['assets', 'agent', 'navigator']);
    expect(widthOf(migrated, 'navigator')).toBe(320);
    expect(widthOf(migrated, 'team')).toBe(500);
    expect(migrated.version).toBe(LAYOUT_VERSION);
  });
});
