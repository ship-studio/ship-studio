import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddSelectorBar } from './CssCascadePanel';
import { MediaQueryGroupCard } from './MediaQueryGroupCard';

function MediaQueryCreationHarness({ onAddSelector }: { onAddSelector: () => void }) {
  const [condition, setCondition] = useState<string | null>(null);
  return (
    <>
      <AddSelectorBar
        onAddSelector={onAddSelector}
        onAddMediaQuery={setCondition}
        suggestions={[]}
        existing={[]}
      />
      {condition != null ? (
        <MediaQueryGroupCard
          condition={condition}
          autoFocusQuery
          commitQueryOnAppend
          onRename={setCondition}
          addSelector={
            <AddSelectorBar
              onAddSelector={onAddSelector}
              suggestions={[]}
              existing={[]}
              fixedCondition={`@media ${condition}`}
            />
          }
        >
          {null}
        </MediaQueryGroupCard>
      ) : null}
    </>
  );
}

describe('AddSelectorBar', () => {
  it('turns an @media selector draft into an active media-query composer', () => {
    const onAddSelector = vi.fn();
    render(<MediaQueryCreationHarness onAddSelector={onAddSelector} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add selector' }));
    const selector = screen.getByRole('combobox', { name: 'Add selector' });
    fireEvent.change(selector, { target: { value: '@media' } });
    fireEvent.keyDown(selector, { key: 'Enter' });

    const group = screen.getByTestId('media-query-group');
    expect(document.querySelector('[data-query-chunk-kind="at-rule"]')).toHaveTextContent('@media');
    const query = screen.getByRole('combobox', { name: 'Continue media query' });
    expect(query).toHaveFocus();
    expect(within(group).getByRole('button', { name: 'Add selector' })).toBeEnabled();
    expect(within(group).getByRole('status')).toHaveTextContent('Incomplete query');
    expect(within(group).queryByText(/class selector/)).not.toBeInTheDocument();
    expect(onAddSelector).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(query).not.toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    const addWhileIncomplete = within(group).getByRole('button', { name: 'Add selector' });
    fireEvent.click(addWhileIncomplete);
    const pendingSelector = within(group).getByRole('combobox', { name: 'Add selector' });
    fireEvent.change(pendingSelector, { target: { value: '.hero-title' } });
    fireEvent.keyDown(pendingSelector, { key: 'Enter' });
    expect(onAddSelector).toHaveBeenCalledWith('.hero-title', '@media ');

    fireEvent.focus(query);
    fireEvent.change(query, { target: { value: 'screen' } });
    fireEvent.keyDown(query, { key: 'Enter' });

    expect(within(group).getByText('screen')).toBeInTheDocument();
    expect(within(group).queryByRole('status')).not.toBeInTheDocument();
    const addNestedSelector = within(group).getByRole('button', { name: 'Add selector' });
    expect(addNestedSelector).toBeEnabled();
    fireEvent.click(addNestedSelector);
    expect(within(group).getByRole('combobox', { name: 'Add selector' })).toBeInTheDocument();
    expect(onAddSelector).toHaveBeenCalledOnce();
  });

  it('keeps the top action visible and submits nested selectors with a separate condition', () => {
    const onAddSelector = vi.fn();
    const { rerender } = render(
      <AddSelectorBar onAddSelector={onAddSelector} suggestions={[]} existing={[]} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add selector' }));

    expect(screen.getByRole('button', { name: 'Add selector' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'New selector' })).toBeInTheDocument();

    rerender(
      <AddSelectorBar
        onAddSelector={onAddSelector}
        suggestions={[]}
        existing={[]}
        fixedCondition="@media screen and (max-width: 991px)"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add selector' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Add selector' }), {
      target: { value: '.hero-title' },
    });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Add selector' }), { key: 'Enter' });

    expect(onAddSelector).toHaveBeenLastCalledWith(
      '.hero-title',
      '@media screen and (max-width: 991px)'
    );
  });
});
