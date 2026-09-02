import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, TabsList, TabsPanel, TabsTab } from './Tabs';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('Tabs', () => {
  it('links each tab to its labeled panel with stable, encoded ids', () => {
    render(
      <Tabs defaultValue="first">
        <TabsList aria-label="Example views">
          <TabsTab value="first">First</TabsTab>
          <TabsTab value="/second view">Second</TabsTab>
        </TabsList>
        <TabsPanel value="first">First panel</TabsPanel>
        <TabsPanel value="/second view">Second panel</TabsPanel>
      </Tabs>
    );

    const first = screen.getByRole('tab', { name: 'First' });
    const second = screen.getByRole('tab', { name: 'Second' });
    const firstPanel = screen.getByRole('tabpanel', { name: 'First' });
    const secondPanel = document.getElementById(second.getAttribute('aria-controls') ?? '');

    expect(first).toHaveAttribute('aria-controls', firstPanel.id);
    expect(firstPanel).toHaveAttribute('aria-labelledby', first.id);
    expect(second.getAttribute('aria-controls')).toMatch(/panel-/);
    expect(secondPanel).toHaveAttribute('aria-labelledby', second.id);
    expect(secondPanel).toHaveAttribute('hidden');
  });

  it('omits panel relationships in navigation mode', () => {
    render(
      <Tabs mode="navigation" defaultValue="overview">
        <TabsList aria-label="Workspace navigation">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="settings">Settings</TabsTab>
        </TabsList>
      </Tabs>
    );

    expect(screen.getByRole('tab', { name: 'Overview' })).not.toHaveAttribute('aria-controls');
    expect(screen.getByRole('tab', { name: 'Settings' })).not.toHaveAttribute('aria-controls');
  });

  it('moves through enabled tabs with arrows, Home, and End', () => {
    render(
      <Tabs defaultValue="first">
        <TabsList aria-label="Keyboard views">
          <TabsTab value="first">First</TabsTab>
          <TabsTab value="disabled" disabled>
            Disabled
          </TabsTab>
          <TabsTab value="last">Last</TabsTab>
        </TabsList>
      </Tabs>
    );

    const first = screen.getByRole('tab', { name: 'First' });
    const last = screen.getByRole('tab', { name: 'Last' });

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
  });

  it('can keep stateful panels mounted while making inactive content inert', () => {
    render(
      <Tabs defaultValue="first">
        <TabsList aria-label="Persistent views">
          <TabsTab value="first">First</TabsTab>
          <TabsTab value="last">Last</TabsTab>
        </TabsList>
        <TabsPanel value="first" keepMounted>
          First panel
        </TabsPanel>
        <TabsPanel value="last" keepMounted>
          Last panel
        </TabsPanel>
      </Tabs>
    );

    const firstPanel = screen.getByRole('tabpanel', { name: 'First' });
    const lastTab = screen.getByRole('tab', { name: 'Last' });
    const lastPanel = document.getElementById(lastTab.getAttribute('aria-controls') ?? '');

    expect(firstPanel).not.toHaveAttribute('hidden');
    expect(lastPanel).not.toHaveAttribute('hidden');
    expect(lastPanel).toHaveAttribute('aria-hidden', 'true');
    // jsdom's inert support is partial; the serialized DOM still exposes the
    // boolean attribute emitted by React.
    expect(lastPanel?.outerHTML).toContain(' inert=""');
  });

  it('remeasures the active indicator when the layout changes', () => {
    let activeWidth = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('tabs__list')) return rect(0, 0, 120, 32);
      if (this.dataset.tabValue === 'first') return rect(1, 1, activeWidth, 30);
      return rect(1 + activeWidth, 1, 20, 30);
    });

    render(
      <Tabs defaultValue="first">
        <TabsList aria-label="Responsive views">
          <TabsTab value="first">First</TabsTab>
          <TabsTab value="second">Second</TabsTab>
        </TabsList>
      </Tabs>
    );

    const indicator = screen.getByRole('tablist').querySelector<HTMLElement>('.tabs__indicator');
    expect(indicator).not.toBeNull();
    expect(indicator?.style.width).toBe('100px');

    activeWidth = 40;
    fireEvent(window, new Event('resize'));

    expect(indicator?.style.width).toBe('40px');
  });
});
