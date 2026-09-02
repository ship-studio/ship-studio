import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { StructureSelection } from '../../hooks/useElementStructure';
import { ElementToolbar } from './ElementToolbar';

function renderToolbar(tagName: string) {
  const selection: StructureSelection = {
    signature: {
      tagName,
      className: 'hero-title secondary',
      ancestorClasses: [],
    },
    rect: { top: 80, left: 40, width: 120, height: 24 },
    count: 1,
    nodeId: 1,
  };

  return render(
    <ElementToolbar
      selection={selection}
      bounds={{ w: 800, h: 600 }}
      busy={false}
      hidden={false}
      onInsert={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

describe('ElementToolbar', () => {
  it('uses the matching tag icon while keeping the class selector visible', () => {
    const { container } = renderToolbar('p');

    expect(container.querySelector('[data-icon-name="AlignLeftIcon"]')).toBeInTheDocument();
    expect(container.querySelector('.ss-el-toolbar__tag')).not.toBeInTheDocument();
    expect(screen.getByText('.hero-title')).toBeInTheDocument();
    expect(
      screen.getByTestId('element-toolbar').querySelector('.ss-el-toolbar__selection')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('element-toolbar').querySelector('.ss-el-toolbar__actions')
    ).toBeInTheDocument();

    const actions = screen.getByRole('group', { name: 'Element actions' });
    for (const iconName of ['PlusIcon', 'DuplicateIcon', 'TrashIcon']) {
      expect(actions.querySelector(`[data-icon-name="${iconName}"]`)).toHaveClass(
        'ss-el-toolbar__control-icon'
      );
    }
  });

  it('falls back to the tag name when no matching icon exists', () => {
    const { container } = renderToolbar('main');

    expect(container.querySelector('.ss-el-toolbar__tag')).toHaveTextContent('main');
    expect(container.querySelector('.ss-el-toolbar__tag-icon')).not.toBeInTheDocument();
  });
});
