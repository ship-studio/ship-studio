import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviewSizeControl, type PreviewBreakpointOption } from './PreviewSizeControl';

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
    activeBreakpoint: 'full',
    breakpointOptions: undefined as PreviewBreakpointOption[] | undefined,
    onBreakpointChange: vi.fn(),
    ...overrides,
  };
  render(<PreviewSizeControl {...props} />);
  return props;
};

describe('PreviewSizeControl', () => {
  it('shows the current size and opens the popover on click', () => {
    renderControl();
    const button = screen.getByRole('button', { name: /1440 × 900/ });
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Preview size' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preview size' })).toBeInTheDocument();
    expect(screen.getByLabelText('Width in pixels')).toHaveValue('1440');
    // Auto height renders as an empty input with the 'auto' placeholder.
    expect(screen.getByLabelText('Height in pixels (empty for auto)')).toHaveValue('');
  });

  it('applies a typed width with auto height', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: /1440 × 900/ }));
    const width = screen.getByLabelText('Width in pixels');
    fireEvent.input(width, { target: { value: '820' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onApply).toHaveBeenCalledWith(820, null);
  });

  it('applies width and height together on Enter', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: /1440 × 900/ }));
    fireEvent.input(screen.getByLabelText('Width in pixels'), { target: { value: '390' } });
    const height = screen.getByLabelText('Height in pixels (empty for auto)');
    fireEvent.input(height, { target: { value: '844' } });
    fireEvent.keyDown(height, { key: 'Enter' });
    expect(props.onApply).toHaveBeenCalledWith(390, 844);
  });

  it('rejects out-of-range widths without applying', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: /1440 × 900/ }));
    fireEvent.input(screen.getByLabelText('Width in pixels'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('Fit pane resets and closes', () => {
    const props = renderControl();
    fireEvent.click(screen.getByRole('button', { name: /1440 × 900/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit pane' }));
    expect(props.onFit).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('mentions scaling when the frame is scaled to fit', () => {
    renderControl({ scalePercent: 57 });
    fireEvent.click(screen.getByRole('button', { name: /1440 × 900/ }));
    expect(screen.getByText(/scaled to 57%/)).toBeInTheDocument();
  });

  it('keeps every breakpoint available in the size popover', () => {
    const props = renderControl({
      activeBreakpoint: 'desktop',
      breakpointOptions: [
        { value: 'full', label: 'Full', width: '100%', icon: <span aria-hidden="true" /> },
        { value: 'desktop', label: 'Desktop', width: '1440px', icon: <span aria-hidden="true" /> },
        { value: 'laptop', label: 'Laptop', width: '1024px', icon: <span aria-hidden="true" /> },
        { value: 'tablet', label: 'Tablet', width: '768px', icon: <span aria-hidden="true" /> },
        { value: 'mobile', label: 'Mobile', width: '375px', icon: <span aria-hidden="true" /> },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /1440 × 900/ }));
    expect(screen.getByRole('heading', { name: 'Breakpoints' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desktop 1440px' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mobile 375px' }));
    expect(props.onBreakpointChange).toHaveBeenCalledWith('mobile');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
