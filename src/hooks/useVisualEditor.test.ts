/**
 * Auto-save behavior for the visual editor hook.
 *
 * Focus: a burst of rapid edits (like a drag) debounces into a SINGLE source
 * write, and only when auto-save is on. The grammar is exercised for real; only
 * the two Tauri-backed calls (resolve + write-back) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/edit', async (importActual) => {
  const actual = await importActual<typeof import('../lib/edit')>();
  return {
    ...actual,
    resolveClassnameSource: vi.fn(),
    applyClassnameEdit: vi.fn(),
    applyClassnameEditMulti: vi.fn(),
  };
});

// The hook lists custom classes on edit-mode entry; stub it so the test doesn't
// reach for a real Tauri IPC (the focus here is the element auto-save path).
vi.mock('../lib/customClasses', () => ({
  detectTailwindSetup: vi
    .fn()
    .mockResolvedValue({ version: 'v4', entryCss: 'app.css', componentsLayer: false }),
  listCustomClasses: vi.fn().mockResolvedValue([]),
  createCustomClass: vi.fn(),
  updateCustomClass: vi.fn(),
  classifyApplyTokens: vi.fn().mockResolvedValue([]),
}));

import { useVisualEditor } from './useVisualEditor';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  applyClassnameEditMulti,
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
} from '../lib/edit';
import {
  detectTailwindSetup,
  updateCustomClass,
  createCustomClass,
  classifyApplyTokens,
  listCustomClasses,
} from '../lib/customClasses';

type Fn = ReturnType<typeof vi.fn>;

const BREAKPOINTS = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];

/** A minimal iframe ref: swallows postMessage and the `load` listener the hook
 *  attaches to re-activate across HMR reloads. */
function fakeIframeRef() {
  return {
    current: {
      contentWindow: { postMessage: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  } as unknown as React.RefObject<HTMLIFrameElement | null>;
}

function setup() {
  const iframeRef = fakeIframeRef();
  const hook = renderHook(() =>
    useVisualEditor({
      iframeRef,
      projectPath: '/proj',
      enabled: true,
      activeBreakpoint: BASE_BREAKPOINT,
      breakpoints: BREAKPOINTS,
    })
  );
  return { ...hook, iframeRef };
}

/** Flush pending microtasks (e.g. the async resolve) under act. */
const flush = () => act(async () => void (await Promise.resolve()));
/** Advance fake timers and flush the work they trigger. */
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });

/** Drive a selection through the in-window message bridge and resolve it.
 *  `source` mirrors the real preview iframe's contentWindow — the hook now
 *  rejects messages from any other source as a security measure. */
async function select(className: string, source: MessageEventSource) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data: {
          type: 'ss:select',
          signature: { className, tagName: 'div', ancestorClasses: [] },
          count: 1,
        },
      })
    );
    await Promise.resolve();
  });
  await flush(); // resolveClassnameSource → setSelection
}

beforeEach(() => {
  vi.clearAllMocks(); // isolate call history between tests (no global clearMocks)
  // clearAllMocks also drops the factory's resolved values — re-establish the
  // defaults the hook awaits on edit-mode entry.
  (detectTailwindSetup as ReturnType<typeof vi.fn>).mockResolvedValue({
    version: 'v4',
    entryCss: 'app.css',
    componentsLayer: false,
  });
  (listCustomClasses as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (classifyApplyTokens as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (resolveClassnameSource as ReturnType<typeof vi.fn>).mockImplementation(
    (_p: string, sig: { className: string }) =>
      Promise.resolve({
        status: 'resolved',
        file: 'app/page.tsx',
        line: 1,
        column: 1,
        class_name: sig.className, // a fresh selection is clean (live == source)
        confidence: 'unique',
      })
  );
  (applyClassnameEdit as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('useVisualEditor auto-save', () => {
  it('does NOT save automatically when auto-save is off', async () => {
    const { result, iframeRef } = setup();
    act(() => result.current.toggleEditMode());
    await select('p-3', iframeRef.current!.contentWindow!);

    act(() => result.current.applyEnum('p-8', { padding: '2rem' }));
    await advance(2000);
    expect(applyClassnameEdit).not.toHaveBeenCalled();
  });

  it('debounces a burst of edits into ONE save when auto-save is on', async () => {
    const { result, iframeRef } = setup();
    act(() => result.current.toggleAutoSave()); // turn on
    act(() => result.current.toggleEditMode());
    await select('p-3', iframeRef.current!.contentWindow!);

    // Simulate a drag: many rapid mutations, each well within the debounce window.
    act(() => {
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 4 });
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 5 });
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 6 });
      result.current.setBoxSide('padding', 'top', { kind: 'scale', n: 7 });
    });

    // Before the debounce elapses: nothing saved yet.
    await advance(400);
    expect(applyClassnameEdit).not.toHaveBeenCalled();

    // After it settles: exactly one write, carrying the final value.
    await advance(700);
    expect(applyClassnameEdit).toHaveBeenCalledTimes(1);
    const call = (applyClassnameEdit as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(call[3]).toBe('p-3'); // oldClass (drift baseline)
    expect(call[4]).toContain('pt-7'); // newClass carries the final drag value
  });

  it('persists the toggle choice to localStorage', () => {
    const { result } = setup();
    act(() => result.current.toggleAutoSave());
    expect(localStorage.getItem('ss:visualEditor:autoSave')).toBe('1');
    act(() => result.current.toggleAutoSave());
    expect(localStorage.getItem('ss:visualEditor:autoSave')).toBe('0');
  });
});

describe('useVisualEditor custom classes', () => {
  it('routes class edits to a class-scoped preview and saves via updateCustomClass', async () => {
    (updateCustomClass as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { result, iframeRef } = setup();
    act(() => result.current.toggleEditMode());
    await select('btn p-3', iframeRef.current!.contentWindow!);

    // Point the controls at the custom class `.btn` (seeded from its @apply list).
    act(() => result.current.editClass('btn', ['px-4']));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the postMessage mock's calls, not invoking it bound
    const post = iframeRef.current!.contentWindow!.postMessage as ReturnType<typeof vi.fn>;
    post.mockClear();

    // An edit now previews against the class selector — every instance — and the
    // element-scoped mutate must NOT fire.
    act(() => result.current.applyEnum('px-8', { padding: '2rem' }));
    const calls = post.mock.calls as Array<[{ type?: string; selector?: string }]>;
    const mutateClass = calls.find((c) => c[0]?.type === 'ss:mutateClass');
    expect(mutateClass?.[0].selector).toBe('.btn');
    expect(calls.some((c) => c[0]?.type === 'ss:mutate')).toBe(false);

    // Saving writes the class's @apply list — not the element's className.
    await act(async () => {
      await result.current.commit();
    });
    expect(applyClassnameEdit).not.toHaveBeenCalled();
    expect(updateCustomClass).toHaveBeenCalledTimes(1);
    const [proj, name, tokens] = (updateCustomClass as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string[],
    ];
    expect(proj).toBe('/proj');
    expect(name).toBe('btn');
    expect(tokens).toContain('px-8');
    // …and the live class preview is KEPT (committed), not dropped: the save's
    // HMR reload is suppressed, so clearing the override would revert the element
    // to the stale compiled rule until the next real reload. The override mirrors
    // the saved tokens and reconciles on target-switch / panel close.
    const clearedAfterSave = (post.mock.calls as Array<[{ type?: string }]>).some(
      (c) => c[0]?.type === 'ss:clearClassPreview'
    );
    expect(clearedAfterSave).toBe(false);
    expect(
      (post.mock.calls as Array<[{ type?: string }]>).some(
        (c) => c[0]?.type === 'ss:suppressReload'
      )
    ).toBe(true);
  });

  it('returning to the element edits its className again', async () => {
    const { result, iframeRef } = setup();
    act(() => result.current.toggleEditMode());
    await select('btn p-3', iframeRef.current!.contentWindow!);
    act(() => result.current.editClass('btn', ['px-4']));
    expect(result.current.editTarget).toEqual({
      kind: 'class',
      name: 'btn',
      baseline: 'px-4',
    });

    act(() => result.current.editElement());
    expect(result.current.editTarget).toEqual({ kind: 'element' });
    // The live class is reseeded from the element, so controls read its utilities.
    expect(result.current.currentClass).toBe('btn p-3');
  });
});

describe('useVisualEditor class gestures (apply / unapply / extract / delete)', () => {
  /** Enter edit mode with a set of project classes loaded, then select `cls`. */
  async function withSelection(
    classes: { name: string; tokens: string[]; editable: boolean }[],
    cls: string
  ) {
    (listCustomClasses as Fn).mockResolvedValue(classes);
    const env = setup();
    act(() => env.result.current.toggleEditMode());
    await flush(); // refreshCustomClasses → customClasses state
    await select(cls, env.iframeRef.current!.contentWindow!);
    return env;
  }

  it('applyClass appends the bare class to the element without switching the edit target', async () => {
    const { result } = await withSelection(
      [{ name: 'card', tokens: ['rounded', 'shadow'], editable: true }],
      'p-3'
    );

    await act(async () => {
      await result.current.applyClass('card');
    });

    const call = (applyClassnameEdit as Fn).mock.calls[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(call[3]).toBe('p-3'); // old className (drift baseline)
    expect(call[4]).toBe('p-3 card'); // new className — class appended
    // Stays on the element so several classes can be added in a row.
    expect(result.current.editTarget).toEqual({ kind: 'element' });
  });

  it('applyClass can add a second class in a row (drift baseline tracks the live className)', async () => {
    const { result } = await withSelection(
      [
        { name: 'card', tokens: ['rounded'], editable: true },
        { name: 'featured', tokens: ['ring'], editable: true },
      ],
      'p-3'
    );

    await act(async () => {
      await result.current.applyClass('card');
    });
    await act(async () => {
      await result.current.applyClass('featured');
    });

    // The second write builds on the first — no dropped class, correct old value.
    const second = (applyClassnameEdit as Fn).mock.calls[1] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(second[3]).toBe('p-3 card'); // old = live className after the first apply
    expect(second[4]).toBe('p-3 card featured');
  });

  it('unapplyClass removes the class from the element and returns to element editing', async () => {
    const { result } = await withSelection(
      [{ name: 'card', tokens: ['rounded'], editable: true }],
      'p-3 card'
    );

    await act(async () => {
      await result.current.unapplyClass('card');
    });

    const call = (applyClassnameEdit as Fn).mock.calls[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(call[4]).toBe('p-3'); // card stripped
    expect(result.current.editTarget).toEqual({ kind: 'element' });
  });

  it('createClassFromStyles moves only utilities into the class, keeping non-utility tokens on the element', async () => {
    // `animate-fade` is a plain custom class, not a utility — must stay on the element.
    (classifyApplyTokens as Fn).mockResolvedValue(['animate-fade']);
    (createCustomClass as Fn).mockResolvedValue([
      { name: 'hero', tokens: ['p-3'], editable: true },
    ]);
    const { result } = await withSelection([], 'p-3 animate-fade');

    await act(async () => {
      await result.current.createClassFromStyles('hero');
    });

    // Only the safe utility went into the new class…
    expect(createCustomClass).toHaveBeenCalledWith('/proj', 'hero', ['p-3']);
    // …and the element keeps the non-utility token plus the new class.
    const call = (applyClassnameEdit as Fn).mock.calls[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(call[4]).toBe('animate-fade hero');
    expect(result.current.editTarget).toMatchObject({ kind: 'class', name: 'hero' });
  });

  it('applyClass honors a single-occurrence multiTarget for a multi-location element', async () => {
    (resolveClassnameSource as Fn).mockResolvedValue({
      status: 'multi',
      locations: [
        { file: 'a.tsx', line: 1, column: 1 },
        { file: 'b.tsx', line: 2, column: 1 },
      ],
      class_name: 'p-3',
    });
    (applyClassnameEditMulti as Fn).mockResolvedValue(1);
    const { result } = await withSelection(
      [{ name: 'card', tokens: ['rounded'], editable: true }],
      'p-3'
    );
    act(() => result.current.setMultiTarget(1)); // only the 2nd occurrence

    await act(async () => {
      await result.current.applyClass('card');
    });

    const call = (applyClassnameEditMulti as Fn).mock.calls[0] as [
      string,
      { file: string; line: number; column: number }[],
      string,
      string,
    ];
    expect(call[1]).toEqual([{ file: 'b.tsx', line: 2, column: 1 }]); // only index 1
    expect(call[3]).toBe('p-3 card');
  });
});
