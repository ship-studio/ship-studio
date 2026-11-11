import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { useCssAnimations } from '../../hooks/useCssAnimations';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { CascadeRow } from '../../lib/cssCascade';
import type { RuleBody } from '../../lib/cssBody';
import { rowKey } from '../../lib/cssCascade';
import { CssCascadePanel } from './CssCascadePanel';

function makeRow(index: number, selector: string, file: string, output?: string): CascadeRow {
  return {
    index,
    selector,
    declarations: [],
    specificity: [0, 1, 0],
    sourceOrder: index,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    origin: 'author',
    editable: true,
    file,
    line: index + 1,
    generatedCssOutput: output,
  };
}

function makeBody(prop: string, value: string): RuleBody {
  return {
    items: [{ kind: 'decl', prop, value, important: false }],
  };
}

function panel(rows: CascadeRow[], selectionClass = 'hero') {
  const bodies = Object.fromEntries(
    rows.map((row) => [
      rowKey(row),
      makeBody(row.selector === '.generated' ? 'margin' : 'color', '0'),
    ])
  );

  return (
    <CssCascadePanel
      selection={{
        signature: { tagName: 'div', className: selectionClass, ancestorClasses: [] },
        instanceCount: 1,
      }}
      rows={rows}
      loading={false}
      bodies={bodies}
      overridden={{}}
      onChangeBody={vi.fn()}
      onDeleteRule={vi.fn()}
      onWrapRule={vi.fn()}
      onRenameRule={vi.fn()}
      onRenameAtRule={vi.fn()}
      onAddSelector={vi.fn()}
      selectorSuggestions={[]}
      existingSelectors={[]}
      variables={[]}
      animations={[]}
      settings={
        {
          selectionKey: selectionClass,
          tag: 'div',
          tagOptions: [],
          canEditTag: false,
          setTag: vi.fn().mockResolvedValue(true),
          classes: [selectionClass],
          attributes: [],
          text: '',
          textReason: null,
          canEditText: false,
          setText: vi.fn().mockResolvedValue(true),
          addClass: vi.fn(),
          renameClass: vi.fn(),
          removeClass: vi.fn(),
          setAttribute: vi.fn(),
          renameAttribute: vi.fn(),
          removeAttribute: vi.fn(),
          canEditAttributes: false,
          sourceMarkupStatus: 'resolved',
          location: null,
          busy: false,
        } satisfies ElementSettings
      }
      animationsState={
        {
          animations: [],
          loading: false,
          setBody: vi.fn(),
          create: vi.fn(),
          rename: vi.fn(),
          remove: vi.fn(),
          reload: vi.fn(),
        } as ReturnType<typeof useCssAnimations>
      }
      onClose={vi.fn()}
    />
  );
}

describe('CssCascadePanel generated-source note', () => {
  it('shows one panel note for generated rules, including while their source group is collapsed', () => {
    const output = 'public/styles/site.css';
    const rows = [
      makeRow(0, '.generated', 'public/styles/base.css', output),
      makeRow(1, '.generated', 'public/styles/base.css', output),
    ];
    render(panel(rows));

    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent(
      'These styles are generated from source files. Source edits appear after the stylesheet rebuilds.'
    );
    expect(document.querySelectorAll('.ss-cascade-card__note')).toHaveLength(0);

    const sourceGroup = screen.getByTestId('cascade-source-group');
    fireEvent.click(within(sourceGroup).getByRole('button', { name: /Collapse source file/ }));
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(sourceGroup).toHaveClass('is-collapsed');
  });

  it('follows search filtering and the currently selected element', () => {
    const generated = makeRow(0, '.generated', 'public/styles/base.css', 'public/styles/site.css');
    const ordinary = makeRow(1, '.ordinary', 'src/styles.css');
    const view = render(panel([generated, ordinary]));

    fireEvent.click(screen.getByRole('button', { name: 'Search CSS rules' }));
    const search = screen.getByRole('searchbox', {
      name: 'Search CSS selectors, properties, and values',
    });
    fireEvent.change(search, { target: { value: 'color' } });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'margin' } });
    expect(screen.getAllByRole('note')).toHaveLength(1);

    view.rerender(panel([ordinary], 'other-selection'));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
