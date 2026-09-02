import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDevDesignSystemLabRequested } from './DevDesignSystemLab';
import { DesignSystemLab } from './DesignSystemLab';

describe('development design-system lab gate', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires the explicit lab query parameter', () => {
    expect(isDevDesignSystemLabRequested('?designSystemLab=1')).toBe(true);
    expect(isDevDesignSystemLabRequested('?designSystemLab=0')).toBe(false);
    expect(isDevDesignSystemLabRequested('')).toBe(false);
  });

  it('renders real primitive families and the current Button medium size', () => {
    render(<DesignSystemLab />);

    expect(screen.getByRole('heading', { name: 'Primitive lab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'medium' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Fields and property controls' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Ship Studio development design-system lab' })
    ).toBeInTheDocument();
  });
});
