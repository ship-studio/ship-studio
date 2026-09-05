/**
 * Ancestor-inherited values surfacing in the free-form value controls: the
 * field shows the effective inherited value when nothing is set locally, and
 * "Set here explicitly" adopts it as a local utility via onApplyEnum.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ValuePropertyControl } from './ValuePropertyControl';
import { BASE_BREAKPOINT, type InheritedProp, type LayerContext } from '../../lib/edit';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

const LAYER: LayerContext = { bp: BASE_BREAKPOINT, ordered: [BASE_BREAKPOINT], known: new Set() };

const INHERITED: InheritedProp = {
  cssValue: '18px',
  tagName: 'div',
  className: 'card text-lg',
  ancestorClasses: [],
  token: 'text-lg',
};

function renderControl(props: Partial<Parameters<typeof ValuePropertyControl>[0]> = {}) {
  return render(
    <ValuePropertyControl
      kind="font-size"
      currentClass=""
      layer={LAYER}
      onApplyEnum={vi.fn()}
      onReset={vi.fn()}
      {...props}
    />
  );
}

describe('ValuePropertyControl ancestor inheritance', () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue({ status: 'read_only', reason: 'not pinned' });
  });

  it('shows the inherited value in an otherwise-empty field, with the orange label', () => {
    const { container } = renderControl({ inherited: INHERITED });
    // ValueField renders the bare number; the unit lives in its suffix.
    expect(screen.getByRole('textbox')).toHaveValue('18');
    expect(container.querySelector('.ss-edit-panel__label--inherited')).toBeInTheDocument();
  });

  it('a locally-set value wins over the inherited one', () => {
    renderControl({ inherited: INHERITED, currentClass: 'text-sm' });
    // text-sm == 0.875rem — read from the element's own class.
    expect(screen.getByRole('textbox')).toHaveValue('0.875');
  });

  it('"Set here explicitly" writes the value as a local utility', async () => {
    const onApplyEnum = vi.fn();
    renderControl({ inherited: INHERITED, onApplyEnum, projectPath: '/tmp/demo' });
    fireEvent.click(screen.getByTitle(/Inherited from/));
    fireEvent.click(await screen.findByRole('button', { name: 'Set here explicitly' }));
    // No scale token matches 18px exactly, so it's written as an arbitrary value.
    expect(onApplyEnum).toHaveBeenCalledWith('text-[length:18px]', { 'font-size': '18px' });
  });
});

describe('ValuePropertyControl radius values', () => {
  it('starts linked and renders the locked icon action', () => {
    const { container } = renderControl({ kind: 'radius', currentClass: 'rounded-[12px]' });

    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveValue('12');
    expect(container.querySelector('.value-field__leading svg')).toHaveAttribute(
      'data-icon-source',
      'icons/corner-radius.svg'
    );
    const toggle = screen.getByRole('button', { name: 'Separate radius values' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle.querySelector('svg')).toHaveAttribute('data-icon-source', 'icons/locked.svg');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('copies a single border-radius value into all four corner fields when unlocked', () => {
    renderControl({ kind: 'radius', currentClass: 'rounded-[12px]' });

    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    expect(screen.getByRole('button', { name: 'Link radius values' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      screen.getByRole('button', { name: 'Link radius values' }).querySelector('svg')
    ).toHaveAttribute('data-icon-source', 'icons/unlocked.svg');
    const cornerSources = {
      'Top left': 'icons/corner-radius-top-left.svg',
      'Top right': 'icons/corner-radius-top-right.svg',
      'Bottom right': 'icons/corner-radius-bottom-right.svg',
      'Bottom left': 'icons/corner-radius-bottom-left.svg',
    };
    for (const [label, source] of Object.entries(cornerSources)) {
      const field = screen.getByRole('textbox', { name: `Radius ${label}` });
      expect(field).toHaveValue('12');
      expect(field.closest('.ss-radius-control__corner')?.querySelector('svg')).toHaveAttribute(
        'data-icon-source',
        source
      );
    }
  });

  it('expands CSS two-value shorthand using the CSS corner order', () => {
    renderControl({ kind: 'radius', currentClass: 'rounded-[4px_8px]' });

    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    expect(screen.getByRole('textbox', { name: 'Radius Top left' })).toHaveValue('4');
    expect(screen.getByRole('textbox', { name: 'Radius Top right' })).toHaveValue('8');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom right' })).toHaveValue('4');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom left' })).toHaveValue('8');
  });

  it('writes an edited corner back through the border-radius shorthand', () => {
    const onApplyEnum = vi.fn();
    renderControl({ kind: 'radius', currentClass: 'rounded-[4px]', onApplyEnum });
    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    const topLeft = screen.getByRole('textbox', { name: 'Radius Top left' });
    fireEvent.change(topLeft, { target: { value: '12' } });
    fireEvent.blur(topLeft);

    expect(onApplyEnum).toHaveBeenCalledWith('rounded-[12px_4px_4px_4px]', {
      'border-radius': '12px 4px 4px 4px',
    });
  });

  it('uses zero for the other corners when an unset radius is separated', () => {
    const onApplyEnum = vi.fn();
    renderControl({ kind: 'radius', currentClass: '', onApplyEnum });
    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    const topLeft = screen.getByRole('textbox', { name: 'Radius Top left' });
    fireEvent.change(topLeft, { target: { value: '12' } });
    fireEvent.blur(topLeft);

    expect(onApplyEnum).toHaveBeenCalledWith('rounded-[12px_0_0_0]', {
      'border-radius': '12px 0 0 0',
    });
  });

  it('reads v4 trailing-important and configured-prefix radius utilities', () => {
    renderControl({
      kind: 'radius',
      currentClass: 'tw:rounded-[12px]!',
      layer: { ...LAYER, tailwindVersion: 'v4', utilityPrefix: 'tw:' },
    });

    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveValue('12');
  });

  it('reads v3 leading-important and dash-prefixed radius utilities', () => {
    renderControl({
      kind: 'radius',
      currentClass: '!tw-rounded-[8px]',
      layer: { ...LAYER, tailwindVersion: 'v3', utilityPrefix: 'tw-' },
    });

    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveValue('8');
  });

  it('seeds separated fields from physical side and corner utilities', () => {
    renderControl({
      kind: 'radius',
      currentClass: 'rounded-[1px_2px_3px_4px] rounded-t-[8px] rounded-tr-[10px] rounded-bl-[6px]',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    expect(screen.getByRole('textbox', { name: 'Radius Top left' })).toHaveValue('8');
    expect(screen.getByRole('textbox', { name: 'Radius Top right' })).toHaveValue('10');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom right' })).toHaveValue('3');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom left' })).toHaveValue('6');
  });

  it('fills untouched corners with zero for a one-sided radius utility', () => {
    renderControl({ kind: 'radius', currentClass: 'rounded-r-[9px]' });

    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    expect(screen.getByRole('textbox', { name: 'Radius Top left' })).toHaveValue('0');
    expect(screen.getByRole('textbox', { name: 'Radius Top right' })).toHaveValue('9');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom right' })).toHaveValue('9');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom left' })).toHaveValue('0');
  });

  it('maps logical radius utilities to physical fields using the writing direction', () => {
    renderControl({
      kind: 'radius',
      currentClass: 'rounded-s-[12px] rounded-e-[8px]',
      layer: { ...LAYER, tailwindVersion: 'v4', direction: 'rtl' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    expect(screen.getByRole('textbox', { name: 'Radius Top left' })).toHaveValue('8');
    expect(screen.getByRole('textbox', { name: 'Radius Top right' })).toHaveValue('12');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom right' })).toHaveValue('12');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom left' })).toHaveValue('8');
  });

  it('combines base and responsive radius utilities per corner', () => {
    const md = { name: 'md', prefix: 'md', minPx: 768 } as const;
    renderControl({
      kind: 'radius',
      currentClass: 'rounded-[2px] md:rounded-tl-[12px]',
      layer: {
        bp: md,
        ordered: [BASE_BREAKPOINT, md],
        known: new Set(['md']),
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Separate radius values' }));

    expect(screen.getByRole('textbox', { name: 'Radius Top left' })).toHaveValue('12');
    expect(screen.getByRole('textbox', { name: 'Radius Top right' })).toHaveValue('2');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom right' })).toHaveValue('2');
    expect(screen.getByRole('textbox', { name: 'Radius Bottom left' })).toHaveValue('2');
  });
});
