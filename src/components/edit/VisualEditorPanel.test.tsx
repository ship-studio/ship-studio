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
};

function renderPanel(selection: Selection | null, currentClass = 'p-3') {
  return render(
    <VisualEditorPanel
      selection={selection}
      currentClass={currentClass}
      onStepSpacing={vi.fn()}
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
    // Spacing steppers
    expect(screen.getByText('Padding')).toBeInTheDocument();
    expect(screen.getByText('Margin')).toBeInTheDocument();
    expect(screen.getByText('Gap')).toBeInTheDocument();
    // Enum controls
    expect(screen.getByText('Align')).toBeInTheDocument();
    expect(screen.getByText('Weight')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Center' })).toBeInTheDocument();
    // Save button
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows read-only reason and no controls for a read-only element', () => {
    renderPanel({
      signature: { className: 'x', tagName: 'div', ancestorClasses: [] },
      resolution: { status: 'read_only', reason: 'Dynamic classes.' },
    });
    expect(screen.getByText('Dynamic classes.')).toBeInTheDocument();
    expect(screen.queryByText('Padding')).not.toBeInTheDocument();
  });
});
