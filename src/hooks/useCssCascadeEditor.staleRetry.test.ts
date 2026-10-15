/**
 * Structural rule edits (rename / rename at-rule / delete / wrap) get the same
 * stale-rule recovery `saveRule` has (issue #1008): a rule renamed, rewritten
 * or moved since its card was seeded is re-located and the edit retried once,
 * and a rule that is genuinely gone warns instead of auto-filing a bug report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../lib/cssCascade', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cssCascade')>()),
  locateCssRules: vi.fn(),
  renameCssSelector: vi.fn(),
  renameCssAtRule: vi.fn(),
  deleteCssRule: vi.fn(),
  wrapCssRule: vi.fn(),
  listCssClasses: vi.fn(),
  listCssSelectors: vi.fn(),
  listCssVariables: vi.fn(),
  listStylesheets: vi.fn(),
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { useCssCascadeEditor } from './useCssCascadeEditor';
import {
  deleteCssRule,
  listCssClasses,
  listCssSelectors,
  listCssVariables,
  listStylesheets,
  locateCssRules,
  renameCssSelector,
  rowKey,
  type MatchedRule,
} from '../lib/cssCascade';
import { logger } from '../lib/logger';

const STALE = {
  type: 'Validation',
  field: 'selector',
  reason: 'rule no longer matches — reselect the element',
};

const matched: MatchedRule = {
  selector: '.hero',
  declarations: [{ prop: 'color', value: 'red', important: false, active: true }],
  specificity: [0, 1, 0],
  sourceOrder: 0,
  mediaText: null,
  mediaMinPx: null,
  inactiveMedia: false,
  layer: null,
  href: null,
  origin: 'author',
};

async function setUp() {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const iframeRef = { current: iframe };
  const onToast = vi.fn();
  vi.mocked(locateCssRules).mockResolvedValueOnce([
    { status: 'resolved', file: 'styles.css', line: 1, inner_text: ' color: red; ' },
  ]);
  const hook = renderHook(() =>
    useCssCascadeEditor({ iframeRef, projectPath: '/p', enabled: true, onToast })
  );
  act(() => hook.result.current.toggleEditMode());
  const send = (data: unknown): void => {
    window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
  };
  act(() =>
    send({ type: 'ss:select', signature: { tagName: 'div', className: 'hero' }, count: 1 })
  );
  act(() => send({ type: 'ss:cascade', rules: [matched] }));
  const hero = () => hook.result.current.rows.find((r) => r.selector === '.hero' && !r.draft);
  await waitFor(() => expect(hero()).toBeDefined());
  const key = rowKey(hero()!);
  return { hook, key, onToast };
}

describe('useCssCascadeEditor — structural edits on a stale rule (#1008)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-seed — clearing wipes the implementations.
    for (const list of [listCssClasses, listCssSelectors, listCssVariables, listStylesheets]) {
      vi.mocked(list).mockResolvedValue([]);
    }
  });

  it('re-locates and retries a rename against where the rule is now', async () => {
    const { hook, key, onToast } = await setUp();
    vi.mocked(renameCssSelector).mockRejectedValueOnce(STALE).mockResolvedValueOnce(undefined);
    vi.mocked(locateCssRules).mockResolvedValueOnce([
      { status: 'resolved', file: 'moved.css', line: 9, inner_text: ' color: blue; ' },
    ]);

    await act(() => hook.result.current.renameSelector(key, '.banner'));

    expect(renameCssSelector).toHaveBeenLastCalledWith(
      '/p',
      'moved.css',
      '.hero',
      null,
      ' color: blue; ',
      '.banner'
    );
    expect(hook.result.current.rows.find((r) => r.selector === '.banner')).toMatchObject({
      file: 'moved.css',
    });
    expect(onToast).not.toHaveBeenCalled();
  });

  it('warns (not errors) when the rule is still gone after re-locating', async () => {
    const { hook, key, onToast } = await setUp();
    vi.mocked(deleteCssRule).mockRejectedValueOnce(STALE);
    vi.mocked(locateCssRules).mockResolvedValueOnce([{ status: 'not_found' }]);

    await act(() => hook.result.current.deleteRule(key));

    expect(deleteCssRule).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the mock
    expect(logger.warn).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the mock
    expect(logger.error).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('no longer matches'), 'error');
  });

  it('does not retry a failure that is not a stale rule', async () => {
    const { hook, key } = await setUp();
    vi.mocked(deleteCssRule).mockRejectedValueOnce({ type: 'Io', message: 'disk full' });

    await act(() => hook.result.current.deleteRule(key));

    expect(deleteCssRule).toHaveBeenCalledTimes(1);
    expect(locateCssRules).toHaveBeenCalledTimes(1); // only the initial cascade locate
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the mock
    expect(logger.error).toHaveBeenCalled();
  });
});
