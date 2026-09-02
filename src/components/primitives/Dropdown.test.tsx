import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { Dropdown, DropdownItem } from './Dropdown';

function TestTrigger(props: ComponentProps<'button'>) {
  return <button type="button" {...props} />;
}

function renderMenu(options: { onFirst?: () => void; onLast?: () => void } = {}) {
  return render(
    <>
      <Dropdown
        trigger={(props) => <TestTrigger {...props}>Open menu</TestTrigger>}
        menuClassName="test-dropdown-menu"
      >
        <DropdownItem onSelect={options.onFirst ?? vi.fn()}>Alpha</DropdownItem>
        <DropdownItem disabled onSelect={vi.fn()}>
          Disabled
        </DropdownItem>
        <DropdownItem onSelect={options.onLast ?? vi.fn()}>Gamma</DropdownItem>
      </Dropdown>
      <button type="button">Outside</button>
    </>
  );
}

describe('Dropdown', () => {
  it('opens from its trigger and focuses the first enabled menu item', async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Disabled' })).toBeDisabled();
  });

  it('supports roving arrows, Home/End, typeahead, and keyboard selection', async () => {
    const user = userEvent.setup();
    const onLast = vi.fn();
    renderMenu({ onLast });

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    await user.click(trigger);
    const first = screen.getByRole('menuitem', { name: 'Alpha' });
    const last = screen.getByRole('menuitem', { name: 'Gamma' });

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'ArrowUp' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'g' });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Enter' });
    expect(onLast).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('activates the focused item with Space and restores focus on Escape', async () => {
    const user = userEvent.setup();
    const onFirst = vi.fn();
    renderMenu({ onFirst });

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    await user.click(trigger);
    const first = screen.getByRole('menuitem', { name: 'Alpha' });

    fireEvent.keyDown(first, { key: ' ' });
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Alpha' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('supports click-outside dismissal and body-portal rendering', async () => {
    const user = userEvent.setup();
    render(
      <Dropdown portal trigger={(props) => <TestTrigger {...props}>Open portal menu</TestTrigger>}>
        <DropdownItem onSelect={vi.fn()}>Portal item</DropdownItem>
      </Dropdown>
    );

    const trigger = screen.getByRole('button', { name: 'Open portal menu' });
    await user.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(menu.parentElement).toBe(document.body);

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps controlled open state with callbacks separate from internal state', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Dropdown
        open={false}
        onOpenChange={onOpenChange}
        trigger={(props) => <TestTrigger {...props}>Controlled menu</TestTrigger>}
      >
        <DropdownItem onSelect={vi.fn()}>Controlled item</DropdownItem>
      </Dropdown>
    );

    const trigger = screen.getByRole('button', { name: 'Controlled menu' });
    await user.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    rerender(
      <Dropdown
        open
        onOpenChange={onOpenChange}
        trigger={(props) => <TestTrigger {...props}>Controlled menu</TestTrigger>}
      >
        <DropdownItem onSelect={vi.fn()}>Controlled item</DropdownItem>
      </Dropdown>
    );
    expect(screen.getByRole('menuitem', { name: 'Controlled item' })).toHaveFocus();

    await user.click(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
