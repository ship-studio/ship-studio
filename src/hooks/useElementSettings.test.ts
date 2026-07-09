/**
 * Element Settings — the CLASSES editor's two add-class paths.
 *
 * Focus: the regression where an element with NO class couldn't be styled at all —
 * `addClass` resolved via the class-literal resolver (which has nothing to anchor
 * on for a classless element) and dead-ended with a generic toast. The classless
 * path must now INSERT a fresh class attribute (`insertClassAttr`), while elements
 * WITH classes keep the resolve + replace path. Only the Tauri-backed lib calls
 * are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/edit', async (importActual) => {
  const actual = await importActual<typeof import('../lib/edit')>();
  return {
    ...actual,
    resolveClassnameSource: vi.fn(),
    applyClassnameEdit: vi.fn(),
    applyClassnameEditMulti: vi.fn(),
    insertClassAttr: vi.fn(),
  };
});
vi.mock('../lib/edit-html', () => ({
  resolveElementHtml: vi.fn(),
  applyElementHtml: vi.fn(),
}));
// trackEvent would otherwise reach for a real Tauri IPC on a saved edit.
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));

import { useElementSettings } from './useElementSettings';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  insertClassAttr,
  type ElementSignature,
} from '../lib/edit';
import { resolveElementHtml } from '../lib/edit-html';

type Fn = ReturnType<typeof vi.fn>;

function fakeIframeRef() {
  return {
    current: { contentWindow: { postMessage: vi.fn() } },
  } as unknown as React.RefObject<HTMLIFrameElement | null>;
}

/** Calls posted to the iframe, as `{type, ...}` objects. */
function posts(iframeRef: React.RefObject<HTMLIFrameElement | null>) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the postMessage mock's calls, not invoking it bound
  const fn = iframeRef.current!.contentWindow!.postMessage as Fn;
  return (fn.mock.calls as Array<[{ type?: string }]>).map((c) => c[0]);
}

function setup(signature: ElementSignature) {
  const iframeRef = fakeIframeRef();
  const onToast = vi.fn();
  const hook = renderHook(() =>
    useElementSettings({ iframeRef, projectPath: '/proj', enabled: true, signature, onToast })
  );
  return { ...hook, iframeRef, onToast };
}

/** Run the fire-and-forget `addClass` and flush its promise chain. */
async function add(result: { current: { addClass: (n: string) => void } }, name: string) {
  await act(async () => {
    result.current.addClass(name);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const CLASSLESS: ElementSignature = {
  className: '',
  tagName: 'div',
  text: 'Hello there world',
  ancestorClasses: ['wrapper'],
};
const CLASSED: ElementSignature = { className: 'p-3', tagName: 'div', ancestorClasses: [] };

beforeEach(() => {
  vi.clearAllMocks();
  // Attributes panel resolve is irrelevant here — let it fail (attributes hidden).
  (resolveElementHtml as Fn).mockRejectedValue(new Error('not anchored'));
  (insertClassAttr as Fn).mockResolvedValue({ file: 'Hero.tsx', line: 3, column: 6 });
  (resolveClassnameSource as Fn).mockResolvedValue({
    status: 'resolved',
    file: 'Hero.tsx',
    line: 3,
    column: 6,
    class_name: 'p-3',
    confidence: 'unique',
  });
  (applyClassnameEdit as Fn).mockResolvedValue(undefined);
});

describe('useElementSettings addClass', () => {
  it('inserts a fresh class attribute for an element with NO class (the classless regression)', async () => {
    const { result, iframeRef } = setup(CLASSLESS);

    await add(result, 'mt-4');

    // The insert path runs INSTEAD of resolve + replace (which has no literal to
    // anchor on for a classless element and used to dead-end with a toast).
    expect(insertClassAttr).toHaveBeenCalledWith('/proj', CLASSLESS, 'mt-4');
    expect(resolveClassnameSource).not.toHaveBeenCalled();
    expect(applyClassnameEdit).not.toHaveBeenCalled();
    expect(result.current.classes).toEqual(['mt-4']);

    // Same live-preview protocol as a successful class rewrite.
    const sent = posts(iframeRef);
    expect(sent).toContainEqual({ type: 'ss:suppressReload' });
    expect(sent).toContainEqual({ type: 'ss:mutate', className: 'mt-4', rules: [] });
    expect(sent).toContainEqual({ type: 'ss:commit' });
  });

  it("surfaces the backend's specific reason when the classless insert is rejected", async () => {
    (insertClassAttr as Fn).mockRejectedValue({
      type: 'Validation',
      field: 'element',
      reason:
        "Couldn't tell which <div> in source to add the class to — 3 classless <div> tag(s) matched",
    });
    const { result, onToast } = setup(CLASSLESS);

    await add(result, 'mt-4');

    expect(onToast).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't tell which <div> in source"),
      'error'
    );
    // Nothing was written — the class list stays empty.
    expect(result.current.classes).toEqual([]);
  });

  it('keeps the resolve + replace path for an element that already has classes', async () => {
    const { result } = setup(CLASSED);

    await add(result, 'mt-4');

    expect(insertClassAttr).not.toHaveBeenCalled();
    expect(resolveClassnameSource).toHaveBeenCalledWith('/proj', CLASSED);
    expect(applyClassnameEdit).toHaveBeenCalledWith('/proj', 'Hero.tsx', 3, 'p-3', 'p-3 mt-4');
    expect(result.current.classes).toEqual(['p-3', 'mt-4']);
  });
});
