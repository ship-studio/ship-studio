import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PixelLoader } from './PixelLoader';

describe('PixelLoader', () => {
  it('renders the centre-out rings variant', () => {
    const { container } = render(
      <PixelLoader size="sm" variant="rings" label="Working on agent" data-testid="rings-loader" />
    );

    expect(screen.getByTestId('rings-loader')).toHaveClass('ss-pixel-loader--rings');
    expect(container.querySelectorAll('.ss-pixel-loader__pixel')).toHaveLength(25);
    expect(container.querySelectorAll('[data-ring="0"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ring="1"]')).toHaveLength(8);
    expect(container.querySelectorAll('[data-ring="2"]')).toHaveLength(16);
  });

  it('renders accessible single- and quad-core pixel grids with the selected variants', () => {
    const { container } = render(
      <PixelLoader size="lg" variant="scan" label="Building preview" data-testid="loader" />
    );

    const loader = screen.getByTestId('loader');
    expect(loader).toHaveAttribute('role', 'status');
    expect(loader).toHaveAccessibleName('Building preview');
    expect(loader).toHaveClass('ss-pixel-loader--lg', 'ss-pixel-loader--scan');
    expect(container.querySelectorAll('.ss-pixel-loader__pixel')).toHaveLength(25);
    expect(container.querySelectorAll('[data-ring="0"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-ring="1"]')).toHaveLength(8);
    expect(container.querySelectorAll('[data-ring="2"]')).toHaveLength(16);

    const quad = render(
      <PixelLoader variant="ripple-quad" label="Loading projects" data-testid="quad-loader" />
    );
    expect(screen.getByTestId('quad-loader')).toHaveClass(
      'ss-pixel-loader--ripple-quad',
      'ss-pixel-loader--grid-6'
    );
    expect(quad.container.querySelectorAll('.ss-pixel-loader__pixel')).toHaveLength(36);
    expect(quad.container.querySelectorAll('[data-ring="0"]')).toHaveLength(4);
    expect(quad.container.querySelectorAll('[data-ring="1"]')).toHaveLength(12);
    expect(quad.container.querySelectorAll('[data-ring="2"]')).toHaveLength(20);

    const custom = render(<PixelLoader gridSize={7} coreSize={3} data-testid="custom-loader" />);
    expect(screen.getByTestId('custom-loader')).toHaveStyle({
      '--pixel-loader-grid-size': '7',
    });
    expect(custom.container.querySelectorAll('.ss-pixel-loader__pixel')).toHaveLength(49);
    expect(custom.container.querySelectorAll('[data-ring="0"]')).toHaveLength(9);
    expect(custom.container.querySelectorAll('[data-ring="1"]')).toHaveLength(16);
    expect(custom.container.querySelectorAll('[data-ring="2"]')).toHaveLength(24);
  });
});
