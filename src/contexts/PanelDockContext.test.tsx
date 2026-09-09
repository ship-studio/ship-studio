/**
 * The rail's orchestration: what a change does, and what it writes.
 *
 * `workspaceLayout.test.ts` proves the moves are correct as functions and
 * `workspaceLayoutStore.test.ts` proves persistence round-trips. What is left —
 * and what these cover — is the part between them: that every mutator writes,
 * that "save as default" and "reset" mean what the menu says they mean, and
 * that switching projects picks up the other project's arrangement without
 * rendering a frame of the previous one's.
 */

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
  PANEL_META,
  PREVIEW,
  dockedPanels,
  isDocked,
  sideOf,
} from '../lib/workspaceLayout';
import {
  hasProjectLayout,
  readDefaultLayout,
  readProjectLayout,
  writeDefaultLayout,
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

describe('changing the arrangement', () => {
  it('writes on every change — arranging a project is what gives it one', () => {
    // There is no separate save. The alternative is a drag that the next
    // launch undoes.
    const { result } = dockOf();
    expect(hasProjectLayout(A)).toBe(false);

    act(() => result.current.setDocked('agent', false));

    expect(hasProjectLayout(A)).toBe(true);
    expect(readProjectLayout(A).floating).toContain('agent');
    expect(result.current.isCustomised).toBe(true);
  });

  it('moves a panel one slot at a time', () => {
    const { result } = dockOf();
    const before = result.current.layout.order.indexOf('agent');

    act(() => result.current.nudge('agent', 1));

    expect(result.current.layout.order.indexOf('agent')).toBe(before + 1);
    expect(readProjectLayout(A).order.indexOf('agent')).toBe(before + 1);
  });

  it('records a width', () => {
    const { result } = dockOf();
    act(() => result.current.setWidth('agent', 500));
    expect(readProjectLayout(A).widths.agent).toBe(500);
  });

  it('does not write when a change would change nothing', () => {
    // Re-docking an already-docked panel must not silently make a project
    // "customised", which would make Reset appear for something nobody did.
    const { result } = dockOf();
    act(() => result.current.setDocked('agent', true));
    expect(hasProjectLayout(A)).toBe(false);
    expect(result.current.isCustomised).toBe(false);
  });
});

describe('presets', () => {
  it('applies one as an ordinary layout you can then change', () => {
    const design = LAYOUT_PRESETS.find((preset) => preset.id === 'design')!;
    const { result } = dockOf();

    act(() => result.current.applyPreset(design));
    expect(sideOf(result.current.layout, 'navigator')).toBe('left');
    expect(sideOf(result.current.layout, 'editor')).toBe('right');

    // Nothing is "in" a preset: the next move is just a move.
    act(() => result.current.setDocked('team', true));
    expect(dockedPanels(result.current.layout)).toContain('team');
  });
});

describe('the default', () => {
  it('save-as-default is offered only when there is something to save', () => {
    const { result } = dockOf();
    expect(result.current.differsFromDefault).toBe(false);

    act(() => result.current.nudge('agent', 1));
    expect(result.current.differsFromDefault).toBe(true);

    act(() => result.current.saveAsDefault());
    expect(result.current.differsFromDefault).toBe(false);
    expect(readDefaultLayout().order).toEqual(result.current.layout.order);
  });

  it('reset gives the project back to the default rather than freezing a copy', () => {
    const { result } = dockOf();
    act(() => result.current.setDocked('agent', false));
    expect(hasProjectLayout(A)).toBe(true);

    act(() => result.current.resetToDefault());

    expect(hasProjectLayout(A)).toBe(false);
    expect(result.current.isCustomised).toBe(false);
    expect(isDocked(result.current.layout, 'agent')).toBe(true);
  });

  it('a saved default reaches a project that was never arranged', () => {
    writeDefaultLayout({
      order: ['agent', PREVIEW, 'team', 'navigator', 'variables', 'editor'],
      floating: [],
      widths: {},
    });
    const { result } = dockOf(B);
    expect(sideOf(result.current.layout, 'team')).toBe('right');
    expect(hasProjectLayout(B)).toBe(false);
  });
});

describe('switching projects', () => {
  it('picks up the other project’s arrangement, without a frame of the first', () => {
    // Adjust-state-during-render rather than an effect. An effect renders one
    // frame of the previous project's layout first, which is a visible flash
    // of the wrong workspace.
    writeProjectLayout(B, {
      order: [PREVIEW, 'agent', 'team', 'navigator', 'variables', 'editor'],
      floating: ['team'],
      widths: {},
    });

    const seen: string[][] = [];
    function Probe() {
      const { layout } = usePanelDock();
      seen.push([...layout.order]);
      return null;
    }
    const { rerender } = render(
      <PanelDockProvider projectPath={A}>
        <Probe />
      </PanelDockProvider>
    );
    const rendersForA = seen.length;

    rerender(
      <PanelDockProvider projectPath={B}>
        <Probe />
      </PanelDockProvider>
    );

    expect(seen[seen.length - 1][0]).toBe(PREVIEW);
    // Every render after the switch already shows B; none shows A's order.
    for (const order of seen.slice(rendersForA)) expect(order[0]).toBe(PREVIEW);
  });

  it('does not carry one project’s customised flag into another', () => {
    writeProjectLayout(A, { order: [PREVIEW, 'agent'], floating: [], widths: {} });
    function Probe() {
      const { isCustomised } = usePanelDock();
      return <span data-testid="flag">{String(isCustomised)}</span>;
    }
    const { rerender } = render(
      <PanelDockProvider projectPath={A}>
        <Probe />
      </PanelDockProvider>
    );
    expect(screen.getByTestId('flag')).toHaveTextContent('true');

    rerender(
      <PanelDockProvider projectPath={B}>
        <Probe />
      </PanelDockProvider>
    );
    expect(screen.getByTestId('flag')).toHaveTextContent('false');
  });
});

describe('presence', () => {
  it('a panel claims a column while it is open and gives it back when it closes', () => {
    // What stops a docked panel that is closed leaving an empty band of
    // workspace behind it.
    function Panel({ visible }: { visible: boolean }) {
      const dock = usePanelDockBinding('team');
      const setPresent = dock?.setPresent;
      // Mirrors what `DockablePanel` does with its `visible` prop.
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
    return Promise.resolve().then(() => {
      expect(screen.getByTestId('present')).toHaveTextContent('team');
      act(() => {
        rerender(
          <PanelDockProvider projectPath={A}>
            <Panel visible={false} />
            <Probe />
          </PanelDockProvider>
        );
      });
      return Promise.resolve().then(() => {
        expect(screen.getByTestId('present')).not.toHaveTextContent('team');
      });
    });
  });
});

describe('a panel with no rail', () => {
  it('gets no binding at all, so the primitive behaves as it always did', () => {
    // `DockablePanel` is also the colour picker's and other floating tools'
    // — they have no place in a workspace rail and must not acquire one.
    const { result } = renderHook(() => usePanelDockBinding('team'));
    expect(result.current).toBeUndefined();
  });

  it('is a wiring mistake for a workspace panel, and says so', () => {
    expect(() => renderHook(() => usePanelDock())).toThrow(/PanelDockProvider/);
  });
});

describe('width bounds', () => {
  it('clamps a width the panel cannot be used at', () => {
    const { result } = dockOf();
    act(() => result.current.setWidth('navigator', 5000));
    expect(result.current.layout.widths.navigator).toBe(PANEL_META.navigator.maxWidth);
    act(() => result.current.setWidth('navigator', 1));
    expect(result.current.layout.widths.navigator).toBe(PANEL_META.navigator.minWidth);
  });
});
