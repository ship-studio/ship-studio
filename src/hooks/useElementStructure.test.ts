/**
 * Structural editing bridge (insert / duplicate / delete) for both styling
 * editors.
 *
 * Focus: a selection tracked from `ss:select`/`ss:selRect`, actions calling the
 * Tauri-backed commands, the post-write `ss:reselect` of the NEW element (its
 * generated class), the failure-toast path (no reselect), and the
 * iframe-source security guard. Only the Tauri-backed calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, renderHook, act } from '@testing-library/react';

vi.mock('../lib/edit-structure', async (importActual) => {
  const actual = await importActual<typeof import('../lib/edit-structure')>();
  return {
    ...actual,
    insertElement: vi.fn(),
    duplicateElement: vi.fn(),
    deleteElement: vi.fn(),
    pasteElement: vi.fn(),
  };
});
vi.mock('../lib/edit-html', () => ({
  resolveElementHtml: vi.fn(),
}));
// trackEvent would otherwise reach for a real Tauri IPC on a saved edit.
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));

import {
  useElementStructure,
  structuralEditMessage,
  isExpectedStructuralRefusal,
} from './useElementStructure';
import {
  insertElement,
  duplicateElement,
  deleteElement,
  pasteElement,
} from '../lib/edit-structure';
import { resolveElementHtml } from '../lib/edit-html';

type Fn = ReturnType<typeof vi.fn>;

function fakeIframeRef() {
  return {
    current: {
      contentWindow: { postMessage: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  } as unknown as React.RefObject<HTMLIFrameElement | null>;
}

function setup(enabled = true) {
  const iframeRef = fakeIframeRef();
  const onToast = vi.fn();
  const hook = renderHook(() =>
    useElementStructure({ iframeRef, projectPath: '/proj', enabled, onToast })
  );
  return { ...hook, iframeRef, onToast };
}

/** Calls posted back to the iframe, as `{type, ...}` objects. */
function posts(iframeRef: React.RefObject<HTMLIFrameElement | null>) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the postMessage mock's calls, not invoking it bound
  const fn = iframeRef.current!.contentWindow!.postMessage as Fn;
  return (
    fn.mock.calls as Array<[{ type?: string; signature?: Record<string, unknown>; id?: number }]>
  ).map((c) => c[0]);
}

/** Dispatch a window message as if from the given source, then flush microtasks. */
async function dispatch(data: unknown, source: MessageEventSource) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source, data }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

const SIG = {
  className: 'hero',
  tagName: 'section',
  text: 'Old copy',
  ancestorClasses: ['page'],
  rect: { top: 10, left: 20, width: 300, height: 100 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  (insertElement as Fn).mockResolvedValue({
    file: 'src/pages/index.astro',
    line: 12,
    className: 'ss-p-ab12',
    tagName: 'p',
  });
  (duplicateElement as Fn).mockResolvedValue({
    file: 'src/pages/index.astro',
    line: 14,
    className: 'hero ss-section-cd34',
    tagName: 'section',
  });
  (deleteElement as Fn).mockResolvedValue(undefined);
  (pasteElement as Fn).mockResolvedValue({
    file: 'src/pages/index.astro',
    line: 16,
    className: 'hero ss-section-ef56',
    tagName: 'section',
  });
  (resolveElementHtml as Fn).mockResolvedValue({
    file: 'src/pages/index.astro',
    line: 8,
    html: '<section class="hero"><p class="child">Child</p></section>',
  });
});

describe('useElementStructure', () => {
  it('tracks the selection from ss:select and refreshes its rect from ss:selRect', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;

    await dispatch({ type: 'ss:select', signature: SIG, count: 3, nodeId: 7 }, source);
    expect(result.current.selection).toMatchObject({ count: 3, nodeId: 7, rect: SIG.rect });

    const moved = { top: 90, left: 20, width: 300, height: 100 };
    await dispatch({ type: 'ss:selRect', rect: moved }, source);
    expect(result.current.selection?.rect).toEqual(moved);
  });

  it('ignores messages that are not from the preview iframe', async () => {
    const { result } = setup();
    await dispatch({ type: 'ss:select', signature: SIG, count: 1 }, window);
    expect(result.current.selection).toBeNull();
  });

  it('insert calls the backend and reselects the NEW element by its generated class', async () => {
    const { result, iframeRef, onToast } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);

    vi.useFakeTimers();
    await act(async () => {
      await result.current.insert('inside', 'p');
    });
    expect(insertElement as Fn).toHaveBeenCalledWith('/proj', SIG, 'inside', 'p');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    const reselect = posts(iframeRef).find((p) => p.type === 'ss:reselect');
    expect(reselect?.signature).toMatchObject({
      className: 'ss-p-ab12',
      tagName: 'p',
      text: 'Write something here.',
      // Inside: the anchor becomes the parent.
      ancestorClasses: ['hero', 'page'],
    });
    expect(onToast).toHaveBeenCalledWith('Added Paragraph', 'success');
    vi.useRealTimers();
  });

  it('duplicate reselects with the copy’s extended class attribute', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1 }, source);

    vi.useFakeTimers();
    await act(async () => {
      await result.current.duplicate();
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const reselect = posts(iframeRef).find((p) => p.type === 'ss:reselect');
    expect(reselect?.signature).toMatchObject({
      className: 'hero ss-section-cd34',
      ancestorClasses: ['page'],
    });
    vi.useRealTimers();
  });

  it('copy captures the selected element markup, including its descendants', async () => {
    const { result, iframeRef, onToast } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);

    await act(async () => {
      await result.current.copy();
    });

    expect(resolveElementHtml as Fn).toHaveBeenCalledWith('/proj', SIG);
    expect(result.current.hasClipboard).toBe(true);
    expect(result.current.clipboardSourceNodeId).toBe(7);
    expect(onToast).toHaveBeenCalledWith('Element copied', 'success');
  });

  it('cut captures the subtree only after deleting the source element', async () => {
    const { result, iframeRef, onToast } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);

    await act(async () => {
      await result.current.cut();
    });

    expect(deleteElement as Fn).toHaveBeenCalledWith(
      '/proj',
      SIG,
      '<section class="hero"><p class="child">Child</p></section>'
    );
    expect(result.current.selection).toBeNull();
    expect(result.current.hasClipboard).toBe(true);
    expect(onToast).toHaveBeenCalledWith('Element cut', 'success');
  });

  it('pastes the captured subtree inside the selected destination', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);
    await act(async () => {
      await result.current.copy();
    });

    const target = { ...SIG, className: 'shell', tagName: 'main', nodeId: 9 };
    await dispatch({ type: 'ss:select', signature: target, count: 1, nodeId: 9 }, source);
    await act(async () => {
      await result.current.paste();
    });

    expect(pasteElement as Fn).toHaveBeenCalledWith(
      '/proj',
      target,
      '<section class="hero"><p class="child">Child</p></section>',
      'hero'
    );
    expect(result.current.hasClipboard).toBe(true);
  });

  it('handles Cmd/Ctrl+C, X, and V from the host window', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'c', metaKey: true });
      await Promise.resolve();
    });
    expect(result.current.hasClipboard).toBe(true);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'x', metaKey: true });
      await Promise.resolve();
    });
    expect(deleteElement as Fn).toHaveBeenCalledWith(
      '/proj',
      SIG,
      '<section class="hero"><p class="child">Child</p></section>'
    );

    await dispatch(
      { type: 'ss:select', signature: { ...SIG, className: 'shell', tagName: 'main' }, nodeId: 9 },
      source
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: 'v', metaKey: true });
      await Promise.resolve();
    });
    expect(pasteElement as Fn).toHaveBeenCalled();
  });

  it('handles Cmd/Ctrl+D and Backspace from the host window', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'd', metaKey: true });
      await Promise.resolve();
    });
    expect(duplicateElement as Fn).toHaveBeenCalledWith('/proj', SIG);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Backspace' });
      await Promise.resolve();
    });
    expect(deleteElement as Fn).toHaveBeenCalledWith(
      '/proj',
      SIG,
      '<section class="hero"><p class="child">Child</p></section>'
    );
    expect(result.current.selection).toBeNull();
  });

  it('handles native macOS clipboard commands through the element actions', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);

    await act(async () => {
      fireEvent.copy(document);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.hasClipboard).toBe(true);

    await act(async () => {
      fireEvent.cut(document);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deleteElement as Fn).toHaveBeenCalledWith(
      '/proj',
      SIG,
      '<section class="hero"><p class="child">Child</p></section>'
    );

    await dispatch(
      { type: 'ss:select', signature: { ...SIG, className: 'shell', tagName: 'main' }, nodeId: 9 },
      source
    );
    await act(async () => {
      fireEvent.paste(document);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pasteElement as Fn).toHaveBeenCalled();
  });

  it('handles element shortcuts forwarded from the preview iframe', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 7 }, source);

    await dispatch({ type: 'ss:elementShortcut', key: 'c' }, source);
    await dispatch({ type: 'ss:elementShortcut', key: 'd' }, source);
    await dispatch({ type: 'ss:elementShortcut', key: 'backspace' }, source);

    expect(result.current.hasClipboard).toBe(true);
    expect(resolveElementHtml as Fn).toHaveBeenCalledWith('/proj', SIG);
    expect(duplicateElement as Fn).toHaveBeenCalledWith('/proj', SIG);
    expect(deleteElement as Fn).toHaveBeenCalledWith(
      '/proj',
      SIG,
      '<section class="hero"><p class="child">Child</p></section>'
    );
  });

  it('delete resolves fresh markup as the drift baseline and clears the selection', async () => {
    const { result, iframeRef, onToast } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 2 }, source);

    await act(async () => {
      await result.current.remove();
    });
    expect(deleteElement as Fn).toHaveBeenCalledWith(
      '/proj',
      SIG,
      '<section class="hero"><p class="child">Child</p></section>'
    );
    expect(result.current.selection).toBeNull();
    expect(onToast).toHaveBeenCalledWith('Element deleted — affects 2 copies', 'success');
  });

  it('a failed write surfaces a toast and never reselects', async () => {
    const { result, iframeRef, onToast } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1 }, source);
    // Reject the way the backend really does: a structured CommandError object.
    // Toasting it un-formatted would render "[object Object]".
    (insertElement as Fn).mockRejectedValue({
      type: 'Validation',
      field: 'element',
      reason: 'This element appears in several identical places',
    });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.insert('after', 'div');
    });
    // The multi-instance resolution failure is rephrased for the structural
    // context (issues #318/#320), not passed through verbatim — and as a
    // recognized by-design refusal it toasts as 'info', not 'error', so it
    // doesn't re-enter telemetry via the toast pipeline (issue #515).
    expect(onToast).toHaveBeenCalledWith(
      expect.stringContaining('appears in several places in your code'),
      'info'
    );
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining('object Object'), 'info');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(posts(iframeRef).find((p) => p.type === 'ss:reselect')).toBeUndefined();
    vi.useRealTimers();
  });

  it('the structural-tag guard toasts friendly wording as info, not a bug', async () => {
    const { result, iframeRef, onToast } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: { ...SIG, tagName: 'body' }, count: 1 }, source);
    // The backend refuses by design; the raw wording used to reach the user
    // verbatim AND file a bug on every occurrence (issues #723/#740).
    (deleteElement as Fn).mockRejectedValue({
      type: 'Validation',
      field: 'element',
      reason: "<body> can't be deleted.",
    });

    await act(async () => {
      await result.current.remove();
    });
    expect(onToast).toHaveBeenCalledWith(
      expect.stringContaining('part of the page itself'),
      'info'
    );
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining("can't be deleted."), 'error');
  });

  it('an unrecognized failure keeps the reportable error toast type', async () => {
    const { result, iframeRef, onToast } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1 }, source);
    (insertElement as Fn).mockRejectedValue({ type: 'Io', message: 'disk full' });

    await act(async () => {
      await result.current.insert('after', 'div');
    });
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('disk full'), 'error');
  });

  it('selectAndRun selects the tree node first, then runs the queued action', async () => {
    const { result, iframeRef } = setup();
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    const action = vi.fn();

    act(() => {
      result.current.selectAndRun(42, action);
    });
    expect(posts(iframeRef).find((p) => p.type === 'ss:selectNode')?.id).toBe(42);
    expect(action).not.toHaveBeenCalled();

    await dispatch({ type: 'ss:select', signature: SIG, count: 1, nodeId: 42 }, source);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled', async () => {
    const { result, iframeRef } = setup(false);
    const source = iframeRef.current!.contentWindow as unknown as MessageEventSource;
    await dispatch({ type: 'ss:select', signature: SIG, count: 1 }, source);
    expect(result.current.selection).toBeNull();
  });
});

describe('structuralEditMessage', () => {
  // The backend's resolution errors are worded for the raw-markup editor;
  // canvas insert/duplicate/delete rephrase the known ones (issues #318/#320).
  it('rephrases the no-class resolution failure', () => {
    const msg = structuralEditMessage(
      "Validation failed for 'element': This element has no class in source to anchor its markup on. Add a class to it first (the Add class action), then its markup becomes editable."
    );
    expect(msg).toContain('Add a class to it first');
    expect(msg).not.toContain('markup');
  });

  it('rephrases both multi-instance failures', () => {
    for (const raw of [
      'This element appears in several places whose markup differs, so editing it here could change the wrong one. Ask your agent to edit it instead.',
      'This element appears in several identical places, so editing its markup here could change the wrong one. Ask your agent to edit it instead.',
    ]) {
      expect(structuralEditMessage(raw)).toContain('appears in several places in your code');
    }
  });

  it('rephrases the dynamic-class failure and passes unknown messages through', () => {
    expect(
      structuralEditMessage(
        "This element can't be matched to its source markup (it has no static class to anchor on). Edit it with your agent instead."
      )
    ).toContain('generated dynamically');
    expect(structuralEditMessage('disk full')).toBe('disk full');
  });

  // The STRUCTURAL_TAGS guard in edit_structure.rs (issues #723/#740).
  it('rephrases the html/head/body structural-tag guard', () => {
    expect(structuralEditMessage("<body> can't be deleted.")).toBe(
      "<body> is part of the page itself, so it can't be deleted. Pick an element inside it instead."
    );
    expect(structuralEditMessage("<html> can't be duplicated.")).toContain("can't be duplicated");
    expect(
      structuralEditMessage("Can't insert next to <head> — insert inside it instead.")
    ).toContain('Nothing can sit beside <head>');
  });

  // Issue #789: raw internal wording reached the toast verbatim.
  it('rephrases the span-mapping failure but keeps it reportable', () => {
    const raw = "couldn't map this element to its source markup";
    expect(structuralEditMessage(raw)).toContain("couldn't read this element's full markup");
    expect(isExpectedStructuralRefusal(raw)).toBe(false);
  });
});

describe('isExpectedStructuralRefusal', () => {
  it('recognizes the by-design refusals, including the structural-tag guard', () => {
    for (const raw of [
      'This element has no class in source to anchor its markup on.',
      'This element appears in several places whose markup differs',
      'This element appears in several identical places',
      "This element can't be matched to its source markup",
      "Couldn't tell which <img> in source to add the class to \u2014 7 classless <img> tag(s) matched",
      "Couldn't find a <div> without a class in source to add a class to",
      "<body> can't be deleted.",
      "<html> can't be duplicated.",
      "Can't insert next to <body>",
    ]) {
      expect(isExpectedStructuralRefusal(raw)).toBe(true);
    }
  });

  it('does not swallow genuine failures', () => {
    expect(isExpectedStructuralRefusal('I/O error: disk full')).toBe(false);
    expect(isExpectedStructuralRefusal("couldn't map this element to its source markup")).toBe(
      false
    );
  });
});
