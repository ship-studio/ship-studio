import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceModes } from './WorkspaceModes';

function renderModes(overrides: Partial<Parameters<typeof WorkspaceModes>[0]> = {}) {
  const props: Parameters<typeof WorkspaceModes>[0] = {
    hasPreview: true,
    isPreviewHidden: false,
    workspaceTab: 'code',
    setIsPreviewHidden: vi.fn(),
    setIsAgentPanelHidden: vi.fn(),
    setWorkspaceTab: vi.fn(),
    onSelectPreview: vi.fn(),
    ...overrides,
  };
  render(<WorkspaceModes {...props} />);
  return props;
}

describe('WorkspaceModes', () => {
  it('shows the Preview tab whenever the project supports preview', () => {
    renderModes();
    expect(screen.getByRole('tab', { name: /preview/i })).toBeInTheDocument();
  });

  it('fires onSelectPreview when the Preview tab is picked', () => {
    const props = renderModes();
    fireEvent.click(screen.getByRole('tab', { name: /preview/i }));
    expect(props.onSelectPreview).toHaveBeenCalledTimes(1);
    expect(props.setWorkspaceTab).toHaveBeenCalledWith('preview');
  });

  it('does not fire onSelectPreview for other tabs', () => {
    const props = renderModes({ workspaceTab: 'preview' });
    fireEvent.click(screen.getByRole('tab', { name: /code/i }));
    expect(props.onSelectPreview).not.toHaveBeenCalled();
  });
});
