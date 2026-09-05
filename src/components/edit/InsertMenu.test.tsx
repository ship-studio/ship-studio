import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ELEMENT_KINDS } from '../../lib/edit-structure';
import { InsertMenu } from './InsertMenu';

function renderMenu(insideDisabled = false) {
  return render(
    <InsertMenu
      anchor={{ left: 100, top: 100, bottom: 120 }}
      insideDisabled={insideDisabled}
      onInsert={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

describe('InsertMenu', () => {
  it('uses the shared tabs primitive for placement and gives every element an icon', () => {
    renderMenu();

    expect(screen.getByRole('tablist', { name: 'Placement' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Inside' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(ELEMENT_KINDS.length);

    const expectedIcons: Record<string, string> = {
      Div: 'ElementDivIcon',
      Section: 'ElementSectionIcon',
      'Heading 1': 'ElementHeading1Icon',
      'Heading 2': 'ElementHeading2Icon',
      'Heading 3': 'ElementHeading3Icon',
      Paragraph: 'ElementParagraphIcon',
      Link: 'ElementLinkIcon',
      Button: 'ElementButtonIcon',
      Image: 'ImageIcon',
      List: 'ElementListIcon',
      'Text span': 'DecorationNoneIcon',
    };

    for (const [label, iconName] of Object.entries(expectedIcons)) {
      const row = screen.getByRole('option', { name: new RegExp(`^${label} `) });
      expect(row.querySelector(`[data-icon-name="${iconName}"]`)).toBeInTheDocument();
    }
  });

  it('keeps Inside disabled for void elements and uses the selected placement when inserting', () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(
      <InsertMenu
        anchor={{ left: 100, top: 100, bottom: 120 }}
        insideDisabled
        onInsert={onInsert}
        onClose={onClose}
      />
    );

    expect(screen.getByRole('tab', { name: 'Inside' })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Before' }));
    fireEvent.click(screen.getByRole('option', { name: /^Image / }));

    expect(onInsert).toHaveBeenCalledWith('before', 'img');
    expect(onClose).toHaveBeenCalled();
  });
});
