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
import { PREVIEW, isDocked, sideOf } from '../lib/workspaceLayout';
import {
  hasProjectLayout,
  readDefaultLayout,
  readProjectLayout,
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
    expect(readProjectLayout(PROJECT).order.indexOf('editor')).toBeLessThan(
      readProjectLayout(PROJECT).order.indexOf(PREVIEW)
    );
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
      expect.arrayContaining(['navigator', 'variables', 'editor', 'team'])
    );

    view.rerender();
    run('layout.reset');
    expect(hasProjectLayout(PROJECT)).toBe(false);
  });
});
