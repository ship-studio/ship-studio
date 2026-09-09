import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearProjectLayout,
  hasProjectLayout,
  readDefaultLayout,
  readProjectLayout,
  writeDefaultLayout,
  writeProjectLayout,
} from './workspaceLayoutStore';
import {
  DEFAULT_LAYOUT,
  PANEL_META,
  PREVIEW,
  dockedPanels,
  layoutsEqual,
  movePanel,
  normalizeLayout,
  setFloating,
  setPanelWidth,
} from './workspaceLayout';

const PROJECT = '/Users/dev/ShipStudio/site';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the default', () => {
  it('is the arrangement Ship Studio has always had, on a fresh install', () => {
    expect(readDefaultLayout().order).toEqual(DEFAULT_LAYOUT.order);
  });

  it('survives a round trip', () => {
    const arranged = movePanel(readDefaultLayout(), 'agent', 99);
    writeDefaultLayout(arranged);
    expect(layoutsEqual(readDefaultLayout(), arranged)).toBe(true);
  });
});

describe('a project', () => {
  it('follows the default until it is arranged itself', () => {
    expect(hasProjectLayout(PROJECT)).toBe(false);
    expect(layoutsEqual(readProjectLayout(PROJECT), readDefaultLayout())).toBe(true);
  });

  it('follows a *changed* default, rather than a copy taken when it first opened', () => {
    // The point of not writing an entry until somebody arranges the project:
    // change your default and every project you never touched moves with it.
    const changed = movePanel(readDefaultLayout(), 'agent', 99);
    writeDefaultLayout(changed);
    expect(layoutsEqual(readProjectLayout(PROJECT), changed)).toBe(true);
  });

  it('keeps its own arrangement once it has one', () => {
    const mine = setFloating(readDefaultLayout(), 'agent', true);
    writeProjectLayout(PROJECT, mine);
    writeDefaultLayout(movePanel(readDefaultLayout(), 'team', 0));

    expect(hasProjectLayout(PROJECT)).toBe(true);
    expect(layoutsEqual(readProjectLayout(PROJECT), mine)).toBe(true);
  });

  it('does not leak into another project', () => {
    writeProjectLayout(PROJECT, setFloating(readDefaultLayout(), 'agent', true));
    expect(hasProjectLayout('/Users/dev/ShipStudio/other')).toBe(false);
  });

  it('goes back to following the default when reset, not to a frozen copy of it', () => {
    writeProjectLayout(PROJECT, setPanelWidth(readDefaultLayout(), 'agent', 700));
    clearProjectLayout(PROJECT);
    expect(hasProjectLayout(PROJECT)).toBe(false);

    const laterDefault = movePanel(readDefaultLayout(), 'navigator', 0);
    writeDefaultLayout(laterDefault);
    expect(layoutsEqual(readProjectLayout(PROJECT), laterDefault)).toBe(true);
  });

  it('repairs a corrupted entry instead of failing to open the workspace', () => {
    localStorage.setItem(`shipstudio.layout.project:${PROJECT}`, '{"order":[oops');
    expect(readProjectLayout(PROJECT).order).toContain(PREVIEW);
  });
});

describe('migration from the pre-rail preferences', () => {
  it('opens on the arrangement an existing install already had', () => {
    // Agent + Navigator pinned, Variables floating, a dragged navigator width.
    localStorage.setItem('agentPanelPinned', '1');
    localStorage.setItem('elementTreePinned', '1');
    localStorage.setItem('variablesPanelPinned', '0');
    localStorage.setItem('elementTreeDockedWidth', '320');

    const migrated = readDefaultLayout();
    expect(dockedPanels(migrated)).toEqual(['agent', 'navigator']);
    expect(migrated.widths.navigator).toBe(320);
  });

  it('carries a docked Team and its width across', () => {
    localStorage.setItem('teamPanelPinned', '1');
    localStorage.setItem('shipstudio.team.panelDockedWidth', '500');

    const migrated = readDefaultLayout();
    expect(dockedPanels(migrated)).toContain('team');
    expect(migrated.widths.team).toBe(500);
  });

  it('turns the agent panel’s old split percentage into a width', () => {
    // It was the left half of a two-pane split stored as a percentage; the rail
    // stores pixels. The conversion is an estimate from the window — see the
    // note on `legacyAgentWidth` — and is clamped like any other width.
    localStorage.setItem('agentPanelDockedSplit', '40');
    expect(readDefaultLayout().widths.agent).toBe(Math.round(window.innerWidth * 0.4));
  });

  it('does not migrate a split percentage that is narrower than the panel can be', () => {
    localStorage.setItem('agentPanelDockedSplit', '2');
    expect(readDefaultLayout().widths.agent).toBe(PANEL_META.agent.minWidth);
  });

  it('runs once, so arranging your panels back is not undone on next launch', () => {
    localStorage.setItem('variablesPanelPinned', '1');
    expect(dockedPanels(readDefaultLayout())).toContain('variables');

    writeDefaultLayout(setFloating(readDefaultLayout(), 'variables', true));
    expect(dockedPanels(readDefaultLayout())).not.toContain('variables');
  });

  it('does not read the old flags for an install that already has a layout', () => {
    writeDefaultLayout(normalizeLayout({ order: DEFAULT_LAYOUT.order, floating: [] }));
    localStorage.setItem('agentPanelPinned', '0');
    expect(dockedPanels(readDefaultLayout())).toContain('agent');
  });
});

describe('when storage is unavailable', () => {
  it('still renders a layout, and a rejected write costs only the preference', () => {
    // A private window, blocked site data, or a full quota. Losing where your
    // panels are is acceptable; failing to open the workspace is not.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(readProjectLayout(PROJECT).order).toContain(PREVIEW);
    expect(() => writeProjectLayout(PROJECT, readDefaultLayout())).not.toThrow();
    expect(() => clearProjectLayout(PROJECT)).not.toThrow();
  });
});
