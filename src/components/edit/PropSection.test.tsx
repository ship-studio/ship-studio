import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PropSection } from './PropSection';

describe('PropSection', () => {
  it('keeps disclosure behavior native and keyboard-accessible', () => {
    render(
      <PropSection title="Spacing" defaultOpen={false}>
        <span>Spacing controls</span>
      </PropSection>
    );

    const details = screen.getByText('Spacing').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');

    fireEvent.click(screen.getByText('Spacing'));
    expect(details).toHaveProperty('open', true);
  });
});
