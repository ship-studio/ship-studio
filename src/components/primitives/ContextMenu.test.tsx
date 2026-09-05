import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ContextMenu';

function renderMenu(onSelect = vi.fn()) {
  return render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">Target</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>First</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem>Second</ContextMenuItem>
        <ContextMenuItem disabled>Disabled</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe('ContextMenu', () => {
  it('opens at the context-menu gesture and selects an item', async () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Target' }), {
      clientX: 120,
      clientY: 80,
    });

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
    fireEvent.click(screen.getByRole('menuitem', { name: 'First' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('supports keyboard movement, disabled items, Escape, and outside dismissal', async () => {
    renderMenu();
    const target = screen.getByRole('button', { name: 'Target' });

    fireEvent.contextMenu(target);
    const first = screen.getByRole('menuitem', { name: 'First' });
    const second = screen.getByRole('menuitem', { name: 'Second' });

    expect(screen.getByRole('menuitem', { name: 'Disabled' })).toBeDisabled();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    fireEvent.contextMenu(target);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
