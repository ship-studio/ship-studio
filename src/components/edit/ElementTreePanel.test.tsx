import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ElementTreePanel } from './ElementTreePanel';
import type { ElementTreeNode } from '../../hooks/useElementTree';

// body
//   header (2)
//   div.route-fade (3)
//     h2 (5)
//     span (6)
//   footer (4)
const TREE: ElementTreeNode = {
  id: 1,
  tag: 'body',
  cls: '',
  text: '',
  children: [
    { id: 2, tag: 'header', cls: '', text: '', children: [] },
    {
      id: 3,
      tag: 'div',
      cls: 'route-fade',
      text: '',
      children: [
        { id: 5, tag: 'h2', cls: '', text: '', children: [] },
        { id: 6, tag: 'span', cls: '', text: '', children: [] },
      ],
    },
    { id: 4, tag: 'footer', cls: '', text: '', children: [] },
  ],
};

function setup(selectedId: number | null) {
  const onSelect = vi.fn<(id: number) => void>();
  render(
    <ElementTreePanel
      tree={TREE}
      truncated={false}
      selectedId={selectedId}
      onSelect={onSelect}
      onHover={() => {}}
      projectPath="/tmp/project"
      selectedSignature={null}
    />
  );
  return { onSelect };
}

describe('ElementTreePanel keyboard navigation', () => {
  it('ArrowDown selects the next sibling', () => {
    const { onSelect } = setup(3);
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith(4);
  });

  it('ArrowUp selects the previous sibling', () => {
    const { onSelect } = setup(3);
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('ArrowLeft selects the parent', () => {
    const { onSelect } = setup(3);
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('ArrowRight dives into the first child', () => {
    const { onSelect } = setup(3);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it('does not wrap past the first sibling', () => {
    const { onSelect } = setup(2); // header is the first child of body
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not wrap past the last sibling', () => {
    const { onSelect } = setup(4); // footer is the last child of body
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does nothing for the root (no parent, no siblings)', () => {
    const { onSelect } = setup(1);
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does nothing when no element is selected', () => {
    const { onSelect } = setup(null);
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores arrows while a text field is focused (e.g. the edit panel)', () => {
    const onSelect = vi.fn<(id: number) => void>();
    render(
      <>
        <input data-testid="field" />
        <ElementTreePanel
          tree={TREE}
          truncated={false}
          selectedId={3}
          onSelect={onSelect}
          onHover={() => {}}
          projectPath="/tmp/project"
          selectedSignature={null}
        />
      </>
    );
    const field = screen.getByTestId('field');
    field.focus();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('ElementTreePanel search', () => {
  function renderPanel() {
    render(
      <ElementTreePanel
        tree={TREE}
        truncated={false}
        selectedId={null}
        onSelect={() => {}}
        onHover={() => {}}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );
    return screen.getByLabelText('Search elements');
  }

  const type = (input: HTMLElement, value: string) =>
    fireEvent.change(input, { target: { value } });

  it('renders a search box', () => {
    renderPanel();
    expect(screen.getByLabelText('Search elements')).toBeInTheDocument();
  });

  it('filters to matching nodes plus their ancestor path', () => {
    const input = renderPanel();
    type(input, 'footer');
    expect(screen.getByText('footer')).toBeInTheDocument(); // the match
    expect(screen.getByText('body')).toBeInTheDocument(); // its ancestor
    expect(screen.queryByText('header')).not.toBeInTheDocument();
    expect(screen.queryByText('div')).not.toBeInTheDocument();
  });

  it('matches on class and drops non-matching descendants', () => {
    const input = renderPanel();
    type(input, 'route'); // div.route-fade
    expect(screen.getByText('div')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.queryByText('h2')).not.toBeInTheDocument();
    expect(screen.queryByText('span')).not.toBeInTheDocument();
    expect(screen.queryByText('header')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', () => {
    const input = renderPanel();
    type(input, 'zzz-no-match');
    expect(screen.getByText('No matching elements')).toBeInTheDocument();
    expect(screen.queryByText('header')).not.toBeInTheDocument();
  });

  it('restores the full tree when the query is cleared', () => {
    const input = renderPanel();
    type(input, 'footer');
    expect(screen.queryByText('header')).not.toBeInTheDocument();
    type(input, '');
    expect(screen.getByText('header')).toBeInTheDocument();
    expect(screen.getByText('footer')).toBeInTheDocument();
  });

  it('re-enters the filtered view when arrowing from a selection the query pruned out', () => {
    const onSelect = vi.fn<(id: number) => void>();
    render(
      <ElementTreePanel
        tree={TREE}
        truncated={false}
        selectedId={2} // header — NOT a match for the query below, so it gets pruned
        onSelect={onSelect}
        onHover={() => {}}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );
    fireEvent.change(screen.getByLabelText('Search elements'), { target: { value: 'footer' } });
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    // Nav would otherwise be dead; instead it re-enters at the filtered tree root (body, id 1).
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('shows a truncation-aware empty state when a search finds nothing in a truncated tree', () => {
    render(
      <ElementTreePanel
        tree={TREE}
        truncated={true}
        selectedId={null}
        onSelect={() => {}}
        onHover={() => {}}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );
    fireEvent.change(screen.getByLabelText('Search elements'), { target: { value: 'zzz-nope' } });
    expect(
      screen.getByText('No matches in the loaded part of this large page.')
    ).toBeInTheDocument();
  });

  it('keeps a filtering-aware truncation note visible while searching a truncated tree', () => {
    render(
      <ElementTreePanel
        tree={TREE}
        truncated={true}
        selectedId={null}
        onSelect={() => {}}
        onHover={() => {}}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );
    fireEvent.change(screen.getByLabelText('Search elements'), { target: { value: 'footer' } });
    expect(screen.getByText(/searched only the first part/i)).toBeInTheDocument();
  });
});
