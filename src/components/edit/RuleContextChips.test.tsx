import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuleContextChips } from './RuleContextChips';

/** A condition whose feature chunk can be replaced through the suggestion menu. */
const CONDITION = '(hover: hover)';

function open(onRenameAtRule = vi.fn()) {
  render(<RuleContextChips mediaText={CONDITION} onRenameAtRule={onRenameAtRule} />);
  fireEvent.click(screen.getByRole('button', { name: 'hover:' }));
  return {
    input: screen.getByRole('combobox', { name: 'Edit media query feature' }),
    onRenameAtRule,
  };
}

describe('RuleContextChips media condition', () => {
  it('accepts the first feature suggestion when Enter follows a click with no typing', () => {
    const { input, onRenameAtRule } = open();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameAtRule).toHaveBeenCalledWith('(width: hover)');
  });

  it('applies the highlighted suggestion once the user types', () => {
    const { input, onRenameAtRule } = open();
    fireEvent.change(input, { target: { value: 'print' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameAtRule).toHaveBeenCalledWith('(print: hover)');
  });

  it('applies the highlighted suggestion once the user arrows to it', () => {
    const { input, onRenameAtRule } = open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameAtRule).toHaveBeenCalledWith('(min-width: hover)');
  });
});
