import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CascadeChip } from './CascadeChip';
import { RuleContextChips } from './RuleContextChips';
import { SelectorChip, SelectorDisplay } from './SelectorChip';

describe('CascadeChip', () => {
  it('exposes tone and editing state through one stable root contract', () => {
    const { rerender } = render(<CascadeChip tone="selector">.button</CascadeChip>);
    const chip = screen.getByText('.button');
    expect(chip).toHaveClass('ss-cascade-chip');
    expect(chip).toHaveAttribute('data-tone', 'selector');

    rerender(
      <CascadeChip tone="media" editing>
        <input aria-label="Condition" />
      </CascadeChip>
    );
    expect(screen.getByLabelText('Condition').parentElement).toHaveClass(
      'ss-cascade-chip',
      'is-editing'
    );
    expect(screen.getByLabelText('Condition').parentElement).toHaveAttribute('data-tone', 'media');
  });

  it('opens selector editing with keyboard activation', () => {
    render(<SelectorChip selector=".button" suggestions={[]} onCommit={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
    expect(screen.getByRole('combobox', { name: 'Rule selector' })).toHaveValue('.button');
  });

  it('uses the media color family for plain tag selectors', () => {
    render(<SelectorChip selector="button:hover" suggestions={[]} onCommit={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('data-tone', 'tag');
  });

  it('labels the universal selector while keeping the CSS selector visible', () => {
    render(<SelectorDisplay selector="*" />);

    expect(screen.getByText('*')).toBeInTheDocument();
    expect(screen.getByText('Universal')).toBeInTheDocument();
    expect(screen.getByLabelText('* — Universal')).toBeInTheDocument();
    expect(screen.getByText('*').closest('.ss-cascade-chip')).toHaveAttribute('data-tone', 'tag');
  });

  it('uses the same media-tone contract in display and editing states', () => {
    render(<RuleContextChips mediaText="(max-width: 768px)" onRenameAtRule={vi.fn()} />);
    const displayChip = screen.getByRole('button', { name: '@media' });
    expect(displayChip).toHaveAttribute('data-tone', 'media');

    fireEvent.click(displayChip);
    const input = screen.getByRole('combobox', { name: 'Edit media query at-rule' });
    expect(input.parentElement).toHaveClass('ss-cascade-chip', 'is-editing');
    expect(input.parentElement).toHaveAttribute('data-tone', 'media');
    expect(screen.getByRole('option', { name: '@media' }).querySelector('code')).toHaveAttribute(
      'data-suggestion-tone',
      'media'
    );
  });

  it.each(['.section--hero.heading', '.section--hero .heading'])(
    'renders class selector sequences as connected blue chips: %s',
    (selectorText) => {
      render(<SelectorDisplay selector={selectorText} />);

      expect(screen.getAllByText(/^(\.section--hero|\.heading)$/)).toHaveLength(2);
      const selector = document.querySelector('.ss-cascade-selector-display');
      expect(
        selector?.querySelectorAll(':scope > .ss-cascade-selector-display__part')
      ).toHaveLength(2);
      expect(selector?.querySelectorAll('.ss-cascade-selector-display__connector')).toHaveLength(1);
      expect(selector?.querySelectorAll('.ss-cascade-chip[data-tone="selector"]')).toHaveLength(2);
      expect(selector?.querySelector('svg')).toHaveAttribute('preserveAspectRatio', 'none');
    }
  );

  it('keeps compound selector editing as one selector field', () => {
    render(<SelectorChip selector=".section--hero.heading" suggestions={[]} onCommit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('combobox', { name: 'Rule selector' })).toHaveValue(
      '.section--hero.heading'
    );
  });
});
