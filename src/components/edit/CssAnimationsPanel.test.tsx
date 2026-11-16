import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AnimationRow } from '../../hooks/useCssAnimations';
import { CssAnimationsPanel } from './CssAnimationsPanel';

const file = 'src/styles/animations.css';

function makeAnimation(selector: string, name: string, line: number, body: AnimationRow['body']) {
  return { selector, name, file, line, body };
}

describe('CssAnimationsPanel', () => {
  it('groups keyframes by stylesheet, links the source header, and places Add step last', () => {
    const onOpenInCode = vi.fn();
    const collapseControl = {
      collapsedKeys: new Set<string>(),
      searchCollapsedOverrides: new Map<string, boolean>(),
      toggle: vi.fn(),
      toggleSearch: vi.fn(),
    };
    const animations = [
      makeAnimation('@keyframes fade', 'fade', 12, {
        items: [
          {
            kind: 'rule',
            selector: 'from',
            body: { items: [{ kind: 'decl', prop: 'opacity', value: '0', important: false }] },
          },
        ],
      }),
      makeAnimation('@keyframes rise', 'rise', 28, { items: [] }),
    ];

    render(
      <CssAnimationsPanel
        animations={animations}
        loading={false}
        selectorSuggestions={[]}
        variables={[]}
        onChangeBody={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        searchTerm=""
        displayOrder="newest-bottom"
        collapseControl={collapseControl}
        onOpenInCode={onOpenInCode}
        onClearSearch={vi.fn()}
      />
    );

    const sourceGroup = screen.getByTestId('cascade-source-group');
    expect(screen.getAllByTestId('cascade-source-group')).toHaveLength(1);
    expect(sourceGroup).toHaveAttribute('aria-label', 'Animations from animations.css');
    expect(sourceGroup).toHaveTextContent('2 animations');
    expect(sourceGroup.querySelector('.ss-cascade-card__src-chip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Open ${file} at line 12 in Code tab` }));
    expect(onOpenInCode).toHaveBeenCalledWith(file, 12, '@keyframes fade');

    const keyframesCard = sourceGroup.querySelector('.ss-cascade-card');
    const keyframesBody = keyframesCard?.querySelector(':scope > .ss-cascade-card__body');
    expect(keyframesBody?.lastElementChild).toHaveClass('ss-cascade-card__add-row');
    expect(keyframesCard).not.toBeNull();
    expect(
      within(keyframesCard as HTMLElement).getByRole('button', { name: 'Add a keyframe step' })
    ).toHaveTextContent('Add step');
  });
});
