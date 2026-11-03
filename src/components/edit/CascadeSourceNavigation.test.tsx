import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRuleBody, type RuleBody } from '../../lib/cssBody';
import type { FileContent, FileEntry } from '../../lib/code';
import { cascadeSourceBackingFile, cascadeSourceFileLabel } from '../../lib/cascadePresentation';
import type { useCssAnimations } from '../../hooks/useCssAnimations';
import type { ElementSettings } from '../../hooks/useElementSettings';
import { rowKey, type CascadeRow } from '../../lib/cssCascade';
import { CascadeSourceGroupCard } from './CascadeSourceGroupCard';

const { registeredCommands } = vi.hoisted(() => ({
  registeredCommands: [] as Array<{ id: string; run: () => void | Promise<void> }>,
}));

vi.mock('../../lib/code', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/code')>();
  return {
    ...actual,
    listProjectFiles: vi.fn(),
    readProjectFile: vi.fn(),
    saveProjectFile: vi.fn(),
  };
});

vi.mock('../../lib/cssCascade', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/cssCascade')>();
  return { ...actual, resolveCssSourceLine: vi.fn() };
});

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../commands/useCommands', () => ({
  useCommands: (factory: () => Array<{ id: string; run: () => void | Promise<void> }>) => {
    registeredCommands.push(...factory());
  },
}));
vi.mock('../code/CodeViewer', () => ({
  CodeViewer: ({
    filePath,
    revealLine,
    revealRequestId,
  }: {
    filePath: string | null;
    revealLine?: number | null;
    revealRequestId?: number | null;
  }) => (
    <div
      data-testid="code-viewer"
      data-file={filePath ?? ''}
      data-line={revealLine ?? ''}
      data-request={revealRequestId ?? ''}
    />
  ),
}));

import { CodeTab } from '../code/CodeTab';
import { listProjectFiles, readProjectFile } from '../../lib/code';
import { CssCascadePanel } from './CssCascadePanel';
import { resolveCssSourceLine } from '../../lib/cssCascade';

const previousScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView'
);

const content: FileContent = {
  content: '<style>h1 { color: red }</style>',
  isBinary: false,
  isTruncated: false,
  size: 32,
  language: 'astro',
};

const entries: FileEntry[] = [
  { name: 'src', path: 'src', isDirectory: true, size: 0 },
  { name: 'components', path: 'src/components', isDirectory: true, size: 0 },
  {
    name: 'ProjectMedia.astro',
    path: 'src/components/ProjectMedia.astro',
    isDirectory: false,
    size: 32,
  },
  { name: 'package.json', path: 'package.json', isDirectory: false, size: 10 },
];

function makeElementSettings(): ElementSettings {
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

function makeCascadeRow(index: number, options: Partial<CascadeRow> = {}): CascadeRow {
  return {
    index,
    selector: '.hero',
    declarations: [],
    specificity: [0, 1, 0],
    sourceOrder: index,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    origin: 'author',
    editable: false,
    file: 'src/styles/site.css',
    ...options,
  };
}

function renderCascadeSourcePanel(rows: CascadeRow[], bodies: Record<string, RuleBody> = {}) {
  const onOpenInCode = vi.fn();
  render(
    <CssCascadePanel
      selection={{
        signature: { tagName: 'div', className: 'hero', ancestorClasses: [] },
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
      projectPath="/project"
      settings={makeElementSettings()}
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
      onOpenInCode={onOpenInCode}
    />
  );
  return onOpenInCode;
}

function renderSource(
  source:
    | { kind: 'resolved'; file: string }
    | {
        kind: 'multiple';
        files: string[];
        candidates?: Array<{ file: string; line: number | null }>;
        ruleCount?: number;
      },
  onOpenInCode?: (file: string, line?: number) => void
) {
  return render(
    <CascadeSourceGroupCard
      runKey="source-run"
      source={source}
      count={1}
      collapsed={false}
      onToggleCollapse={() => undefined}
      onOpenInCode={onOpenInCode}
    >
      <div>rule</div>
    </CascadeSourceGroupCard>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredCommands.length = 0;
  vi.mocked(resolveCssSourceLine).mockResolvedValue(17);
  vi.mocked(readProjectFile).mockResolvedValue(content);
});

afterEach(() => {
  if (previousScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

describe('CSS cascade source navigation', () => {
  it('keeps the source link keyboard-focusable and reports its source reference', () => {
    const onOpenInCode = vi.fn();
    renderSource({ kind: 'resolved', file: 'src/styles/site.css' }, onOpenInCode);

    const sourceLink = screen.getByRole('button', { name: 'Open src/styles/site.css in Code tab' });
    expect(sourceLink).toHaveClass('ss-cascade-file-group__source-link');
    expect(sourceLink.querySelector('.button__icon svg')).toHaveAttribute('aria-hidden', 'true');
    expect(sourceLink.querySelector('button')).toBeNull();
    sourceLink.focus();
    expect(sourceLink).toHaveFocus();
    fireEvent.click(sourceLink);

    expect(onOpenInCode).toHaveBeenCalledWith('src/styles/site.css');
  });

  it('explains an embedded style source accessibly and strips only its numeric virtual suffix', () => {
    const onOpenInCode = vi.fn();
    renderSource(
      { kind: 'resolved', file: 'src/components/ProjectMedia.astro?style=0' },
      onOpenInCode
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open embedded style block 0 in src/components/ProjectMedia.astro in Code tab',
      })
    );

    expect(onOpenInCode).toHaveBeenCalledWith('src/components/ProjectMedia.astro?style=0');
    expect(cascadeSourceBackingFile('src/Bad.astro?style=other')).toBe('src/Bad.astro?style=other');
    expect(cascadeSourceFileLabel('src/Bad.astro?style=other')).toBe('Bad.astro?style=other');
  });

  it('keeps ambiguous source candidates independently clickable', () => {
    const onOpenInCode = vi.fn();
    renderSource(
      {
        kind: 'multiple',
        files: ['src/styles/site.css', 'src/components/ProjectMedia.astro?style=2'],
      },
      onOpenInCode
    );

    expect(screen.getByTestId('cascade-source-group')).toHaveAttribute(
      'data-source-kind',
      'multiple'
    );
    const candidateLinks = screen.getAllByRole('button', {
      name: /^Open ambiguous source candidate/,
    });
    expect(candidateLinks).toHaveLength(2);
    expect(candidateLinks.every((link) => link.querySelector('.button__icon svg') !== null)).toBe(
      true
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open ambiguous source candidate src/styles/site.css in Code tab',
      })
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open ambiguous source candidate embedded style block 2 in src/components/ProjectMedia.astro in Code tab',
      })
    );

    expect(onOpenInCode.mock.calls).toEqual([
      ['src/styles/site.css'],
      ['src/components/ProjectMedia.astro?style=2'],
    ]);
  });

  it('places a draft in its verified stylesheet run without changing rule order or source identity', () => {
    const sourceFile = 'src/components/ProjectMedia.astro?style=2';
    const beforeDraft = makeCascadeRow(0, {
      selector: '*',
      editable: true,
      file: sourceFile,
      line: 5,
    });
    const draft = makeCascadeRow(1, {
      selector: 'div',
      editable: true,
      draft: true,
      file: undefined,
      line: undefined,
      innerText: undefined,
      draftTargetFile: sourceFile,
    });
    const afterDraft = makeCascadeRow(2, {
      selector: '.intro-copy',
      editable: true,
      file: sourceFile,
      line: 18,
    });
    renderCascadeSourcePanel([beforeDraft, draft, afterDraft], {
      [rowKey(beforeDraft)]: parseRuleBody('color: black;'),
      [rowKey(draft)]: parseRuleBody(''),
      [rowKey(afterDraft)]: parseRuleBody('color: navy;'),
    });

    const sourceGroups = screen.getAllByTestId('cascade-source-group');
    expect(sourceGroups).toHaveLength(1);
    const [sourceGroup] = sourceGroups;
    if (!sourceGroup) throw new Error('Expected one stylesheet group');
    expect(sourceGroup).toHaveAttribute('data-source-file', sourceFile);
    expect(within(sourceGroup).getByText('3 selectors')).toBeInTheDocument();
    const cards = Array.from(
      sourceGroup.querySelectorAll<HTMLElement>('[data-testid="cascade-card"]')
    );
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent('*');
    expect(cards[1]).toHaveTextContent('div');
    expect(cards[2]).toHaveTextContent('.intro-copy');
    const draftCard = cards[1];
    expect(draftCard).toHaveClass('is-draft');
    expect(draftCard?.querySelector('.ss-cascade-card__src-chip')).toBeNull();
    expect(screen.queryByText('Not yet in a stylesheet')).not.toBeInTheDocument();

    const collapse = within(sourceGroup).getByRole('button', { name: /Collapse source file/ });
    fireEvent.click(collapse);
    expect(sourceGroup).toHaveClass('is-collapsed');
    expect(sourceGroup.querySelectorAll('[data-testid="cascade-card"]')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Search CSS rules' }));
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search CSS selectors, properties, and values' }),
      { target: { value: 'div' } }
    );
    expect(within(sourceGroup).getByText('No rules applied')).toBeVisible();
    expect(sourceGroup).not.toHaveClass('is-collapsed');
  });

  it('leaves an unknown draft destination ungrouped and without source navigation metadata', () => {
    const draft = makeCascadeRow(1, {
      selector: 'div',
      editable: true,
      draft: true,
      file: undefined,
      line: undefined,
      innerText: undefined,
    });
    renderCascadeSourcePanel([draft], { [rowKey(draft)]: parseRuleBody('') });

    const draftCard = screen.getByText('No rules applied').closest('[data-testid="cascade-card"]');
    expect(draftCard).toHaveClass('is-draft');
    expect(draftCard?.querySelector('.ss-cascade-card__src-chip')).toBeNull();
    expect(draftCard?.closest('[data-testid="cascade-source-group"]')).toBeNull();
    expect(draftCard?.closest('[data-testid="cascade-destination-group"]')).toBeNull();
    expect(screen.queryByText('Not yet in a stylesheet')).not.toBeInTheDocument();
    const draftStatus = screen.getByText('No rules applied');
    expect(draftStatus).toBeVisible();
    expect(draftStatus).toHaveAttribute(
      'title',
      'No verified stylesheet destination is known for this selector yet'
    );
  });

  it('opens repeated rules in one file at each candidate line', () => {
    const onOpenInCode = vi.fn();
    renderSource(
      {
        kind: 'multiple',
        files: ['src/styles/site.css'],
        ruleCount: 2,
        candidates: [
          { file: 'src/styles/site.css', line: 7 },
          { file: 'src/styles/site.css', line: 18 },
        ],
      },
      onOpenInCode
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open ambiguous source candidate src/styles/site.css at line 18 in Code tab',
      })
    );
    expect(onOpenInCode).toHaveBeenCalledWith('src/styles/site.css', 18);
  });

  it('opens same-file candidates directly without claiming one matching rule was resolved', () => {
    const onOpenInCode = renderCascadeSourcePanel([
      makeCascadeRow(2, {
        file: undefined,
        sourceFiles: ['src/styles/site.css'],
        sourceRuleCount: 2,
        sourceCandidates: [
          { file: 'src/styles/site.css', line: 7 },
          { file: 'src/styles/site.css', line: 18 },
        ],
        readonlyReason:
          'this selector matches 2 source rules in this file; inspect the candidate rules in Code',
      }),
    ]);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open ambiguous source candidate src/styles/site.css at line 7 in Code tab',
      })
    );

    expect(onOpenInCode).toHaveBeenCalledWith('src/styles/site.css', 7);
    expect(resolveCssSourceLine).not.toHaveBeenCalled();
  });

  it('resolves the first displayed source rule for both the header link and palette action', async () => {
    const sourceFile = 'src/components/Page.astro?style=1';
    const onOpenInCode = renderCascadeSourcePanel([
      makeCascadeRow(0, { selector: '.hero', file: sourceFile, line: 2 }),
      makeCascadeRow(1, { selector: '.hero:hover', file: sourceFile, line: 8 }),
    ]);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open embedded style block 1 in src/components/Page.astro in Code tab',
      })
    );
    await waitFor(() => expect(resolveCssSourceLine).toHaveBeenCalledTimes(1));
    const expectedQuery = {
      selector: '.hero',
      mediaText: null,
      href: null,
      layer: null,
      container: null,
      supports: null,
    };
    expect(resolveCssSourceLine).toHaveBeenLastCalledWith('/project', sourceFile, expectedQuery);
    expect(onOpenInCode).toHaveBeenCalledWith('src/components/Page.astro', 17);

    const paletteAction = registeredCommands.find(
      (command) => command.id === `css.openSource.${encodeURIComponent(sourceFile)}`
    );
    expect(paletteAction).toBeDefined();
    await act(async () => paletteAction?.run());
    expect(resolveCssSourceLine).toHaveBeenCalledTimes(2);
    expect(resolveCssSourceLine).toHaveBeenLastCalledWith('/project', sourceFile, expectedQuery);
    expect(onOpenInCode).toHaveBeenNthCalledWith(2, 'src/components/Page.astro', 17);
  });

  it('ignores an in-flight source lookup after the panel closes', async () => {
    let finishLookup!: (line: number) => void;
    vi.mocked(resolveCssSourceLine).mockReturnValueOnce(
      new Promise((resolve) => {
        finishLookup = resolve;
      })
    );
    const onOpenInCode = renderCascadeSourcePanel([makeCascadeRow(0)]);
    fireEvent.click(screen.getByRole('button', { name: 'Open src/styles/site.css in Code tab' }));
    cleanup();
    await act(async () => {
      finishLookup(17);
      await Promise.resolve();
    });
    expect(onOpenInCode).not.toHaveBeenCalled();
  });

  it('does not let an older lookup override a later candidate-line navigation', async () => {
    let finishLookup!: (line: number) => void;
    vi.mocked(resolveCssSourceLine).mockReturnValueOnce(
      new Promise((resolve) => {
        finishLookup = resolve;
      })
    );
    const candidateFile = 'src/styles/secondary.css';
    const onOpenInCode = renderCascadeSourcePanel([
      makeCascadeRow(0, { file: 'src/styles/primary.css' }),
      makeCascadeRow(1, {
        file: undefined,
        sourceFiles: [candidateFile],
        sourceCandidates: [{ file: candidateFile, line: 23 }],
        sourceRuleCount: 1,
      }),
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: 'Open src/styles/primary.css in Code tab' })
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open ambiguous source candidate src/styles/secondary.css at line 23 in Code tab',
      })
    );
    expect(onOpenInCode).toHaveBeenCalledTimes(1);
    expect(onOpenInCode).toHaveBeenCalledWith(candidateFile, 23);

    await act(async () => {
      finishLookup(17);
      await Promise.resolve();
    });
    expect(onOpenInCode).toHaveBeenCalledTimes(1);
  });

  it('resolves the exact clicked file for each ambiguous source candidate', async () => {
    const candidateFile = 'src/styles/secondary.css';
    const onOpenInCode = renderCascadeSourcePanel([
      makeCascadeRow(0, {
        file: undefined,
        sourceFiles: ['src/styles/primary.css', candidateFile],
      }),
    ]);

    fireEvent.click(
      screen.getByRole('button', {
        name: `Open ambiguous source candidate ${candidateFile} in Code tab`,
      })
    );

    await waitFor(() =>
      expect(resolveCssSourceLine).toHaveBeenCalledWith(
        '/project',
        candidateFile,
        expect.objectContaining({ selector: '.hero' })
      )
    );
    await waitFor(() => expect(onOpenInCode).toHaveBeenCalledWith(candidateFile, 17));
  });

  it('clears a Code search filter, expands real ancestors, and reads the physical file on reveal', async () => {
    let resolveEntries!: (result: FileEntry[]) => void;
    vi.mocked(listProjectFiles).mockReturnValue(
      new Promise((resolve) => {
        resolveEntries = resolve;
      })
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const view = render(
      <CodeTab
        projectPath="/project"
        revealTarget={{ file: 'src/components/ProjectMedia.astro', line: 7, requestId: 1 }}
      />
    );
    const search = screen.getByRole('searchbox', { name: 'Search project files' });
    fireEvent.change(search, { target: { value: 'package' } });

    await act(async () => {
      resolveEntries(entries);
      await Promise.resolve();
      await Promise.resolve();
    });

    const target = await screen.findByRole('treeitem', { name: 'ProjectMedia.astro' });
    await waitFor(() => expect(target).toHaveAttribute('aria-selected', 'true'));
    expect(search).toHaveValue('');
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: 'components' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(readProjectFile).toHaveBeenCalledWith('/project', 'src/components/ProjectMedia.astro');
    expect(screen.getByTestId('code-viewer')).toHaveAttribute(
      'data-file',
      'src/components/ProjectMedia.astro'
    );
    await waitFor(() =>
      expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-line', '7')
    );
    expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-request', '1');
    expect(scrollIntoView).toHaveBeenCalled();

    // The same file and line still carry a fresh request identity through to
    // the editor, so CodeMirror reruns its reveal effect without a file reload.
    view.rerender(
      <CodeTab
        projectPath="/project"
        revealTarget={{ file: 'src/components/ProjectMedia.astro', line: 7, requestId: 2 }}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-request', '2')
    );
    expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-line', '7');
    expect(readProjectFile).toHaveBeenCalledTimes(1);

    // A completed reveal must not keep scrolling or reselecting its target as
    // the user browses folders, searches, or refreshes the file tree.
    const revealScrollCount = scrollIntoView.mock.calls.length;
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(revealScrollCount);
    fireEvent.click(screen.getByRole('treeitem', { name: 'package.json' }));
    await waitFor(() =>
      expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-file', 'package.json')
    );
    fireEvent.change(search, { target: { value: 'package' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh file tree' }));
    const packageEntry = await screen.findByRole('treeitem', { name: 'package.json' });
    expect(packageEntry).toHaveAttribute('aria-selected', 'true');
    expect(search).toHaveValue('package');
    expect(readProjectFile).toHaveBeenCalledTimes(2);
  });
});
