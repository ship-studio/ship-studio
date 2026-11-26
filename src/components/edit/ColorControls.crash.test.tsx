import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BASE_BREAKPOINT, type LayerContext } from '../../lib/edit';
import { ColorField } from './ColorControls';

/**
 * The #1211 path with the parse fix taken away: the picker's Variables tab
 * hands every custom property to culori's raw `parse`, which throws on
 * `translateY(-4px)`. This proves the containment on its own — the next bug of
 * this shape costs the colour picker, not the window.
 */
vi.mock('../../lib/parseColor', async () => {
  const culori = await import('culori');
  return { parseColor: (value: string) => culori.parse(value) };
});

const mocks = vi.hoisted(() => ({
  logError: vi.fn<(error: Error, context: Record<string, unknown>, source?: string) => void>(),
}));
vi.mock('../../lib/logger', () => ({
  logger: { logError: mocks.logError, error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  }
);

const LAYER: LayerContext = { bp: BASE_BREAKPOINT, ordered: [BASE_BREAKPOINT], known: new Set() };

describe('ColorField crash containment (#1211)', () => {
  it('replaces only the colour picker when it crashes, and reports it as the colour picker', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ColorField
        label="Text"
        css="color"
        prefix="text"
        currentClass="text-[#336699]"
        layer={LAYER}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        computed={{ color: 'rgb(51, 102, 153)' }}
        variables={[
          { name: '--brand', value: '#336699' },
          { name: '--lift', value: 'translateY(-4px)' },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Text color' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Color picker crashed');
    // The field that opened it is still there and still works.
    expect(screen.getByRole('button', { name: 'Text color' })).toBeInTheDocument();
    const [error, context, source] = mocks.logError.mock.calls[0];
    expect(String(error)).toContain("reading 'type'");
    expect(context.panel).toBe('color-picker');
    expect(source).toBe('frontend-crash');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
