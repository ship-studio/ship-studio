import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BASE_BREAKPOINT, type LayerContext } from '../../lib/edit';
import { ColorField, resolveVariableColor } from './ColorControls';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }
);

const LAYER: LayerContext = {
  bp: BASE_BREAKPOINT,
  ordered: [BASE_BREAKPOINT],
  known: new Set(),
};

describe('ColorField', () => {
  it('resolves project color variables for both the swatch and picker', async () => {
    const variables = [
      { name: '--test-token', value: 'hsla(0, 100%, 50%, 0.8)' },
      { name: '--alias', value: 'var(--test-token)' },
    ];
    expect(resolveVariableColor('var(--alias)', variables)).toBe('hsla(0, 100%, 50%, 0.8)');

    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass="text-[var(--test-token)]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        computed={{ color: 'rgb(0, 0, 0)' }}
        variables={variables}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Text color' });
    expect(trigger.querySelector('.ss-color-swatch__color')).toHaveStyle({
      backgroundColor: 'rgba(255, 0, 0, 0.8)',
    });

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(document.querySelector('.ss-color-picker__preview-original')).toHaveStyle({
        backgroundColor: 'rgba(255, 0, 0, 0.8)',
      })
    );
  });

  it('uses the transparency checkerboard when no color is set', () => {
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass=""
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Text color' });
    expect(swatch).toHaveClass('ss-color-swatch--embedded');
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).toBeInTheDocument();
    expect(swatch).not.toHaveTextContent('—');
  });

  it('keeps the checkerboard off a swatch with a color value', () => {
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass="text-[#e2f8fd]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Text color' });
    expect(swatch.querySelector('.ss-color-swatch__chip')).toBeInTheDocument();
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).not.toBeInTheDocument();
  });

  it('shows the checkerboard behind a partially transparent color', () => {
    render(
      <ColorField
        label="Background"
        css="background-color"
        prefix="bg"
        currentClass="bg-[rgba(226,248,253,0.5)]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Background color' });
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).toBeInTheDocument();
    expect(swatch.querySelector('.ss-color-swatch__color')).toHaveStyle({
      backgroundColor: 'rgba(226, 248, 253, 0.5)',
    });
  });

  it('shows the checkerboard behind a fully transparent color', () => {
    render(
      <ColorField
        label="Background"
        css="background-color"
        prefix="bg"
        currentClass="bg-[transparent]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Background color' });
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).toBeInTheDocument();
  });

  it('switching the display format never writes a color', () => {
    const onApplyEnum = vi.fn();
    const { unmount } = render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass=""
        layer={LAYER}
        onApplyEnum={onApplyEnum}
        onReset={vi.fn()}
      />
    );

    // No value at all: switching format must not commit the #000000 fallback.
    fireEvent.click(screen.getByRole('button', { name: 'Text value format' }));
    fireEvent.click(screen.getByRole('option', { name: 'RGB' }));
    expect(onApplyEnum).not.toHaveBeenCalled();
    unmount();

    // Only a computed (browser-rendered) color: switching format must not promote
    // it into an explicit class either — but the field does re-render it.
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass=""
        layer={LAYER}
        onApplyEnum={onApplyEnum}
        onReset={vi.fn()}
        computed={{ color: '#ff0000' }}
      />
    );
    const field = screen.getByRole('textbox', { name: 'Text value' });
    expect(field).toHaveValue('#ff0000');

    fireEvent.click(screen.getByRole('button', { name: 'Text value format' }));
    fireEvent.click(screen.getByRole('option', { name: 'RGB' }));
    expect(onApplyEnum).not.toHaveBeenCalled();
    expect(field).toHaveValue('rgb(255, 0, 0)');
  });

  it('does not treat an unresolved color variable as transparent', () => {
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass="text-[var(--foreground)]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const swatch = screen.getByRole('button', { name: 'Text color' });
    expect(swatch.querySelector('.ss-color-swatch__chip--checkerboard')).not.toBeInTheDocument();
  });
});
