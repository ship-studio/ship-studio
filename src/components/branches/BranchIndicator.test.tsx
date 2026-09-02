import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BranchIndicator } from './BranchIndicator';

vi.mock('../../lib/branches', () => ({
  discardChanges: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./DiffModal', () => ({
  DiffModal: ({ filePath }: { filePath: string }) => <div>Diff for {filePath}</div>,
}));

describe('BranchIndicator', () => {
  const defaultProps = {
    currentBranch: 'feature/test',
    hasUncommittedChanges: true,
    changedFiles: [{ path: 'src/test.ts', status: 'modified' as const }],
    projectPath: '/path/to/project',
  };

  it('only renders while there are unsaved changes', () => {
    const { rerender } = render(<BranchIndicator {...defaultProps} />);

    expect(screen.getByRole('button', { name: /review 1 unsaved change/i })).toBeInTheDocument();
    rerender(<BranchIndicator {...defaultProps} hasUncommittedChanges={false} changedFiles={[]} />);
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();
  });

  it('shows branch and count without inferring a live state', () => {
    render(
      <BranchIndicator
        {...defaultProps}
        currentBranch="main"
        changedFiles={[
          { path: 'src/test.ts', status: 'modified' },
          { path: 'README.md', status: 'added' },
        ]}
      />
    );

    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('2 unsaved')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('opens changed files on click rather than hover', () => {
    render(<BranchIndicator {...defaultProps} />);

    fireEvent.mouseEnter(screen.getByRole('button', { name: /review/i }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(screen.getByText('1 Unsaved Change')).toBeInTheDocument();
    expect(screen.getByText('test.ts')).toBeInTheDocument();
    expect(screen.queryByText('Push')).not.toBeInTheDocument();
  });

  it('opens the existing diff view for a changed file', () => {
    render(<BranchIndicator {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    fireEvent.click(screen.getByRole('button', { name: /test.ts/i }));

    expect(screen.getByText('Diff for src/test.ts')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('closes on Escape and reports controlled state changes', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <BranchIndicator {...defaultProps} isOpen={false} onOpenChange={onOpenChange} />
    );

    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    rerender(<BranchIndicator {...defaultProps} isOpen={true} onOpenChange={onOpenChange} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('opens the shared Push menu from the grouped status segment', () => {
    const onOpenChange = vi.fn();
    render(
      <BranchIndicator {...defaultProps} isOpen={false} onOpenChange={onOpenChange} opensPushMenu />
    );

    fireEvent.click(screen.getByRole('button', { name: /open push options/i }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });
});
