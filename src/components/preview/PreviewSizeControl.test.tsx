import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviewSizeControl } from './PreviewSizeControl';

vi.mock('../../lib/analytics', () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

const renderControl = (overrides = {}) => {
  const props = {
    width: 1440,
    height: 900,
    hasCustomHeight: false,
    scalePercent: null as number | null,
    onApply: vi.fn(),
    onFit: vi.fn(),
    ...overrides,
  };
  render(<PreviewSizeControl {...props} />);
  return props;
};

describe('PreviewSizeControl', () => {
  it('shows the current size and opens the popover on click', () => {
    renderControl();
    const button = screen.getByRole('button', { name: '1440 × 900' });
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Set preview size' })).toBeInTheDocument();
    expect(screen.getByLabelText('Width in pixels')).toHaveValue(1440);
    // Auto height renders as an empty input with the 'auto' placeholder.
    expect(screen.getByLabelText('Height in pixels (empty for auto)')).toHaveValue(null);
  });

  it('applies a typed width with auto height', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: '1440 × 900' }));
    const width = screen.getByLabelText('Width in pixels');
    fireEvent.change(width, { target: { value: '820' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onApply).toHaveBeenCalledWith(820, null);
  });

  it('applies width and height together on Enter', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: '1440 × 900' }));
    fireEvent.change(screen.getByLabelText('Width in pixels'), { target: { value: '390' } });
    const height = screen.getByLabelText('Height in pixels (empty for auto)');
    fireEvent.change(height, { target: { value: '844' } });
    fireEvent.keyDown(height, { key: 'Enter' });
    expect(props.onApply).toHaveBeenCalledWith(390, 844);
  });

  it('rejects out-of-range widths without applying', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: '1440 × 900' }));
    fireEvent.change(screen.getByLabelText('Width in pixels'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('Fit pane resets and closes', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: '1440 × 900' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit pane' }));
    expect(props.onFit).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('mentions scaling when the frame is scaled to fit', () => {
    renderControl({ scalePercent: 57 });
    fireEvent.click(screen.getByRole('button', { name: '1440 × 900' }));
    expect(screen.getByText(/scaled to 57%/)).toBeInTheDocument();
  });
});
