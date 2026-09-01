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

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { useTextEditing } from './useTextEditing';
import { resolveTextSource, applyTextEdit } from '../lib/edit';
import { logger } from '../lib/logger';

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

  describe('stale-save recovery (issue #557)', () => {
    /** The drift guard's exact rejection shape from apply_text_edit. */
    const DRIFT_REJECTION = {
      type: 'Validation',
      field: 'old_text',
      reason: 'source no longer matches — reselect the element',
    };

    /** Extra microtask flushes: the recovery path chains re-resolve + re-apply. */
    const settle = () =>
      act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });

    it('re-resolves and re-applies the typed text when the drift guard rejects a stale save', async () => {
      (applyTextEdit as Fn).mockRejectedValueOnce(DRIFT_REJECTION).mockResolvedValueOnce(undefined);
      (resolveTextSource as Fn)
        // Select-time resolve: the (about-to-be-stale) baseline.
        .mockResolvedValueOnce({
          status: 'resolved',
          file: 'src/pages/index.astro',
          line: 7,
          column: 3,
          text: 'Old copy',
        })
        // Recovery resolve: a formatter/HMR write moved the text and reflowed it.
        .mockResolvedValueOnce({
          status: 'resolved',
          file: 'src/pages/index.astro',
          line: 9,
          column: 5,
          text: 'Old copy, reflowed',
        });
      const { iframeRef, onToast } = setup();
      const src = iframeRef.current!.contentWindow!;
      await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
      await dispatch({ type: 'ss:textCommit', text: 'New copy' }, src);
      await settle();

      // The retry wrote the user's text against the FRESH location + baseline —
      // the typed copy was not discarded.
      expect(applyTextEdit).toHaveBeenCalledTimes(2);
      expect((applyTextEdit as Fn).mock.calls[1]).toEqual([
        '/proj',
        'src/pages/index.astro',
        9,
        5,
        'Old copy, reflowed',
        'New copy',
      ]);
      expect(posts(iframeRef)).toContainEqual({ type: 'ss:commit' });
      expect(posts(iframeRef)).not.toContainEqual({ type: 'ss:textRevert' });
      expect(onToast).toHaveBeenCalledWith('Saved to source', 'success');
      // Recovered drift is an expected state — it must not auto-file a report.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the mock, not invoking it bound
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('re-baselines without writing when the fresh source already holds the typed text', async () => {
      (applyTextEdit as Fn).mockRejectedValueOnce(DRIFT_REJECTION);
      (resolveTextSource as Fn)
        .mockResolvedValueOnce({
          status: 'resolved',
          file: 'src/pages/index.astro',
          line: 7,
          column: 3,
          text: 'Old copy',
        })
        // e.g. the first write actually landed but its response was lost.
        .mockResolvedValueOnce({
          status: 'resolved',
          file: 'src/pages/index.astro',
          line: 7,
          column: 3,
          text: 'New copy',
        });
      const { iframeRef, onToast } = setup();
      const src = iframeRef.current!.contentWindow!;
      await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
      await dispatch({ type: 'ss:textCommit', text: 'New copy' }, src);
      await settle();

      expect(applyTextEdit).toHaveBeenCalledTimes(1); // no second write needed
      expect(posts(iframeRef)).toContainEqual({ type: 'ss:commit' });
      expect(posts(iframeRef)).not.toContainEqual({ type: 'ss:textRevert' });
      expect(onToast).toHaveBeenCalledWith('Saved to source', 'success');
    });

    it('is never silent when recovery fails: explains, reverts, and does not auto-file', async () => {
      (applyTextEdit as Fn).mockRejectedValue(DRIFT_REJECTION);
      (resolveTextSource as Fn)
        .mockResolvedValueOnce({
          status: 'resolved',
          file: 'src/pages/index.astro',
          line: 7,
          column: 3,
          text: 'Old copy',
        })
        // The element's text is gone from source — nothing to re-apply against.
        .mockResolvedValueOnce({ status: 'read_only', reason: 'no longer found' });
      const { iframeRef, onToast } = setup();
      const src = iframeRef.current!.contentWindow!;
      await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
      await dispatch({ type: 'ss:textCommit', text: 'New copy' }, src);
      await settle();

      expect(applyTextEdit).toHaveBeenCalledTimes(1);
      expect(posts(iframeRef)).toContainEqual({ type: 'ss:textRevert' });
      expect(onToast).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't save your text"),
        'error'
      );
      // Expected environment state (the file changed underneath us) — warn only.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the mock, not invoking it bound
      expect(logger.warn).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the mock, not invoking it bound
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('retries even when the re-resolve matches the stale baseline exactly', async () => {
      // The rejection came from the backend's own read a moment earlier, so an
      // identical re-resolve means the transient writer (formatter, HMR) has
      // already settled back — the same write plausibly succeeds now. Giving up
      // here threw away saves that could have landed (issue #769).
      (applyTextEdit as Fn).mockRejectedValueOnce(DRIFT_REJECTION);
      (resolveTextSource as Fn).mockResolvedValue({
        status: 'resolved',
        file: 'src/pages/index.astro',
        line: 7,
        column: 3,
        text: 'Old copy',
      });
      const { iframeRef, onToast } = setup();
      const src = iframeRef.current!.contentWindow!;
      await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
      await dispatch({ type: 'ss:textCommit', text: 'New copy' }, src);
      await settle();

      expect(applyTextEdit).toHaveBeenCalledTimes(2);
      expect(posts(iframeRef)).not.toContainEqual({ type: 'ss:textRevert' });
      expect(onToast).toHaveBeenCalledWith('Saved to source', 'success');
    });

    it('still reverts when the retry is rejected too', async () => {
      // The retry is an extra chance, not a way around the guard: a second
      // rejection still explains, reverts, and stays out of the bug pipeline.
      (applyTextEdit as Fn).mockRejectedValue(DRIFT_REJECTION);
      (resolveTextSource as Fn).mockResolvedValue({
        status: 'resolved',
        file: 'src/pages/index.astro',
        line: 7,
        column: 3,
        text: 'Old copy',
      });
      const { iframeRef, onToast } = setup();
      const src = iframeRef.current!.contentWindow!;
      await dispatch({ type: 'ss:select', signature: SIG, leafText: true }, src);
      await dispatch({ type: 'ss:textCommit', text: 'New copy' }, src);
      await settle();

      expect(applyTextEdit).toHaveBeenCalledTimes(2);
      expect(posts(iframeRef)).toContainEqual({ type: 'ss:textRevert' });
      expect(onToast).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't save your text"),
        'error'
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the mock, not invoking it bound
      expect(logger.error).not.toHaveBeenCalled();
    });
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
