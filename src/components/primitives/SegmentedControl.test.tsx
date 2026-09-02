import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

describe('SegmentedControl', () => {
  it('uses aria-pressed as the single selected-state contract', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        value="left"
        options={[
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ]}
        aria-label="Align"
        onValueChange={onValueChange}
      />
    );

    expect(screen.getByRole('button', { name: 'Left' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Right' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    expect(onValueChange).toHaveBeenCalledWith('right');
  });
});
