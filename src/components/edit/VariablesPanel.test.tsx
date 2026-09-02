import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { useCssVariables } from '../../hooks/useCssVariables';
import { VariablesPanel } from './VariablesPanel';

function variablesState(): ReturnType<typeof useCssVariables> {
  return {
    variables: [],
    loading: false,
    setValue: vi.fn(),
    addVariable: vi.fn(),
    analyzeDeletion: vi.fn(),
    deleteVariable: vi.fn(),
    reload: vi.fn(),
  };
}

describe('VariablesPanel', () => {
  it('renders standalone panel chrome and closes from its header', () => {
    const onClose = vi.fn();
    render(<VariablesPanel variablesState={variablesState()} onClose={onClose} />);

    expect(screen.getByTestId('variables-panel')).toBeInTheDocument();
    expect(screen.getByText('Variables')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close Variables panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('describes pinning the floating panel and unpinning the docked panel', () => {
    const onTogglePin = vi.fn();
    const props = { variablesState: variablesState(), onClose: vi.fn(), onTogglePin };

    const { rerender } = render(<VariablesPanel {...props} pinned={false} />);
    const pinButton = screen.getByRole('button', {
      name: 'Pin Variables panel to the window',
    });
    expect(pinButton).toHaveAttribute('title', 'Pin to the window');
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pinButton);
    expect(onTogglePin).toHaveBeenCalledTimes(1);

    rerender(<VariablesPanel {...props} pinned />);
    const unpinButton = screen.getByRole('button', { name: 'Unpin Variables panel' });
    expect(unpinButton).toHaveAttribute('title', 'Unpin — float over the preview');
    expect(unpinButton).toHaveAttribute('aria-pressed', 'true');
  });
});
