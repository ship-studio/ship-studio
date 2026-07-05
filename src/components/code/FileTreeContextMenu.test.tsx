import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeContextMenu } from './FileTreeContextMenu';

function setup(overrides: Partial<Parameters<typeof FileTreeContextMenu>[0]> = {}) {
  const onDelete = vi.fn();
  const onClose = vi.fn();
  render(
    <FileTreeContextMenu
      x={120}
      y={80}
      name="logo.svg"
      onDelete={onDelete}
      onClose={onClose}
      {...overrides}
    />
  );
  return { onDelete, onClose };
}

describe('FileTreeContextMenu', () => {
  it('renders a Delete action labelled for the entry', () => {
    setup();
    const menu = screen.getByRole('menu', { name: /actions for logo\.svg/i });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });

  it('positions itself at the cursor', () => {
    setup({ x: 200, y: 150 });
    const menu = screen.getByRole('menu');
    expect(menu).toHaveStyle({ top: '150px', left: '200px' });
  });

  it('invokes onDelete when the Delete item is clicked', () => {
    const { onDelete, onClose } = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a pointer-down outside the menu', () => {
    const { onClose } = setup();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on a pointer-down inside the menu', () => {
    const { onClose } = setup();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: /delete/i }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
