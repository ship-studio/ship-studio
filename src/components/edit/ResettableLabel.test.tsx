/**
 * Provenance-label behavior for the visual editor's controls: blue set-here
 * (Reset pill), neutral breakpoint-inherited (hollow dot only — orange is
 * reserved), and orange ancestor-inherited (opens the provenance popover).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResettableLabel } from './ResettableLabel';
import { BASE_BREAKPOINT } from '../../lib/edit';
import type { Breakpoint, InheritedProp } from '../../lib/edit';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

const MD: Breakpoint = { name: 'md', prefix: 'md', minPx: 768 };

const INHERITED: InheritedProp = {
  cssValue: '18px',
  tagName: 'div',
  className: 'card text-lg',
  ancestorClasses: ['hero'],
  token: 'text-lg',
};

function renderLabel(props: Partial<Parameters<typeof ResettableLabel>[0]> = {}) {
  return render(
    <ResettableLabel
      label="Size"
      definedAt={null}
      active={BASE_BREAKPOINT}
      onReset={vi.fn()}
      {...props}
    />
  );
}

describe('ResettableLabel provenance states', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('set at the active breakpoint: clickable label opens the floating Reset', () => {
    const onReset = vi.fn();
    const { container } = renderLabel({ definedAt: BASE_BREAKPOINT, onReset });
    expect(container.firstChild).toHaveClass('ss-edit-panel__label--modified');

    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    const reset = screen.getByText('Reset');
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('Alt-clicking a set label resets immediately', () => {
    const onReset = vi.fn();
    renderLabel({ definedAt: BASE_BREAKPOINT, onReset });

    fireEvent.click(screen.getByRole('button', { name: /Size/ }), { altKey: true });

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Reset')).toBeNull();
  });

  it('breakpoint-inherited value: neutral label with a hollow dot — no orange, no button', () => {
    const { container } = renderLabel({ definedAt: BASE_BREAKPOINT, active: MD });
    const label = container.querySelector('.ss-edit-panel__label')!;
    // Orange now means ANCESTOR-inherited only.
    expect(label).not.toHaveClass('ss-edit-panel__label--inherited');
    expect(label).not.toHaveClass('ss-edit-panel__label--modified');
    expect(container.querySelector('.ss-layer-dot--inherited')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ancestor-inherited value: orange tag whose popover shows provenance and adopts', async () => {
    invokeMock.mockResolvedValue({
      status: 'resolved',
      file: 'components/Card.tsx',
      line: 7,
      column: 1,
      class_name: 'card text-lg',
      confidence: 'unique',
    });
    const onAdopt = vi.fn();
    const onOpenInCode = vi.fn();
    const { container } = renderLabel({
      inherited: INHERITED,
      onAdopt,
      projectPath: '/tmp/demo',
      onOpenInCode,
    });
    expect(container.firstChild).toHaveClass('ss-edit-panel__label--inherited');
    expect(container.firstChild).not.toHaveClass('ss-edit-panel__label--modified');

    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    expect(await screen.findByText(/div\.card/)).toBeInTheDocument();
    expect(screen.getByText('text-lg')).toBeInTheDocument(); // attributed token chip
    expect(screen.getByText('18px')).toBeInTheDocument(); // honest computed value
    expect(await screen.findByText(/Card\.tsx:7/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set here explicitly' }));
    expect(onAdopt).toHaveBeenCalledTimes(1);
    // Popover closes after adopting.
    await waitForAbsent(() => screen.queryByRole('dialog'));
  });

  it('Escape dismisses the provenance popover without adopting', () => {
    const onAdopt = vi.fn();
    renderLabel({
      inherited: INHERITED,
      onAdopt,
      projectPath: '/tmp/demo',
    });
    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAdopt).not.toHaveBeenCalled();
  });
});

async function waitForAbsent(query: () => HTMLElement | null) {
  for (let i = 0; i < 20 && query(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(query()).toBeNull();
}
