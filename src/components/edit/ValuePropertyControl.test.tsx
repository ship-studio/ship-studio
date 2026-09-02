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
