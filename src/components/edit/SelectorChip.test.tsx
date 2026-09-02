import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectorChip } from './SelectorChip';

// The rule's own selector is a prefix of other project classes, so the browse menu
// that opens on click is headed by a *different* class than the rule's.
const SELECTOR = '.card';
const SUGGESTIONS = ['.card-header', '.card-body', '.card'];

function open(onCommit = vi.fn(), onWrap = vi.fn()) {
  render(
    <SelectorChip
      selector={SELECTOR}
      suggestions={SUGGESTIONS}
      onCommit={onCommit}
      onWrap={onWrap}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /card/ }));
  return { input: screen.getByRole('combobox', { name: 'Rule selector' }), onCommit, onWrap };
}

describe('SelectorChip', () => {
  it('does not rename the rule when Enter follows a click with no typing', () => {
    const { input, onCommit } = open();
    // Enter here means "keep what the field says", not "take the first suggestion".
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('applies the highlighted suggestion once the user types', () => {
    const { input, onCommit } = open();
    fireEvent.change(input, { target: { value: '.card-h' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('.card-header');
  });

  it('applies the highlighted suggestion once the user arrows to it', () => {
    const { input, onCommit } = open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('.card-body');
  });
});
