/**
 * Element Settings source writes, their guarded preview protocols, and the
 * CLASSES editor's two add-class paths.
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
    resolveTextSource: vi.fn(),
    applyTextEdit: vi.fn(),
  };
});
vi.mock('../lib/edit-html', () => ({
  resolveElementHtml: vi.fn(),
  applyElementHtml: vi.fn(),
}));
// trackEvent would otherwise reach for a real Tauri IPC on a saved edit.
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { useElementSettings } from './useElementSettings';
import { logger } from '../lib/logger';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  insertClassAttr,
  resolveTextSource,
  applyTextEdit,
  type ElementSignature,
  type TextResolution,
} from '../lib/edit';
import { resolveElementHtml, applyElementHtml } from '../lib/edit-html';

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
  return (
    fn.mock.calls as Array<
      [
        {
          type?: string;
          signature?: ElementSignature;
          className?: string;
          value?: string;
          rules?: unknown[];
        },
      ]
    >
  ).map((c) => c[0]);
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

async function rename(
  result: { current: { renameClass: (oldName: string, newName: string) => void } },
  oldName: string,
  newName: string
) {
  await act(async () => {
    result.current.renameClass(oldName, newName);
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
  (resolveTextSource as Fn).mockResolvedValue({
    status: 'read_only',
    reason: 'This element has no editable text.',
  });
  (applyElementHtml as Fn).mockResolvedValue(1);
  (applyTextEdit as Fn).mockResolvedValue(undefined);
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

    // A by-design refusal: the backend declining to guess which of several
    // look-alike tags was clicked. The user still gets the specific reason, but
    // as 'info' — an 'error' toast re-files it as a bug on every occurrence
    // through useToasts' `source: 'toast'` reporting (issue #818).
    expect(onToast).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't tell which <div> in source"),
      'info'
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    const errorLog = logger.error as Fn;
    expect(errorLog).not.toHaveBeenCalled();
    // The warn log carries the same formatted message — a plain CommandError
    // object through String(err) would log "[object Object]" (issues #516/#517).
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    const warnLog = logger.warn as Fn;
    const logged = (warnLog.mock.calls as Array<[string, { error: string }]>).find(
      ([msg]) => msg === '[ElementSettings] add class refused'
    );
    expect(logged?.[1].error).toContain("Couldn't tell which <div>");
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

describe('useElementSettings renameClass', () => {
  it('rewrites the generated anchor and refreshes the live selection signature', async () => {
    const generated = { ...CLASSED, className: 'ss-div-c098' };
    (resolveClassnameSource as Fn).mockResolvedValue({
      status: 'resolved',
      file: 'app/page.tsx',
      line: 132,
      column: 5,
      class_name: 'ss-div-c098',
      confidence: 'unique',
    });
    const { result, iframeRef } = setup(generated);

    await rename(result, 'ss-div-c098', 'content-panel');

    expect(applyClassnameEdit).toHaveBeenCalledWith(
      '/proj',
      'app/page.tsx',
      132,
      'ss-div-c098',
      'content-panel'
    );
    expect(result.current.classes).toEqual(['content-panel']);
    const reselect = posts(iframeRef).find((message) => message.type === 'ss:reselect');
    expect(reselect?.signature?.className).toBe('content-panel');
  });
});

describe('useElementSettings text source editing', () => {
  it('shows the full resolved source text and encodes text safely for JSX writes', async () => {
    const signature = { ...CLASSLESS, text: 'Shortened selection preview…' };
    (resolveElementHtml as Fn).mockResolvedValue({
      file: 'Hero.tsx',
      line: 4,
      html: '<h1 className="hero" {...props} data-note={config.title} id="main">A &amp; B</h1>',
    });
    (resolveTextSource as Fn).mockResolvedValue({
      status: 'resolved',
      file: 'Hero.tsx',
      line: 4,
      column: 23,
      text: 'A &amp; B &copy;',
      confidence: 'unique',
    });
    const { result, iframeRef } = setup(signature);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.text).toBe('A & B ©');
    expect(result.current.canEditText).toBe(true);
    expect(result.current.attributes).toEqual([
      { name: 'data-note', value: '{config.title}', isExpression: true },
      { name: 'id', value: 'main' },
    ]);

    await act(async () => {
      await result.current.setText('A & <copy> {title}');
    });

    expect(applyTextEdit).toHaveBeenCalledWith(
      '/proj',
      'Hero.tsx',
      4,
      23,
      'A &amp; B &copy;',
      'A &amp; &lt;copy&gt; &#123;title&#125;'
    );
    expect(posts(iframeRef)).toContainEqual({
      type: 'ss:setText',
      value: 'A & <copy> {title}',
    });
    expect(posts(iframeRef)).toContainEqual({ type: 'ss:commit' });
    const reselect = posts(iframeRef).find((message) => message.type === 'ss:reselect');
    expect(reselect?.signature?.text).toBe('A & <copy> {title}');
  });

  it('does not let a stale resolver replace the next selected element text', async () => {
    const oldSelection = { ...CLASSLESS, text: 'Old element text' };
    const newSelection = { ...CLASSLESS, className: 'new', text: 'New element text' };
    let resolveOld!: (value: TextResolution) => void;
    const oldResolution = new Promise<TextResolution>((resolve) => {
      resolveOld = resolve;
    });
    vi.mocked(resolveTextSource).mockImplementation(
      (_projectPath: string, selected: ElementSignature) =>
        selected === oldSelection
          ? oldResolution
          : Promise.resolve({ status: 'read_only', reason: 'new selection reason' })
    );
    const iframeRef = fakeIframeRef();
    const onToast = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }: { selected: ElementSignature }) =>
        useElementSettings({
          iframeRef,
          projectPath: '/proj',
          enabled: true,
          signature: selected,
          onToast,
        }),
      { initialProps: { selected: oldSelection } }
    );

    rerender({ selected: newSelection });
    await act(async () => {
      resolveOld({
        status: 'resolved',
        file: 'Hero.tsx',
        line: 1,
        column: 1,
        text: 'Old element text',
        confidence: 'unique',
      });
      await Promise.resolve();
    });

    expect(result.current.text).toBe('');
    expect(result.current.textReason).toBe('new selection reason');
  });
});

describe('useElementSettings tag conversion', () => {
  it('keeps rendered image values read-only when resolved markup does not contain them', async () => {
    const signature: ElementSignature = {
      className: 'hero',
      tagName: 'img',
      ancestorClasses: [],
      attrSrc: '/rendered.png',
      attrAlt: 'Rendered hero',
    };
    (resolveElementHtml as Fn).mockResolvedValue({
      file: 'Hero.tsx',
      line: 3,
      html: '<img className="hero" />',
    });
    const { result, onToast } = setup(signature);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.sourceMarkupStatus).toBe('resolved');
    expect(result.current.imageAttributeEditBlockReason).toBe('mismatch');
    expect(result.current.canEditAttributes).toBe(false);
    await act(async () => {
      expect(await result.current.setAttribute('src', '/replacement.png')).toBe(false);
    });
    expect(applyElementHtml).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('rendered attributes'), 'info');
  });

  it.each([
    {
      name: 'spread-backed image markup',
      html: '<img className="hero" alt="Hero" {...props} />',
      locations: undefined,
      reason: 'spread' as const,
    },
    {
      name: 'ambiguous identical image markup',
      html: '<img className="hero" alt="Hero" />',
      locations: [
        { file: 'Hero.tsx', line: 3, column: 10 },
        { file: 'Footer.tsx', line: 8, column: 10 },
      ],
      reason: 'ambiguous' as const,
    },
  ])('refuses every image attribute write for $name', async ({ html, locations, reason }) => {
    const signature: ElementSignature = { className: 'hero', tagName: 'img', ancestorClasses: [] };
    (resolveElementHtml as Fn).mockResolvedValue({
      file: 'Hero.tsx',
      line: 3,
      html,
      locations,
    });
    const { result, onToast } = setup(signature);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.canEditAttributes).toBe(false);
    expect(result.current.imageAttributeEditBlockReason).toBe(reason);
    await act(async () => {
      expect(await result.current.setAttribute('alt', 'Changed')).toBe(false);
      result.current.renameAttribute('alt', 'aria-label', 'Hero');
    });
    expect(applyElementHtml).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('image'), 'info');
  });

  it('replaces only the paired tag names and reselects the live preview node', async () => {
    const source =
      '<div data-note={title.includes(">") ? "yes" : "no"} className={classes}>before<div>inner</div> after</div>';
    const signature = { ...CLASSLESS, text: 'before inner after' };
    (resolveElementHtml as Fn).mockResolvedValue({
      file: 'Hero.tsx',
      line: 3,
      html: source,
    });
    const { result, iframeRef } = setup(signature);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.canEditTag).toBe(true);

    await act(async () => {
      await result.current.setTag('section');
    });

    const converted =
      '<section data-note={title.includes(">") ? "yes" : "no"} className={classes}>before<div>inner</div> after</section>';
    expect(applyElementHtml).toHaveBeenCalledWith('/proj', signature, source, converted);
    expect(posts(iframeRef)).toContainEqual({ type: 'ss:setTag', value: 'section' });
    const reselect = posts(iframeRef).find((message) => message.type === 'ss:reselect');
    expect(reselect?.signature?.tagName).toBe('section');
  });

  it('does not overwrite the next selection when an older attribute write finishes late', async () => {
    const oldSelection = { ...CLASSLESS, className: 'old', text: 'Old selection' };
    const newSelection = { ...CLASSLESS, className: 'new', text: 'New selection' };
    vi.mocked(resolveElementHtml).mockImplementation(
      (_projectPath: string, selected: ElementSignature) =>
        Promise.resolve({
          file: 'Hero.tsx',
          line: 1,
          html:
            selected === oldSelection
              ? '<div className="old">Old selection</div>'
              : '<div className="new" data-new="fresh">New selection</div>',
        })
    );

    let finishOldWrite!: () => void;
    const oldWrite = new Promise<number>((resolve) => {
      finishOldWrite = () => resolve(1);
    });
    (applyElementHtml as Fn).mockReturnValue(oldWrite);

    const iframeRef = fakeIframeRef();
    const onToast = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }: { selected: ElementSignature }) =>
        useElementSettings({
          iframeRef,
          projectPath: '/proj',
          enabled: true,
          signature: selected,
          onToast,
        }),
      { initialProps: { selected: oldSelection } }
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      void result.current.setAttribute('title', 'old write');
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ selected: newSelection });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.attributes).toEqual([{ name: 'data-new', value: 'fresh' }]);

    await act(async () => {
      finishOldWrite();
      await Promise.resolve();
    });

    expect(result.current.attributes).toEqual([{ name: 'data-new', value: 'fresh' }]);
    expect(result.current.tag).toBe('div');
  });
});
