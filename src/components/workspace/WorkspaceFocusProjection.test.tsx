import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PanelDockProvider,
  usePanelDock,
  usePanelDockBinding,
} from '../../contexts/PanelDockContext';
import {
  readProjectFocusSplitRatio,
  readProjectLayout,
  writeProjectFocusSplitRatio,
} from '../../lib/workspaceLayoutStore';
import { DEFAULT_LAYOUT, type PanelId, type WorkspaceLayout } from '../../lib/workspaceLayout';
import { DockablePanel } from '../primitives/DockablePanel';
import { WorkspaceModes } from './WorkspaceModes';
import { WorkspaceDock } from './WorkspaceDock';
import type { WorkspaceTab } from './workspaceViewState';

const PROJECT = '/Users/dev/ShipStudio/focus-projection';
const OTHER_PROJECT = '/Users/dev/ShipStudio/other-focus-projection';

const SAVED_LAYOUT: WorkspaceLayout = {
  version: 2,
  columns: [
    { kind: 'preview' },
    { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }], width: 360 },
    { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }], width: 220 },
    { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }], width: 300 },
    { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }], width: 240 },
    { kind: 'panels', panels: [{ panel: 'team', weight: 1 }], width: 420 },
  ],
  floating: ['agent', 'variables', 'team'],
};

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

class ResizeObserverMock {
  readonly targets: Element[] = [];
  observe = vi.fn((target: Element) => this.targets.push(target));
  disconnect = vi.fn();
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const resizeObservers: ResizeObserverMock[] = [];
let railWidth = 1200;

function rect(left: number, right: number, top = 0, bottom = 800): DOMRect {
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
}

function TestPanel({ panel, visible = true }: { panel: PanelId; visible?: boolean }) {
  const dock = usePanelDockBinding(panel);
  const { layout } = usePanelDock();
  return (
    <DockablePanel
      dock={dock}
      docked={
        panel === 'agent'
          ? Boolean(dock?.focusMode) || !layout.floating.includes(panel)
          : !layout.floating.includes(panel)
      }
      visible={visible}
      ariaLabel={`${panel} panel`}
      positionKey={`${panel}.position`}
      sizeKey={`${panel}.size`}
      floatingSize={{ width: 360, height: 420 }}
      initialPosition={() => ({ left: 60, top: 80 })}
    >
      <div>
        <header data-dockable-drag-handle>{panel}</header>
        <button type="button" data-testid={`${panel}-action`}>
          {panel} action
        </button>
      </div>
    </DockablePanel>
  );
}

function FocusWorkspace({
  initialTab,
  projectPath = PROJECT,
  initialAgentHidden = false,
}: {
  initialTab: 'preview' | 'code';
  projectPath?: string;
  initialAgentHidden?: boolean;
}) {
  const [focusMode, setFocusMode] = useState(false);
  const [agentHidden] = useState(initialAgentHidden);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(initialTab);

  return (
    <PanelDockProvider projectPath={projectPath} focusMode={focusMode}>
      <WorkspaceModes
        hasPreview
        projectTypeResolved
        isPreviewHidden={focusMode}
        workspaceTab={workspaceTab}
        setIsPreviewHidden={setFocusMode}
        setWorkspaceTab={setWorkspaceTab}
      />
      <WorkspaceDock
        focusMode={focusMode}
        preview={<div data-testid="selected-workspace-surface">{workspaceTab}</div>}
      >
        <TestPanel panel="agent" visible={!agentHidden} />
        <TestPanel panel="navigator" />
        <TestPanel panel="editor" />
        <TestPanel panel="variables" />
        <TestPanel panel="team" />
      </WorkspaceDock>
    </PanelDockProvider>
  );
}

function layoutWithAgentStackedWith(panel: 'navigator' | 'team'): WorkspaceLayout {
  const columns = SAVED_LAYOUT.columns.filter(
    (column) =>
      column.kind === 'preview' || !column.panels.some((placement) => placement.panel === panel)
  );
  const agentColumnIndex = columns.findIndex(
    (column) =>
      column.kind === 'panels' && column.panels.some((placement) => placement.panel === 'agent')
  );
  columns[agentColumnIndex] = {
    kind: 'panels',
    panels: [
      { panel: 'agent', weight: 1 },
      { panel, weight: 1 },
    ],
    width: 360,
  };
  return { ...SAVED_LAYOUT, columns };
}

function renderFocusWorkspace(
  initialTab: 'preview' | 'code',
  layout: WorkspaceLayout = SAVED_LAYOUT,
  projectPath = PROJECT,
  initialAgentHidden = false
) {
  localStorage.setItem(`shipstudio.layout.project:${projectPath}`, JSON.stringify(layout));
  return render(
    <FocusWorkspace
      initialTab={initialTab}
      projectPath={projectPath}
      initialAgentHidden={initialAgentHidden}
    />
  );
}

function resizeRail(width: number, source: 'window' | 'observer') {
  railWidth = width;
  act(() => {
    if (source === 'window') {
      window.dispatchEvent(new Event('resize'));
      return;
    }
    const rail = document.querySelector('.workspace-dock');
    resizeObservers.find((observer) => observer.targets.includes(rail!))?.trigger();
    window.dispatchEvent(new Event('resize'));
  });
}

function measureDockedPanel(panel: PanelId) {
  const placeholder = document.querySelector(
    `.workspace-dock__slot[data-rail-panel="${panel}"] .dockable-panel__placeholder`
  );
  if (!placeholder) throw new Error(`Expected the ${panel} placeholder to be in the dock rail`);
  const observer = resizeObservers.find((candidate) => candidate.targets.includes(placeholder));
  if (!observer) throw new Error(`Expected a resize observer for the ${panel} placeholder`);
  act(() => observer.trigger());
}

beforeAll(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

beforeEach(() => {
  localStorage.clear();
  railWidth = 1200;
  resizeObservers.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const element = this as HTMLElement;
    if (element.classList.contains('workspace-dock')) return rect(0, railWidth);
    if (element.dataset.preview === 'true') return rect(0, railWidth);
    if (element.classList.contains('workspace-dock__column')) {
      const width = Number.parseFloat(element.style.width) || 0;
      return rect(0, width);
    }
    if (
      element.classList.contains('workspace-dock__slot') ||
      element.classList.contains('dockable-panel__placeholder')
    ) {
      const column = element.closest<HTMLElement>('.workspace-dock__column');
      const width = Number.parseFloat(column?.style.width ?? '') || 0;
      return rect(0, width);
    }
    return rect(0, 1200);
  });
});

describe('topbar Focus projection', () => {
  it('restores the default Preview Agent width after Focus', async () => {
    renderFocusWorkspace('preview', DEFAULT_LAYOUT);
    await act(async () => Promise.resolve());

    const agentColumn = document.querySelector<HTMLElement>(
      '.workspace-dock__column[data-column-index="1"]'
    );
    const agentSurface = screen.getByLabelText('agent panel');
    const savedBeforeFocus = readProjectLayout(PROJECT);
    expect(agentColumn).toHaveStyle({ width: '420px' });
    expect(agentSurface).toHaveStyle({ width: '420px' });

    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    expect(agentColumn).toHaveStyle({ width: '600px' });
    expect(agentSurface).toHaveStyle({ width: '600px' });

    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await act(async () => Promise.resolve());
    expect(agentColumn).toHaveStyle({ width: '420px' });
    expect(agentSurface).toHaveStyle({ width: '420px' });
    expect(readProjectLayout(PROJECT)).toEqual(savedBeforeFocus);
  });

  it('keeps a saved Preview Agent width through a Focus resize', async () => {
    const customLayout: WorkspaceLayout = {
      ...DEFAULT_LAYOUT,
      columns: DEFAULT_LAYOUT.columns.map((column) =>
        column.kind === 'panels' && column.panels.some(({ panel }) => panel === 'agent')
          ? { ...column, width: 520 }
          : column
      ),
    };
    renderFocusWorkspace('preview', customLayout);
    await act(async () => Promise.resolve());

    const agentColumn = document.querySelector<HTMLElement>(
      '.workspace-dock__column[data-column-index="1"]'
    );
    const agentSurface = screen.getByLabelText('agent panel');
    const savedBeforeFocus = readProjectLayout(PROJECT);
    expect(agentColumn).toHaveStyle({ width: '520px' });
    expect(agentSurface).toHaveStyle({ width: '520px' });

    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    const divider = screen.getByRole('separator', { name: 'Resize Agent column' });
    act(() => {
      fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600 });
      fireEvent.pointerMove(divider, { pointerId: 1, clientX: 480 });
      fireEvent.pointerUp(divider, { pointerId: 1, clientX: 480 });
    });
    measureDockedPanel('agent');
    expect(agentColumn).toHaveStyle({ width: '480px' });
    expect(agentSurface).toHaveStyle({ width: '480px' });
    expect(readProjectFocusSplitRatio(PROJECT)).toBeCloseTo(0.4);

    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await act(async () => Promise.resolve());
    expect(agentColumn).toHaveStyle({ width: '520px' });
    expect(agentSurface).toHaveStyle({ width: '520px' });
    expect(readProjectLayout(PROJECT)).toEqual(savedBeforeFocus);

    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    expect(agentColumn).toHaveStyle({ width: '480px' });
    expect(agentSurface).toHaveStyle({ width: '480px' });
    expect(readProjectLayout(PROJECT)).toEqual(savedBeforeFocus);
  });

  it('shows an initially hidden Agent only in Focus and restores its hidden state on exit', async () => {
    renderFocusWorkspace('preview', DEFAULT_LAYOUT, PROJECT, true);
    await act(async () => Promise.resolve());

    const agentSurface = screen.getByLabelText('agent panel');
    expect(agentSurface).toHaveClass('is-hidden');
    expect(agentSurface).toHaveAttribute('aria-hidden', 'true');
    expect(agentSurface).toHaveAttribute('inert');
    expect(document.querySelector('.workspace-dock__column[data-column-index="1"]')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    expect(agentSurface).not.toHaveClass('is-hidden');
    expect(agentSurface).not.toHaveAttribute('aria-hidden', 'true');
    expect(agentSurface).not.toHaveAttribute('inert');
    expect(document.querySelector('.workspace-dock__column[data-column-index="1"]')).toHaveStyle({
      width: '600px',
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await act(async () => Promise.resolve());
    expect(agentSurface).toHaveClass('is-hidden');
    expect(agentSurface).toHaveAttribute('aria-hidden', 'true');
    expect(agentSurface).toHaveAttribute('inert');
    expect(document.querySelector('.workspace-dock__column[data-column-index="1"]')).toBeNull();
  });

  it.each(['preview', 'code'] as const)(
    'starts the selected %s surface in a 50/50 Focus split',
    async (tab) => {
      renderFocusWorkspace(tab);
      if (tab === 'code') fireEvent.click(screen.getByRole('tab', { name: 'Code' }));

      fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
      await act(async () => Promise.resolve());

      expect(screen.getByTestId('selected-workspace-surface')).toHaveTextContent(tab);
      const agentColumn = document.querySelector<HTMLElement>('.workspace-dock__column');
      const previewColumn = document.querySelector<HTMLElement>('.workspace-dock__center');
      expect(agentColumn).toHaveStyle({ order: '0', width: '600px' });
      expect(previewColumn).toHaveStyle({ order: '1' });

      const divider = screen.getByRole('separator', { name: 'Resize Agent column' });
      expect(divider).toHaveAttribute('aria-valuemin', '260');
      expect(divider).toHaveAttribute('aria-valuemax', '940');
      expect(divider).toHaveAttribute('aria-valuenow', '600');
    }
  );

  it('keeps a 50/50 default beyond the normal 900px docked-column maximum', async () => {
    railWidth = 2000;
    renderFocusWorkspace('preview');
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());

    const divider = screen.getByRole('separator', { name: 'Resize Agent column' });
    expect(divider).toHaveAttribute('aria-valuemin', '260');
    expect(divider).toHaveAttribute('aria-valuemax', '1740');
    expect(divider).toHaveAttribute('aria-valuenow', '1000');
  });

  it('remembers explicit pointer resizing through exit, re-entry, and remount without changing layout', async () => {
    const { unmount } = renderFocusWorkspace('preview');
    await act(async () => Promise.resolve());
    const layoutBeforeFocus = readProjectLayout(PROJECT);

    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    const divider = screen.getByRole('separator', { name: 'Resize Agent column' });
    act(() => {
      fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600 });
      fireEvent.pointerMove(divider, { pointerId: 1, clientX: 480 });
      fireEvent.pointerUp(divider, { pointerId: 1, clientX: 480 });
    });

    expect(divider).toHaveAttribute('aria-valuenow', '480');
    expect(readProjectFocusSplitRatio(PROJECT)).toBeCloseTo(0.4);
    expect(readProjectLayout(PROJECT)).toEqual(layoutBeforeFocus);

    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole('separator', { name: 'Resize Agent column' })).toHaveAttribute(
      'aria-valuenow',
      '480'
    );

    unmount();
    renderFocusWorkspace('preview');
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole('separator', { name: 'Resize Agent column' })).toHaveAttribute(
      'aria-valuenow',
      '480'
    );
    expect(readProjectLayout(PROJECT)).toEqual(layoutBeforeFocus);
  });

  it('keeps ratios per project while switching the active workspace', async () => {
    writeProjectFocusSplitRatio(PROJECT, 0.4);
    writeProjectFocusSplitRatio(OTHER_PROJECT, 0.7);
    const { rerender } = renderFocusWorkspace('preview');
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole('separator', { name: 'Resize Agent column' })).toHaveAttribute(
      'aria-valuenow',
      '480'
    );

    rerender(<FocusWorkspace initialTab="preview" projectPath={OTHER_PROJECT} />);
    await act(async () => Promise.resolve());
    expect(screen.getByRole('separator', { name: 'Resize Agent column' })).toHaveAttribute(
      'aria-valuenow',
      '840'
    );

    rerender(<FocusWorkspace initialTab="preview" projectPath={PROJECT} />);
    await act(async () => Promise.resolve());
    expect(screen.getByRole('separator', { name: 'Resize Agent column' })).toHaveAttribute(
      'aria-valuenow',
      '480'
    );
    expect(readProjectFocusSplitRatio(PROJECT)).toBe(0.4);
    expect(readProjectFocusSplitRatio(OTHER_PROJECT)).toBe(0.7);
  });

  it('saves keyboard resizing and keeps the ratio through narrow and wide rail clamps', async () => {
    renderFocusWorkspace('preview');
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());

    const divider = screen.getByRole('separator', { name: 'Resize Agent column' });
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(divider).toHaveAttribute('aria-valuenow', '590');
    expect(readProjectFocusSplitRatio(PROJECT)).toBeCloseTo(590 / 1200);
    const layoutBeforeResize = readProjectLayout(PROJECT);

    resizeRail(400, 'observer');
    expect(divider).toHaveAttribute('aria-valuemin', '200');
    expect(divider).toHaveAttribute('aria-valuemax', '200');
    expect(divider).toHaveAttribute('aria-valuenow', '200');
    expect(readProjectFocusSplitRatio(PROJECT)).toBeCloseTo(590 / 1200);

    resizeRail(1600, 'window');
    expect(divider).toHaveAttribute('aria-valuemin', '260');
    expect(divider).toHaveAttribute('aria-valuemax', '1340');
    expect(divider).toHaveAttribute('aria-valuenow', '787');
    expect(readProjectFocusSplitRatio(PROJECT)).toBeCloseTo(590 / 1200);
    expect(readProjectLayout(PROJECT)).toEqual(layoutBeforeResize);
  });

  it.each(['navigator', 'team'] as const)(
    'keeps Focus bounds and saved ratio independent of a hidden Agent/%s stack',
    async (stackedPanel) => {
      const savedArrangement = layoutWithAgentStackedWith(stackedPanel);
      renderFocusWorkspace('preview', savedArrangement);
      const savedBeforeFocus = readProjectLayout(PROJECT);

      fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
      await act(async () => Promise.resolve());

      const divider = screen.getByRole('separator', { name: 'Resize Agent column' });
      expect(divider).toHaveAttribute('aria-valuemin', '260');
      expect(divider).toHaveAttribute('aria-valuemax', '940');
      expect(divider).toHaveAttribute('aria-valuenow', '600');

      act(() => {
        fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600 });
        fireEvent.pointerMove(divider, { pointerId: 1, clientX: 900 });
        fireEvent.pointerUp(divider, { pointerId: 1, clientX: 900 });
      });
      expect(divider).toHaveAttribute('aria-valuenow', '900');
      expect(readProjectFocusSplitRatio(PROJECT)).toBeCloseTo(0.75);
      expect(readProjectLayout(PROJECT)).toEqual(savedBeforeFocus);

      fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
      await act(async () => Promise.resolve());
      fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
      await act(async () => Promise.resolve());
      expect(screen.getByRole('separator', { name: 'Resize Agent column' })).toHaveAttribute(
        'aria-valuenow',
        '900'
      );
      expect(readProjectLayout(PROJECT)).toEqual(savedBeforeFocus);
    }
  );

  it.each(['2', '-0.2', '"0.3"', 'null', 'not-json'])(
    'falls back to 50/50 for invalid saved Focus ratio %s',
    async (storedRatio) => {
      localStorage.setItem(`shipstudio.focus.split:${PROJECT}`, storedRatio);
      renderFocusWorkspace('preview');
      fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
      await act(async () => Promise.resolve());
      expect(screen.getByRole('separator', { name: 'Resize Agent column' })).toHaveAttribute(
        'aria-valuenow',
        '600'
      );
      expect(readProjectFocusSplitRatio(PROJECT)).toBe(0.5);
    }
  );

  it('hides docked and floating auxiliary portals during Preview Focus and restores them on exit', async () => {
    renderFocusWorkspace('preview');
    await act(async () => Promise.resolve());
    const savedBeforeFocus = readProjectLayout(PROJECT);
    const panelNames: PanelId[] = ['navigator', 'editor', 'variables', 'team'];
    const surfaces = Object.fromEntries(
      panelNames.map((panel) => [panel, screen.getByLabelText(`${panel} panel`)])
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => Promise.resolve());

    expect(screen.getByTestId('selected-workspace-surface')).toHaveTextContent('preview');
    expect(document.querySelectorAll('.workspace-dock__column')).toHaveLength(1);
    expect(screen.getByLabelText('agent panel')).toHaveClass('dockable-panel__surface--docked');
    for (const surface of Object.values(surfaces)) {
      expect(surface).toHaveClass('is-hidden');
      expect(surface).toHaveAttribute('aria-hidden', 'true');
      expect(surface).toHaveAttribute('inert');
    }
    expect(surfaces.navigator).toHaveClass('dockable-panel__surface--docked');
    expect(surfaces.editor).toHaveClass('dockable-panel__surface--docked');
    expect(surfaces.variables).toHaveClass('dockable-panel__surface--floating');
    expect(surfaces.team).toHaveClass('dockable-panel__surface--floating');
    expect(readProjectLayout(PROJECT)).toEqual(savedBeforeFocus);

    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await act(async () => Promise.resolve());

    expect(screen.getByTestId('selected-workspace-surface')).toHaveTextContent('preview');
    expect(screen.getByLabelText('agent panel')).toHaveClass('dockable-panel__surface--floating');
    for (const surface of Object.values(surfaces)) {
      expect(surface).not.toHaveClass('is-hidden');
      expect(surface).not.toHaveAttribute('aria-hidden', 'true');
      expect(surface).not.toHaveAttribute('inert');
    }
    expect(readProjectLayout(PROJECT)).toEqual(savedBeforeFocus);
  });
});
