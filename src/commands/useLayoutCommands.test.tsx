/**
 * Arranging the workspace from the palette.
 *
 * The palette is the repo's contract for reaching a feature without hunting a
 * toolbar for it, so these check the two things that make a command real: that
 * it is *there* when it should be, and that running it does the thing.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { useLayoutCommands } from './useLayoutCommands';
import { _reset, getSnapshot } from './registry';
import { PanelDockProvider } from '../contexts/PanelDockContext';
import { PREVIEW, indexOf, isDocked, sideOf, type WorkspaceLayout } from '../lib/workspaceLayout';
import {
  hasProjectLayout,
  readLayoutScope,
  readDefaultLayout,
  readProjectLayout,
  writeProjectLayout,
} from '../lib/workspaceLayoutStore';

const PROJECT = '/Users/dev/ShipStudio/site';

beforeEach(() => {
  localStorage.clear();
  _reset();
});

function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PanelDockProvider projectPath={PROJECT}>{children}</PanelDockProvider>
  );
  const view = renderHook(() => useLayoutCommands(), { wrapper });
  return view;
}

function mountWithLayout(layout: ReturnType<typeof stackedLayout>) {
  writeProjectLayout(PROJECT, layout);
  return mount();
}

/** Every layout command currently offered inside a project. */
function offered() {
  return getSnapshot()
    .filter((command) => command.id.startsWith('layout.'))
    .filter((command) =>
      typeof command.when === 'function'
        ? command.when({ kind: 'project' } as never)
        : command.when === 'project' || command.when === undefined
    );
}

function run(id: string) {
  const command = offered().find((candidate) => candidate.id === id);
  if (!command) {
    throw new Error(
      `no layout command ${id}; have ${offered()
        .map((c) => c.id)
        .join(', ')}`
    );
  }
  act(() => void command.run());
}

function stackedLayout() {
  return {
    version: 2 as const,
    columns: [
      {
        kind: 'panels' as const,
        panels: [
          { panel: 'agent' as const, weight: 1 },
          { panel: 'navigator' as const, weight: 1 },
        ],
      },
      { kind: 'preview' as const },
      { kind: 'panels' as const, panels: [{ panel: 'editor' as const, weight: 1 }] },
      { kind: 'panels' as const, panels: [{ panel: 'variables' as const, weight: 1 }] },
      { kind: 'panels' as const, panels: [{ panel: 'team' as const, weight: 1 }] },
    ],
    floating: [],
  };
}

function panelColumn(
  panel: 'agent' | 'navigator' | 'editor' | 'variables' | 'team',
  layout: WorkspaceLayout = readProjectLayout(PROJECT)
) {
  return layout.columns.find(
    (column) =>
      column.kind === 'panels' && column.panels.some((placement) => placement.panel === panel)
  );
}

describe('what the palette offers', () => {
  it('has a dock/float and a move for every panel', () => {
    mount();
    const ids = offered().map((command) => command.id);
    for (const panel of ['agent', 'navigator', 'variables', 'editor', 'team']) {
      expect(ids).toContain(`layout.dock.${panel}`);
      expect(ids).toContain(`layout.move.${panel}`);
    }
  });

  it('has every preset', () => {
    mount();
    const ids = offered().map((command) => command.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'layout.preset.default',
        'layout.preset.focus',
        'layout.preset.design',
        'layout.preset.review',
      ])
    );
  });

  it('offers stacking only when a neighbouring column can accept it', () => {
    writeProjectLayout(PROJECT, {
      version: 2,
      columns: [
        { kind: 'panels', panels: [{ panel: 'team', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }] },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
      ],
      floating: [],
    });
    mount();
    const stack = offered().find((command) => command.id === 'layout.stack.agent');
    expect(stack?.title).toBe('Stack Agent with Team');
  });

  it('offers stack directions and new-column moves only for panels in a stack', () => {
    writeProjectLayout(PROJECT, stackedLayout());
    mount();

    const ids = offered().map((command) => command.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'layout.stack.down.agent',
        'layout.stack.up.navigator',
        'layout.column.left.navigator',
        'layout.column.right.navigator',
      ])
    );
    expect(ids).not.toContain('layout.stack.up.agent');
    expect(ids).not.toContain('layout.stack.down.navigator');
    expect(ids).not.toContain('layout.column.left.editor');
    expect(ids).not.toContain('layout.column.right.editor');
  });

  it('names what the command would do, not what the state is', () => {
    // "Float Agent panel" while it is docked. A command titled with the state
    // reads as a description and leaves you guessing what pressing it does.
    mount();
    const titles = new Map(offered().map((command) => [command.id, command.title]));
    expect(titles.get('layout.dock.agent')).toBe('Float Agent panel');
    expect(titles.get('layout.dock.team')).toBe('Dock Team panel');
  });

  it('hides save-as-default and reset until they would do something', () => {
    const view = mount();
    let ids = offered().map((command) => command.id);
    expect(ids).not.toContain('layout.saveDefault');
    expect(ids).not.toContain('layout.reset');

    run('layout.dock.agent');
    view.rerender();

    ids = offered().map((command) => command.id);
    expect(ids).toContain('layout.saveDefault');
    expect(ids).toContain('layout.reset');
  });

  it('offers exactly one scope switch for the current mode', () => {
    const view = mount();
    let commands = offered();
    expect(commands.find((command) => command.id === 'layout.scope.global')?.title).toBe(
      'Use the same panel layout across all projects'
    );
    expect(commands.map((command) => command.id)).not.toContain('layout.scope.project');

    run('layout.scope.global');
    view.rerender();
    commands = offered();
    expect(readLayoutScope()).toBe('global');
    expect(commands.map((command) => command.id)).toContain('layout.scope.project');
    expect(commands.map((command) => command.id)).not.toContain('layout.scope.global');
  });
});

describe('running one', () => {
  it('floats a docked panel and docks a floating one', () => {
    const view = mount();
    run('layout.dock.agent');
    expect(readProjectLayout(PROJECT).floating).toContain('agent');

    view.rerender();
    run('layout.dock.agent');
    expect(readProjectLayout(PROJECT).floating).not.toContain('agent');
  });

  it('moves a panel towards the preview, which is the move worth having', () => {
    // One step *across* is what changes which side you are on, and is the only
    // move somebody reaching for a command rather than a drag actually wants.
    const view = mount();
    expect(sideOf(readProjectLayout(PROJECT), 'editor')).toBe('right');

    run('layout.move.editor');
    view.rerender();
    expect(indexOf(readProjectLayout(PROJECT), 'editor')).toBeLessThan(
      indexOf(readProjectLayout(PROJECT), PREVIEW)
    );
  });

  it('moves a panel up and down within its current stack', () => {
    const view = mountWithLayout(stackedLayout());

    run('layout.stack.up.navigator');
    expect(panelColumn('navigator')).toMatchObject({
      panels: [{ panel: 'navigator' }, { panel: 'agent' }],
    });

    view.rerender();
    run('layout.stack.down.navigator');
    expect(panelColumn('navigator')).toMatchObject({
      panels: [{ panel: 'agent' }, { panel: 'navigator' }],
    });
  });

  it('moves a stacked panel into a new column on either side', () => {
    const view = mountWithLayout(stackedLayout());

    run('layout.column.left.navigator');
    const afterLeft = readProjectLayout(PROJECT);
    expect(panelColumn('navigator', afterLeft)).toMatchObject({
      panels: [{ panel: 'navigator' }],
    });
    expect(afterLeft.columns.indexOf(panelColumn('navigator', afterLeft)!)).toBeLessThan(
      afterLeft.columns.findIndex((column) => column.kind === 'preview')
    );
    expect(panelColumn('agent', afterLeft)).toMatchObject({ panels: [{ panel: 'agent' }] });

    // Rebuild the stacked fixture so the right-column command is tested from
    // the same source shape rather than depending on the first move's result.
    writeProjectLayout(PROJECT, stackedLayout());
    view.unmount();
    mount();
    run('layout.column.right.agent');
    const afterRight = readProjectLayout(PROJECT);
    expect(panelColumn('agent', afterRight)).toMatchObject({ panels: [{ panel: 'agent' }] });
    expect(afterRight.columns.indexOf(panelColumn('agent', afterRight)!)).toBeLessThan(
      afterRight.columns.findIndex((column) => column.kind === 'preview')
    );
    expect(panelColumn('navigator', afterRight)).toMatchObject({
      panels: [{ panel: 'navigator' }],
    });
  });

  it('applies a preset', () => {
    mount();
    run('layout.preset.design');
    const saved = readProjectLayout(PROJECT);
    expect(sideOf(saved, 'navigator')).toBe('left');
    expect(sideOf(saved, 'editor')).toBe('right');
    expect(isDocked(saved, 'navigator')).toBe(true);
  });

  it('saves the arrangement as the default, and resets back to following it', () => {
    const view = mount();
    run('layout.preset.focus');
    view.rerender();

    run('layout.saveDefault');
    expect(readDefaultLayout().floating).toEqual(
      expect.arrayContaining(['navigator', 'pages', 'variables', 'editor', 'team'])
    );

    view.rerender();
    run('layout.reset');
    expect(hasProjectLayout(PROJECT)).toBe(false);
  });
});
