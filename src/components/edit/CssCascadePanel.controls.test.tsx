import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useCssAnimations } from '../../hooks/useCssAnimations';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { CascadeRow } from '../../lib/cssCascade';
import type { RuleBody } from '../../lib/cssBody';
import {
  CASCADE_DISPLAY_ORDER_PREFERENCE_KEY,
  orderCascadeRowsForDisplay,
} from '../../lib/cascadePresentation';
import { rowKey } from '../../lib/cssCascade';
import { CssCascadePanel } from './CssCascadePanel';

function makeSettings(): ElementSettings {
  return {
    selectionKey: 'selected-element',
    tag: 'div',
    tagOptions: [],
    canEditTag: false,
    setTag: vi.fn().mockResolvedValue(true),
    classes: ['hero'],
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
    location: null,
    busy: false,
  };
}

function makeRow(
  index: number,
  selector: string | null,
  options: Partial<CascadeRow> = {}
): CascadeRow {
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
    file: 'src/styles.css',
    line: index + 1,
    ...options,
  };
}

function makeBody(...properties: Array<[string, string]>): RuleBody {
  return {
    items: properties.map(([prop, value]) => ({
      kind: 'decl' as const,
      prop,
      value,
      important: false,
    })),
  };
}

function panelElement(
  rows: CascadeRow[],
  bodies: Record<string, RuleBody>,
  selectedClassName = 'hero',
  onAddSelector: (selector: string, atPrelude?: string) => void | Promise<void> = vi.fn()
) {
  return (
    <CssCascadePanel
      selection={{
        signature: { tagName: 'div', className: selectedClassName, ancestorClasses: [] },
        instanceCount: 1,
      }}
      rows={rows}
      loading={false}
      bodies={bodies}
      overridden={{}}
      onChangeBody={vi.fn()}
      onDeleteRule={vi.fn()}
      onDeleteRules={vi.fn()}
      onWrapRule={vi.fn()}
      onRenameRule={vi.fn()}
      onRenameAtRule={vi.fn()}
      onAddSelector={onAddSelector}
      selectorSuggestions={[]}
      existingSelectors={[]}
      variables={[]}
      animations={[]}
      settings={makeSettings()}
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

function renderPanel(
  rows: CascadeRow[],
  bodies: Record<string, RuleBody>,
  selectedClassName = 'hero'
) {
  return render(panelElement(rows, bodies, selectedClassName));
}

function selectorCard(panel: HTMLElement, selector: string): HTMLElement {
  const card = Array.from(panel.querySelectorAll<HTMLElement>('[data-testid="cascade-card"]')).find(
    (candidate) =>
      Array.from(candidate.querySelectorAll('.ss-cascade-chip__content')).some(
        (content) => content.textContent === selector
      )
  );
  if (!card) throw new Error(`Expected a selector card for ${selector}`);
  return card;
}

function draftMediaGroup(panel: HTMLElement): HTMLElement {
  const group = panel.querySelector<HTMLElement>('.ss-media-query-group.is-incomplete');
  if (!group) throw new Error('Expected the draft media query to match search');
  return group;
}

function addIncompleteMediaSelector(selector: string) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add selector' })[0]);
  const topInput = screen.getByRole('combobox', { name: 'Add selector' });
  fireEvent.change(topInput, { target: { value: '@media' } });
  fireEvent.keyDown(topInput, { key: 'Enter' });

  const draftGroup = document.querySelector<HTMLElement>('.ss-media-query-group.is-incomplete');
  if (!draftGroup) throw new Error('Expected a draft media query group');
  fireEvent.click(within(draftGroup).getByRole('button', { name: 'Add selector' }));
  const selectorInput = within(draftGroup).getByRole('combobox', { name: 'Add selector' });
  fireEvent.change(selectorInput, { target: { value: selector } });
  fireEvent.keyDown(selectorInput, { key: 'Enter' });
  return draftGroup;
}

function cardOrder(list: HTMLElement): string[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-testid="cascade-card"]'))
    .filter(
      (card) =>
        card.parentElement === list ||
        card.parentElement?.parentElement?.matches('[data-testid="cascade-source-group"]')
    )
    .map((card) => card.querySelector('.ss-cascade-chip__content')?.textContent ?? '');
}

function renderedRowSelectors(panel: HTMLElement): string[] {
  return Array.from(panel.querySelectorAll<HTMLElement>('[data-testid="cascade-card"]'))
    .filter((card) => !card.parentElement?.closest('[data-testid="cascade-card"]'))
    .map((card) => card.querySelector('.ss-cascade-chip__content')?.textContent ?? '');
}

const ELEMENT_DISPLAY_PREFERENCE_KEYS = [
  'elementTreeShowTagIcons',
  'elementTreeShowTagSansSerif',
  'elementTreeShowTagColors',
];

beforeEach(() => {
  localStorage.removeItem(CASCADE_DISPLAY_ORDER_PREFERENCE_KEY);
  ELEMENT_DISPLAY_PREFERENCE_KEYS.forEach((key) => localStorage.removeItem(key));
});
afterEach(() => {
  localStorage.removeItem(CASCADE_DISPLAY_ORDER_PREFERENCE_KEY);
  ELEMENT_DISPLAY_PREFERENCE_KEYS.forEach((key) => localStorage.removeItem(key));
});

describe('CssCascadePanel controls', () => {
  it('applies the shared Elements display preferences to the selected element label', () => {
    localStorage.setItem('elementTreeShowTagIcons', '1');
    localStorage.setItem('elementTreeShowTagSansSerif', '1');
    localStorage.setItem('elementTreeShowTagColors', '0');

    renderPanel([], {});

    const target = document.querySelector<HTMLElement>('.ss-cascade-target');
    if (!target) throw new Error('Expected the selected-element label');
    expect(target).toHaveClass('ss-cascade-target--sans-serif', 'ss-cascade-target--monochrome');
    expect(target.querySelector('.ss-cascade-target__tag-icon svg')).toHaveAttribute(
      'data-icon-name',
      'ElementDivIcon'
    );
    expect(target.querySelector('.ss-cascade-target__tag')).not.toBeInTheDocument();
    expect(target.querySelector('.ss-cascade-target__class')).toHaveTextContent('.hero');
  });

  it('keeps the tag name next to its icon when there are no classes', () => {
    localStorage.setItem('elementTreeShowTagIcons', '1');

    renderPanel([], {}, '');

    const target = document.querySelector<HTMLElement>('.ss-cascade-target');
    if (!target) throw new Error('Expected the selected-element label');
    expect(target.querySelector('.ss-cascade-target__tag-icon svg')).toHaveAttribute(
      'data-icon-name',
      'ElementDivIcon'
    );
    expect(target.querySelector('.ss-cascade-target__tag')).toHaveTextContent('div');
  });

  it('moves the Add selector action and created rules to the selected display edge', () => {
    const existing = makeRow(1, '.existing');
    const olderCreated = makeRow(1_000_001, '.created-older', {
      sourceOrder: undefined,
      line: 0,
    });
    const newerCreated = makeRow(1_000_002, '.created-newer', {
      sourceOrder: undefined,
      line: 0,
    });
    const rows = [existing, olderCreated, newerCreated];
    const bodies = Object.fromEntries(
      rows.map((row) => [rowKey(row), makeBody(['display', 'grid'])])
    );
    renderPanel(rows, bodies);
    expect(screen.getByRole('button', { name: 'Copy ID' })).toHaveClass('button--icon-only');
    addIncompleteMediaSelector('.hero-draft');

    const panel = screen.getByTestId('css-cascade-panel');
    const list = panel.querySelector<HTMLElement>('.ss-cascade-cards');
    if (!list) throw new Error('Expected the cascade list');
    const header = panel.querySelector<HTMLElement>('.ss-cascade-header');
    const headerMain = panel.querySelector<HTMLElement>('.ss-cascade-header__main');
    const target = panel.querySelector<HTMLElement>('.ss-cascade-target');
    const toolbar = panel.querySelector<HTMLElement>('.ss-cascade-toolbar');
    if (!header || !headerMain || !target || !toolbar)
      throw new Error('Expected the selected-element toolbar');
    expect(target.parentElement).toBe(headerMain);
    expect(toolbar.parentElement).toBe(headerMain);
    expect(target.nextElementSibling).toBe(toolbar);
    const tag = target.querySelector<HTMLElement>('[data-tone="tag"]');
    if (!tag) throw new Error('Expected the selected tag name');
    const copyButton = within(target).getByRole('button', { name: 'Copy ID' });
    expect(tag.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const selector = target.querySelector<HTMLElement>('.ss-cascade-target__selector');
    if (!selector) throw new Error('Expected the selected element classes');
    expect(
      selector.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(copyButton).toHaveAttribute('data-tooltip-content', 'Copy ID & Location: div.hero');

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search CSS rules' }));
    const search = screen.getByRole('searchbox', {
      name: 'Search CSS selectors, properties, and values',
    });
    expect(search).toHaveFocus();
    const searchField = search.closest('.ss-search-field');
    expect(searchField?.parentElement).toBe(header);
    expect(headerMain.nextElementSibling).toBe(searchField);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search CSS rules' })).toHaveFocus();

    const topAddButton = list.querySelector<HTMLElement>(
      ':scope > .ss-cascade-action [data-cascade-add-selector]'
    );
    if (!topAddButton) throw new Error('Expected the top Add selector button');
    expect(topAddButton).toHaveClass('button--fill');
    expect(
      toolbar.compareDocumentPosition(topAddButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const topAdd = list.querySelector(':scope > .ss-cascade-action');
    expect(list.firstElementChild).toBe(topAdd);
    expect(cardOrder(list)).toEqual(['.created-newer', '.created-older', '.existing']);
    expect(list.children[1]).toHaveClass('ss-media-query-group');
    expect(
      list.children[1].querySelector('.ss-media-query-group__selectors')?.lastElementChild
    ).toHaveClass('ss-cascade-action');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'CSS rule order: newest at top. Change to newest at bottom',
      })
    );

    expect(cardOrder(list)).toEqual(['.existing', '.created-older', '.created-newer']);
    expect(list.lastElementChild).toHaveClass('ss-cascade-action');
    const bottomAddButton = list.querySelector<HTMLElement>(
      ':scope > .ss-cascade-action:last-child [data-cascade-add-selector]'
    );
    if (!bottomAddButton) throw new Error('Expected the bottom Add selector button');
    expect(bottomAddButton).toHaveClass('button--fill');
    expect(
      toolbar.compareDocumentPosition(bottomAddButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(list.children[list.children.length - 2]).toHaveClass('ss-media-query-group');
    expect(rows.map((row) => row.sourceOrder)).toEqual([1, undefined, undefined]);
  });

  it('shares the app-global order across mounted panels and restores it after remount', () => {
    const first = renderPanel([], {});
    const second = renderPanel([], {});

    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'CSS rule order: newest at top. Change to newest at bottom',
      })[0]
    );

    expect(
      screen.getAllByRole('button', {
        name: 'CSS rule order: newest at bottom. Change to newest at top',
      })
    ).toHaveLength(2);
    expect(localStorage.getItem(CASCADE_DISPLAY_ORDER_PREFERENCE_KEY)).toBe('1');

    first.unmount();
    second.unmount();
    renderPanel([], {});
    expect(
      screen.getByRole('button', {
        name: 'CSS rule order: newest at bottom. Change to newest at top',
      })
    ).toBeInTheDocument();
  });

  it('filters declaration matches, reveals search results for collapse controls, and restores saved collapse state', () => {
    const root = makeRow(1, '.hero');
    const readonly = makeRow(2, '.hero-readonly', {
      editable: false,
      declarations: [{ prop: 'font-family', value: 'Inter', important: false, active: true }],
    });
    const responsive = makeRow(3, '.hero-responsive', {
      mediaText: '(max-width: 700px)',
      mediaMinPx: null,
    });
    const newDraft = makeRow(4, '.hero-new', { draft: true, line: 0 });
    const rows = [root, readonly, responsive, newDraft];
    const bodies: Record<string, RuleBody> = {
      [rowKey(root)]: {
        items: [
          { kind: 'decl', prop: 'font-family', value: 'Inter', important: false },
          { kind: 'decl', prop: 'display', value: 'grid', important: false },
          {
            kind: 'rule',
            selector: '&:hover',
            body: {
              items: [{ kind: 'decl', prop: 'color', value: 'red', important: false }],
            },
          },
        ],
      },
      [rowKey(responsive)]: makeBody(['font-family', 'Inter']),
      [rowKey(newDraft)]: { items: [] },
    };
    renderPanel(rows, bodies);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse media query' }));
    addIncompleteMediaSelector('.hero-draft');
    fireEvent.click(screen.getByRole('button', { name: 'Search CSS rules' }));
    const search = screen.getByRole('searchbox', {
      name: 'Search CSS selectors, properties, and values',
    });

    fireEvent.change(search, { target: { value: 'font-family' } });
    const panel = screen.getByTestId('css-cascade-panel');
    const getRootCard = () => selectorCard(panel, '.hero');
    expect(within(getRootCard()).getByText('font-family')).toBeInTheDocument();
    expect(within(getRootCard()).queryByText('display')).not.toBeInTheDocument();
    expect(selectorCard(panel, '.hero-readonly')).toBeInTheDocument();
    expect(selectorCard(panel, '.hero-responsive')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'hero' } });
    expect(draftMediaGroup(panel)).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-new')).toBeInTheDocument();
    expect(getRootCard().querySelector('[data-testid="cascade-card"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
    const fileGroup = panel.querySelector<HTMLElement>('[data-source-file="src/styles.css"]');
    if (!fileGroup) throw new Error('Expected the resolved stylesheet group');
    expect(fileGroup).not.toHaveClass('is-collapsed');
    expect(getRootCard()).toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-readonly')).toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-new')).toHaveClass('is-collapsed');
    expect(draftMediaGroup(panel)).toHaveClass('is-collapsed');

    fireEvent.click(within(getRootCard()).getByRole('button', { name: 'Expand rule' }));
    const getNestedCard = () => {
      const card = getRootCard().querySelector<HTMLElement>('[data-testid="cascade-card"]');
      if (!card) throw new Error('Expected the nested rule card to match search');
      return card;
    };
    expect(getNestedCard()).toHaveClass('is-collapsed');

    fireEvent.click(
      within(draftMediaGroup(panel)).getByRole('button', { name: 'Expand media query' })
    );
    expect(selectorCard(panel, '.hero-draft')).toHaveClass('is-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all CSS selector cards' }));
    expect(getRootCard()).not.toHaveClass('is-collapsed');
    expect(getNestedCard()).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-readonly')).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-responsive')).not.toHaveClass('is-collapsed');
    expect(draftMediaGroup(panel)).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-draft')).not.toHaveClass('is-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Clear CSS search' }));

    const mediaGroup = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="media-query-group"]')
    ).find((group) => group.textContent?.includes('700px'));
    expect(mediaGroup).toHaveClass('is-collapsed');
    expect(getRootCard()).not.toHaveClass('is-collapsed');
    expect(getNestedCard()).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-readonly')).not.toHaveClass('is-collapsed');
    expect(draftMediaGroup(panel)).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.hero-draft')).not.toHaveClass('is-collapsed');
  });

  it('groups contiguous identical source runs without changing selector order or controls', () => {
    const componentFile = '/project/src/components/Card.astro?style=0';
    const pageFile = '/project/src/pages/Card.astro?style=1';
    const base = makeRow(1, '.card', { file: componentFile });
    const componentMedia = makeRow(2, '.card-responsive', {
      file: componentFile,
      mediaText: '(min-width: 600px)',
      mediaMinPx: 600,
    });
    const componentMediaSibling = makeRow(9, '.card-responsive-alt', {
      file: componentFile,
      mediaText: '(min-width: 600px)',
      mediaMinPx: 600,
    });
    const pageMedia = makeRow(3, '.page-card-responsive', {
      file: pageFile,
      mediaText: '(min-width: 600px)',
      mediaMinPx: 600,
    });
    const componentMediaLater = makeRow(10, '.card-responsive-later', {
      file: componentFile,
      mediaText: '(min-width: 600px)',
      mediaMinPx: 600,
    });
    const pageBase = makeRow(8, '.page-card', { file: pageFile });
    const ambiguous = makeRow(4, '.ambiguous', {
      file: undefined,
      editable: false,
      sourceFiles: ['/project/src/one.css', '/project/src/two.css'],
      readonlyReason:
        'this selector matches multiple source rules across 2 files; inspect the candidates in Code',
      declarations: [{ prop: 'color', value: 'purple', important: false, active: true }],
    });
    const ambiguousMedia = makeRow(11, '.ambiguous-responsive', {
      file: undefined,
      editable: false,
      sourceFiles: ['/project/src/two.css', '/project/src/one.css'],
      mediaText: '(min-width: 600px)',
      mediaMinPx: 600,
      readonlyReason:
        'this selector matches multiple source rules across 2 files; inspect the candidates in Code',
      declarations: [{ prop: 'display', value: 'grid', important: false, active: true }],
    });
    const ambiguousMediaSibling = makeRow(12, '.ambiguous-responsive-alt', {
      file: undefined,
      editable: false,
      sourceFiles: ['/project/src/one.css', '/project/src/two.css'],
      mediaText: '(min-width: 600px)',
      mediaMinPx: 600,
      readonlyReason:
        'this selector matches multiple source rules across 2 files; inspect the candidates in Code',
      declarations: [{ prop: 'display', value: 'flex', important: false, active: true }],
    });
    const differentAmbiguous = makeRow(13, '.different-ambiguous', {
      file: undefined,
      editable: false,
      sourceFiles: ['/project/src/one.css', '/project/src/three.css'],
      readonlyReason:
        'this selector matches multiple source rules across 2 files; inspect the candidates in Code',
      declarations: [{ prop: 'color', value: 'orange', important: false, active: true }],
    });
    const ambiguousRecurring = makeRow(14, '.ambiguous-recurring', {
      file: undefined,
      editable: false,
      sourceFiles: ['/project/src/one.css', '/project/src/two.css'],
      readonlyReason:
        'this selector matches multiple source rules across 2 files; inspect the candidates in Code',
      declarations: [{ prop: 'color', value: 'purple', important: false, active: true }],
    });
    const inline = makeRow(5, null, {
      file: undefined,
      selector: null,
      origin: 'inline',
      editable: false,
      readonlyReason: 'inline style — move it to a class to edit',
      declarations: [{ prop: 'color', value: 'teal', important: false, active: true }],
    });
    const draft = makeRow(6, '.new-draft', {
      file: undefined,
      line: undefined,
      innerText: undefined,
      draft: true,
      draftTargetFile: componentFile,
    });
    const noSource = makeRow(7, '.framework-rule', {
      file: undefined,
      editable: false,
      readonlyReason: 'stylesheet source could not be mapped',
    });
    const rows = [
      base,
      componentMedia,
      componentMediaSibling,
      pageMedia,
      componentMediaLater,
      pageBase,
      ambiguous,
      ambiguousMedia,
      ambiguousMediaSibling,
      differentAmbiguous,
      ambiguousRecurring,
      inline,
      draft,
      noSource,
    ];
    const bodies: Record<string, RuleBody> = {
      [rowKey(base)]: makeBody(['padding', '1rem'], ['display', 'grid']),
      [rowKey(componentMedia)]: makeBody(['display', 'flex']),
      [rowKey(componentMediaSibling)]: makeBody(['display', 'grid']),
      [rowKey(pageMedia)]: makeBody(['display', 'block']),
      [rowKey(componentMediaLater)]: makeBody(['display', 'contents']),
      [rowKey(pageBase)]: makeBody(['color', 'navy']),
      [rowKey(draft)]: makeBody(),
    };
    const onAddSelector = vi.fn();
    const view = render(panelElement(rows, bodies, 'hero', onAddSelector));
    const panel = screen.getByTestId('css-cascade-panel');
    const expectedSelectors = (order: 'newest-top' | 'newest-bottom') =>
      orderCascadeRowsForDisplay(rows, order).map((row) => row.selector ?? 'element.style');
    const sourceRunKeys = () =>
      Array.from(panel.querySelectorAll<HTMLElement>('[data-testid="cascade-source-group"]'))
        .map((group) => group.dataset.sourceGroupKey)
        .sort();
    const newestTopSourceRunKeys = sourceRunKeys();

    expect(renderedRowSelectors(panel)).toEqual(expectedSelectors('newest-top'));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'CSS rule order: newest at top. Change to newest at bottom',
      })
    );
    expect(renderedRowSelectors(panel)).toEqual(expectedSelectors('newest-bottom'));
    expect(sourceRunKeys()).toEqual(newestTopSourceRunKeys);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'CSS rule order: newest at bottom. Change to newest at top',
      })
    );
    expect(renderedRowSelectors(panel)).toEqual(expectedSelectors('newest-top'));

    const fileGroups = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="cascade-source-group"]')
    );
    const resolvedGroups = fileGroups.filter((group) => group.dataset.sourceKind === 'resolved');
    expect(resolvedGroups.map((group) => group.dataset.sourceFile)).toEqual([
      componentFile,
      pageFile,
      componentFile,
      pageFile,
    ]);
    const componentGroups = resolvedGroups.filter(
      (group) => group.dataset.sourceFile === componentFile
    );
    const pageGroups = resolvedGroups.filter((group) => group.dataset.sourceFile === pageFile);
    expect(componentGroups).toHaveLength(2);
    expect(pageGroups).toHaveLength(2);
    const componentGroup = componentGroups[0];
    const pageGroup = pageGroups[0];
    if (!componentGroup || !pageGroup) throw new Error('Expected both resolved source groups');
    expect(
      within(componentGroup).getByText('Card.astro › style').closest('[title]')
    ).toHaveAttribute('title', expect.stringContaining(componentFile));
    expect(within(pageGroup).getByText('Card.astro › style').closest('[title]')).toHaveAttribute(
      'title',
      expect.stringContaining(pageFile)
    );

    const mediaGroups = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="media-query-group"]')
    );
    expect(mediaGroups).toHaveLength(4);
    expect(mediaGroups[0]?.querySelectorAll('[data-testid="cascade-card"]')).toHaveLength(2);
    expect(mediaGroups[1]).not.toHaveClass('is-inactive');
    expect(componentGroup.querySelector('.ss-cascade-card__src-chip')).not.toBeInTheDocument();
    expect(pageGroup.querySelector('.ss-cascade-card__src-chip')).not.toBeInTheDocument();
    expect(selectorCard(panel, '.card')).toBeInTheDocument();
    expect(selectorCard(panel, '.card-responsive')).toBeInTheDocument();
    expect(selectorCard(panel, '.card-responsive-alt')).toBeInTheDocument();
    expect(selectorCard(panel, '.page-card-responsive')).toBeInTheDocument();
    expect(selectorCard(panel, '.card-responsive-later')).toBeInTheDocument();
    expect(selectorCard(panel, '.page-card')).toBeInTheDocument();
    const ambiguousGroups = fileGroups.filter((group) => group.dataset.sourceKind === 'multiple');
    expect(ambiguousGroups.map((group) => group.dataset.sourceFiles)).toEqual([
      '/project/src/one.css\n/project/src/two.css',
      '/project/src/one.css\n/project/src/three.css',
      '/project/src/one.css\n/project/src/two.css',
    ]);
    expect(new Set(ambiguousGroups.map((group) => group.dataset.sourceGroupKey)).size).toBe(3);
    const firstAmbiguousGroup = ambiguousGroups[0];
    const differentAmbiguousGroup = ambiguousGroups[1];
    const recurringAmbiguousGroup = ambiguousGroups[2];
    if (!firstAmbiguousGroup || !differentAmbiguousGroup || !recurringAmbiguousGroup) {
      throw new Error('Expected three contiguous ambiguous-source runs');
    }
    expect(within(firstAmbiguousGroup).getByText('Ambiguous')).toBeInTheDocument();
    expect(
      within(firstAmbiguousGroup).getByText('one.css, two.css').closest('[title]')
    ).toHaveAttribute('title', '/project/src/one.css\n/project/src/two.css');
    expect(selectorCard(panel, '.ambiguous').closest('[data-testid="cascade-source-group"]')).toBe(
      firstAmbiguousGroup
    );
    expect(
      within(selectorCard(panel, '.ambiguous')).getByText(
        'this selector matches multiple source rules across 2 files; inspect the candidates in Code'
      )
    ).toBeInTheDocument();
    expect(firstAmbiguousGroup.querySelector('.ss-cascade-card__src-chip')).toBeNull();
    expect(within(firstAmbiguousGroup).getByText('.ambiguous-responsive')).toBeInTheDocument();
    expect(within(firstAmbiguousGroup).getByText('.ambiguous-responsive-alt')).toBeInTheDocument();
    expect(differentAmbiguousGroup).toContainElement(selectorCard(panel, '.different-ambiguous'));
    expect(recurringAmbiguousGroup).toContainElement(selectorCard(panel, '.ambiguous-recurring'));
    expect(screen.getByText('element.style')).toBeInTheDocument();
    expect(
      selectorCard(panel, 'element.style').closest('[data-testid="cascade-source-group"]')
    ).toBeNull();
    expect(selectorCard(panel, 'element.style')).toHaveTextContent(
      'inline style — move it to a class to edit'
    );
    const draftCard = selectorCard(panel, '.new-draft');
    expect(draftCard.querySelector('.ss-cascade-card__src-chip')).toBeNull();
    expect(draftCard.closest('[data-testid="cascade-source-group"]')).toBeNull();
    expect(draftCard.closest('[data-testid="cascade-destination-group"]')).toHaveAttribute(
      'data-destination-file',
      componentFile
    );
    expect(selectorCard(panel, '.framework-rule')).toBeInTheDocument();
    expect(
      selectorCard(panel, '.framework-rule').closest('[data-testid="cascade-source-group"]')
    ).toBeNull();
    expect(selectorCard(panel, '.framework-rule')).toHaveTextContent(
      'stylesheet source could not be mapped'
    );

    expect(
      within(mediaGroups[0]).getByRole('button', { name: 'Delete media query' })
    ).toBeInTheDocument();
    fireEvent.click(within(mediaGroups[1]).getByRole('button', { name: 'Add selector' }));
    const mediaSelectorInput = within(mediaGroups[1]).getByRole('combobox', {
      name: 'Add selector',
    });
    fireEvent.change(mediaSelectorInput, { target: { value: '.added-to-media' } });
    fireEvent.keyDown(mediaSelectorInput, { key: 'Enter' });
    expect(onAddSelector).toHaveBeenCalledWith('.added-to-media', '@media (min-width: 600px)');

    fireEvent.click(within(mediaGroups[0]).getByRole('button', { name: 'Collapse media query' }));
    expect(mediaGroups[0]).toHaveClass('is-collapsed');
    expect(mediaGroups[2]).not.toHaveClass('is-collapsed');

    fireEvent.click(
      within(componentGroup).getByRole('button', {
        name: 'Collapse source file Card.astro › style',
      })
    );
    expect(componentGroups.every((group) => group.classList.contains('is-collapsed'))).toBe(true);
    expect(pageGroups.every((group) => !group.classList.contains('is-collapsed'))).toBe(true);
    fireEvent.click(
      within(firstAmbiguousGroup).getByRole('button', {
        name: 'Collapse ambiguous source rules one.css, two.css',
      })
    );
    expect(firstAmbiguousGroup).toHaveClass('is-collapsed');
    expect(recurringAmbiguousGroup).toHaveClass('is-collapsed');
    expect(differentAmbiguousGroup).not.toHaveClass('is-collapsed');
    view.rerender(panelElement(rows, bodies, 'other-selection', onAddSelector));
    const reselectedComponentGroups = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="cascade-source-group"]')
    ).filter((group) => group.dataset.sourceFile === componentFile);
    expect(reselectedComponentGroups).toHaveLength(2);
    expect(
      reselectedComponentGroups.every((group) => group.classList.contains('is-collapsed'))
    ).toBe(true);
    const reselectedAmbiguousGroups = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="cascade-source-group"]')
    ).filter((group) => group.dataset.sourceKind === 'multiple');
    expect(reselectedAmbiguousGroups[0]).toHaveClass('is-collapsed');
    expect(reselectedAmbiguousGroups[1]).not.toHaveClass('is-collapsed');
    expect(reselectedAmbiguousGroups[2]).toHaveClass('is-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
    expect(
      reselectedComponentGroups.every((group) => group.classList.contains('is-collapsed'))
    ).toBe(true);
    expect(reselectedAmbiguousGroups[0]).toHaveClass('is-collapsed');
    expect(reselectedAmbiguousGroups[1]).not.toHaveClass('is-collapsed');
    expect(reselectedAmbiguousGroups[2]).toHaveClass('is-collapsed');
    expect(pageGroups.every((group) => !group.classList.contains('is-collapsed'))).toBe(true);
    expect(selectorCard(panel, '.page-card')).toHaveClass('is-collapsed');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all CSS selector cards' }));
    expect(
      reselectedComponentGroups.every((group) => group.classList.contains('is-collapsed'))
    ).toBe(true);
    expect(reselectedAmbiguousGroups[0]).toHaveClass('is-collapsed');
    expect(reselectedAmbiguousGroups[1]).not.toHaveClass('is-collapsed');
    expect(reselectedAmbiguousGroups[2]).toHaveClass('is-collapsed');
    expect(pageGroups.every((group) => !group.classList.contains('is-collapsed'))).toBe(true);
    expect(selectorCard(panel, '.page-card')).not.toHaveClass('is-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Search CSS rules' }));
    const search = screen.getByRole('searchbox', {
      name: 'Search CSS selectors, properties, and values',
    });
    fireEvent.change(search, { target: { value: 'padding' } });
    const paddingSourceGroups = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="cascade-source-group"]')
    ).filter((group) => group.dataset.sourceFile === componentFile);
    expect(paddingSourceGroups).toHaveLength(1);
    expect(paddingSourceGroups[0]).not.toHaveClass('is-collapsed');
    expect(selectorCard(panel, '.card')).toBeInTheDocument();
    expect(panel.querySelector(`[data-source-file="${pageFile}"]`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
    expect(paddingSourceGroups[0]).not.toHaveClass('is-collapsed');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all CSS selector cards' }));
    expect(paddingSourceGroups[0]).not.toHaveClass('is-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Clear CSS search' }));
    fireEvent.change(search, { target: { value: pageFile } });
    const pageSearchResults = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="cascade-source-group"]')
    ).filter((group) => group.dataset.sourceFile === pageFile);
    expect(pageSearchResults).toHaveLength(2);
    expect(pageSearchResults.every((group) => !group.classList.contains('is-collapsed'))).toBe(
      true
    );
    expect(selectorCard(panel, '.page-card-responsive')).toBeInTheDocument();
    expect(panel.querySelector(`[data-source-file="${componentFile}"]`)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear CSS search' }));
    fireEvent.change(search, { target: { value: '/project/src/two.css' } });
    const ambiguousSearchResults = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="cascade-source-group"]')
    ).filter((group) => group.dataset.sourceKind === 'multiple');
    expect(ambiguousSearchResults).toHaveLength(2);
    expect(
      ambiguousSearchResults.every(
        (group) => group.dataset.sourceFiles === '/project/src/one.css\n/project/src/two.css'
      )
    ).toBe(true);
    expect(ambiguousSearchResults.every((group) => !group.classList.contains('is-collapsed'))).toBe(
      true
    );
    expect(selectorCard(panel, '.ambiguous-responsive')).toBeInTheDocument();
    expect(selectorCard(panel, '.ambiguous-recurring')).toBeInTheDocument();
    expect(panel.textContent).not.toContain('.different-ambiguous');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
    expect(ambiguousSearchResults.every((group) => !group.classList.contains('is-collapsed'))).toBe(
      true
    );
  });

  it('bulk collapse and expand keeps source headers open across repeated cycles', () => {
    const hero = makeRow(1, '.hero');
    const heroLabel = makeRow(2, '.hero-label');
    const panel = renderPanel([hero, heroLabel], {
      [rowKey(hero)]: makeBody(['color', 'red']),
      [rowKey(heroLabel)]: makeBody(['font-weight', 'bold']),
    });
    const sourceGroup = panel.container.querySelector<HTMLElement>(
      '[data-testid="cascade-source-group"]'
    );
    if (!sourceGroup) throw new Error('Expected the stylesheet source group');

    const expectSourceHeaderOpen = () => {
      expect(sourceGroup).not.toHaveClass('is-collapsed');
      expect(
        within(sourceGroup).getByRole('button', { name: 'Collapse source file styles.css' })
      ).toHaveAttribute('aria-expanded', 'true');
    };

    expectSourceHeaderOpen();
    expect(within(sourceGroup).getByText('styles.css')).toBeInTheDocument();

    for (let cycle = 0; cycle < 2; cycle += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all CSS selector cards' }));
      expectSourceHeaderOpen();
      expect(selectorCard(panel.container, '.hero')).toHaveClass('is-collapsed');
      expect(selectorCard(panel.container, '.hero-label')).toHaveClass('is-collapsed');

      fireEvent.click(screen.getByRole('button', { name: 'Expand all CSS selector cards' }));
      expectSourceHeaderOpen();
      expect(selectorCard(panel.container, '.hero')).not.toHaveClass('is-collapsed');
      expect(selectorCard(panel.container, '.hero-label')).not.toHaveClass('is-collapsed');
    }
  });
});
