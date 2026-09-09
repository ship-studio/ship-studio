/**
 * The rail, end to end: a panel's placeholder finds its slot, a header drag
 * moves it, and a release writes the arrangement down.
 *
 * These render a real `DockablePanel` inside a real `PanelDockProvider` rather
 * than mocking the seam between them, because the seam *is* the feature — the
 * whole design rests on a placeholder being portaled into a slot it does not
 * know about.
 *
 * jsdom reports every rect as zero, so the geometry a drag resolves against is
 * stubbed per test. That is the honest boundary: `dropTargetAt` is tested
 * against real numbers in `dockDrag.test.ts`; what these check is the wiring.
 */

import { render, screen, act } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDock } from './WorkspaceDock';
import { DockablePanel } from '../primitives/DockablePanel';
import {
  PanelDockProvider,
  usePanelDock,
  usePanelDockBinding,
} from '../../contexts/PanelDockContext';
import { PREVIEW, isDocked, type PanelId } from '../../lib/workspaceLayout';
import { readProjectLayout } from '../../lib/workspaceLayoutStore';

const PROJECT = '/Users/dev/ShipStudio/site';

/**
 * A panel with nothing in it but a draggable header.
 *
 * Takes `docked` from the layout exactly as the real panels do, so a test can
 * never put the two in a state the app cannot reach.
 */
function TestPanel({ panel }: { panel: PanelId }) {
  const dock = usePanelDockBinding(panel);
  const { layout } = usePanelDock();
  const docked = isDocked(layout, panel);
  return (
    <DockablePanel
      dock={dock}
      docked={docked}
      ariaLabel={`${panel} panel`}
      positionKey={`${panel}.pos`}
      sizeKey={`${panel}.size`}
      floatingSize={{ width: 300, height: 400 }}
      initialPosition={() => ({ left: 40, top: 40 })}
    >
      <div>
        <header data-dockable-drag-handle data-testid={`${panel}-header`}>
          {panel}
        </header>
      </div>
    </DockablePanel>
  );
}

function renderRail(panels: PanelId[], layout?: unknown, previewHidden = false) {
  if (layout) {
    localStorage.setItem(`shipstudio.layout.project:${PROJECT}`, JSON.stringify(layout));
  }
  return render(
    <PanelDockProvider projectPath={PROJECT}>
      <WorkspaceDock previewHidden={previewHidden} preview={<div data-testid="preview" />}>
        {panels.map((panel) => (
          <TestPanel key={panel} panel={panel} />
        ))}
      </WorkspaceDock>
    </PanelDockProvider>
  );
}

/** Rail items left to right, read off the DOM the way `measure` does. */
function visualOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-rail-item]')]
    .map((node) => ({
      item: node.dataset.railItem!,
      order: Number(getComputedStyle(node).order || 0),
    }))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.item);
}

/**
 * Give the rail a geometry, since jsdom has none.
 *
 * Agent 0–300, preview 300–900, editor 900–1200, in a rail 100px from the top.
 */
function stubGeometry() {
  const rects: Record<string, [number, number]> = {
    agent: [0, 300],
    [PREVIEW]: [300, 900],
    editor: [900, 1200],
  };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const item = (this as HTMLElement).dataset?.railItem;
    const [left, right] = item ? (rects[item] ?? [0, 0]) : [0, 1200];
    return {
      left,
      right,
      top: 100,
      bottom: 800,
      width: right - left,
      height: 700,
      x: left,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function dragHeader(panel: PanelId, to: { x: number; y: number }) {
  const header = screen.getByTestId(`${panel}-header`);
  act(() => {
    header.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 10, clientY: 400 })
    );
  });
  act(() => {
    header.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: to.x, clientY: to.y })
    );
  });
  act(() => {
    header.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: to.x, clientY: to.y })
    );
  });
}

/**
 * jsdom has no `PointerEvent`, and a pointer drag is what this file is about.
 * A MouseEvent carrying a `pointerId` is everything the handlers read.
 */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

beforeAll(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  // jsdom has no ResizeObserver, and `DockablePanel` measures its dock slot
  // with one. Nothing here depends on it firing — the rects are stubbed per
  // test — so a constructor that does nothing is the whole stub.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the rail', () => {
  it('gives a docked panel a slot and puts its placeholder in it', () => {
    // The seam the whole design rests on. Without it a panel is wherever it
    // happens to be written in the tree, which is what it was before.
    renderRail(['agent'], { order: ['agent', PREVIEW], floating: [] });

    const slot = document.querySelector('.workspace-dock__slot[data-panel="agent"]');
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('.dockable-panel__placeholder')).not.toBeNull();
  });

  it('gives a floating panel no slot at all', () => {
    // A column with nothing in it is the failure mode of a portaled surface.
    renderRail(['agent'], { order: ['agent', PREVIEW], floating: ['agent'] });
    expect(document.querySelector('.workspace-dock__slot[data-panel="agent"]')).toBeNull();
    // It is still rendered, just as a window rather than a column.
    expect(document.querySelector('.dockable-panel__surface--floating')).not.toBeNull();
  });

  it('orders the rail without moving anything in the DOM', () => {
    // Position is the flex `order` property, never the tree: an iframe reloads
    // when it is moved in the DOM, and the preview is one.
    renderRail(['agent', 'editor'], {
      order: ['editor', PREVIEW, 'agent'],
      floating: [],
    });
    expect(visualOrder()).toEqual(['editor', PREVIEW, 'agent']);

    const domOrder = [...document.querySelectorAll<HTMLElement>('[data-rail-item]')].map(
      (node) => node.dataset.railItem
    );
    expect(domOrder).toEqual(['agent', 'editor', PREVIEW]);
  });

  it('docks the agent for focus mode even when the layout floats it', () => {
    // Putting the preview away with a floating agent would otherwise leave an
    // empty workspace with a window over it.
    renderRail(['agent'], { order: ['agent', PREVIEW], floating: ['agent'] }, true);
    expect(document.querySelector('.workspace-dock__slot[data-panel="agent"]')).not.toBeNull();
  });

  it('does not reserve a column for a panel that is not there', () => {
    renderRail(['agent'], { order: ['agent', 'editor', PREVIEW], floating: [] });
    expect(document.querySelector('.workspace-dock__slot[data-panel="editor"]')).toBeNull();
    expect(document.querySelector('.workspace-dock__slot[data-panel="agent"]')).not.toBeNull();
  });
});

describe('dragging a docked panel', () => {
  it('moves it across the preview and remembers it', () => {
    renderRail(['agent', 'editor'], { order: ['agent', PREVIEW, 'editor'], floating: [] });
    stubGeometry();

    // Release near the rail's right end — past the preview, past the editor.
    dragHeader('agent', { x: 1195, y: 400 });

    expect(visualOrder()).toEqual([PREVIEW, 'editor', 'agent']);

    // Written down, and written down as a *move* — the panels this render does
    // not mount are still in the order, in the places they had.
    const saved = readProjectLayout(PROJECT).order;
    expect(saved.indexOf('agent')).toBe(saved.length - 1);
    expect(saved.indexOf('agent')).toBeGreaterThan(saved.indexOf(PREVIEW));
  });

  it('floats it when released away from every seam', () => {
    renderRail(['agent', 'editor'], { order: ['agent', PREVIEW, 'editor'], floating: [] });
    stubGeometry();

    // The middle of the canvas: no boundary within the snap distance.
    dragHeader('agent', { x: 600, y: 400 });

    const saved = readProjectLayout(PROJECT);
    expect(saved.floating).toContain('agent');
    // Its place is kept, so re-docking returns it here rather than to an end.
    expect(saved.order.indexOf('agent')).toBeLessThan(saved.order.indexOf(PREVIEW));
    expect(document.querySelector('.workspace-dock__slot[data-panel="agent"]')).toBeNull();
  });

  it('shows what releasing now would do, while you are still holding it', () => {
    renderRail(['agent', 'editor'], { order: ['agent', PREVIEW, 'editor'], floating: [] });
    stubGeometry();

    const header = screen.getByTestId('agent-header');
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 10, clientY: 400 })
      );
    });
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 890, clientY: 400 })
      );
    });

    expect(screen.getByRole('status')).toHaveTextContent('Agent');
    expect(screen.getByRole('status')).toHaveTextContent('Before Edit');

    // Bounded by the rail, not by the window. The line is `position: fixed` so
    // it can sit above the portaled panel surfaces, and it was drawing straight
    // up through the workspace header and the titlebar above them.
    const line = document.querySelector<HTMLElement>('.workspace-dock__drop-line');
    expect(line).not.toBeNull();
    expect(line!.style.top).toBe('100px');
    expect(line!.style.height).toBe('700px');
  });

  it('does nothing at all when the header is merely clicked', () => {
    // Releasing resolves a drop at the pointer, and the middle of a wide
    // panel's header is further from any seam than the snap distance — so
    // before the drag threshold, clicking the agent's title floated it.
    renderRail(['agent', 'editor'], { order: ['agent', PREVIEW, 'editor'], floating: [] });
    stubGeometry();

    const header = screen.getByTestId('agent-header');
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 150, clientY: 400 })
      );
    });
    act(() => {
      // A pixel of tremor, as a real click has.
      header.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 151, clientY: 400 })
      );
    });
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 151, clientY: 400 })
      );
    });

    expect(readProjectLayout(PROJECT).floating).not.toContain('agent');
    expect(visualOrder()).toEqual(['agent', PREVIEW, 'editor']);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('changes nothing when the gesture is cancelled', () => {
    // A lost pointer is not a drop.
    renderRail(['agent', 'editor'], { order: ['agent', PREVIEW, 'editor'], floating: [] });
    stubGeometry();

    const header = screen.getByTestId('agent-header');
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 10, clientY: 400 })
      );
    });
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          clientX: 1195,
          clientY: 400,
        })
      );
    });
    act(() => {
      header.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    });

    expect(visualOrder()).toEqual(['agent', PREVIEW, 'editor']);
    expect(document.querySelector('.workspace-dock__drop-line')).toBeNull();
  });
});
