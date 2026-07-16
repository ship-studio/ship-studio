import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditPopover } from './EditPopover';

function renderPopover(initial: string, options?: string[]) {
  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  const onCommit = vi.fn();
  const onClose = vi.fn();
  render(
    <EditPopover
      anchor={anchor}
      initial={initial}
      options={options}
      onCommit={onCommit}
      onClose={onClose}
    />
  );
  return { input: screen.getByRole<HTMLInputElement>('combobox'), onCommit, onClose };
}

describe('EditPopover', () => {
  it('commits the typed value on Enter', () => {
    const { input, onCommit, onClose } = renderPopover('12px');
    fireEvent.change(input, { target: { value: '20px' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('20px');
    expect(onClose).toHaveBeenCalled();
  });

  // ── Arrow-key stepping (ArrowUp/Down; Shift ×10, Alt ÷10) ──

  it('steps a numeric value with ArrowUp/ArrowDown and live-applies it', () => {
    const { input, onCommit, onClose } = renderPopover('12px');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('13px');
    expect(onCommit).toHaveBeenLastCalledWith('13px');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('11px');
    expect(onCommit).toHaveBeenLastCalledWith('11px');
    expect(onClose).not.toHaveBeenCalled(); // stays open, like scrubbing
  });

  it('steps ×10 with Shift and ÷10 with Alt', () => {
    const { input, onCommit } = renderPopover('12px');
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith('22px');
    fireEvent.keyDown(input, { key: 'ArrowUp', altKey: true });
    expect(onCommit).toHaveBeenLastCalledWith('22.1px');
  });

  it('uses the magnitude-aware step and preserves the unit (< 10 → 0.1)', () => {
    const { input, onCommit } = renderPopover('1.5rem');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith('1.6rem');
  });

  it('steps unitless hundreds (font-weight) by 10', () => {
    const { input, onCommit } = renderPopover('700');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith('710');
  });

  it('keeps navigating the suggestion menu with arrows while it is open', () => {
    const { input, onCommit } = renderPopover('', ['auto', 'inherit']);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // The arrow moved the active option — it did not step or apply a value.
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringMatching(/-opt-1$/));
    expect(input.value).toBe('');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('leaves keyword values untouched on arrow keys', () => {
    const { input, onCommit } = renderPopover('auto');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('auto');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
