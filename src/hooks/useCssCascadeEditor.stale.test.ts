import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/cssCascade', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cssCascade')>();
  return {
    ...actual,
    locateCssRules: vi.fn(),
    createCssRule: vi.fn(),
    listStylesheets: vi.fn(),
    replaceCssSelectorList: vi.fn(),
    deleteCssRule: vi.fn(),
  };
});
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: log }));

import {
  createCssRule,
  deleteCssRule,
  listStylesheets,
  locateCssRules,
  replaceCssSelectorList,
  type CssRuleSourceIdentity,
  type RuleLocation,
} from '../lib/cssCascade';
import { useCssCascadeEditor } from './useCssCascadeEditor';

// The exact backend rejection from issue #1008.
const STALE = {
  type: 'Validation',
  field: 'selector',
  reason: 'rule no longer matches — reselect the element',
};

function identity(
  file: string,
  selector: string,
  innerText: string,
  version: string
): CssRuleSourceIdentity {
  return {
    sourcePath: file,
    sourceVersion: version,
    selectorOffset: 0,
    selector,
    selectorMemberIndex: 0,
    matchedSelector: selector,
    selectorMembers: [selector],
    innerText,
    contextPath: [],
  };
}

function located(sourceIdentity: CssRuleSourceIdentity): RuleLocation[] {
  return [
    {
      status: 'resolved',
      file: sourceIdentity.sourcePath,
      line: 1,
      inner_text: sourceIdentity.innerText,
      source_identity: sourceIdentity,
    },
  ];
}

async function setupWithRule() {
  const onToast = vi.fn();
  const iframeRef = { current: null };
  const hook = renderHook(() =>
    useCssCascadeEditor({
      iframeRef,
      projectPath: '/p',
      enabled: true,
      onToast,
    })
  );
  await act(async () => {
    await hook.result.current.addSelector('.hero');
  });
  const row = hook.result.current.rows.find((r) => r.selector === '.hero');
  if (!row) throw new Error('rule card was not created');
  const { rowKey } = await vi.importActual<typeof import('../lib/cssCascade')>('../lib/cssCascade');
  return { ...hook, onToast, key: rowKey(row) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listStylesheets).mockResolvedValue(['styles.css']);
  vi.mocked(createCssRule).mockResolvedValue(identity('styles.css', '.hero', '\n', 'v1'));
  vi.mocked(locateCssRules).mockResolvedValue(located(identity('styles.css', '.hero', '\n', 'v1')));
});

describe('useCssCascadeEditor stale-rule handling (issue #1008)', () => {
  it('re-locates and retries a rename the backend rejected as stale', async () => {
    const { result, onToast, key } = await setupWithRule();
    const relocated = identity('other.css', '.hero', '\n  color: red;\n', 'v2');
    const renamed = identity('other.css', '.hero-2', '\n  color: red;\n', 'v3');
    vi.mocked(replaceCssSelectorList).mockRejectedValueOnce(STALE).mockResolvedValueOnce(renamed);
    vi.mocked(locateCssRules).mockResolvedValue(located(relocated));

    await act(async () => {
      await result.current.renameSelector(key, '.hero-2');
    });

    expect(replaceCssSelectorList).toHaveBeenCalledTimes(2);
    expect(replaceCssSelectorList).toHaveBeenLastCalledWith(
      '/p',
      'other.css',
      '.hero',
      null,
      '\n  color: red;\n',
      '.hero-2',
      relocated
    );
    expect(onToast).not.toHaveBeenCalledWith(expect.anything(), 'error');
    expect(log.error).not.toHaveBeenCalled();
    expect(result.current.rows.some((r) => r.selector === '.hero-2')).toBe(true);
  });

  it('warns instead of filing a bug when the rule is still stale after re-locating', async () => {
    const { result, onToast, key } = await setupWithRule();
    vi.mocked(replaceCssSelectorList).mockRejectedValue(STALE);

    await act(async () => {
      await result.current.renameSelector(key, '.hero-2');
    });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('[CssCascade] rename failed', {
      error: 'Validation failed for `selector`: rule no longer matches — reselect the element',
    });
    expect(onToast).toHaveBeenCalledWith(
      'Validation failed for `selector`: rule no longer matches — reselect the element',
      'error'
    );
  });

  it('does not retry a stale delete against the re-located rule', async () => {
    const { result, key } = await setupWithRule();
    vi.mocked(deleteCssRule).mockRejectedValue(STALE);

    await act(async () => {
      await result.current.deleteRule(key);
    });

    expect(deleteCssRule).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('[CssCascade] delete failed', expect.anything());
  });
});

describe('useCssCascadeEditor add selector (issue #1015)', () => {
  it('shows the no-stylesheet refusal as info, not a reported error', async () => {
    vi.mocked(listStylesheets).mockResolvedValue([]);
    const onToast = vi.fn();
    const iframeRef = { current: null };
    const { result } = renderHook(() =>
      useCssCascadeEditor({
        iframeRef,
        projectPath: '/p',
        enabled: true,
        onToast,
      })
    );
    await act(async () => {
      await result.current.addSelector('.hero');
    });
    expect(onToast).toHaveBeenCalledWith('No stylesheet found to add the rule to.', 'info');
  });
});
