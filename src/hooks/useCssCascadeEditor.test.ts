import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementSignature } from '../lib/edit';
import type { CssRuleSourceIdentity, MatchedRule, RuleLocation } from '../lib/cssCascade';

vi.mock('../lib/cssCascade', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cssCascade')>();
  return {
    ...actual,
    applyCssRuleText: vi.fn(),
    createCssRule: vi.fn(),
    listCssClasses: vi.fn().mockResolvedValue([]),
    listCssSelectors: vi.fn().mockResolvedValue([]),
    listCssVariables: vi.fn().mockResolvedValue([]),
    locateCssRules: vi.fn(),
  };
});
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { applyCssRuleText, createCssRule, locateCssRules, rowKey } from '../lib/cssCascade';
import { useCssCascadeEditor } from './useCssCascadeEditor';
import { useElementTree } from './useElementTree';

function identity(
  selector: string,
  version: string,
  innerText: string,
  selectorOffset: number
): CssRuleSourceIdentity {
  return {
    sourcePath: 'styles.css',
    sourceVersion: version,
    selectorOffset,
    selector,
    selectorMemberIndex: 0,
    matchedSelector: selector,
    selectorMembers: [selector],
    innerText,
    contextPath: [],
  };
}

function matchedRule(selector: string, sourceOrder: number): MatchedRule {
  return {
    selector,
    declarations: [{ prop: 'color', value: 'red', important: false, active: true }],
    specificity: [0, 1, 0],
    sourceOrder,
    runtimeIdentity: {
      stylesheetIndex: 0,
      rulePath: [sourceOrder],
      href: 'http://localhost/styles.css',
      rootHref: 'http://localhost/styles.css',
      selectorList: selector,
      selectorMemberIndex: 0,
      declarations: [{ property: 'color', value: 'red', important: false }],
    },
    selectorMemberIndex: 0,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    href: 'http://localhost/styles.css',
    origin: 'author',
  };
}

function location(sourceIdentity: CssRuleSourceIdentity, line: number): RuleLocation {
  return {
    status: 'resolved',
    file: sourceIdentity.sourcePath,
    line,
    inner_text: sourceIdentity.innerText,
    source_identity: sourceIdentity,
  };
}

async function openCascade(rules: MatchedRule[]) {
  const iframeWindow = window;
  const iframeRef = {
    current: {
      contentWindow: iframeWindow,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  } as unknown as React.RefObject<HTMLIFrameElement | null>;
  const onToast = vi.fn();
  const hook = renderHook(() =>
    useCssCascadeEditor({ iframeRef, projectPath: '/project', enabled: true, onToast })
  );

  act(() => hook.result.current.toggleEditMode());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframeWindow,
        data: {
          type: 'ss:select',
          selectionId: 'selection-1',
          count: 1,
          signature: {
            tagName: 'DIV',
            id: '',
            className: 'hero',
            text: '',
            domPath: '0/0',
          } as unknown as ElementSignature,
        },
      })
    );
    window.dispatchEvent(
      new MessageEvent('message', { source: iframeWindow, data: { type: 'ss:cascade', rules } })
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { ...hook, onToast };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it('propagates each preview selection to the CSS panel and Elements tree', async () => {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const previewWindow = iframe.contentWindow;
  expect(previewWindow).not.toBeNull();
  vi.spyOn(previewWindow!, 'postMessage').mockImplementation(() => {});
  const iframeRef = { current: iframe };
  const onToast = vi.fn();
  const { result, unmount } = renderHook(() => ({
    css: useCssCascadeEditor({ iframeRef, projectPath: '/project', enabled: true, onToast }),
    tree: useElementTree({ iframeRef, enabled: true }),
  }));

  act(() => result.current.css.toggleEditMode());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const select = (nodeId: number, className: string, domPath: string) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: previewWindow,
        data: {
          type: 'ss:select',
          selectionId: `selection-${nodeId}`,
          nodeId,
          count: 1,
          signature: {
            tagName: 'DIV',
            className,
            text: '',
            domPath,
            ancestorClasses: [],
          } as unknown as ElementSignature,
        },
      })
    );
  };

  act(() => select(4, 'first', '0/0'));
  expect(result.current.css.selection?.signature.className).toBe('first');
  expect(result.current.tree.selectedId).toBe(4);

  act(() => select(7, 'second', '0/1'));
  expect(result.current.css.selection?.signature).toMatchObject({
    className: 'second',
    domPath: '0/1',
  });
  expect(result.current.tree.selectedId).toBe(7);

  unmount();
  iframe.remove();
});

describe('useCssCascadeEditor source identity refresh', () => {
  it('refreshes same-stylesheet siblings from the initial cascade without a resize', async () => {
    const hero = identity('.hero', 'source-v1', '\n  color: red;\n', 0);
    const sibling = identity('.sibling', 'source-v1', '\n  color: red;\n', 40);
    const heroSaved = identity('.hero', 'source-v2', '\n  color: blue;\n', 0);
    const siblingRefreshed = identity('.sibling', 'source-v2', '\n  color: red;\n', 40);
    vi.mocked(locateCssRules)
      .mockResolvedValueOnce([location(hero, 1), location(sibling, 4)])
      .mockResolvedValueOnce([location(heroSaved, 1), location(siblingRefreshed, 4)]);
    vi.mocked(applyCssRuleText).mockResolvedValue(heroSaved);

    const { result } = await openCascade([matchedRule('.hero', 0), matchedRule('.sibling', 1)]);
    const heroRow = result.current.rows.find((row) => row.selector === '.hero');
    const siblingRow = result.current.rows.find((row) => row.selector === '.sibling');
    if (!heroRow || !siblingRow) throw new Error('Expected both stylesheet rows to load');

    vi.useFakeTimers();
    act(() => {
      result.current.setBody(rowKey(heroRow), {
        items: [{ kind: 'decl', prop: 'color', value: 'blue', important: false }],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    const refreshedSibling = result.current.rows.find((row) => row.selector === '.sibling');
    expect(refreshedSibling?.editable).toBe(true);
    expect(refreshedSibling?.sourceIdentity?.sourceVersion).toBe('source-v2');
  });

  it('keeps edits typed during a draft first save and saves them after key migration', async () => {
    const baseAfterCreate = identity('.base', 'source-v2', '\n  color: red;\n', 0);
    const created = identity('.hero', 'source-v2', '\n', 40);
    const heroBlue = identity('.hero', 'source-v2', '\n  color: blue;\n', 40);
    const heroGreen = identity('.hero', 'source-v3', '\n  color: green;\n', 40);
    vi.mocked(locateCssRules).mockImplementation((_projectPath, queries) =>
      Promise.resolve(queries.map((_, index) => location(baseAfterCreate, index + 1)))
    );
    vi.mocked(createCssRule).mockResolvedValue(created);

    let resolveFirstWrite!: (saved: CssRuleSourceIdentity) => void;
    const firstWrite = new Promise<CssRuleSourceIdentity>((resolve) => {
      resolveFirstWrite = resolve;
    });
    vi.mocked(applyCssRuleText).mockReturnValueOnce(firstWrite).mockResolvedValueOnce(heroGreen);

    const { result } = await openCascade([matchedRule('.base', 0)]);
    const draft = result.current.rows.find((row) => row.selector === '.hero' && row.draft);
    if (!draft) throw new Error('Expected the element class draft to load');

    vi.useFakeTimers();
    const draftKey = rowKey(draft);
    act(() => {
      result.current.setBody(draftKey, {
        items: [{ kind: 'decl', prop: 'color', value: 'blue', important: false }],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createCssRule).toHaveBeenCalledWith('/project', 'styles.css', '.hero');
    expect(applyCssRuleText).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setBody(draftKey, {
        items: [{ kind: 'decl', prop: 'color', value: 'green', important: false }],
      });
    });
    await act(async () => {
      resolveFirstWrite(heroBlue);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const savedRow = result.current.rows.find((row) => row.selector === '.hero');
    if (!savedRow) throw new Error('Expected the draft to migrate to its saved source row');
    expect(savedRow.draft).not.toBe(true);
    expect(rowKey(savedRow)).not.toBe(draftKey);
    expect(result.current.bodies[rowKey(savedRow)]?.items).toEqual([
      { kind: 'decl', prop: 'color', value: 'green', important: false },
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyCssRuleText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyCssRuleText).mock.calls[1]?.slice(0, 6)).toEqual([
      '/project',
      'styles.css',
      '.hero',
      null,
      '\n  color: blue;\n',
      '\n  color: green;\n',
    ]);
  });
});
