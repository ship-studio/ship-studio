/**
 * The Layout menu — the half of this feature that is not a drag.
 *
 * A drag is the fast way to move a panel and must never be the only way, so
 * everything the pointer can do is here as a control with a name: which side
 * each panel is on, docked or floating, one step either way. Plus the two
 * things a drag cannot express at all.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceLayoutMenu } from './WorkspaceLayoutMenu';
import { PanelDockProvider } from '../../contexts/PanelDockContext';
import { DEFAULT_LAYOUT, PREVIEW } from '../../lib/workspaceLayout';
import {
  hasProjectLayout,
  readDefaultLayout,
  readProjectLayout,
  writeProjectLayout,
} from '../../lib/workspaceLayoutStore';

const PROJECT = '/Users/dev/ShipStudio/site';

beforeEach(() => localStorage.clear());

async function openMenu(layout?: unknown) {
  if (layout) writeProjectLayout(PROJECT, layout as never);
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

describe('the menu', () => {
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

  it('moves a panel across the preview a step at a time', async () => {
    const user = await openMenu({
      order: ['agent', PREVIEW, 'editor', 'team', 'navigator', 'variables'],
      floating: [],
      widths: {},
    });

    await user.click(within(row('Agent')).getByRole('button', { name: 'Move Agent right' }));

    expect(within(row('Agent')).getByText('Right')).toBeInTheDocument();
    const saved = readProjectLayout(PROJECT).order;
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

    const float = within(row('Navigator')).getByRole('button', { name: 'Float Navigator' });
    expect(float).toHaveAttribute('aria-pressed', 'true');
    await user.click(float);

    expect(readProjectLayout(PROJECT).floating).toContain('navigator');
    const dock = within(row('Navigator')).getByRole('button', { name: 'Dock Navigator' });
    expect(dock).toHaveAttribute('aria-pressed', 'false');

    await user.click(dock);
    expect(readProjectLayout(PROJECT).floating).not.toContain('navigator');
    // Back where it was, not at an end.
    expect(readProjectLayout(PROJECT).order[1]).toBe('navigator');
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
    expect(readDefaultLayout().order).toEqual(readProjectLayout(PROJECT).order);
    expect(readDefaultLayout().order).not.toEqual(DEFAULT_LAYOUT.order);
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
