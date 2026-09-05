import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CascadeRuleCard } from './CascadeRuleCard';

describe('CascadeRuleCard', () => {
  it('renders the draft message in the properties body', () => {
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

    expect(message.closest('.ss-cascade-card__body')).toBe(
      card.querySelector('.ss-cascade-card__body')
    );
    expect(message.parentElement).toHaveClass('ss-cascade-card__draft-row');
    expect(card.querySelector('.ss-cascade-card__head')).not.toContainElement(message);
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
        readonlyReason="this selector is defined in multiple files"
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
});
