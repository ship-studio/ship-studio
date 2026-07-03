/**
 * Tests for the redline annotation grammar and the host-driven request entry.
 *
 * The reducer ({@link redlineReducer}) holds the whole annotation-list state, so
 * exercising it directly covers the contract behavior — pick adds, label sets,
 * remove resequences, textedit adds — without React or Tauri in the loop. A
 * second suite renders {@link useRedline} to cover `addRequestForSelection`,
 * which dispatches the pick → label → resolve sequence and badges the selected
 * element; only the one Tauri-backed call (`findComponentUsage`) is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/edit', async (importActual) => {
  const actual = await importActual<typeof import('../lib/edit')>();
  return { ...actual, findComponentUsage: vi.fn() };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { invoke } from '@tauri-apps/api/core';
import {
  redlineReducer,
  initialRedlineState,
  useRedline,
  type RedlineState,
  type RedlineAction,
} from './useRedline';
import { findComponentUsage } from '../lib/edit';
import type { ElementSignature, RedlineLocator } from '../lib/redline';

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SIG: ElementSignature = {
  className: 'text-lg font-bold',
  tagName: 'H1',
  text: 'Welcome',
  ancestorClasses: ['container', 'hero'],
};

const LOCATOR: RedlineLocator = {
  tag: 'h1',
  id: 'hero-title',
  classList: ['text-lg', 'font-bold'],
  role: 'heading',
  ariaLabel: 'Page title',
  textSnippet: 'Welcome',
  dataAttributes: {},
  ancestorClasses: ['container', 'hero'],
  nearbyLandmark: 'main',
};

const RECT = { top: 10, left: 20, width: 100, height: 40 };

function pick(id: string): Extract<RedlineAction, { type: 'pick' }> {
  return {
    type: 'pick',
    id,
    signature: SIG,
    locator: LOCATOR,
    rect: RECT,
    createdAt: '2026-06-13T09:30:00.000Z',
  };
}

function textedit(
  id: string,
  oldText: string,
  newText: string
): Extract<RedlineAction, { type: 'textedit' }> {
  return {
    type: 'textedit',
    id,
    signature: SIG,
    locator: LOCATOR,
    rect: RECT,
    oldText,
    newText,
    hasInlineMarkup: false,
    createdAt: '2026-06-13T09:31:00.000Z',
  };
}

/** Apply a sequence of actions starting from the initial state. */
function run(...actions: RedlineAction[]): RedlineState {
  return actions.reduce(redlineReducer, initialRedlineState);
}

// ─── pick ────────────────────────────────────────────────────────────────────

describe('redlineReducer: pick', () => {
  it('adds a numbered "change" annotation with an empty label and null source', () => {
    const state = run(pick('a'));
    expect(state.annotations).toHaveLength(1);
    const a = state.annotations[0];
    expect(a.id).toBe('a');
    expect(a.number).toBe(1);
    expect(a.kind).toBe('change');
    expect(a.label).toBe('');
    expect(a.resolvedLocation).toBeNull();
    expect(a.signature).toBe(SIG);
    expect(a.rect).toEqual(RECT);
  });

  it('numbers consecutive picks 1, 2, 3', () => {
    const state = run(pick('a'), pick('b'), pick('c'));
    expect(state.annotations.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(state.annotations.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the prior state object', () => {
    const before = run(pick('a'));
    const after = redlineReducer(before, pick('b'));
    expect(before.annotations).toHaveLength(1);
    expect(after.annotations).toHaveLength(2);
    expect(after).not.toBe(before);
  });
});

// ─── label ───────────────────────────────────────────────────────────────────

describe('redlineReducer: label', () => {
  it('sets the label of the matching annotation only', () => {
    const state = run(pick('a'), pick('b'), { type: 'label', id: 'b', text: 'Tighten spacing' });
    expect(state.annotations.find((x) => x.id === 'a')?.label).toBe('');
    expect(state.annotations.find((x) => x.id === 'b')?.label).toBe('Tighten spacing');
  });

  it('is a no-op for an unknown id', () => {
    const before = run(pick('a'));
    const after = redlineReducer(before, { type: 'label', id: 'zzz', text: 'x' });
    expect(after.annotations[0].label).toBe('');
  });
});

// ─── remove (resequences) ─────────────────────────────────────────────────────

describe('redlineReducer: remove', () => {
  it('drops the annotation and resequences the remaining numbers', () => {
    const state = run(pick('a'), pick('b'), pick('c'), { type: 'remove', id: 'b' });
    expect(state.annotations.map((x) => x.id)).toEqual(['a', 'c']);
    expect(state.annotations.map((x) => x.number)).toEqual([1, 2]);
  });

  it('drops the annotation usage entry alongside it', () => {
    const state = run(pick('a'), { type: 'usage', id: 'a', count: 3 }, { type: 'remove', id: 'a' });
    expect(state.usageById).toEqual({});
  });

  it('clearing empties annotations and usage', () => {
    const state = run(pick('a'), { type: 'usage', id: 'a', count: 2 }, { type: 'clear' });
    expect(state.annotations).toEqual([]);
    expect(state.usageById).toEqual({});
  });
});

// ─── textedit ─────────────────────────────────────────────────────────────────

describe('redlineReducer: textedit', () => {
  it('adds a numbered "textedit" annotation carrying verbatim old/new text', () => {
    const state = run(textedit('t1', 'Sign up free', 'Start your trial'));
    expect(state.annotations).toHaveLength(1);
    const a = state.annotations[0];
    expect(a.kind).toBe('textedit');
    expect(a.number).toBe(1);
    expect(a.oldText).toBe('Sign up free');
    expect(a.newText).toBe('Start your trial');
    expect(a.hasInlineMarkup).toBe(false);
  });

  it('interleaves with change picks and keeps contiguous numbering', () => {
    const state = run(pick('a'), textedit('t1', 'x', 'y'), pick('b'));
    expect(state.annotations.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(state.annotations.map((x) => x.kind)).toEqual(['change', 'textedit', 'change']);
  });
});

// ─── resolve / usage patching ─────────────────────────────────────────────────

describe('redlineReducer: resolve & usage', () => {
  it('patches resolvedLocation + confidence on the matching annotation', () => {
    const state = run(pick('a'), {
      type: 'resolve',
      id: 'a',
      resolvedLocation: { file: 'src/Hero.tsx', line: 42, column: 8 },
      confidence: 'unique',
    });
    expect(state.annotations[0].resolvedLocation).toEqual({
      file: 'src/Hero.tsx',
      line: 42,
      column: 8,
    });
    expect(state.annotations[0].confidence).toBe('unique');
  });

  it('records a usage count keyed by annotation id', () => {
    const state = run(pick('a'), { type: 'usage', id: 'a', count: 4 });
    expect(state.usageById.a).toBe(4);
  });

  it('ignores a usage update for an annotation that no longer exists', () => {
    const state = run(pick('a'), { type: 'remove', id: 'a' }, { type: 'usage', id: 'a', count: 9 });
    expect(state.usageById).toEqual({});
  });
});

// ─── reorder ──────────────────────────────────────────────────────────────────

describe('redlineReducer: reorder', () => {
  it('moves an annotation to a new index and resequences', () => {
    const state = run(pick('a'), pick('b'), pick('c'), {
      type: 'reorder',
      fromId: 'c',
      toIndex: 0,
    });
    expect(state.annotations.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(state.annotations.map((x) => x.number)).toEqual([1, 2, 3]);
  });

  it('is a no-op for an unknown id', () => {
    const before = run(pick('a'), pick('b'));
    const after = redlineReducer(before, { type: 'reorder', fromId: 'zzz', toIndex: 0 });
    expect(after).toBe(before);
  });
});

// ─── addRequestForSelection (host-driven) ─────────────────────────────────────

/** A minimal iframe ref whose contentWindow records posted badge messages.
 *  Returns the `postMessage` mock directly so assertions use a bound reference
 *  rather than reaching through `current.contentWindow.postMessage`. */
function fakeIframeRef() {
  const postMessage = vi.fn();
  return {
    ref: {
      current: { contentWindow: { postMessage } },
    } as unknown as React.RefObject<HTMLIFrameElement | null>,
    postMessage,
  };
}

function setup(opts?: { captureRedlinePng?: () => Promise<number[] | null> }) {
  const { ref: iframeRef, postMessage } = fakeIframeRef();
  const onSendToClaude = vi.fn();
  const hook = renderHook(() =>
    useRedline({
      iframeRef,
      projectPath: '/proj',
      pageUrl: 'https://example.com/',
      pageTitle: 'Home',
      onSendToClaude,
      captureRedlinePng: opts?.captureRedlinePng,
    })
  );
  return { ...hook, iframeRef, postMessage, onSendToClaude };
}

/** Flush the background usage patch (the only async work). */
const flush = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  (findComponentUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
    component: 'Hero',
    selfKind: 'component',
    sites: [{ file: 'src/Hero.tsx', line: 42, kind: 'component' }],
  });
  // The global afterEach (test/setup.ts) clearMocks() wipes implementations, so
  // re-arm invoke to resolve for the export write each test.
  mockInvoke.mockResolvedValue(undefined);
});

describe('useRedline: addRequestForSelection', () => {
  it('dispatches pick + label + resolve and yields a numbered, resolved request', async () => {
    const { result, postMessage } = setup();

    let id = '';
    act(() => {
      id = result.current.addRequestForSelection({
        signature: SIG,
        locator: LOCATOR,
        resolvedLocation: { file: 'src/Hero.tsx', line: 42, column: 8 },
        confidence: 'unique',
        rect: RECT,
        label: 'Tighten the hero spacing',
      });
    });
    await flush(); // background findComponentUsage → usage patch

    expect(id).toBeTruthy();
    expect(result.current.requests).toHaveLength(1);
    const a = result.current.requests[0];
    expect(a.id).toBe(id);
    expect(a.number).toBe(1);
    expect(a.kind).toBe('change');
    expect(a.label).toBe('Tighten the hero spacing'); // label dispatched
    expect(a.resolvedLocation).toEqual({ file: 'src/Hero.tsx', line: 42, column: 8 }); // resolve dispatched
    expect(a.confidence).toBe('unique');
    expect(result.current.usageById[id]).toBe(1); // usage patched from findComponentUsage

    // Badges the currently-selected element with the assigned number.
    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:annotate:set', id, number: 1 }, '*');
  });

  it('skips the label dispatch when the label is blank and leaves the source unresolved', async () => {
    const { result } = setup();

    let id = '';
    act(() => {
      id = result.current.addRequestForSelection({
        signature: SIG,
        locator: LOCATOR,
        resolvedLocation: null, // host could not resolve a source location
        rect: RECT,
        label: '   ', // whitespace-only → no label action
      });
    });
    await flush();

    const a = result.current.requests[0];
    expect(a.label).toBe(''); // blank label never dispatched
    expect(a.resolvedLocation).toBeNull(); // no resolve when location is null
    expect(result.current.usageById[id]).toBeUndefined(); // no usage lookup without a location
    expect(findComponentUsage).not.toHaveBeenCalled();
  });
});

// ─── sendToAgent (export + atomic self-clear) ─────────────────────────────────

/** Seed one resolved request so there is something to export. */
function addOneRequest(result: ReturnType<typeof setup>['result']) {
  act(() => {
    result.current.addRequestForSelection({
      signature: SIG,
      locator: LOCATOR,
      resolvedLocation: { file: 'src/Hero.tsx', line: 42, column: 8 },
      confidence: 'unique',
      rect: RECT,
      label: 'Tighten the hero spacing',
    });
  });
}

/** Pull the args of the single `write_redline_export` invoke call. */
function exportCallArgs(): { projectPath: string; slug: string; markdown: string; png: number[] } {
  const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'write_redline_export');
  expect(call).toBeTruthy();
  return call![1] as { projectPath: string; slug: string; markdown: string; png: number[] };
}

describe('useRedline: sendToAgent', () => {
  it('captures a real PNG, writes the export with those bytes, then clears the queue atomically', async () => {
    const png = [137, 80, 78, 71, 13, 10, 26, 10]; // PNG magic bytes — a stand-in capture
    const captureRedlinePng = vi.fn().mockResolvedValue(png);
    const { result, postMessage, onSendToClaude } = setup({ captureRedlinePng });
    addOneRequest(result);
    await flush(); // settle the background usage patch
    expect(result.current.requests).toHaveLength(1);

    await act(async () => {
      await result.current.sendToAgent();
    });

    // The capture ran and its bytes were threaded into the export write verbatim.
    expect(captureRedlinePng).toHaveBeenCalledTimes(1);
    const args = exportCallArgs();
    expect(args.projectPath).toBe('/proj');
    expect(args.png).toEqual(png);
    expect(typeof args.markdown).toBe('string');
    expect(args.markdown.length).toBeGreaterThan(0);
    expect(args.slug.endsWith('.png')).toBe(false); // slug is bare; ".png" is appended in markdown

    // The agent got the prompt, then the queue + badges reset (atomic done-action).
    expect(onSendToClaude).toHaveBeenCalledTimes(1);
    expect(result.current.requests).toHaveLength(0); // queue self-cleared
    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:annotate:clear' }, '*'); // badges wiped
    expect(result.current.sending).toBe(false); // sending toggled back off
  });

  it('exports markdown-only (empty png) when no capture fn is provided, and still clears', async () => {
    const { result, postMessage, onSendToClaude } = setup(); // no captureRedlinePng
    addOneRequest(result);
    await flush();

    await act(async () => {
      await result.current.sendToAgent();
    });

    const args = exportCallArgs();
    expect(args.png).toEqual([]); // stub falls back to an empty byte list
    expect(onSendToClaude).toHaveBeenCalledTimes(1);
    expect(result.current.requests).toHaveLength(0); // still self-clears
    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:annotate:clear' }, '*');
  });

  it('treats a null capture result as no png (markdown-only) and still clears', async () => {
    const captureRedlinePng = vi.fn().mockResolvedValue(null);
    const { result, onSendToClaude } = setup({ captureRedlinePng });
    addOneRequest(result);
    await flush();

    await act(async () => {
      await result.current.sendToAgent();
    });

    expect(captureRedlinePng).toHaveBeenCalledTimes(1);
    expect(exportCallArgs().png).toEqual([]); // null → empty byte list
    expect(onSendToClaude).toHaveBeenCalledTimes(1);
    expect(result.current.requests).toHaveLength(0);
  });

  it('keeps the queue and surfaces a toast when the export write fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('disk full'));
    const showToast = vi.fn();
    const { ref: iframeRef } = fakeIframeRef();
    const onSendToClaude = vi.fn();
    const { result } = renderHook(() =>
      useRedline({
        iframeRef,
        projectPath: '/proj',
        pageUrl: 'https://example.com/',
        pageTitle: 'Home',
        onSendToClaude,
        captureRedlinePng: vi.fn().mockResolvedValue([1, 2, 3]),
        showToast,
      })
    );
    addOneRequest(result);
    await flush();

    await act(async () => {
      await result.current.sendToAgent();
    });

    expect(onSendToClaude).not.toHaveBeenCalled(); // prompt never sent on failure
    expect(result.current.requests).toHaveLength(1); // queue preserved for retry
    expect(showToast).toHaveBeenCalledWith('Error: disk full', 'error');
    expect(result.current.sending).toBe(false); // sending reset in finally
  });
});
