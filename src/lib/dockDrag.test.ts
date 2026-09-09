import { describe, expect, it } from 'vitest';
import {
  applyDrop,
  describeDrop,
  dropTargetAt,
  railBoundaries,
  type RailBounds,
  type RailSlotRect,
} from './dockDrag';
import {
  PANEL_META,
  PREVIEW,
  dockedPanels,
  isFloating,
  type RailItem,
  type WorkspaceLayout,
} from './workspaceLayout';

/** Agent | preview | editor, in a 1200px-wide rail. */
const slots: RailSlotRect[] = [
  { item: 'agent', left: 0, right: 400 },
  { item: PREVIEW, left: 400, right: 900 },
  { item: 'editor', left: 900, right: 1200 },
];
const bounds: RailBounds = { left: 0, right: 1200, top: 100, bottom: 800 };

const layout: WorkspaceLayout = {
  order: ['agent', PREVIEW, 'editor'],
  floating: [],
  widths: {},
};

const labelOf = (item: RailItem) => (item === PREVIEW ? 'Preview' : PANEL_META[item].label);

describe('railBoundaries', () => {
  it('offers one seam per join, plus the two ends', () => {
    expect(railBoundaries(slots, bounds)).toEqual([
      { x: 0, before: 'agent' },
      { x: 400, before: PREVIEW },
      { x: 900, before: 'editor' },
      { x: 1200, before: null },
    ]);
  });

  it('collapses a gap between two slots to a single target', () => {
    // Two slots two pixels apart are one seam to a person. Offering both edges
    // would make which one wins depend on sub-pixel rounding.
    const spaced: RailSlotRect[] = [
      { item: 'agent', left: 0, right: 400 },
      { item: PREVIEW, left: 408, right: 900 },
    ];
    const seams = railBoundaries(spaced, bounds).filter((b) => b.before === PREVIEW);
    expect(seams).toEqual([{ x: 404, before: PREVIEW }]);
  });

  it('gives an empty rail one target', () => {
    expect(railBoundaries([], bounds)).toEqual([{ x: 0, before: null }]);
  });
});

describe('dropTargetAt', () => {
  it('docks at the seam the pointer is nearest', () => {
    expect(dropTargetAt(slots, bounds, { x: 420, y: 400 })).toEqual({
      kind: 'dock',
      before: PREVIEW,
      x: 400,
    });
    expect(dropTargetAt(slots, bounds, { x: 880, y: 400 })).toEqual({
      kind: 'dock',
      before: 'editor',
      x: 900,
    });
  });

  it('floats out over the middle of the canvas, where no seam is near', () => {
    // The float gesture. The rail *is* the workspace, so "drag it out of the
    // rail" has nowhere to go — the canvas is the target that does.
    expect(dropTargetAt(slots, bounds, { x: 650, y: 400 })).toEqual({ kind: 'float' });
  });

  it('floats above or below the rail whatever the x lines up with', () => {
    expect(dropTargetAt(slots, bounds, { x: 400, y: 40 })).toEqual({ kind: 'float' });
    expect(dropTargetAt(slots, bounds, { x: 400, y: 900 })).toEqual({ kind: 'float' });
  });

  it('reaches both ends of the rail', () => {
    expect(dropTargetAt(slots, bounds, { x: 4, y: 400 })).toMatchObject({ before: 'agent' });
    expect(dropTargetAt(slots, bounds, { x: 1196, y: 400 })).toMatchObject({ before: null });
  });
});

describe('applyDrop', () => {
  it('puts the panel before the item the indicator named', () => {
    const after = applyDrop(layout, 'editor', { kind: 'dock', before: 'agent', x: 0 });
    expect(after.order).toEqual(['editor', 'agent', PREVIEW]);
  });

  it('puts it at the far right when the indicator is past everything', () => {
    const after = applyDrop(layout, 'agent', { kind: 'dock', before: null, x: 1200 });
    expect(after.order).toEqual([PREVIEW, 'editor', 'agent']);
  });

  it('docks a floating panel that was dropped on the rail', () => {
    const floated: WorkspaceLayout = { ...layout, floating: ['editor'] };
    const after = applyDrop(floated, 'editor', { kind: 'dock', before: PREVIEW, x: 400 });
    expect(isFloating(after, 'editor')).toBe(false);
    expect(after.order).toEqual(['agent', 'editor', PREVIEW]);
  });

  it('floats a docked panel dropped away from every seam', () => {
    const after = applyDrop(layout, 'agent', { kind: 'float' });
    expect(isFloating(after, 'agent')).toBe(true);
    expect(dockedPanels(after)).not.toContain('agent');
    // Its slot is kept, so re-docking returns it here rather than to an end.
    expect(after.order).toEqual(layout.order);
  });
});

describe('describeDrop', () => {
  it('says what releasing now would do', () => {
    expect(describeDrop({ kind: 'float' }, labelOf)).toBe('Float');
    expect(describeDrop({ kind: 'dock', before: PREVIEW, x: 0 }, labelOf)).toBe('Left of preview');
    expect(describeDrop({ kind: 'dock', before: 'editor', x: 0 }, labelOf)).toBe('Before Edit');
    expect(describeDrop({ kind: 'dock', before: null, x: 0 }, labelOf)).toBe('Far right');
  });
});
