import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CascadeRuleCard } from './CascadeRuleCard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CascadeRuleCard', () => {
  it('renders the draft status in the header without taking space from properties', () => {
    render(
      <CascadeRuleCard
        editable
        draft
        selector=".button"
        body={{ items: [] }}
        overridden={new Map()}
        onChange={vi.fn()}
      />
    );

    const message = screen.getByText('No rules applied');
    const card = screen.getByTestId('cascade-card');

    expect(message).toHaveClass('ss-cascade-card__draft-status');
    expect(card.querySelector('.ss-cascade-card__head')).toContainElement(message);
    expect(card.querySelector('.ss-cascade-card__body')).not.toContainElement(message);
    expect(
      screen.getByRole('button', { name: 'Add a property, nested rule, or condition' })
    ).toHaveTextContent('Add property');
  });

  it('shows candidate source filenames for an ambiguous rule', () => {
    render(
      <CascadeRuleCard
        editable={false}
        selector=".button"
        sourceFiles={['src/a.css', 'src/b.css']}
        decls={[]}
        overridden={new Map()}
        readonlyReason="this selector matches multiple source rules across 2 files; inspect the candidates in Code"
      />
    );

    expect(screen.getByText('a.css, b.css')).toBeInTheDocument();
    expect(document.querySelector('.ss-cascade-card__src-chip')).toHaveAttribute(
      'title',
      'src/a.css\nsrc/b.css'
    );
  });

  it('summarizes the declaration count while collapsed', () => {
    render(
      <CascadeRuleCard
        editable={false}
        collapsed
        onToggleCollapse={vi.fn()}
        selector=".button"
        decls={[
          { prop: 'display', value: 'grid', important: false },
          { prop: 'gap', value: '1rem', important: false },
        ]}
        overridden={new Map()}
      />
    );

    expect(screen.getByText('2 properties')).toBeInTheDocument();
    expect(document.querySelector('.ss-cascade-card__body')).not.toBeInTheDocument();
  });

  it('opens the shared-rule delete confirmation from a collapsed card', () => {
    render(
      <CascadeRuleCard
        editable
        collapsed
        onToggleCollapse={vi.fn()}
        selector=".button"
        sharedSelectors={['.button-primary']}
        body={{ items: [] }}
        overridden={new Map()}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onRemoveSelector={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rule actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete entire shared rule…' }));

    expect(screen.getByRole('dialog', { name: 'Delete entire shared rule?' })).toBeInTheDocument();
  });

  it('does not apply the selected element contrast context to nested declarations', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('PointerEvent', MouseEvent);
    render(
      <CascadeRuleCard
        editable
        selector=".button"
        body={{
          items: [
            {
              kind: 'rule',
              selector: '& .icon',
              body: {
                items: [{ kind: 'decl', prop: 'color', value: '#000000', important: false }],
              },
            },
          ],
        }}
        overridden={new Map()}
        colorContrast={{
          text: { backgroundColor: '#ffffff', category: 'normal-text' },
          graphics: { backgroundColor: '#ffffff', category: 'graphics' },
        }}
        onChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open color picker for color' }));
    fireEvent.click(screen.getByRole('button', { name: 'Contrast checker' }));

    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      'Contrast check unavailable. Background color is unavailable for this selection.'
    );
  });

  it('filters to matching properties and dims nonmatches when Show all is selected', () => {
    const body = {
      items: [
        { kind: 'decl' as const, prop: 'display', value: 'grid', important: false },
        { kind: 'decl' as const, prop: 'font-family', value: 'Inter', important: false },
        {
          kind: 'rule' as const,
          selector: '&:hover',
          body: {
            items: [{ kind: 'decl' as const, prop: 'color', value: 'red', important: false }],
          },
        },
      ],
    };

    render(
      <CascadeRuleCard
        editable
        selector=".hero-title"
        body={body}
        overridden={new Map()}
        onChange={vi.fn()}
        searchTerm="FONT-FAMILY"
      />
    );

    const card = screen.getByTestId('cascade-card');
    expect(card.querySelectorAll('.ss-decl:not(.ss-decl--ghost)')).toHaveLength(1);
    expect(within(card).getByText('font-family')).toBeInTheDocument();
    expect(within(card).queryByText('display')).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('combobox', { name: 'Nested selector' })
    ).not.toBeInTheDocument();
    const matchingProperty = card.querySelector('.ss-decl');
    const showAllAction = within(card).getByRole('button', { name: 'Show all properties' });
    expect(matchingProperty).not.toBeNull();
    expect(
      matchingProperty!.compareDocumentPosition(showAllAction) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show all properties' }));

    expect(within(card).getByText('display')).toBeInTheDocument();
    expect(within(card).getByRole('combobox', { name: 'Nested selector' })).toHaveValue('&:hover');
    expect(card.querySelector('.ss-cascade-filtered.is-dimmed')).toBeInTheDocument();
  });

  it('edits a filtered declaration at its original body index and preserves hidden items', () => {
    const body = {
      items: [
        { kind: 'decl' as const, prop: 'display', value: 'grid', important: false },
        { kind: 'decl' as const, prop: 'font-family', value: 'Inter', important: false },
        {
          kind: 'rule' as const,
          selector: '&:hover',
          body: {
            items: [{ kind: 'decl' as const, prop: 'color', value: 'red', important: false }],
          },
        },
      ],
    };
    const onChange = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    render(
      <CascadeRuleCard
        editable
        selector=".hero-title"
        body={body}
        overridden={new Map()}
        onChange={onChange}
        searchTerm="font-family"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove property' }));

    expect(onChange).toHaveBeenCalledWith({
      items: [
        { kind: 'decl', prop: 'display', value: 'grid', important: false },
        {
          kind: 'rule',
          selector: '&:hover',
          body: {
            items: [{ kind: 'decl', prop: 'color', value: 'red', important: false }],
          },
        },
      ],
    });
  });

  it('shows selector-list members as separate groups and keeps compound chips joined', () => {
    const selectorList =
      ':global(.brand-link.brand-label, .brand-footer), .card .label, :is(.one, .two), [data-label="a,b"], .escaped\\,comma';
    render(
      <CascadeRuleCard
        editable
        selector=".brand-link.brand-label"
        selectorList={selectorList}
        sharedSelectors={[
          '.brand-footer',
          '.card .label',
          ':is(.one,.two)',
          '[data-label="a,b"]',
          '.escaped\\,comma',
        ]}
        selectorListSplitSafe
        onSplitSelectorList={vi.fn()}
        body={{ items: [] }}
        overridden={new Map()}
        onChange={vi.fn()}
        onRename={vi.fn()}
      />
    );

    const card = screen.getByTestId('cascade-card');
    const groups = card.querySelectorAll('.ss-cascade-selector-list__member');
    expect(groups).toHaveLength(6);
    expect(card.querySelectorAll('.ss-cascade-selector-list__separator')).toHaveLength(5);
    expect(groups[0].querySelectorAll('.ss-cascade-selector-display__part')).toHaveLength(2);
    const splitAction = screen.getByRole('button', {
      name: 'Split all 6 selectors into individual rules',
    });
    expect(splitAction).toHaveTextContent('Split');
    expect(splitAction).toHaveClass('text-button');
    expect(card.querySelector('.ss-cascade-card__body')).not.toHaveTextContent('Also applies to');
    expect(card.querySelector('.ss-cascade-card__body')).not.toHaveTextContent('Make independent');
  });

  it('opens the full authored selector list and commits the complete replacement', () => {
    const selectorList = ':global(.brand-link, .brand-label), .page :is(.card, .tile)';
    const onRename = vi.fn();
    render(
      <CascadeRuleCard
        editable
        selector=".brand-link"
        selectorList={selectorList}
        sharedSelectors={['.brand-label', '.page :is(.card,.tile)']}
        body={{ items: [] }}
        overridden={new Map()}
        onChange={vi.fn()}
        onRename={onRename}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: selectorList }));
    const input = screen.getByRole('combobox', { name: 'Rule selector' });
    expect(input).toHaveValue(selectorList);
    fireEvent.change(input, { target: { value: '.new:is(.one, .two), .other' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('.new:is(.one, .two), .other');
  });

  it('shows full selector lists on readonly cards without edit or Split actions', () => {
    const selectorList = '.brand-link, [data-label="a,b"], :has(.icon, .badge)';
    render(
      <CascadeRuleCard
        editable={false}
        selector=".brand-link"
        selectorList={selectorList}
        decls={[]}
        overridden={new Map()}
      />
    );

    const card = screen.getByTestId('cascade-card');
    expect(card.querySelectorAll('.ss-cascade-selector-list__member')).toHaveLength(3);
    expect(within(card).queryByRole('button', { name: 'Split' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('combobox', { name: 'Rule selector' })).not.toBeInTheDocument();
  });
});
