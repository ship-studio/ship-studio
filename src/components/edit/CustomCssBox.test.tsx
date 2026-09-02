import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BASE_BREAKPOINT, type LayerContext, type ResetSpec } from '../../lib/edit';
import { CustomCssBox } from './CustomCssBox';

const LAYER: LayerContext = {
  bp: BASE_BREAKPOINT,
  ordered: [BASE_BREAKPOINT],
  known: new Set(),
};

// jsdom has no CSS.supports — stub it so arbitrary-property validation is exercised.
beforeAll(() => {
  if (typeof CSS === 'undefined') {
    (globalThis as unknown as { CSS: unknown }).CSS = {};
  }
  (CSS as unknown as { supports: (property: string, value: string) => boolean }).supports = (
    _property,
    value
  ) => value.trim() !== '' && !value.includes('@@');
});

describe('CustomCssBox', () => {
  it('renders arbitrary properties as shared declaration rows without nesting controls', () => {
    render(
      <CustomCssBox
        currentClass="[clip-path:circle(50%)]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'clip-path' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'circle(50%)' })).toBeInTheDocument();
    expect(document.querySelector('.ss-custom-css__chip')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Move into a nested rule' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a property' })).toHaveTextContent('Add');
  });

  it('edits an existing value through the shared inline editor', () => {
    const onApplyEnum = vi.fn();
    const onReset = vi.fn<(spec: ResetSpec) => void>();
    render(
      <CustomCssBox
        currentClass="[clip-path:circle(50%)]"
        layer={LAYER}
        onApplyEnum={onApplyEnum}
        onReset={onReset}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'circle(50%)' }));
    const valueInput = screen.getByPlaceholderText('value');
    fireEvent.change(valueInput, { target: { value: 'inset(1px)' } });
    fireEvent.keyDown(valueInput, { key: 'Enter' });

    expect(onReset).toHaveBeenCalledTimes(1);
    const reset = onReset.mock.calls[0]?.[0];
    expect(reset).toBeDefined();
    if (!reset) return;
    expect(reset.cssProps).toEqual(['clip-path']);
    expect(reset.match('[clip-path:circle(50%)]')).toBe(true);
    expect(onApplyEnum).toHaveBeenCalledWith('[clip-path:inset(1px)]', {
      'clip-path': 'inset(1px)',
    });
  });

  it('preserves the important suffix when removing an arbitrary property', () => {
    const onReset = vi.fn<(spec: ResetSpec) => void>();
    render(
      <CustomCssBox
        currentClass="[clip-path:circle(50%)]!"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={onReset}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove property' }));

    const reset = onReset.mock.calls[0]?.[0];
    expect(reset).toBeDefined();
    if (!reset) return;
    expect(reset.match('[clip-path:circle(50%)]!')).toBe(true);
  });

  it('adds a property through the searchable Add flow and opens its value row', () => {
    const onApplyEnum = vi.fn();
    render(
      <CustomCssBox currentClass="" layer={LAYER} onApplyEnum={onApplyEnum} onReset={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add a property' }));
    const propertySearch = screen.getByRole('combobox', { name: 'Add property' });
    fireEvent.change(propertySearch, { target: { value: 'clip-path' } });
    fireEvent.click(screen.getByRole('option', { name: 'clip-path' }));

    const valueInput = screen.getByPlaceholderText('value');
    fireEvent.change(valueInput, { target: { value: 'circle(50%)' } });
    fireEvent.keyDown(valueInput, { key: 'Enter' });

    expect(onApplyEnum).toHaveBeenCalledWith('[clip-path:circle(50%)]', {
      'clip-path': 'circle(50%)',
    });
  });
});
