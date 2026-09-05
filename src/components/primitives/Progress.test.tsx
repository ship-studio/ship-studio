import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Progress } from './Progress';

describe('Progress', () => {
  it('exposes a determinate progressbar and renders the matching width', () => {
    render(<Progress value={56} aria-label="Upload progress" />);

    const progress = screen.getByRole('progressbar', { name: 'Upload progress' });
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).toHaveAttribute('aria-valuenow', '56');
    expect(progress.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({
      width: '56%',
    });
  });

  it('clamps values to the configured range', () => {
    render(<Progress value={240} max={200} aria-label="Build progress" />);

    const progress = screen.getByRole('progressbar', { name: 'Build progress' });
    expect(progress).toHaveAttribute('aria-valuenow', '200');
    expect(progress.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({
      width: '100%',
    });
  });

  it('omits aria-valuenow for an indeterminate progressbar', () => {
    render(<Progress aria-label="Loading" />);

    const progress = screen.getByRole('progressbar', { name: 'Loading' });
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(progress).toHaveClass('ss-progress--indeterminate');
  });
});
