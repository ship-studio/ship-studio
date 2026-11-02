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
  it('keeps color declaration values in the text editor', () => {
    renderRow('#ff0000');
    fireEvent.click(screen.getByRole('button', { name: /#ff0000/ }));
    expect(screen.queryByRole('dialog', { name: 'Color picker' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('keeps the color swatch visible and usable while editing the value', () => {
    renderRow('#ff0000');
    fireEvent.click(screen.getByRole('button', { name: /#ff0000/ }));

    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('combobox').closest('.ss-value-pop--inline')).toHaveClass(
      'ss-value-pop--inline-has-swatch'
    );
    const swatch = screen.getByRole('button', { name: 'Open color picker for color' });
    expect(swatch).toBeInTheDocument();
    fireEvent.click(swatch);
    expect(screen.getByRole('dialog', { name: 'Color picker' })).toBeInTheDocument();
  });

  it('carries an uncommitted text draft into the color picker', () => {
    renderRow('#ff0000');
    fireEvent.click(screen.getByRole('button', { name: /#ff0000/ }));

    const input = screen.getByRole<HTMLTextAreaElement>('combobox');
    fireEvent.change(input, { target: { value: '#00ff00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open color picker for color' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Hex' }));
    expect(screen.getByLabelText('Hex')).toHaveValue('#00ff00');
  });

  it('keeps the text editor for a non-color value', () => {
    renderRow('12px');
    fireEvent.click(screen.getByRole('button', { name: /12px/ }));
    expect(screen.queryByRole('dialog', { name: 'Color picker' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});
