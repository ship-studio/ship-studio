import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VisualEditorPanel } from './VisualEditorPanel';
import type { Selection } from '../../hooks/useVisualEditor';

const resolvedSelection: Selection = {
  signature: { className: 'p-3', tagName: 'div', ancestorClasses: [] },
  resolution: {
    status: 'resolved',
    file: 'components/Hero.tsx',
    line: 11,
    column: 1,
    class_name: 'p-3',
    confidence: 'unique',
  },
  instanceCount: 1,
};

function renderPanel(selection: Selection | null, currentClass = 'p-3') {
  return render(
    <VisualEditorPanel
      selection={selection}
      currentClass={currentClass}
      onStepGap={vi.fn()}
      onSetSide={vi.fn()}
      onApplyEnum={vi.fn()}
      onCommit={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

describe('VisualEditorPanel', () => {
  it('renders every control for a resolved element', () => {
    renderPanel(resolvedSelection);
    // Source line
    expect(screen.getByText('components/Hero.tsx:11')).toBeInTheDocument();
    // Box-model spacing editor with per-side fields
    expect(screen.getByTestId('spacing-box')).toBeInTheDocument();
    expect(screen.getByLabelText('Padding top')).toBeInTheDocument();
    expect(screen.getByLabelText('Margin left')).toBeInTheDocument();
    // Gap stepper + enum controls
    expect(screen.getByText('Gap')).toBeInTheDocument();
    expect(screen.getByText('Align')).toBeInTheDocument();
    expect(screen.getByText('Weight')).toBeInTheDocument();
    // Align renders icon buttons ("Left" is unique to Align)
    expect(screen.getByRole('button', { name: 'Left' })).toBeInTheDocument();
    // New properties
    expect(screen.getByText('Opacity')).toBeInTheDocument();
    // Color controls render as swatch buttons that open the picker popover
    expect(screen.getByRole('button', { name: 'Text color' })).toBeInTheDocument();
    // Save button
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows read-only reason and no controls for a read-only element', () => {
    renderPanel({
      signature: { className: 'x', tagName: 'div', ancestorClasses: [] },
      resolution: { status: 'read_only', reason: 'Dynamic classes.' },
      instanceCount: 1,
    });
    expect(screen.getByText('Dynamic classes.')).toBeInTheDocument();
    expect(screen.queryByTestId('spacing-box')).not.toBeInTheDocument();
  });

  it('warns when multiple elements share the source', () => {
    renderPanel({ ...resolvedSelection, instanceCount: 4 });
    expect(screen.getByText(/Editing 4 elements/)).toBeInTheDocument();
  });
});
