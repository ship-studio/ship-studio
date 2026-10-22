import { render, screen, act } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDock } from './WorkspaceDock';
import { DockablePanel } from '../primitives/DockablePanel';
import {
  PanelDockProvider,
  usePanelDockBinding,
  usePanelDock,
} from '../../contexts/PanelDockContext';
import { type PanelId } from '../../lib/workspaceLayout';
import { readProjectLayout } from '../../lib/workspaceLayoutStore';

const PROJECT = '/Users/dev/ShipStudio/site';
const resizeObserverInstances: ResizeObserverMock[] = [];

class ResizeObserverMock {
  readonly observed: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverInstances.push(this);
  }

  observe = vi.fn((element: Element) => {
    this.observed.push(element);
  });

  disconnect = vi.fn();

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function TestPanel({
  panel,
  visible = true,
  defaultWidth,
}: {
  panel: PanelId;
  visible?: boolean;
  defaultWidth?: number;
}) {
  const dock = usePanelDockBinding(panel);
  const { layout } = usePanelDock();
  const docked = !layout.floating.includes(panel);
  useEffect(() => {
    dock?.setDefaultWidth(defaultWidth);
  }, [defaultWidth, dock]);
  return (
    <DockablePanel
      dock={dock}
      docked={docked}
      visible={visible}
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

function v2Layout(columns: unknown[], floating: PanelId[] = []) {
  const known = new Set<PanelId>();
  for (const column of columns) {
    if (!column || typeof column !== 'object' || !('panels' in column)) continue;
    for (const placement of (column as { panels?: unknown[] }).panels ?? []) {
      if (placement && typeof placement === 'object' && 'panel' in placement) {
        known.add((placement as { panel: PanelId }).panel);
      }
    }
  }
  const missing = (['agent', 'navigator', 'variables', 'editor', 'team'] as PanelId[]).filter(
    (panel) => !known.has(panel)
  );
  return {
    version: 2,
    columns: [
      ...columns,
      ...missing.map((panel) => ({ kind: 'panels', panels: [{ panel, weight: 1 }] })),
    ],
    floating,
  };
}

function renderRail(panels: PanelId[], layout: unknown, previewHidden = false) {
  localStorage.setItem(`shipstudio.layout.project:${PROJECT}`, JSON.stringify(layout));
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

function dragHeader(panel: PanelId, to: { x: number; y: number }) {
  const header = screen.getByTestId(`${panel}-header`);
  act(() => {
    header.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 10, clientY: 200 })
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

function ApplyLayout({ layout }: { layout: unknown }) {
  const { setLayout } = usePanelDock();
  useEffect(() => {
    setLayout(layout as Parameters<typeof setLayout>[0]);
  }, [layout, setLayout]);
  return null;
}

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

beforeAll(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

beforeEach(() => {
  localStorage.clear();
  resizeObserverInstances.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const element = this as HTMLElement;
    const item = element.dataset.railPanel ?? element.dataset.preview;
    const rects: Record<string, [number, number, number, number]> = {
      agent: [0, 300, 100, 450],
      navigator: [0, 300, 450, 800],
      editor: [900, 1200, 100, 800],
      true: [300, 900, 100, 800],
    };
    const [left, right, top, bottom] = rects[item ?? ''] ?? [0, 1200, 100, 800];
    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

describe('stacked rendering', () => {
  it('renders multiple panels in one column with one horizontal divider', async () => {
    renderRail(
      ['agent', 'navigator', 'editor'],
      v2Layout([
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 0.5 },
            { panel: 'navigator', weight: 0.5 },
          ],
        },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
      ])
    );
    await act(async () => Promise.resolve());
    const columns = document.querySelectorAll('.workspace-dock__column');
    expect(columns).toHaveLength(2);
    expect(columns[0].querySelectorAll('[data-rail-panel]')).toHaveLength(2);
    expect(columns[0].querySelectorAll('[aria-orientation="horizontal"]')).toHaveLength(1);
  });

  it('supports three-panel stacks with two shared dividers', async () => {
    renderRail(
      ['agent', 'navigator', 'variables'],
      v2Layout([
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 1 / 3 },
            { panel: 'navigator', weight: 1 / 3 },
            { panel: 'variables', weight: 1 / 3 },
          ],
        },
        { kind: 'preview' },
      ])
    );
    await act(async () => Promise.resolve());
    expect(document.querySelectorAll('.workspace-dock__slot')).toHaveLength(3);
    expect(document.querySelectorAll('[aria-orientation="horizontal"]')).toHaveLength(2);
  });

  it('starts a stack at the widest member default width', async () => {
    renderRail(
      ['navigator', 'team'],
      v2Layout([
        {
          kind: 'panels',
          panels: [
            { panel: 'navigator', weight: 0.5 },
            { panel: 'team', weight: 0.5 },
          ],
        },
        { kind: 'preview' },
      ])
    );
    await act(async () => Promise.resolve());
    const column = document.querySelector<HTMLElement>(
      '.workspace-dock__column[data-column-index="0"]'
    );
    expect(column?.style.width).toBe('420px');
  });

  it('honors a dynamic panel width preference when no column width was committed', async () => {
    localStorage.setItem(
      `shipstudio.layout.project:${PROJECT}`,
      JSON.stringify(
        v2Layout([
          { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
          { kind: 'preview' },
        ])
      )
    );
    render(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceDock preview={<div data-testid="preview" />}>
          <TestPanel panel="navigator" defaultWidth={460} />
        </WorkspaceDock>
      </PanelDockProvider>
    );
    await act(async () => Promise.resolve());
    const column = document.querySelector<HTMLElement>(
      '.workspace-dock__column[data-column-index="0"]'
    );
    expect(column?.style.width).toBe('460px');
  });

  it('omits floating and closed members without changing source structure', async () => {
    renderRail(
      ['agent', 'navigator'],
      v2Layout(
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
      )
    );
    await act(async () => Promise.resolve());
    expect(document.querySelectorAll('[data-rail-panel]')).toHaveLength(1);
    expect(document.querySelector('.workspace-dock__column')).not.toBeNull();
  });

  it('fills a column when a stacked panel floats without changing its saved weight', async () => {
    renderRail(
      ['agent', 'navigator'],
      v2Layout(
        [
          {
            kind: 'panels',
            panels: [
              { panel: 'agent', weight: 0.25 },
              { panel: 'navigator', weight: 0.75 },
            ],
          },
          { kind: 'preview' },
        ],
        ['agent']
      )
    );
    await act(async () => Promise.resolve());

    const slot = document.querySelector<HTMLElement>('[data-rail-panel="navigator"]');
    expect(slot?.style.flex).toBe('1 1 0px');
    expect(readProjectLayout(PROJECT).columns[0]).toMatchObject({
      panels: [
        { panel: 'agent', weight: 0.25 },
        { panel: 'navigator', weight: 0.75 },
      ],
    });
  });
});

describe('vertical resizing', () => {
  it('keeps weight changes local until the horizontal divider is released', async () => {
    renderRail(
      ['agent', 'navigator'],
      v2Layout([
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 0.5 },
            { panel: 'navigator', weight: 0.5 },
          ],
        },
        { kind: 'preview' },
      ])
    );
    await act(async () => Promise.resolve());
    const handle = screen.getByRole('separator', { name: 'Resize Agent and Elements panels' });
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientY: 450 })
      );
    });
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientY: 300 })
      );
    });
    expect(readProjectLayout(PROJECT).columns[0]).toMatchObject({
      panels: [{ weight: 0.5 }, { weight: 0.5 }],
    });
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerId: 2, clientY: 300 })
      );
    });
    const saved = readProjectLayout(PROJECT).columns[0];
    expect(saved).toMatchObject({ kind: 'panels' });
    if (saved.kind === 'panels') expect(saved.panels[0].weight).not.toBe(0.5);
  });
});

describe('two-dimensional dragging', () => {
  it('reorders a panel within a stack when released below another panel', async () => {
    renderRail(
      ['agent', 'navigator'],
      v2Layout([
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 0.5 },
            { panel: 'navigator', weight: 0.5 },
          ],
        },
        { kind: 'preview' },
      ])
    );
    await act(async () => Promise.resolve());
    const header = screen.getByTestId('agent-header');
    const surface = screen.getByLabelText('agent panel');
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 1,
          clientX: 10,
          clientY: 200,
        })
      );
      header.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          clientX: 150,
          clientY: 792,
        })
      );
    });

    expect(surface).toHaveClass('dockable-panel__surface--dragging');
    expect(surface).toHaveStyle({ left: '140px', top: '692px' });

    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 1,
          clientX: 150,
          clientY: 792,
        })
      );
    });
    const saved = readProjectLayout(PROJECT).columns[0];
    expect(saved).toMatchObject({
      kind: 'panels',
      panels: [{ panel: 'navigator' }, { panel: 'agent' }],
    });
  });

  it('leaves a docked panel at its release position when dropped away from a rail target', async () => {
    localStorage.setItem('agent.pos', JSON.stringify({ left: 40, top: 40 }));
    renderRail(
      ['agent'],
      v2Layout([{ kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] }, { kind: 'preview' }])
    );
    await act(async () => Promise.resolve());

    const header = screen.getByTestId('agent-header');
    const surface = screen.getByLabelText('agent panel');
    act(() => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 1,
          clientX: 10,
          clientY: 200,
        })
      );
      header.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          clientX: 600,
          clientY: 400,
        })
      );
      header.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 1,
          clientX: 600,
          clientY: 400,
        })
      );
    });

    expect(readProjectLayout(PROJECT).floating).toContain('agent');
    expect(surface).toHaveClass('dockable-panel__surface--floating');
    expect(surface).toHaveStyle({ left: '590px', top: '300px' });
    expect(localStorage.getItem('agent.pos')).toBe('{"left":590,"top":300}');
  });
});

describe('focus and body portals', () => {
  it('stretches the agent temporarily without changing the saved layout', async () => {
    renderRail(
      ['agent', 'navigator'],
      v2Layout(
        [{ kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] }, { kind: 'preview' }],
        ['agent']
      ),
      true
    );
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('preview').parentElement).toHaveAttribute('hidden');
    expect(screen.queryByRole('separator', { name: 'Resize Agent column' })).toBeNull();
    expect(document.querySelectorAll('[data-rail-panel]')).toHaveLength(1);
    const saved = readProjectLayout(PROJECT);
    dragHeader('agent', { x: 150, y: 700 });
    expect(readProjectLayout(PROJECT)).toEqual(saved);
    expect(readProjectLayout(PROJECT).floating).toContain('agent');
  });

  it('remeasures docked surfaces when the rail moves without changing slot size', async () => {
    let panelLeft = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const element = this as HTMLElement;
      const item =
        element.dataset.railPanel ??
        element.dataset.preview ??
        element.closest<HTMLElement>('[data-rail-panel]')?.dataset.railPanel;
      const rects: Record<string, [number, number, number, number]> = {
        agent: [panelLeft, panelLeft + 100, 100, 800],
        true: [300, 900, 100, 800],
      };
      const [left, right, top, bottom] = rects[item ?? ''] ?? [0, 1200, 100, 800];
      return {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });

    renderRail(
      ['agent'],
      v2Layout([{ kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] }, { kind: 'preview' }])
    );
    await act(async () => Promise.resolve());

    const railObserver = resizeObserverInstances.find((observer) =>
      observer.observed.some((element) =>
        (element as HTMLElement).classList.contains('workspace-dock')
      )
    );
    expect(railObserver).toBeDefined();

    panelLeft = 174;
    act(() => railObserver?.trigger());

    expect(screen.getByLabelText('agent panel')).toHaveStyle({ left: '174px' });
  });

  it('remeasures surviving docked surfaces when a preceding panel closes', async () => {
    let agentVisible = true;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const element = this as HTMLElement;
      const item =
        element.dataset.railPanel ??
        element.dataset.preview ??
        element.closest<HTMLElement>('[data-rail-panel]')?.dataset.railPanel;
      const lefts: Record<string, number> = {
        agent: 0,
        navigator: agentVisible ? 180 : 0,
        true: agentVisible ? 360 : 180,
      };
      const left = lefts[item ?? ''] ?? 0;
      const width = item === 'true' ? 600 : 180;
      const top = 100;
      const bottom = 800;
      return {
        left,
        right: left + width,
        top,
        bottom,
        width,
        height: bottom - top,
        x: left,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });

    localStorage.setItem(
      `shipstudio.layout.project:${PROJECT}`,
      JSON.stringify(
        v2Layout([
          { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
          { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
          { kind: 'preview' },
        ])
      )
    );

    const workspace = (showAgent: boolean) => (
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceDock preview={<div data-testid="preview" />}>
          <TestPanel panel="agent" visible={showAgent} />
          <TestPanel panel="navigator" />
        </WorkspaceDock>
      </PanelDockProvider>
    );
    const view = render(workspace(true));
    await act(async () => Promise.resolve());

    const navigatorSurface = screen.getByLabelText('navigator panel');
    expect(navigatorSurface).toHaveStyle({ left: '180px' });

    agentVisible = false;
    view.rerender(workspace(false));
    await act(async () => Promise.resolve());

    expect(navigatorSurface).toHaveStyle({ left: '0px' });
  });

  it('keeps the preview DOM node stable while column layout changes', async () => {
    const preview = <div data-testid="preview" />;
    const { rerender } = render(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceDock preview={preview}>
          <TestPanel panel="agent" />
          <TestPanel panel="editor" />
        </WorkspaceDock>
      </PanelDockProvider>
    );
    await act(async () => Promise.resolve());
    const previewNode = screen.getByTestId('preview');
    rerender(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceDock preview={preview}>
          <TestPanel panel="editor" />
          <TestPanel panel="agent" />
        </WorkspaceDock>
      </PanelDockProvider>
    );
    expect(screen.getByTestId('preview')).toBe(previewNode);
  });

  it('keeps preview sibling order stable while changing its visual flex order', async () => {
    const initial = v2Layout([
      { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
      { kind: 'preview' },
      { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
    ]);
    const next = v2Layout([
      { kind: 'preview' },
      { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
      { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
    ]);
    const previewFrame = <iframe title="preview" />;
    localStorage.setItem(`shipstudio.layout.project:${PROJECT}`, JSON.stringify(initial));
    const view = render(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceDock preview={previewFrame}>
          <TestPanel panel="agent" />
          <TestPanel panel="editor" />
        </WorkspaceDock>
      </PanelDockProvider>
    );
    await act(async () => Promise.resolve());
    const rail = view.container.querySelector('.workspace-dock')!;
    const beforeChildren = [...rail.children];
    const preview = rail.querySelector('[data-preview="true"]')!;
    const beforeIndex = beforeChildren.indexOf(preview);
    const beforeVisualOrder = getComputedStyle(preview).order;
    view.rerender(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceDock preview={previewFrame}>
          <TestPanel panel="agent" />
          <TestPanel panel="editor" />
        </WorkspaceDock>
        <ApplyLayout layout={next} />
      </PanelDockProvider>
    );
    await act(async () => Promise.resolve());
    const afterChildren = [...rail.children];
    expect(afterChildren[beforeIndex]).toBe(preview);
    expect(getComputedStyle(preview).order).not.toBe(beforeVisualOrder);
  });
});
