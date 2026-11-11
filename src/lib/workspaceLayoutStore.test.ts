import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearProjectLayout,
  hasProjectLayout,
  readLayoutScope,
  readDefaultLayout,
  readProjectLayout,
  writeDefaultLayout,
  writeLayoutScope,
  writeProjectLayout,
} from './workspaceLayoutStore';
import {
  DEFAULT_LAYOUT,
  PANEL_META,
  PREVIEW,
  dockedPanels,
  layoutsEqual,
  normalizeLayout,
  setFloating,
  stackPanel,
  widthOf,
} from './workspaceLayout';

const PROJECT = '/Users/dev/ShipStudio/site';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the default', () => {
  it('is a v2 layout on a fresh install', () => {
    const result = readDefaultLayout();
    expect(result.version).toBe(2);
    expect(result.columns.some((column) => column.kind === 'preview')).toBe(true);
  });

  it('survives a round trip including stacked weights', () => {
    const arranged = stackPanel(readDefaultLayout(), 'agent', 'navigator', 'after');
    writeDefaultLayout(arranged);
    expect(layoutsEqual(readDefaultLayout(), arranged)).toBe(true);
  });

  it('normalizes and writes a legacy flat default as v2 on first read', () => {
    localStorage.setItem(
      'shipstudio.layout.default',
      JSON.stringify({
        order: ['agent', PREVIEW, 'editor'],
        floating: ['editor'],
        widths: { agent: 500 },
      })
    );
    const migrated = readDefaultLayout();
    expect(migrated.version).toBe(2);
    expect(widthOf(migrated, 'agent')).toBe(500);
    expect(
      JSON.parse(localStorage.getItem('shipstudio.layout.default')!) as { version: number }
    ).toHaveProperty('version', 2);
  });
});

describe('the persistence scope preference', () => {
  it('defaults to project scope and accepts only the two known values', () => {
    expect(readLayoutScope()).toBe('project');
    localStorage.setItem('shipstudio.layout.scope', 'global');
    expect(readLayoutScope()).toBe('global');
    localStorage.setItem('shipstudio.layout.scope', 'unexpected');
    expect(readLayoutScope()).toBe('project');
  });

  it('guards preference reads and writes when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(readLayoutScope()).toBe('project');
    expect(() => writeLayoutScope('global')).not.toThrow();
  });
});

describe('a project', () => {
  it('follows the default until it is arranged itself', () => {
    expect(hasProjectLayout(PROJECT)).toBe(false);
    expect(layoutsEqual(readProjectLayout(PROJECT), readDefaultLayout())).toBe(true);
  });

  it('follows a changed default rather than a copy taken when it first opened', () => {
    const changed = setFloating(readDefaultLayout(), 'agent', true);
    writeDefaultLayout(changed);
    expect(layoutsEqual(readProjectLayout(PROJECT), changed)).toBe(true);
  });

  it('keeps its own arrangement once it has one', () => {
    const mine = setFloating(readDefaultLayout(), 'agent', true);
    writeProjectLayout(PROJECT, mine);
    writeDefaultLayout(setFloating(readDefaultLayout(), 'team', true));

    expect(hasProjectLayout(PROJECT)).toBe(true);
    expect(layoutsEqual(readProjectLayout(PROJECT), mine)).toBe(true);
  });

  it('does not leak into another project', () => {
    writeProjectLayout(PROJECT, setFloating(readDefaultLayout(), 'agent', true));
    expect(hasProjectLayout('/Users/dev/ShipStudio/other')).toBe(false);
  });

  it('goes back to following the default when reset', () => {
    writeProjectLayout(PROJECT, setFloating(readDefaultLayout(), 'agent', true));
    clearProjectLayout(PROJECT);
    expect(hasProjectLayout(PROJECT)).toBe(false);

    const laterDefault = setFloating(readDefaultLayout(), 'navigator', true);
    writeDefaultLayout(laterDefault);
    expect(layoutsEqual(readProjectLayout(PROJECT), laterDefault)).toBe(true);
  });

  it('migrates a legacy project entry and writes back canonical v2', () => {
    localStorage.setItem(
      `shipstudio.layout.project:${PROJECT}`,
      JSON.stringify({ order: ['agent', PREVIEW], floating: [], widths: {} })
    );
    const migrated = readProjectLayout(PROJECT);
    expect(migrated.version).toBe(2);
    expect(
      JSON.parse(localStorage.getItem(`shipstudio.layout.project:${PROJECT}`)!) as {
        version: number;
      }
    ).toHaveProperty('version', 2);
    expect(migrated.columns.filter((column) => column.kind === 'preview')).toHaveLength(1);
  });

  it('repairs a corrupted entry instead of failing to open the workspace', () => {
    localStorage.setItem(`shipstudio.layout.project:${PROJECT}`, '{"columns":[oops');
    expect(readProjectLayout(PROJECT).columns.some((column) => column.kind === 'preview')).toBe(
      true
    );
  });
});

describe('migration from the pre-rail preferences', () => {
  it('opens on the arrangement an existing install already had', () => {
    localStorage.setItem('agentPanelPinned', '1');
    localStorage.setItem('elementTreePinned', '1');
    localStorage.setItem('variablesPanelPinned', '0');
    localStorage.setItem('elementTreeDockedWidth', '320');

    const migrated = readDefaultLayout();
    expect(dockedPanels(migrated)).toEqual(['assets', 'agent', 'navigator']);
    expect(widthOf(migrated, 'navigator')).toBe(320);
  });

  it('carries a docked Team and its width across', () => {
    localStorage.setItem('teamPanelPinned', '1');
    localStorage.setItem('shipstudio.team.panelDockedWidth', '500');

    const migrated = readDefaultLayout();
    expect(dockedPanels(migrated)).toContain('team');
    expect(widthOf(migrated, 'team')).toBe(500);
  });

  it('turns the agent panel old split percentage into a clamped width', () => {
    localStorage.setItem('agentPanelDockedSplit', '2');
    expect(widthOf(readDefaultLayout(), 'agent')).toBe(PANEL_META.agent.minWidth);
  });

  it('runs once, so arranging panels back is not undone on next launch', () => {
    localStorage.setItem('variablesPanelPinned', '1');
    expect(dockedPanels(readDefaultLayout())).toContain('variables');

    writeDefaultLayout(setFloating(readDefaultLayout(), 'variables', true));
    expect(dockedPanels(readDefaultLayout())).not.toContain('variables');
  });

  it('does not read old flags for an install that already has a layout', () => {
    writeDefaultLayout(normalizeLayout(DEFAULT_LAYOUT));
    localStorage.setItem('agentPanelPinned', '0');
    expect(dockedPanels(readDefaultLayout())).toContain('agent');
  });
});

describe('when storage is unavailable', () => {
  it('still renders a layout, and a rejected write costs only the preference', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(readProjectLayout(PROJECT).columns.some((column) => column.kind === 'preview')).toBe(
      true
    );
    expect(() => writeProjectLayout(PROJECT, readDefaultLayout())).not.toThrow();
    expect(() => clearProjectLayout(PROJECT)).not.toThrow();
  });
});
