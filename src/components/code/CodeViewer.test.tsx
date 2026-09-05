import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FileContent } from '../../lib/code';
import type { EditorSelectionInfo } from './CodeFileEditor';
import { CodeViewer } from './CodeViewer';

vi.mock('../../lib/ide', () => ({
  checkIdeAvailability: vi.fn().mockResolvedValue({ vscode: false, cursor: false }),
  openInIde: vi.fn(),
}));

vi.mock('./CodeFileEditor', () => ({
  CodeFileEditor: ({
    onSelectionChange,
  }: {
    onSelectionChange?: (selection: EditorSelectionInfo | null) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelectionChange?.({
          text: 'selected code',
          startLine: 27,
          endLine: 53,
          mouseX: 100,
          mouseY: 100,
        })
      }
    >
      Select code
    </button>
  ),
}));

const fileContent: FileContent = {
  content: 'selected code',
  isBinary: false,
  isTruncated: false,
  size: 13,
  language: 'json',
};

describe('CodeViewer selection reference', () => {
  it('uses right when collapsed and down when expanded', async () => {
    await act(async () => {
      render(
        <CodeViewer
          projectPath="/project"
          filePath="package-lock.json"
          fileContent={fileContent}
          isLoading={false}
          error={null}
          onSendToAgent={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select code' }));

    const reference = screen.getByRole('button', { name: 'package-lock.json:27-53' });
    const attachment = reference.parentElement;
    expect(reference).toHaveAttribute('aria-expanded', 'false');
    expect(attachment).toHaveClass('code-selection-attachment');
    expect(reference.querySelector('[data-icon-name="ChevronRightIcon"]')).toHaveAttribute(
      'width',
      '14'
    );
    expect(reference.querySelector('[data-icon-name="ChevronIcon"]')).not.toBeInTheDocument();

    fireEvent.click(reference);

    expect(reference).toHaveAttribute('aria-expanded', 'true');
    expect(reference.querySelector('[data-icon-name="ChevronIcon"]')).toHaveAttribute(
      'width',
      '14'
    );
    expect(reference.querySelector('[data-icon-name="ChevronRightIcon"]')).not.toBeInTheDocument();
    expect(screen.getByText('selected code')).toBeInTheDocument();
  });
});
