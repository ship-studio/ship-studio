import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MediaQueryGroupCard } from './MediaQueryGroupCard';

describe('MediaQueryGroupCard', () => {
  it('groups selectors beneath one editable media-query header', () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <MediaQueryGroupCard
        condition="screen and (max-width: 767px)"
        file="styles/site.css"
        onRename={onRename}
        onDelete={onDelete}
        addSelector={<button type="button">Add selector</button>}
      >
        <div data-testid="selector-one">.mb-24</div>
        <div data-testid="selector-two">.hero-title</div>
      </MediaQueryGroupCard>
    );

    expect(screen.getByTestId('media-query-group')).toBeInTheDocument();
    const source = screen.getByText('site.css');
    expect(source).toBeInTheDocument();
    expect(source.querySelector('svg')).toBeInTheDocument();
    expect(source.parentElement).toHaveClass('ss-media-query-group__source-row');
    const deleteButton = screen.getByRole('button', { name: 'Delete media query' });
    expect(deleteButton).toBeInTheDocument();
    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.getByTestId('selector-one')).toBeInTheDocument();
    expect(screen.getByTestId('selector-two')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add selector' })).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: 'Collapse media query' });
    const composer = document.querySelector('.ss-media-query-group__query-card');
    expect(composer).not.toContainElement(collapse);
    vi.spyOn(composer!, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 40,
      left: 20,
      top: 40,
      right: 340,
      bottom: 100,
      width: 320,
      height: 60,
      toJSON: () => ({}),
    });

    fireEvent.click(composer!);
    expect(screen.getByRole('combobox', { name: 'Continue media query' })).toHaveFocus();
    expect(screen.getByRole('option', { name: 'and' })).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toHaveStyle({ left: '20px', top: '112px', width: '320px' });

    fireEvent.click(collapse);
    expect(screen.queryByTestId('selector-one')).not.toBeInTheDocument();
    const summary = screen.getByText('2 class selectors');
    expect(summary).toBeInTheDocument();
    expect(composer).not.toContainElement(summary);
    expect(screen.getByRole('button', { name: 'Expand media query' })).toBeInTheDocument();
  });
});
