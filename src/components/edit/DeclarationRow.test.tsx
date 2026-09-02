import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeclarationRow } from './DeclarationRow';

vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }
);

function renderRow(value: string) {
  const onChange = vi.fn();
  render(
    <DeclarationRow
      decl={{ prop: 'color', value, important: false }}
      overridden={false}
      editable
      onChange={onChange}
      onRemove={vi.fn()}
      onNest={vi.fn()}
      nestTargets={[]}
    />
  );
  return { onChange };
}

describe('DeclarationRow', () => {
  it('opens the color picker for a color declaration', () => {
    renderRow('#ff0000');
    fireEvent.click(screen.getByRole('button', { name: /#ff0000/ }));
    expect(screen.getByRole('dialog', { name: 'Color picker' })).toBeInTheDocument();
  });

  it('keeps the text editor for a non-color value', () => {
    renderRow('12px');
    fireEvent.click(screen.getByRole('button', { name: /12px/ }));
    expect(screen.queryByRole('dialog', { name: 'Color picker' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});
