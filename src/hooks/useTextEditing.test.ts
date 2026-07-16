/**
 * Inline text-editing bridge for both styling editors.
 *
 * Focus: the regression that shipped text editing broken for vanilla-CSS / Astro
 * projects — a confirmed `ss:textCommit` must write to source (`applyTextEdit`)
 * and re-baseline (`ss:commit`). Also covers the select-time editability gating
 * (`ss:textInfo`), the failure-revert path, and the iframe-source security guard.
 * Only the two Tauri-backed calls (resolve + write-back) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/edit', async (importActual) => {
  const actual = await importActual<typeof import('../lib/edit')>();
  return {
    ...actual,
    resolveTextSource: vi.fn(),
    applyTextEdit: vi.fn(),
  };
});

// trackEvent would otherwise reach for a real Tauri IPC on a saved edit.
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));

import { useTextEditing } from './useTextEditing';
import { resolveTextSource, applyTextEdit } from '../lib/edit';

type Fn = ReturnType<typeof vi.fn>;

function fakeIframeRef() {
  return {
    current: { contentWindow: { postMessage: vi.fn() } },
  } as unknown as React.RefObject<HTMLIFrameElement | null>;
}

function setup(enabled = true) {
  const iframeRef = fakeIframeRef();
  const onToast = vi.fn();
  const hook = renderHook(() =>
    useTextEditing({ iframeRef, projectPath: '/proj', enabled, onToast })
  );
  return { ...hook, iframeRef, onToast };
}

/** Calls posted back to the iframe, as `{type}` objects. */
function posts(iframeRef: React.RefObject<HTMLIFrameElement | null>) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the postMessage mock's calls, not invoking it bound
  const fn = iframeRef.current!.contentWindow!.postMessage as Fn;
  return (fn.mock.calls as Array<[{ type?: string; editable?: boolean }]>).map((c) => c[0]);
}

/** Dispatch a window message as if from the given source, then flush microtasks. */
async function dispatch(data: unknown, source: MessageEventSource) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source, data }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

const SIG = { className: 'lead', tagName: 'p', ancestorClasses: [] };

beforeEach(() => {
  vi.clearAllMocks();
  (resolveTextSource as Fn).mockResolvedValue({
    status: 'resolved',
    file: 'src/pages/index.astro',
    line: 7,
    column: 3,
    text: 'Old copy',
  });
  (applyTextEdit as Fn).mockResolvedValue(undefined);
});

afterEach(() => {
  localStorage.clear();
});

describe('useTextEditing', () => {
  it('writes a confirmed text edit to source and re-baselines (the CSS-editor regression)', async () => {
    const { iframeRef, onToast } = setup();
    const src = iframeRef.current!.contentWindow!;

    // A leaf-text selection resolves and the iframe is told editing is allowed.
    await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
    expect(posts(iframeRef)).toContainEqual({ type: 'ss:textInfo', editable: true });

    // Confirm an edit → the new text is written to the resolved source location.
    await dispatch({ type: 'ss:textCommit', text: 'New copy' }, src);
    expect(applyTextEdit).toHaveBeenCalledTimes(1);
    expect((applyTextEdit as Fn).mock.calls[0]).toEqual([
      '/proj',
      'src/pages/index.astro',
      7,
      3,
      'Old copy',
      'New copy',
    ]);
    expect(posts(iframeRef)).toContainEqual({ type: 'ss:commit' });
    expect(onToast).toHaveBeenCalledWith('Saved to source', 'success');
  });

  it('posts editable:false for a non-leaf selection and never resolves text', async () => {
    const { iframeRef } = setup();
    await dispatch(
      { type: 'ss:select', signature: SIG, leafText: false },
      iframeRef.current!.contentWindow!
    );
    expect(resolveTextSource).not.toHaveBeenCalled();
    expect(posts(iframeRef)).toContainEqual({ type: 'ss:textInfo', editable: false });
  });

  it('reverts the preview when the source write fails', async () => {
    (applyTextEdit as Fn).mockRejectedValueOnce(new Error('boom'));
    const { iframeRef, onToast } = setup();
    const src = iframeRef.current!.contentWindow!;
    await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
    await dispatch({ type: 'ss:textCommit', text: 'New copy' }, src);
    expect(posts(iframeRef)).toContainEqual({ type: 'ss:textRevert' });
    expect(onToast).toHaveBeenCalledWith('boom', 'error');
  });

  it('does not write when the text is unchanged (just re-baselines)', async () => {
    const { iframeRef } = setup();
    const src = iframeRef.current!.contentWindow!;
    await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
    await dispatch({ type: 'ss:textCommit', text: 'Old copy' }, src);
    expect(applyTextEdit).not.toHaveBeenCalled();
    expect(posts(iframeRef)).toContainEqual({ type: 'ss:commit' });
  });

  it('ignores messages that do not originate from the preview iframe', async () => {
    setup(); // registers the listener; the forged message below must be rejected
    // A forged commit from another frame must not write to the user's files.
    await dispatch({ type: 'ss:textCommit', text: 'Injected' }, {} as MessageEventSource);
    expect(applyTextEdit).not.toHaveBeenCalled();
  });

  it('is inert when no editor is in edit mode', async () => {
    const { iframeRef } = setup(false);
    await dispatch(
      { type: 'ss:select', signature: SIG, leafText: true },
      iframeRef.current!.contentWindow!
    );
    expect(resolveTextSource).not.toHaveBeenCalled();
  });
});
