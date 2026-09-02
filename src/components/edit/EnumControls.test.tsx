/**
 * Ancestor-inherited enum surfacing: when nothing is set locally and the scan
 * attributed a utility token to the defining ancestor, the control preselects
 * that option (the orange label clarifies it isn't set on this element).
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EnumControlRow } from './EnumControls';
import { ENUM_CONTROLS, BASE_BREAKPOINT } from '../../lib/edit';
import type { InheritedProp, LayerContext } from '../../lib/edit';

const LAYER: LayerContext = { bp: BASE_BREAKPOINT, ordered: [BASE_BREAKPOINT], known: new Set() };

const WEIGHT = ENUM_CONTROLS.find((c) => c.label === 'Weight')!;
const FONT = ENUM_CONTROLS.find((c) => c.label === 'Font')!;
const DECORATION = ENUM_CONTROLS.find((c) => c.label === 'Decoration')!;

const INHERITED: InheritedProp = {
  cssValue: '600',
  tagName: 'div',
  className: 'card font-semibold',
  ancestorClasses: [],
  token: 'font-semibold',
};

describe('EnumControlRow ancestor inheritance', () => {
  it('renders and applies the font-family dropdown', () => {
    const onApplyEnum = vi.fn();
    render(
      <EnumControlRow
        control={FONT}
        currentClass=""
        layer={LAYER}
        onApplyEnum={onApplyEnum}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByText('Font')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Font' }));
    fireEvent.click(screen.getByRole('option', { name: 'Serif' }));

    expect(onApplyEnum).toHaveBeenCalledWith('font-serif', {
      'font-family': 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
    });
  });

  it('preselects the attributed inherited option when nothing is set locally', () => {
    render(
      <EnumControlRow
        control={WEIGHT}
        currentClass=""
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        inherited={INHERITED}
      />
    );
    // The dropdown trigger shows Semibold — the ancestor's effective weight.
    expect(screen.getByText('Semibold')).toBeInTheDocument();
  });

  it('a local value wins; an unattributed inheritance selects nothing', () => {
    const { unmount } = render(
      <EnumControlRow
        control={WEIGHT}
        currentClass="font-bold"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        inherited={INHERITED}
      />
    );
    expect(screen.getByText('Bold')).toBeInTheDocument();
    unmount();

    render(
      <EnumControlRow
        control={WEIGHT}
        currentClass=""
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        inherited={{ ...INHERITED, token: undefined }}
      />
    );
    // No token → no honest option to show; the trigger stays empty.
    expect(screen.queryByText('Semibold')).toBeNull();
  });

  it('surfaces a decoration propagating from an ancestor (underline drawn through)', () => {
    render(
      <EnumControlRow
        control={DECORATION}
        currentClass=""
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        inherited={{
          cssValue: 'underline',
          tagName: 'div',
          className: 'deco underline',
          ancestorClasses: [],
          token: 'underline',
        }}
      />
    );
    // The segmented control highlights Underline; the orange label explains why.
    const underline = screen.getByTitle('Underline');
    expect(underline).toHaveAttribute('aria-pressed', 'true');
  });
});
