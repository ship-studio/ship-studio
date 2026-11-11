import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PanelDockProvider,
  usePanelDock,
  usePanelDockBinding,
  usePresentPanels,
} from './PanelDockContext';
import {
  LAYOUT_PRESETS,
  PREVIEW,
  isFloating,
  layoutsEqual,
  setFloating,
  type WorkspaceLayout,
} from '../lib/workspaceLayout';
import {
  hasProjectLayout,
  readDefaultLayout,
  readLayoutScope,
  readProjectLayout,
  writeProjectLayout,
} from '../lib/workspaceLayoutStore';

const A = '/Users/dev/ShipStudio/alpha';
const B = '/Users/dev/ShipStudio/beta';

beforeEach(() => localStorage.clear());

function dockOf(projectPath = A) {
  return renderHook(() => usePanelDock(), {
    wrapper: ({ children }) => (
      <PanelDockProvider projectPath={projectPath}>{children}</PanelDockProvider>
    ),
  });
}

const stackedLayout: WorkspaceLayout = {
  version: 2,
  columns: [
    {
      kind: 'panels',
      panels: [
        { panel: 'agent', weight: 0.5 },
        { panel: 'navigator', weight: 0.5 },
      ],
    },
    { kind: 'preview' },
    { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'team', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'assets', weight: 1 }] },
  ],
  floating: [],
};

describe('structural moves', () => {
  it('preserves singleton column widths through the legacy order projection', () => {
    writeProjectLayout(A, {
      version: 2,
      columns: [
        { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }], width: 500 },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }], width: 350 },
        { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'team', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'assets', weight: 1 }] },
      ],
      floating: [],
    });
    const { result } = dockOf();
    act(() =>
      result.current.setOrder([
        'editor',
        PREVIEW,
        'agent',
        'navigator',
        'variables',
        'team',
        'assets',
      ])
    );
    const columns = result.current.layout.columns.filter((column) => column.kind === 'panels');
    const widthOf = (panel: string) =>
      columns.find((column) => column.panels[0].panel === panel)?.width;
    expect(widthOf('agent')).toBe(500);
    expect(widthOf('editor')).toBe(350);
  });

  it('writes stack and column changes immediately', () => {
    const { result } = dockOf();
    act(() => result.current.stackPanel('navigator', 0, 0));
    expect(result.current.layout.columns[0]).toMatchObject({
      panels: [{ panel: 'navigator' }, { panel: 'assets' }],
    });
    expect(readProjectLayout(A).columns[0]).toMatchObject({
      panels: [{ panel: 'navigator' }, { panel: 'assets' }],
    });
  });

  it('changes adjacent weights without changing the other columns', () => {
    writeProjectLayout(A, stackedLayout);
    const { result } = dockOf();
    act(() => result.current.setPanelWeights(0, { agent: 0.75, navigator: 0.25 }));
    const column = result.current.layout.columns[0];
    expect(column).toMatchObject({ kind: 'panels' });
    if (column.kind === 'panels') {
      expect(column.panels[0].weight).toBeCloseTo(0.75);
      expect(column.panels[1].weight).toBeCloseTo(0.25);
    }
  });

  it('moves a member to a singleton column and floats reversibly', () => {
    writeProjectLayout(A, stackedLayout);
    const { result } = dockOf();
    act(() => result.current.movePanelToColumnGap('navigator', 1));
    expect(result.current.layout.columns[0]).toMatchObject({ panels: [{ panel: 'agent' }] });
    expect(result.current.layout.columns[1]).toMatchObject({ panels: [{ panel: 'navigator' }] });
    act(() => result.current.setFloating('navigator', true));
    expect(isFloating(result.current.layout, 'navigator')).toBe(true);
    expect(result.current.layout.columns[1]).toMatchObject({ panels: [{ panel: 'navigator' }] });
  });
});

describe('persistence and presets', () => {
  it('applies a preset as an ordinary v2 layout', () => {
    const { result } = dockOf();
    const preset = LAYOUT_PRESETS.find((item) => item.id === 'stacked')!;
    act(() => result.current.applyPreset(preset));
    expect(result.current.layout.version).toBe(2);
    expect(
      result.current.layout.columns.some(
        (column) => column.kind === 'panels' && column.panels.length > 1
      )
    ).toBe(true);
  });

  it('save-as-default and reset keep the project following the saved default', () => {
    const { result } = dockOf();
    act(() => result.current.setFloating('agent', true));
    expect(hasProjectLayout(A)).toBe(true);
    act(() => result.current.saveAsDefault());
    act(() => result.current.resetToDefault());
    expect(hasProjectLayout(A)).toBe(false);
    expect(isFloating(result.current.layout, 'agent')).toBe(true);
  });

  it('switches projects without exposing the prior structure', () => {
    writeProjectLayout(B, {
      ...stackedLayout,
      columns: [
        { kind: 'preview' },
        ...stackedLayout.columns.filter((column) => column.kind !== 'preview'),
      ],
    });
    const seen: WorkspaceLayout[] = [];
    function Probe() {
      seen.push(usePanelDock().layout);
      return null;
    }
    const { rerender } = render(
      <PanelDockProvider projectPath={A}>
        <Probe />
      </PanelDockProvider>
    );
    const previous = seen.length;
    rerender(
      <PanelDockProvider projectPath={B}>
        <Probe />
      </PanelDockProvider>
    );
    expect(seen[seen.length - 1].columns[0].kind).toBe('preview');
    expect(seen.slice(previous).every((layout) => layout.columns[0].kind === 'preview')).toBe(true);
  });

  it('promotes the visible project layout when entering global scope and restores it', () => {
    const staleDefault = setFloating(readDefaultLayout(), 'team', true);
    const visible = setFloating(readDefaultLayout(), 'agent', true);
    writeProjectLayout(A, visible);
    // The default is intentionally different from the project's visible entry.
    localStorage.setItem('shipstudio.layout.default', JSON.stringify(staleDefault));

    const { result } = dockOf();
    expect(result.current.layoutScope).toBe('project');
    expect(layoutsEqual(result.current.layout, visible)).toBe(true);

    act(() => result.current.setLayoutScope('global'));
    expect(result.current.layoutScope).toBe('global');
    expect(layoutsEqual(result.current.layout, visible)).toBe(true);
    expect(layoutsEqual(readDefaultLayout(), visible)).toBe(true);
    expect(hasProjectLayout(A)).toBe(true);
    expect(result.current.isCustomised).toBe(false);
    expect(result.current.differsFromDefault).toBe(false);

    act(() => result.current.setLayoutScope('project'));
    expect(result.current.layoutScope).toBe('project');
    expect(layoutsEqual(result.current.layout, visible)).toBe(true);
    expect(layoutsEqual(readProjectLayout(A), visible)).toBe(true);
    expect(readLayoutScope()).toBe('project');
  });

  it('writes global mutations to the shared default and shares them with other projects', () => {
    localStorage.setItem('shipstudio.layout.scope', 'global');
    const first = dockOf(A);
    act(() => first.result.current.setFloating('agent', true));
    expect(first.result.current.layoutScope).toBe('global');
    expect(first.result.current.isCustomised).toBe(false);
    expect(first.result.current.differsFromDefault).toBe(false);
    expect(hasProjectLayout(A)).toBe(false);
    expect(readDefaultLayout().floating).toContain('agent');

    const second = dockOf(B);
    expect(layoutsEqual(second.result.current.layout, first.result.current.layout)).toBe(true);
    first.unmount();
    second.unmount();
  });
});

describe('presence and bindings', () => {
  it('claims and releases a panel slot', async () => {
    function Panel({ visible }: { visible: boolean }) {
      const dock = usePanelDockBinding('team');
      const setPresent = dock?.setPresent;
      if (setPresent) queueMicrotask(() => setPresent(visible));
      return null;
    }
    function Probe() {
      return <span data-testid="present">{usePresentPanels().join(',')}</span>;
    }
    const { rerender } = render(
      <PanelDockProvider projectPath={A}>
        <Panel visible />
        <Probe />
      </PanelDockProvider>
    );
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('present')).toHaveTextContent('team');
    rerender(
      <PanelDockProvider projectPath={A}>
        <Panel visible={false} />
        <Probe />
      </PanelDockProvider>
    );
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('present')).not.toHaveTextContent('team');
  });

  it('throws outside a provider but leaves optional bindings absent', () => {
    expect(() => renderHook(() => usePanelDock())).toThrow(/PanelDockProvider/);
    const { result } = renderHook(() => usePanelDockBinding('team'));
    expect(result.current).toBeUndefined();
  });
});
