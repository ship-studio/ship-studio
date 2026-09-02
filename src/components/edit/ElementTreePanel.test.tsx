import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ElementTreePanel } from './ElementTreePanel';

describe('ElementTreePanel', () => {
  it('describes pinning the floating panel and unpinning the docked panel', () => {
    const onTogglePin = vi.fn();
    const props = {
      tree: { id: 1, tag: 'body', cls: '', text: '', children: [] },
      truncated: false,
      selectedId: 1,
      affectedIds: [],
      onSelect: vi.fn(),
      onHover: vi.fn(),
      projectPath: '/tmp/project',
      selectedSignature: null,
      onTogglePin,
    };

    const { rerender } = render(<ElementTreePanel {...props} pinned={false} />);
    const pinButton = screen.getByRole('button', { name: 'Pin Elements panel to the window' });
    expect(pinButton).toHaveAttribute('title', 'Pin to the window');
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    rerender(<ElementTreePanel {...props} pinned />);
    const unpinButton = screen.getByRole('button', { name: 'Unpin Elements panel' });
    expect(unpinButton).toHaveAttribute('title', 'Unpin — float over the workspace');
    expect(unpinButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows view-only state without a redundant Visual tab', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [{ id: 2, tag: 'div', cls: 'card', text: '', children: [] }],
        }}
        truncated={false}
        selectedId={1}
        affectedIds={[2]}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    expect(screen.getByText('View only')).toHaveAttribute(
      'data-tooltip-content',
      'Turn on edit mode to select and edit elements.'
    );
    expect(screen.queryByText('View-only mode')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Visual' })).not.toBeInTheDocument();
    expect(
      screen.getByTestId('element-tree-panel').querySelector('[data-tree-id="2"]')
    ).toHaveClass('affected');
  });

  it('swaps supported tag names for the Insert Element icons', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [
            { id: 2, tag: 'div', cls: 'card', text: '', children: [] },
            { id: 3, tag: 'main', cls: '', text: '', children: [] },
          ],
        }}
        truncated={false}
        selectedId={1}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    const panel = screen.getByTestId('element-tree-panel');
    const toggle = screen.getByRole('button', { name: 'Show tag icons' });
    expect(panel.querySelector('[data-tree-id="2"] .ss-tree-tag')).toHaveTextContent('div');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Show tag names' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      panel.querySelector('[data-tree-id="2"] [data-icon-name="ElementDivIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="2"] .ss-tree-tag')).not.toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="3"] .ss-tree-tag')).toHaveTextContent('main');
  });
});
