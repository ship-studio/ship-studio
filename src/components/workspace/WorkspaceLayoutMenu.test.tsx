/**
 * The Layout menu — the half of this feature that is not a drag.
 *
 * A drag is the fast way to move a panel and must never be the only way, so
 * everything the pointer can do is here as a control with a name: which side
 * each panel is on, docked or floating, one step either way. Plus the two
 * things a drag cannot express at all.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLayoutMenu } from './WorkspaceLayoutMenu';
import {
  WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY,
  setWorkspaceLayoutMenuImplementation,
} from './WorkspaceLayoutMenuMode';
import { PanelDockProvider } from '../../contexts/PanelDockContext';
import { DEFAULT_LAYOUT, LAYOUT_PRESETS, PREVIEW } from '../../lib/workspaceLayout';
import {
  hasProjectLayout,
  readLayoutScope,
  readDefaultLayout,
  readProjectLayout,
  writeProjectLayout,
} from '../../lib/workspaceLayoutStore';

const PROJECT = '/Users/dev/ShipStudio/site';

function readOrder(layout: unknown): string[] {
  if (!layout || typeof layout !== 'object') return [];
  const value = layout as { order?: unknown; columns?: unknown };
  if (Array.isArray(value.order))
    return value.order.filter((item): item is string => typeof item === 'string');
  if (!Array.isArray(value.columns)) return [];
  return value.columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const entry = column as { kind?: unknown; panels?: unknown };
    if (entry.kind === 'preview') return [PREVIEW];
    if (!Array.isArray(entry.panels)) return [];
    return entry.panels.flatMap((placement) => {
      const panel =
        typeof placement === 'string'
          ? placement
          : placement && typeof placement === 'object'
            ? (placement as { panel?: unknown }).panel
            : undefined;
      return typeof panel === 'string' ? [panel] : [];
    });
  });
}

beforeEach(() => {
  localStorage.clear();
  // The historical assertions below deliberately exercise the preserved
  // implementation. New-editor coverage lives in the final describe block.
  localStorage.setItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY, 'legacy');
});

async function openMenu(layout?: unknown) {
  if (layout && typeof layout === 'object') {
    const complete = { ...layout } as {
      order?: unknown[];
      columns?: unknown[];
      floating?: string[];
      [key: string]: unknown;
    };
    if (Array.isArray(complete.order)) complete.order = [...complete.order];
    if (Array.isArray(complete.columns)) complete.columns = [...complete.columns];
    if (Array.isArray(complete.order) && !complete.order.includes('assets')) {
      const previewIndex = complete.order.indexOf(PREVIEW);
      const insertAt = previewIndex >= 0 ? previewIndex + 1 : 0;
      complete.order.splice(insertAt, 0, 'assets');
    } else if (Array.isArray(complete.columns)) {
      const hasAssets = complete.columns.some(
        (column) =>
          column &&
          typeof column === 'object' &&
          'panels' in column &&
          Array.isArray((column as { panels?: unknown[] }).panels) &&
          (column as { panels: { panel?: unknown }[] }).panels.some(
            (item) => item.panel === 'assets'
          )
      );
      if (!hasAssets) {
        complete.columns.push({ kind: 'panels', panels: [{ panel: 'assets', weight: 1 }] });
      }
    }
    writeProjectLayout(PROJECT, complete as never);
  }
  const user = userEvent.setup();
  render(
    <PanelDockProvider projectPath={PROJECT}>
      <WorkspaceLayoutMenu />
    </PanelDockProvider>
  );
  await user.click(screen.getByRole('button', { name: 'Panel layout' }));
  return user;
}

/** The row for one panel, so its controls can be reached by name. */
function row(label: string) {
  return screen.getByText(label).closest('.workspace-layout-menu__row') as HTMLElement;
}

function pointer(type: string, x: number, y: number, pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

function mockMenuRects() {
  const items = [...document.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
  items.forEach((item, index) => {
    Object.defineProperty(item, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: index * 30,
        right: 280,
        bottom: index * 30 + 20,
        width: 280,
        height: 20,
      }),
    });
  });
}

function activateDrag(source: HTMLElement) {
  const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
  fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
  fireEvent(window, pointer('pointermove', sourceRect.left + 10, sourceRect.top + 70));
  mockMenuRects();
}

describe('the menu', () => {
  it('uses the quiet ghost treatment for the panel layout trigger', () => {
    render(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceLayoutMenu />
      </PanelDockProvider>
    );

    expect(screen.getByRole('button', { name: 'Panel layout' })).toHaveClass('button--ghost');
  });

  it('uses the standard right-side chevron treatment', () => {
    render(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceLayoutMenu />
      </PanelDockProvider>
    );

    const trigger = screen.getByRole('button', { name: 'Panel layout' });
    expect(trigger.querySelector('[data-icon-name="ChevronIcon"]')).toHaveAttribute('width', '14');
  });

  it('uses the default button treatment for every starting point', async () => {
    await openMenu();

    expect(screen.getByText('Panel Layout')).toHaveClass('workspace-layout-menu__title');
    for (const preset of LAYOUT_PRESETS) {
      expect(screen.getByRole('button', { name: preset.label })).toHaveClass('button--default');
    }
  });

  it('says where every panel currently is', async () => {
    await openMenu({
      order: ['agent', PREVIEW, 'editor', 'team', 'navigator', 'variables'],
      floating: ['team'],
      widths: {},
    });

    expect(within(row('Agent')).getByText('Left')).toBeInTheDocument();
    expect(within(row('Edit')).getByText('Right')).toBeInTheDocument();
    expect(within(row('Team')).getByText('Floating')).toBeInTheDocument();
  });

  it('keeps the drag handle as the leading row control', async () => {
    await openMenu();

    const agentRow = row('Agent');
    const handle = within(agentRow).getByRole('button', { name: 'Move Agent panel' });
    expect(agentRow.firstElementChild).toBe(handle);
    expect(handle.parentElement).toBe(agentRow);

    handle.focus();
    expect(handle).toHaveFocus();
    expect(agentRow).toContainElement(document.activeElement as HTMLElement);
  });

  it('uses Preview as the single left/right structural boundary', async () => {
    await openMenu({
      order: ['agent', 'navigator', PREVIEW, 'editor', 'team', 'variables'],
      floating: [],
      widths: {},
    });

    const previewRow = row('Preview');
    const rightPanel = row('Edit');
    expect(previewRow).toHaveClass('is-boundary');
    expect(
      previewRow.compareDocumentPosition(rightPanel) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(rightPanel.previousElementSibling).not.toHaveClass('ss-dropdown__divider');
    expect(screen.queryByText('Canvas')).not.toBeInTheDocument();
  });

  it('moves a panel across the preview a step at a time', async () => {
    const user = await openMenu({
      order: ['agent', PREVIEW, 'editor', 'team', 'navigator', 'variables'],
      floating: [],
      widths: {},
    });

    await user.click(within(row('Agent')).getByRole('button', { name: 'Move Agent right' }));

    expect(within(row('Agent')).getByText('Right')).toBeInTheDocument();
    const saved = readOrder(readProjectLayout(PROJECT));
    expect(saved.indexOf('agent')).toBeGreaterThan(saved.indexOf(PREVIEW));
  });

  it('will not move a panel off either end', async () => {
    await openMenu({
      order: ['agent', PREVIEW, 'editor', 'team', 'navigator', 'variables'],
      floating: [],
      widths: {},
    });
    expect(within(row('Agent')).getByRole('button', { name: 'Move Agent left' })).toBeDisabled();
    expect(
      within(row('Variables')).getByRole('button', { name: 'Move Variables right' })
    ).toBeDisabled();
  });

  it('floats and re-docks a panel, and the pin says which it is', async () => {
    const user = await openMenu({
      order: ['agent', 'navigator', PREVIEW, 'editor', 'team', 'variables'],
      floating: [],
      widths: {},
    });

    const float = within(row('Elements')).getByRole('button', { name: 'Float Elements' });
    expect(float.parentElement).toHaveClass('workspace-layout-menu__heading');
    expect(float.parentElement?.firstElementChild).toBe(float);
    expect(float.parentElement).toContainElement(screen.getByText('Elements'));
    expect(float).toHaveAttribute('aria-pressed', 'true');
    await user.click(float);

    expect(readProjectLayout(PROJECT).floating).toContain('navigator');
    const dock = within(row('Elements')).getByRole('button', { name: 'Dock Elements' });
    expect(dock).toHaveAttribute('aria-pressed', 'false');

    await user.click(dock);
    expect(readProjectLayout(PROJECT).floating).not.toContain('navigator');
    // Back where it was, not at an end.
    expect(readOrder(readProjectLayout(PROJECT))[1]).toBe('navigator');
  });

  it('applies a preset as an ordinary layout', async () => {
    const user = await openMenu();
    await user.click(screen.getByRole('button', { name: 'Focus' }));

    const saved = readProjectLayout(PROJECT);
    expect(saved.floating).toEqual(
      expect.arrayContaining(['navigator', 'variables', 'editor', 'team'])
    );
    expect(saved.floating).not.toContain('agent');
  });

  it('sorts around the locked Preview separator and keeps the menu open', async () => {
    await openMenu();
    vi.useFakeTimers();
    try {
      mockMenuRects();
      const handle = within(row('Agent')).getByRole('button', { name: 'Move Agent panel' });
      fireEvent(handle, pointer('pointerdown', 10, 40));
      fireEvent(window, pointer('pointermove', 10, 200));
      fireEvent(window, pointer('pointerup', 10, 200));
      await act(() => vi.advanceTimersByTime(250));

      expect(readOrder(readProjectLayout(PROJECT))).toEqual([
        'assets',
        'team',
        'variables',
        'navigator',
        PREVIEW,
        'editor',
        'agent',
      ]);
      const agentRow = document.querySelector('[data-drag-sort-id="agent"]') as HTMLElement;
      expect(within(agentRow).getByText('Right')).toBeInTheDocument();
      expect(screen.getByRole('menu')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a full-row portal overlay that follows the pointer', async () => {
    await openMenu();
    vi.useFakeTimers();
    try {
      mockMenuRects();
      const agentRow = row('Agent');
      const handle = within(agentRow).getByRole('button', { name: 'Move Agent panel' });
      fireEvent(handle, pointer('pointerdown', 10, 40));
      fireEvent(window, pointer('pointermove', 20, 140));

      const overlay = document.querySelector('[data-drag-sort-overlay="true"]') as HTMLElement;
      expect(overlay).toBeInTheDocument();
      expect(overlay.querySelector('[data-drag-sort-overlay-content="true"]')).toBeInTheDocument();
      expect(within(overlay).getByText('Agent')).toBeInTheDocument();
      expect(overlay.querySelectorAll('button')).toHaveLength(0);
      expect(overlay.style.getPropertyValue('--drag-sort-overlay-width')).toBe('280px');
      expect(overlay.style.getPropertyValue('--drag-sort-overlay-height')).toBe('20px');
      expect(overlay.style.getPropertyValue('--drag-sort-overlay-y')).toBe('160px');
      expect(agentRow).toHaveClass('is-dragging');
      expect(agentRow).toHaveAttribute('data-drag-sort-has-overlay', 'true');

      fireEvent(window, pointer('pointermove', 20, 40));
      expect(document.querySelector('[data-drag-sort-overlay="true"]')).toBeInTheDocument();
      expect(
        (
          document.querySelector('[data-drag-sort-overlay="true"]') as HTMLElement
        ).style.getPropertyValue('--drag-sort-overlay-y')
      ).toBe('60px');

      fireEvent(window, pointer('pointercancel', 20, 140));
      await act(() => vi.advanceTimersByTime(250));
      expect(document.querySelector('[data-drag-sort-overlay="true"]')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist a cancelled or no-op drag', async () => {
    await openMenu();
    mockMenuRects();
    const handle = within(row('Agent')).getByRole('button', { name: 'Move Agent panel' });
    const before = readOrder(readProjectLayout(PROJECT));
    fireEvent(handle, pointer('pointerdown', 10, 40));
    fireEvent(window, pointer('pointermove', 10, 140));
    fireEvent(window, pointer('pointercancel', 10, 140));
    expect(readOrder(readProjectLayout(PROJECT))).toEqual(before);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent(handle, pointer('pointerdown', 10, 40, 2));
    fireEvent(window, pointer('pointermove', 10, 40, 2));
    fireEvent(window, pointer('pointerup', 10, 40, 2));
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

describe('the default', () => {
  it('offers nothing to save until something has changed', async () => {
    const user = await openMenu();
    const save = screen.getByRole('menuitem', { name: /Save as my default/ });
    expect(save).toBeDisabled();

    // The move controls are not menu items — the menu stays open, so you can
    // arrange several panels and then save, which is the actual workflow.
    await user.click(within(row('Agent')).getByRole('button', { name: 'Move Agent right' }));
    expect(screen.getByRole('menuitem', { name: /Save as my default/ })).toBeEnabled();
    await user.click(screen.getByRole('menuitem', { name: /Save as my default/ }));

    // The default now *is* this arrangement, so unarranged projects follow it.
    expect(readOrder(readDefaultLayout())).toEqual(readOrder(readProjectLayout(PROJECT)));
    expect(readOrder(readDefaultLayout())).not.toEqual(readOrder(DEFAULT_LAYOUT));
  });

  it('offers nothing to reset on a project that has no arrangement of its own', async () => {
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /Reset this project/ })).toBeDisabled();
  });

  it('resets a project back to following the default', async () => {
    const user = await openMenu({
      order: [PREVIEW, 'agent', 'navigator', 'variables', 'editor', 'team'],
      floating: [],
      widths: {},
    });
    expect(hasProjectLayout(PROJECT)).toBe(true);

    await user.click(screen.getByRole('menuitem', { name: /Reset this project/ }));

    expect(hasProjectLayout(PROJECT)).toBe(false);
  });
});

describe('the spatial implementation switch', () => {
  function stacked() {
    return {
      version: 2,
      columns: [
        {
          kind: 'panels',
          panels: [
            { panel: 'agent', weight: 1 },
            { panel: 'navigator', weight: 1 },
          ],
        },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
      ],
      floating: [],
    };
  }

  function floatingStacked() {
    return {
      version: 2,
      columns: [
        {
          kind: 'panels',
          panels: [{ panel: 'agent', weight: 1 }],
        },
        {
          kind: 'panels',
          panels: [{ panel: 'navigator', weight: 1 }],
        },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
      ],
      floating: ['agent'],
    };
  }

  function reorderableColumns() {
    return {
      version: 2,
      columns: [
        { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'team', weight: 1 }] },
      ],
      floating: [],
    };
  }

  it('uses the spatial editor by default', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu();

    expect(screen.getByText('Panel Layout')).toHaveClass('workspace-layout-menu__title');
    expect(screen.queryByText('Workspace columns')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Workspace columns' })).toBeInTheDocument();
    expect(screen.getByText('Floating')).toBeInTheDocument();
    expect(screen.getByText('Elements')).toBeInTheDocument();
  });

  it('renders a vertical outline without empty floating-only source shells', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu({
      version: 2,
      columns: [
        { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'team', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
      ],
      floating: ['agent', 'team', 'variables'],
    });

    const canvas = screen.getByRole('group', { name: 'Workspace columns' });
    expect(canvas).toHaveAttribute('data-layout-outline', 'true');
    expect(canvas.querySelectorAll('[data-layout-new-column]')).toHaveLength(0);
    expect(screen.queryByText('New left column')).not.toBeInTheDocument();
    expect(screen.queryByText('New right column')).not.toBeInTheDocument();
    expect(screen.getByText('Left')).toBeInTheDocument();
    expect(screen.getByText('Right')).toBeInTheDocument();
    expect(canvas.querySelector('[data-layout-preview-divider="true"]')).toBeInTheDocument();
    expect(canvas.querySelector('[data-model-column-index="0"]')).toBeNull();
    const cards = [...canvas.querySelectorAll<HTMLElement>('[data-layout-column-card]')];
    const saved = readProjectLayout(PROJECT);
    const expectedSourceIndexes = saved.columns.flatMap((column, index) =>
      column.kind === 'panels' &&
      !column.panels.every((placement) => saved.floating.includes(placement.panel))
        ? [String(index)]
        : []
    );
    expect(cards.map((column) => column.dataset.modelColumnIndex)).toEqual(expectedSourceIndexes);
    expect(
      [
        ...canvas.querySelectorAll(
          '[data-layout-side="left"] .workspace-layout-menu__column-label'
        ),
      ].map((label) => label.textContent)
    ).toEqual(['Column 1']);
    expect(
      [
        ...canvas.querySelectorAll(
          '[data-layout-side="right"] .workspace-layout-menu__column-label'
        ),
      ].map((label) => label.textContent)
    ).toEqual(['Column 1', 'Column 2']);
    expect(
      screen.getByText('Agent').closest('[data-drag-sort-id="workspace-layout-panel-agent"]')
    ).toHaveClass('workspace-layout-menu__tile--floating');
  });

  it('keeps the outline and Floating list in the scroll body above a fixed footer', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(stacked());

    const menu = document.querySelector('.workspace-layout-menu--spatial') as HTMLElement;
    const scrollBody = menu.querySelector('[data-layout-scroll-body="true"]') as HTMLElement;
    const footer = menu.querySelector('[data-layout-footer="true"]') as HTMLElement;
    const canvas = screen.getByRole('group', { name: 'Workspace columns' });
    const floating = screen.getByLabelText('Floating panels');

    expect(scrollBody).toContainElement(canvas);
    expect(scrollBody).toContainElement(floating);
    expect(footer).not.toContainElement(canvas);
    expect(footer).not.toContainElement(floating);
    expect(footer).toContainElement(
      screen.getByRole('menuitem', { name: 'Save as my default layout' })
    );
  });

  it('reorders whole column cards within the same side', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = screen.getByRole('menuitem', { name: 'Move Left column 1' });
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-navigator"]'
      ) as HTMLElement;
      const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      expect(readOrder(readProjectLayout(PROJECT))).toEqual([
        'navigator',
        'agent',
        PREVIEW,
        'editor',
        'variables',
        'team',
        'assets',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a whole column card across the Preview boundary', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = screen.getByRole('menuitem', { name: 'Move Left column 1' });
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-editor"]'
      ) as HTMLElement;
      const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      expect(readOrder(readProjectLayout(PROJECT))).toEqual([
        'navigator',
        PREVIEW,
        'editor',
        'agent',
        'variables',
        'team',
        'assets',
      ]);
      const movedColumn = readProjectLayout(PROJECT).columns.find(
        (column) =>
          column.kind === 'panels' && column.panels.some((placement) => placement.panel === 'agent')
      );
      expect(movedColumn?.kind === 'panels' && movedColumn.panels).toEqual([
        { panel: 'agent', weight: 1 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a whole-column drag from the card header surface', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-agent"] .workspace-layout-menu__column-label-row'
      ) as HTMLElement;
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-editor"]'
      ) as HTMLElement;
      const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      expect(readOrder(readProjectLayout(PROJECT))).toEqual([
        'navigator',
        PREVIEW,
        'editor',
        'agent',
        'variables',
        'team',
        'assets',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a whole column dropped onto the Right section header', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-agent"] .workspace-layout-menu__column-label-row'
      ) as HTMLElement;
      const target = document.querySelector('[data-layout-side-drop-zone="right"]') as HTMLElement;
      const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      expect(
        document.querySelector('[data-drag-sort-placeholder-gap="true"]')
      ).not.toBeInTheDocument();
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      expect(readOrder(readProjectLayout(PROJECT))).toEqual([
        'navigator',
        PREVIEW,
        'agent',
        'editor',
        'variables',
        'team',
        'assets',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an existing Right column below its heading during a cross-side drag', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    const source = document.querySelector(
      '[data-drag-sort-id="workspace-layout-column-agent"] .workspace-layout-menu__column-label-row'
    ) as HTMLElement;
    const target = document.querySelector(
      '[data-drag-sort-id="workspace-layout-column-editor"]'
    ) as HTMLElement;
    const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
    fireEvent(
      window,
      pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
    );

    expect(target.style.getPropertyValue('--drag-sort-transform')).toBe('translate3d(0px, 0px, 0)');
    fireEvent(window, pointer('pointercancel', targetRect.left + 10, targetRect.top));
  });

  it('moves a whole column card from Right back to Left', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = screen.getByRole('menuitem', { name: 'Move Right column 1' });
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-navigator"]'
      ) as HTMLElement;
      const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      expect(readOrder(readProjectLayout(PROJECT))).toEqual([
        'agent',
        'navigator',
        'editor',
        PREVIEW,
        'variables',
        'team',
        'assets',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the column drag overlay visually shaped like the source card', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    const source = screen.getByRole('menuitem', { name: 'Move Left column 1' });
    const target = document.querySelector(
      '[data-drag-sort-id="workspace-layout-column-navigator"]'
    ) as HTMLElement;
    const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
    fireEvent(
      window,
      pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
    );

    const overlay = document.querySelector('[data-drag-sort-overlay="true"]') as HTMLElement;
    expect(overlay.querySelector('.workspace-layout-menu__column--overlay')).toBeInTheDocument();
    expect(overlay.querySelector('.workspace-layout-menu__column-label')).toHaveTextContent(
      'Column 1'
    );
    expect(overlay.querySelectorAll('.workspace-layout-menu__panel-row')).toHaveLength(1);
    expect(overlay.querySelectorAll('.workspace-layout-menu__overlay-icon')).toHaveLength(3);
    expect(overlay.querySelectorAll('button')).toHaveLength(0);

    fireEvent(window, pointer('pointercancel', targetRect.left + 10, targetRect.top));
  });

  it('keeps the panel drag overlay visually shaped like the source card', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    const source = screen.getByRole('menuitem', { name: 'Move Agent panel' });
    const target = document.querySelector(
      '[data-drag-sort-id="workspace-layout-panel-navigator"]'
    ) as HTMLElement;
    const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
    fireEvent(
      window,
      pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
    );

    const overlay = document.querySelector('[data-drag-sort-overlay="true"]') as HTMLElement;
    expect(overlay.querySelector('.workspace-layout-menu__tile--overlay')).toBeInTheDocument();
    expect(overlay.querySelectorAll('.workspace-layout-menu__panel-row')).toHaveLength(1);
    expect(overlay.querySelectorAll('.workspace-layout-menu__overlay-icon')).toHaveLength(3);
    expect(overlay.querySelectorAll('button')).toHaveLength(0);

    fireEvent(window, pointer('pointercancel', targetRect.left + 10, targetRect.top));
  });

  it('grows the destination column without shifting its existing panel away', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(stacked());
    mockMenuRects();

    const source = screen.getByRole('menuitem', { name: 'Move Agent panel' });
    const sourceItem = source.closest('[data-drag-sort-item]') as HTMLElement;
    const targetItem = document.querySelector(
      '[data-drag-sort-id="workspace-layout-panel-editor"]'
    ) as HTMLElement;
    const sourceRect = sourceItem.getBoundingClientRect();
    const targetRect = targetItem.getBoundingClientRect();

    fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
    fireEvent(window, pointer('pointermove', sourceRect.left + 10, sourceRect.top + 70));
    mockMenuRects();
    fireEvent(window, pointer('pointermove', targetRect.left + 10, targetRect.top + 1));

    const targetColumn = targetItem.closest('[data-layout-column-card="true"]') as HTMLElement;
    const placeholder = targetColumn.querySelector(
      '[data-layout-panel-drop-placeholder="true"]'
    ) as HTMLElement;
    expect(placeholder).toBeInTheDocument();
    expect(placeholder.nextElementSibling).toBe(targetItem);
    expect(placeholder.style.height).toBe('20px');
    expect(sourceItem.style.transform).toBe('none');
    expect(targetItem.style.transform).toBe('none');

    fireEvent(window, pointer('pointercancel', targetRect.left + 10, targetRect.top + 1));
  });

  it('keeps side targets fixed and uses a line target for panel drops', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    const source = screen.getByRole('menuitem', { name: 'Move Agent panel' });
    const target = document.querySelector(
      '[data-drag-sort-id="workspace-layout-panel-navigator"]'
    ) as HTMLElement;
    const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
    fireEvent(
      window,
      pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
    );

    expect(target).toHaveAttribute('data-drag-sort-target-indicator', 'true');
    expect(
      document.querySelector('[data-drag-sort-placeholder-gap="true"]')
    ).not.toBeInTheDocument();
    for (const side of ['left', 'right']) {
      const newColumn = document.querySelector(`[data-layout-new-column="${side}"]`) as HTMLElement;
      expect(newColumn.style.getPropertyValue('--drag-sort-transform')).toBe(
        'translate3d(0px, 0px, 0)'
      );
    }

    fireEvent(window, pointer('pointercancel', targetRect.left + 10, targetRect.top));
  });

  it('moves a whole column to the bottom of the other side via its new-column target', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-agent"] .workspace-layout-menu__column-label-row'
      ) as HTMLElement;
      activateDrag(source);
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-column-drop-right"]'
      ) as HTMLElement;
      const targetRect = target.getBoundingClientRect();
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      expect(readOrder(readProjectLayout(PROJECT))).toEqual([
        'navigator',
        PREVIEW,
        'editor',
        'variables',
        'team',
        'assets',
        'agent',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a panel split into the explicit New left column target', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = screen.getByRole('menuitem', { name: 'Move Agent panel' });
      activateDrag(source);
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-new-column-left"]'
      ) as HTMLElement;
      const targetRect = target.getBoundingClientRect();
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      const saved = readProjectLayout(PROJECT);
      expect(readOrder(saved)).toEqual([
        'navigator',
        'agent',
        PREVIEW,
        'editor',
        'variables',
        'team',
        'assets',
      ]);
      expect(
        saved.columns.some(
          (column) =>
            column.kind === 'panels' &&
            column.panels.length === 1 &&
            column.panels[0]?.panel === 'agent'
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a panel split into the explicit New right column target', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = screen.getByRole('menuitem', { name: 'Move Agent panel' });
      activateDrag(source);
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-new-column-right"]'
      ) as HTMLElement;
      const targetRect = target.getBoundingClientRect();
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      const saved = readProjectLayout(PROJECT);
      const previewIndex = saved.columns.findIndex((column) => column.kind === 'preview');
      const agentIndex = saved.columns.findIndex(
        (column) =>
          column.kind === 'panels' &&
          column.panels.length === 1 &&
          column.panels[0]?.panel === 'agent'
      );
      expect(agentIndex).toBeGreaterThan(previewIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stacks panels when one panel is dropped before another', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(reorderableColumns());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const source = screen.getByRole('menuitem', { name: 'Move Agent panel' });
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-panel-navigator"]'
      ) as HTMLElement;
      const sourceRect = source.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      fireEvent(source, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      const saved = readProjectLayout(PROJECT);
      const stackedColumn = saved.columns.find(
        (column) =>
          column.kind === 'panels' &&
          column.panels.some((placement) => placement.panel === 'navigator')
      );
      expect(
        stackedColumn?.kind === 'panels' && stackedColumn.panels.map((placement) => placement.panel)
      ).toEqual(['navigator', 'agent']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one real hit-area contract for draggable and action controls', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(stacked());

    const hitTargets = document.querySelectorAll('[data-layout-hit-target="true"]');
    expect(hitTargets.length).toBeGreaterThan(5);
    hitTargets.forEach((target) => {
      expect(target).toHaveClass('workspace-layout-menu__hit-target');
    });
    expect(screen.getByRole('menuitem', { name: 'Move Agent panel' })).toHaveAttribute(
      'data-layout-hit-target',
      'true'
    );
  });

  it('focuses the first layout control rather than the footer on open', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(stacked());

    expect(screen.getByRole('menuitem', { name: 'Move Left column 1' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Save as my default layout' })).not.toHaveFocus();
  });

  it('can target a floating panel in a hidden source column', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu({
      version: 2,
      columns: [
        { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'team', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
        { kind: 'panels', panels: [{ panel: 'variables', weight: 1 }] },
      ],
      floating: ['agent', 'team'],
    });
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const handle = screen.getByRole('menuitem', { name: 'Move Agent panel' });
      const target = screen.getByRole('menuitem', { name: 'Move Team panel' });
      const sourceRect = handle.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      const targetRect = target.closest('[data-drag-sort-item]')!.getBoundingClientRect();
      fireEvent(handle, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      const saved = readProjectLayout(PROJECT);
      const teamColumn = saved.columns.find(
        (column) =>
          column.kind === 'panels' && column.panels.some((placement) => placement.panel === 'team')
      );
      expect(saved.floating).not.toContain('agent');
      expect(
        teamColumn?.kind === 'panels' && teamColumn.panels.map((placement) => placement.panel)
      ).toEqual(expect.arrayContaining(['agent', 'team']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps named secondary actions behind the selected panel only', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    const user = await openMenu(stacked());

    expect(
      screen.queryByRole('menuitem', { name: 'Move Agent to its own column left' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'More options for Agent' }));
    expect(
      screen.getByRole('menuitem', { name: 'Move Agent to its own column left' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Move Elements to its own column left' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'More options for Elements' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Move Agent to its own column left' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Move Elements to its own column left' })
    ).toBeInTheDocument();
  });

  it('can switch between the spatial editor and the preserved legacy menu', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    const user = userEvent.setup();
    render(
      <PanelDockProvider projectPath={PROJECT}>
        <WorkspaceLayoutMenu />
      </PanelDockProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Panel layout' }));
    expect(screen.getByRole('group', { name: 'Workspace columns' })).toBeInTheDocument();

    // The implementation switch is intentionally live for developer QA.
    act(() => setWorkspaceLayoutMenuImplementation('legacy'));
    await user.click(screen.getByRole('button', { name: 'Panel layout' }));
    expect(await screen.findByText('Panels')).toBeInTheDocument();
    expect(screen.queryByText('Workspace columns')).not.toBeInTheDocument();
  });

  it('shows a real stack and exposes named non-drag controls for it', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    const user = await openMenu(stacked());

    expect(screen.getByRole('group', { name: 'Workspace columns' })).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Elements')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'More options for Elements' }));
    expect(screen.getByRole('menuitem', { name: 'Move Elements up' })).toBeEnabled();
    await user.click(screen.getByRole('menuitem', { name: 'Move Elements up' }));
    await user.click(screen.getByRole('menuitem', { name: 'More options for Agent' }));
    expect(
      screen.getByRole('menuitem', { name: 'Move Agent to its own column left' })
    ).toBeEnabled();

    const saved = readProjectLayout(PROJECT);
    const stackedColumn = saved.columns.find(
      (column) =>
        column.kind === 'panels' &&
        column.panels.some((placement) => placement.panel === 'navigator')
    );
    expect(stackedColumn?.kind === 'panels' && stackedColumn.panels[0]?.panel).toBe('navigator');
  });

  it('keeps one visible new-column target at the bottom of each side', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(stacked());

    expect(document.querySelectorAll('[data-layout-new-column]')).toHaveLength(0);
    const source = screen.getByRole('menuitem', { name: 'Move Agent panel' });
    activateDrag(source);
    expect(document.querySelectorAll('[data-layout-new-column="left"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-layout-new-column="right"]')).toHaveLength(1);
    expect(screen.getByText('New left column')).toBeInTheDocument();
    expect(screen.getByText('New right column')).toBeInTheDocument();
    const canvas = screen.getByRole('group', { name: 'Workspace columns' });
    const leftSide = canvas.querySelector('[data-layout-side="left"]') as HTMLElement;
    expect(within(leftSide).getByText('New left column')).toBeInTheDocument();
    fireEvent(window, pointer('pointercancel', 0, 0));
  });

  it('keeps spatial drag targets in one visual order across columns and the tray', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu({
      ...floatingStacked(),
      floating: ['agent'],
    });

    const ids = [...document.querySelectorAll<HTMLElement>('[data-drag-sort-item]')].map((item) =>
      item.getAttribute('data-drag-sort-id')
    );
    expect(ids).toEqual([
      'workspace-layout-side-left',
      'workspace-layout-column-team',
      'workspace-layout-panel-team',
      'workspace-layout-column-variables',
      'workspace-layout-panel-variables',
      'workspace-layout-column-navigator',
      'workspace-layout-panel-navigator',
      'preview',
      'workspace-layout-side-right',
      'workspace-layout-column-editor',
      'workspace-layout-panel-editor',
      'workspace-layout-column-assets',
      'workspace-layout-panel-assets',
      'workspace-layout-panel-agent',
    ]);
  });

  it('disables own-column controls for a singleton panel', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu({
      version: 2,
      columns: [
        { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
        { kind: 'preview' },
        { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
      ],
      floating: [],
    });

    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'More options for Agent' }));
    expect(
      screen.getByRole('menuitem', { name: 'Move Agent to its own column left' })
    ).toBeDisabled();
    expect(
      screen.getByRole('menuitem', { name: 'Move Agent to its own column right' })
    ).toBeDisabled();
  });

  it('lets a floating panel drag back into a docked stack', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    await openMenu(floatingStacked());
    mockMenuRects();

    vi.useFakeTimers();
    try {
      const handle = screen.getByRole('menuitem', { name: 'Move Agent panel' });
      expect(handle).not.toBeDisabled();
      const source = handle.closest('[data-drag-sort-item]') as HTMLElement;
      const target = document.querySelector(
        '[data-drag-sort-id="workspace-layout-panel-navigator"]'
      ) as HTMLElement;
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      fireEvent(handle, pointer('pointerdown', sourceRect.left + 10, sourceRect.top + 10));
      fireEvent(
        window,
        pointer('pointermove', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      fireEvent(
        window,
        pointer('pointerup', targetRect.left + 10, targetRect.top + targetRect.height / 2)
      );
      await act(() => vi.advanceTimersByTime(250));

      const saved = readProjectLayout(PROJECT);
      const stackedColumn = saved.columns.find(
        (column) =>
          column.kind === 'panels' &&
          column.panels.some((placement) => placement.panel === 'navigator')
      );
      expect(saved.floating).not.toContain('agent');
      expect(
        stackedColumn?.kind === 'panels' && stackedColumn.panels.map((placement) => placement.panel)
      ).toEqual(expect.arrayContaining(['agent', 'navigator']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps legacy reordering disabled while preserving a v2 stack', async () => {
    const before = stacked();
    await openMenu(before);
    const savedBefore = readProjectLayout(PROJECT);

    const agentRow = row('Agent');
    expect(within(agentRow).getByRole('button', { name: 'Move Agent panel' })).toBeDisabled();
    expect(within(agentRow).getByRole('button', { name: 'Move Agent right' })).toBeDisabled();
    expect(readProjectLayout(PROJECT).columns).toEqual(savedBefore.columns);

    act(() => setWorkspaceLayoutMenuImplementation('new'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Panel layout' }));
    expect(screen.getByRole('group', { name: 'Workspace columns' })).toBeInTheDocument();
    const saved = readProjectLayout(PROJECT);
    expect(saved.columns).toEqual(savedBefore.columns);
  });

  it('keeps floating reversible from the spatial editor', async () => {
    localStorage.removeItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY);
    const user = await openMenu(stacked());

    await user.click(screen.getByRole('menuitem', { name: 'Float Agent' }));
    expect(readProjectLayout(PROJECT).floating).toContain('agent');
    await user.click(screen.getByRole('menuitem', { name: 'Dock Agent' }));
    expect(readProjectLayout(PROJECT).floating).not.toContain('agent');
  });
});

describe('the layout persistence scope selector', () => {
  it.each(['legacy', 'new'] as const)('works at the top of the %s menu', async (implementation) => {
    localStorage.setItem(WORKSPACE_LAYOUT_MENU_IMPLEMENTATION_KEY, implementation);
    const user = await openMenu();

    const scopeControl = screen.getByRole('tablist', { name: 'Layout applies to' });
    expect(scopeControl).toBeInTheDocument();
    expect(scopeControl).toHaveClass('tabs__list');
    expect(scopeControl.parentElement).toHaveClass('workspace-layout-menu__scope-tabs');
    expect(screen.getByText('Panel Layout').compareDocumentPosition(scopeControl)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(document.querySelector('[data-layout-footer="true"]')).not.toContainElement(
      scopeControl
    );
    expect(screen.getByRole('tab', { name: 'This project' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await user.click(screen.getByRole('tab', { name: 'All projects' }));

    expect(readLayoutScope()).toBe('global');
    expect(screen.getByRole('tab', { name: 'All projects' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.queryByRole('menuitem', { name: /Save as my default/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Reset this project/ })).not.toBeInTheDocument();
  });
});
