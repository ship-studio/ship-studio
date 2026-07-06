/**
 * Visual editor controller — owns edit-mode state and the postMessage bridge
 * to the in-iframe selection script (`SELECT_SCRIPT` in
 * `src-tauri/src/proxy/mod.rs`).
 *
 * Lifecycle: toggle on → post `ss:activate` (re-posted on every iframe `load`,
 * since the script re-initializes inert on each HMR reload) → an `ss:select`
 * click resolves to source via the backend (class resolution, plus a parallel
 * image resolution guarded by a staleness token) → edits (`applyToken`,
 * `setBoxSide`, `stepSpacing`, `reset`) twMerge the live class and post
 * `ss:mutate` with breakpoint-scoped preview rules (instant DOM feedback, no
 * write) → `commit` writes the merged className back to source and advances
 * the drift baseline so consecutive edits keep working. Image edits
 * (`replaceImage`) write immediately on confirm. Inline TEXT editing lives in
 * the shared `useTextEditing` hook (mounted alongside this one in Preview.tsx).
 *
 * Exposes `editMode`, `selection`, `currentClass`, image resolution,
 * `multiTarget`, auto-save, and the edit/commit callbacks — consumed by
 * Preview.tsx, which threads them into VisualEditorPanel.
 *
 * Boundaries: lib/edit wrappers (`resolveClassnameSource`, `applyClassnameEdit
 * [Multi]`, `resolveImageSource`/`applySrcEdit`, `findComponentUsage`) over the
 * Rust edit backend; the iframe `ss:*` message protocol; localStorage for the
 * auto-save opt-in.
 *
 * Gotchas: incoming messages are trusted only when `e.source` is the preview
 * iframe's contentWindow — the iframe hosts untrusted project content, and a
 * forged `ss:mutate` would otherwise drive edits on the user's behalf. Every
 * write arms `ss:suppressReload` BEFORE touching disk: Astro's full reload can
 * beat the post-write `ss:commit`, briefly reverting the preview. Live values
 * (`currentClass`, image target) are mirrored into refs so the commit
 * callbacks read fresh state without re-subscribing the message handler.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { twMerge } from 'tailwind-merge';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  applyClassnameEditMulti,
  resolveImageSource,
  applySrcEdit,
  findComponentUsage,
  spacingValue,
  spacingTokenFor,
  spacingCss,
  stepSpacingValue,
  boxSide,
  boxSidePrefix,
  withVariant,
  tokensForVariant,
  removeAtLayer,
  breakpointPrefixes,
  competesWithUnlayered,
  markImportant,
  SPACING_CONTROLS,
  type SpacingKind,
  type BoxType,
  type Side,
  type Breakpoint,
  type SpacingValue,
  type ResetSpec,
  type ElementSignature,
  type Resolution,
  type ImageResolution,
  type UsageReport,
} from '../lib/edit';
import {
  detectTailwindSetup,
  listCustomClasses,
  createCustomClass,
  updateCustomClass,
  classifyApplyTokens,
  type CustomClass,
} from '../lib/customClasses';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';

/**
 * What the style controls currently edit:
 * - `element` — the selected element's own className (writes to the JSX), the
 *   long-standing behavior.
 * - `class` — a shared custom class's `@apply` list (writes to the entry CSS,
 *   updating every element that carries the class). `baseline` is the saved
 *   token string, for dirty-detection / auto-save.
 */
export type EditTarget = { kind: 'element' } | { kind: 'class'; name: string; baseline: string };

/** A breakpoint-scoped slice of the live-preview stylesheet: `decls` applied at
 *  `minPx` and up (0 = base, all widths). A null value deletes that property from
 *  the preview (Reset). Mirrors `select_script.html`'s contract. */
interface PreviewRule {
  minPx: number;
  decls: Record<string, string | null>;
}

/** Persisted opt-in for auto-save (off by default). */
const AUTOSAVE_KEY = 'ss:visualEditor:autoSave';
/** Quiet period after the last edit before an auto-save fires — long enough that a
 *  drag (many rapid mutations) saves once when it settles, not on every frame. */
const AUTOSAVE_DEBOUNCE_MS = 700;

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  /** Feature availability (e.g. Next.js project + server ready). */
  enabled: boolean;
  /** The breakpoint layer edits target (Base = unprefixed). Drives the variant
   *  prefix on written tokens and the min-width of the live-preview rule. */
  activeBreakpoint: Breakpoint;
  /** All breakpoints (incl. Base) — used to recognize/strip variant prefixes. */
  breakpoints: Breakpoint[];
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export interface Selection {
  signature: ElementSignature;
  /** null while the backend resolve is in flight. */
  resolution: Resolution | null;
  /** How many elements on the page share these exact classes (same source ⇒ a
   *  save updates all of them). 1 for a unique element. */
  instanceCount: number;
}

export function useVisualEditor({
  iframeRef,
  projectPath,
  enabled,
  activeBreakpoint,
  breakpoints,
  onToast,
}: Params) {
  // User intent; the *effective* mode below also requires the feature be enabled,
  // so it flips off automatically when the server restarts (no reset effect).
  const [editModeOn, setEditModeOn] = useState(false);
  const editMode = enabled && editModeOn;

  // ── Analytics: edit-mode session tracking ────────────────────────────────
  // Mirror edit-mode intent into a ref so `toggleEditMode` reads the current
  // direction without going stale, plus per-session timing and a saved-edit
  // counter that's reported when the session ends (`visual_edit_stopped`).
  const editModeOnRef = useRef(false);
  useEffect(() => {
    editModeOnRef.current = editModeOn;
  }, [editModeOn]);
  const editStartedAtRef = useRef<number | null>(null);
  const editsCommittedRef = useRef(0);
  /** Fire an analytics event for an edit that persisted to source, and count it
   *  toward the current edit-mode session. Project context is auto-attached by
   *  `trackEvent`/`enrichProperties`, so callers pass only edit-specific props. */
  const recordCommit = useCallback((event: string, props?: Record<string, unknown>) => {
    editsCommittedRef.current += 1;
    void trackEvent(event, props);
  }, []);

  // Known breakpoint prefixes, for scoping a class string to one variant layer.
  const known = useMemo(() => breakpointPrefixes(breakpoints), [breakpoints]);

  // Auto-save: when on, edits persist to source automatically (debounced). Off by
  // default; the choice is remembered across sessions.
  const [autoSave, setAutoSave] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleAutoSave = useCallback(() => {
    setAutoSave((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTOSAVE_KEY, next ? '1' : '0');
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  }, []);

  const [selection, setSelection] = useState<Selection | null>(null);
  // Where the selected element's component is used project-wide (scope hint).
  // Best-effort, fetched after a single-location resolve. Token guards staleness.
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const usageTokenRef = useRef(0);
  /** The class string currently applied live in the iframe (merge baseline). */
  const [currentClass, setCurrentClass] = useState('');
  // Mirror into a ref so `applyToken`/`commit` callbacks read the latest value
  // without re-subscribing. Written only through `setLiveClass` (never in render).
  const currentClassRef = useRef('');
  const setLiveClass = useCallback((value: string) => {
    currentClassRef.current = value;
    setCurrentClass(value);
  }, []);

  // CSS properties the selected element gets from unlayered custom CSS (which beats
  // Tailwind utilities). Edits touching these get the important modifier so the saved
  // class wins the cascade — matching what the !important live preview already shows.
  const unlayeredPropsRef = useRef<string[] | undefined>(undefined);
  useEffect(() => {
    unlayeredPropsRef.current = selection?.signature.unlayeredProps;
  }, [selection]);

  // For a 'multi' resolution (one class string at several source spots): which to
  // write — 'all' (default) or a single location index. Reset on each new selection.
  const [multiTarget, setMultiTargetState] = useState<'all' | number>('all');
  const multiTargetRef = useRef<'all' | number>('all');
  const setMultiTarget = useCallback((t: 'all' | number) => {
    multiTargetRef.current = t;
    setMultiTargetState(t);
  }, []);

  // Inline text editing lives in the shared `useTextEditing` hook (mounted once in
  // Preview.tsx, active for either styling editor) — it owns the ss:textInfo gating
  // and ss:textCommit write-back. This hook keeps only the class/image concerns.

  // The signature of the current selection, mirrored so the class commit/structural
  // gestures read the live source-className baseline without re-subscribing.
  const selectedSigRef = useRef<ElementSignature | null>(null);

  // Image src editing: the resolved src target for the current selection (null when
  // the element isn't an image or its src isn't a static literal). Mirrored into a
  // ref so `replaceImage` reads the latest baseline without re-subscribing.
  const [imageResolution, setImageResolution] = useState<ImageResolution | null>(null);
  const imageTargetRef = useRef<{
    file: string;
    line: number;
    column: number;
    src: string;
  } | null>(null);
  const setImageTarget = useCallback((res: ImageResolution | null) => {
    imageTargetRef.current =
      res?.status === 'resolved'
        ? { file: res.file, line: res.line, column: res.column, src: res.src }
        : null;
    setImageResolution(res);
  }, []);

  // What the controls edit (the element vs. a shared class). Mirrored into a ref
  // so the mutate/commit callbacks branch on the latest value without re-subscribing.
  const [editTarget, setEditTargetState] = useState<EditTarget>({ kind: 'element' });
  const editTargetRef = useRef<EditTarget>({ kind: 'element' });
  const setEditTarget = useCallback((t: EditTarget) => {
    editTargetRef.current = t;
    setEditTargetState(t);
  }, []);

  // The project's custom classes (refreshed on edit-mode entry and after writes).
  const [customClasses, setCustomClasses] = useState<CustomClass[]>([]);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  // Route a live-preview mutation by edit target: an element edit sets the
  // selected element's class attribute; a class edit injects decls scoped to the
  // class selector (every instance), leaving element markup untouched.
  const postMutate = useCallback(
    (merged: string, rules: PreviewRule[]) => {
      const target = editTargetRef.current;
      if (target.kind === 'class') {
        post({ type: 'ss:mutateClass', selector: `.${target.name}`, rules });
      } else {
        post({ type: 'ss:mutate', className: merged, rules });
      }
    },
    [post]
  );

  // Point the controls at the selected element's own className (the default).
  const editElement = useCallback(() => {
    setEditTarget({ kind: 'element' });
    setLiveClass(selectedSigRef.current?.className ?? '');
    post({ type: 'ss:clearClassPreview' });
  }, [post, setEditTarget, setLiveClass]);

  // Point the controls at a custom class: seed the live token bag from its
  // `@apply` list so every control reflects the class's current styles.
  const editClass = useCallback(
    (name: string, tokens: string[]) => {
      const joined = tokens.join(' ');
      setEditTarget({ kind: 'class', name, baseline: joined });
      setLiveClass(joined);
      post({ type: 'ss:clearClassPreview' });
    },
    [post, setEditTarget, setLiveClass]
  );

  // Activate/deactivate the in-iframe selection layer (external-system sync), and
  // keep it active across HMR reloads (each reload resets the script to inert).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (editMode) {
      post({ type: 'ss:activate' });
      const reactivate = () => post({ type: 'ss:activate' });
      iframe?.addEventListener('load', reactivate);
      return () => iframe?.removeEventListener('load', reactivate);
    }
    post({ type: 'ss:deactivate' });
  }, [editMode, post, iframeRef]);

  // Resolve clicked elements + handle inline text-edit commits from the iframe.
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe. The iframe
      // hosts untrusted project content; a forged `ss:textCommit` from another
      // frame would otherwise write to the user's source files.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as {
        type?: string;
        signature?: ElementSignature;
        count?: number;
        leafText?: boolean;
      } | null;
      if (!d) return;

      // Text-edit messages (ss:textBlocked / ss:textCommit) are handled by the
      // shared useTextEditing hook, not here.
      if (d.type !== 'ss:select' || !d.signature) return;
      const sig = d.signature;
      const instanceCount = d.count ?? 1;
      const leafText = !!d.leafText;
      selectedSigRef.current = sig;
      setSelection({ signature: sig, resolution: null, instanceCount });
      setLiveClass(sig.className);
      // Engagement: an element was selected for editing. `tagName` is a plain
      // HTML tag (no PII); className is deliberately NOT sent.
      void trackEvent('visual_element_selected', {
        tag: sig.tagName,
        instance_count: instanceCount,
        leaf_text: leafText,
      });
      // A fresh element selection always edits the element (not a leftover class).
      setEditTarget({ kind: 'element' });
      post({ type: 'ss:clearClassPreview' });
      setMultiTarget('all'); // a fresh selection defaults to editing all occurrences
      setUsage(null);
      setImageTarget(null);
      const usageToken = ++usageTokenRef.current;
      void (async () => {
        try {
          const resolution = await resolveClassnameSource(projectPath, sig);
          setSelection({ signature: sig, resolution, instanceCount });
          // Best-effort scope hint: where else this component is rendered.
          if (resolution.status === 'resolved') {
            try {
              const report = await findComponentUsage(
                projectPath,
                resolution.file,
                resolution.line
              );
              if (usageTokenRef.current === usageToken) setUsage(report);
            } catch {
              /* scope hint is optional */
            }
          }
        } catch (err) {
          logger.error('[VisualEditor] resolve failed', { error: String(err) });
          onToast?.(formatCommandError(asCommandError(err)), 'error');
          setSelection({
            signature: sig,
            resolution: {
              status: 'read_only',
              reason: 'Could not resolve this element to source.',
            },
            instanceCount,
          });
        }
      })();
      // Image src resolution runs in parallel for <img> elements — drives the
      // panel's Image section (current asset + Replace).
      if (sig.tagName === 'img') {
        void (async () => {
          try {
            const imgRes = await resolveImageSource(projectPath, sig);
            // Ignore if the selection changed underneath us.
            if (usageTokenRef.current === usageToken) setImageTarget(imgRes);
          } catch (err) {
            logger.error('[VisualEditor] image resolve failed', { error: String(err) });
            if (usageTokenRef.current === usageToken)
              setImageTarget({
                status: 'read_only',
                reason: 'Could not resolve this image to source.',
              });
          }
        })();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [
    editMode,
    projectPath,
    onToast,
    post,
    iframeRef,
    setLiveClass,
    setMultiTarget,
    setImageTarget,
    setEditTarget,
  ]);

  // Load the project's custom classes when edit mode opens; refresh helper lets
  // writes (create/update/delete) push the fresh list back.
  const refreshCustomClasses = useCallback(async () => {
    try {
      setCustomClasses(await listCustomClasses(projectPath));
    } catch (err) {
      logger.error('[VisualEditor] list custom classes failed', { error: String(err) });
    }
  }, [projectPath]);

  // Whether the project has a writable Tailwind entry stylesheet — gates the
  // "create / edit class" affordances. Apply/edit of existing classes already
  // degrades naturally (the class list is empty without an entry), but create
  // must be disabled with a hint rather than failing on a raw backend error.
  const [classEntryReady, setClassEntryReady] = useState(true);

  useEffect(() => {
    if (!editMode) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load custom classes + entry-CSS check on edit-mode open
    void refreshCustomClasses();
    void detectTailwindSetup(projectPath)
      .then((setup) => setClassEntryReady(setup.entryCss != null))
      .catch(() => setClassEntryReady(false));
  }, [editMode, projectPath, refreshCustomClasses]);

  /**
   * Merge a Tailwind token into the live class at the active breakpoint and
   * preview it (no write). `token` is the BARE (unprefixed) utility — we add the
   * active breakpoint's variant prefix here, so callers stay breakpoint-agnostic.
   *
   * `style` is the CSS the token resolves to, sent as a breakpoint-scoped preview
   * rule. It exists because Tailwind's JIT only emits CSS for classes found in
   * source — a freshly-typed `md:p-14` has no compiled rule, so the class alone
   * shows nothing until saved. The rule (at the breakpoint's min-width) drives a
   * truthful preview: a `md:` edit only shows ≥768px, unlike an inline style.
   */
  const applyToken = useCallback(
    (token: string, style?: Record<string, string>) => {
      // Mark important when the edited property is set by unlayered custom CSS, so
      // the saved utility wins the cascade (the live preview already wins via !important).
      const bare =
        style && competesWithUnlayered(Object.keys(style), unlayeredPropsRef.current)
          ? markImportant(token)
          : token;
      const merged = twMerge(currentClassRef.current, withVariant(activeBreakpoint.prefix, bare));
      setLiveClass(merged);
      const rules: PreviewRule[] = style ? [{ minPx: activeBreakpoint.minPx, decls: style }] : [];
      postMutate(merged, rules);
    },
    [postMutate, setLiveClass, activeBreakpoint]
  );

  /** Set one side of a box (padding/margin) at the active breakpoint to a scale
   *  step or arbitrary value. Previews only the sides this layer actually defines
   *  (so unset sides fall through to the real, already-compiled base CSS). */
  const setBoxSide = useCallback(
    (type: BoxType, side: Side, value: SpacingValue) => {
      const bare = spacingTokenFor(boxSidePrefix(type, side), value);
      const token = competesWithUnlayered([`${type}-${side}`], unlayeredPropsRef.current)
        ? markImportant(bare)
        : bare;
      const merged = twMerge(currentClassRef.current, withVariant(activeBreakpoint.prefix, token));
      setLiveClass(merged);
      const scoped = tokensForVariant(merged, activeBreakpoint.prefix, known);
      const decls: Record<string, string> = {};
      for (const s of ['top', 'right', 'bottom', 'left'] as Side[]) {
        const v = boxSide(scoped, type, s);
        if (v) decls[`${type}-${s}`] = spacingCss(v);
      }
      postMutate(merged, [{ minPx: activeBreakpoint.minPx, decls }]);
    },
    [postMutate, setLiveClass, activeBreakpoint, known]
  );

  /** Step a spacing utility (padding/margin/gap) by one unit at the active
   *  breakpoint, computed from that layer's current value (so stepping `md:` reads
   *  the md value, not base). Steps the scale integer, or a numeric arbitrary
   *  value's magnitude (keeping its unit). Drives a breakpoint-scoped preview rule. */
  const stepSpacing = useCallback(
    (kind: SpacingKind, dir: 1 | -1) => {
      const ctrl = SPACING_CONTROLS.find((c) => c.kind === kind);
      if (!ctrl) return;
      const scoped = tokensForVariant(currentClassRef.current, activeBreakpoint.prefix, known);
      const next = stepSpacingValue(spacingValue(scoped, ctrl.prefix), dir);
      applyToken(spacingTokenFor(ctrl.prefix, next), { [ctrl.css]: spacingCss(next) });
    },
    [applyToken, activeBreakpoint, known]
  );

  /** Reset a property at the active breakpoint: remove its tokens from that layer
   *  and null out its preview decls so the value reverts to its inherited/default
   *  state. The class change is dirty, so Save (or auto-save) persists the removal. */
  const reset = useCallback(
    (spec: ResetSpec) => {
      const merged = removeAtLayer(currentClassRef.current, activeBreakpoint, known, spec.match);
      if (merged === currentClassRef.current) return; // nothing to remove
      setLiveClass(merged);
      const decls: Record<string, string | null> = {};
      for (const p of spec.cssProps) decls[p] = null;
      postMutate(merged, [{ minPx: activeBreakpoint.minPx, decls }]);
    },
    [postMutate, setLiveClass, activeBreakpoint, known]
  );

  /** Persist the current live class to source. `silent` suppresses the success
   *  toast (used by auto-save, which shouldn't toast on every debounced write —
   *  errors still surface). */
  const commit = useCallback(
    async (opts?: { silent?: boolean }) => {
      // Class edit: persist the @apply list to the entry CSS (updates every
      // instance). No element markup changes, so the element-baseline dance below
      // doesn't apply. Suppress the reload our own save triggers (avoids a flash).
      const target = editTargetRef.current;
      if (target.kind === 'class') {
        const next = currentClassRef.current.trim();
        if (next === target.baseline.trim()) return; // unchanged
        const tokens = next.split(/\s+/).filter(Boolean);
        post({ type: 'ss:suppressReload' });
        try {
          const list = await updateCustomClass(projectPath, target.name, tokens);
          setCustomClasses(list);
          recordCommit('custom_class_edited', { token_count: tokens.length });
          // Advance the baseline so consecutive edits (and auto-save) keep working.
          setEditTarget({ kind: 'class', name: target.name, baseline: tokens.join(' ') });
          // Keep the live override as the committed state — do NOT clear it here.
          // The save's HMR reload is suppressed (no flash), so clearing would drop
          // the element back to the STALE compiled rule until the next real reload,
          // making the just-saved edit visibly revert. The override already mirrors
          // the saved tokens; it's reconciled with the freshly-compiled @apply rule
          // when the edit target switches or the panel closes (both clear class
          // previews), or on the next genuine reload. Mirrors how element edits keep
          // their live state via ss:commit rather than discarding it.
          if (!opts?.silent) onToast?.('Class saved', 'success');
        } catch (err) {
          logger.error('[VisualEditor] class write-back failed', { error: String(err) });
          onToast?.(formatCommandError(asCommandError(err)), 'error');
        }
        return;
      }

      const sel = selection;
      const res = sel?.resolution;
      if (!res || (res.status !== 'resolved' && res.status !== 'multi')) return;
      const next = currentClassRef.current;
      // Use the LIVE source className (selectedSigRef) as the drift baseline, not
      // the possibly-stale `selection` closure — a structural gesture may have
      // advanced the source since this `commit` callback was created, and writing
      // against a stale old-value would silently no-op at the backend.
      const prev = selectedSigRef.current?.className ?? res.class_name;
      if (next === prev) return; // nothing changed
      // Arm the reload-suppression window BEFORE writing: Astro's full-reload fires
      // the instant the file changes, which can beat the post-write ss:commit. Setting
      // it here means the reload our own save triggers is reliably swallowed (so the
      // live preview doesn't briefly revert), while agent edits still reload.
      post({ type: 'ss:suppressReload' });
      try {
        if (res.status === 'resolved') {
          await applyClassnameEdit(projectPath, res.file, res.line, prev, next);
        } else {
          // Multi: write to all matching source spots, or the one the user picked.
          const target = multiTargetRef.current;
          const edits =
            target === 'all' ? res.locations : res.locations.filter((_, i) => i === target);
          await applyClassnameEditMulti(projectPath, edits, prev, next);
        }
        // Advance the drift baseline so consecutive edits keep working. Keep
        // selectedSigRef in lockstep — the structural gestures use it as the live
        // source-className baseline, so it must reflect saved style edits too.
        setSelection({ ...sel, resolution: { ...res, class_name: next } });
        if (selectedSigRef.current) {
          selectedSigRef.current = { ...selectedSigRef.current, className: next };
        }
        // Tell the in-iframe script this live state is now the saved baseline, so
        // deactivating (closing the panel) doesn't revert the just-saved edit
        // before HMR re-renders it from source.
        post({ type: 'ss:commit' });
        recordCommit('visual_style_saved', {
          is_autosave: !!opts?.silent,
          is_multi: res.status === 'multi',
        });
        if (!opts?.silent) onToast?.('Saved to source', 'success');
      } catch (err) {
        logger.error('[VisualEditor] write-back failed', { error: String(err) });
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [selection, projectPath, onToast, post, setEditTarget, recordCommit]
  );

  /** Rewrite the selected element's className in source to `next` (single or
   *  multi location), advancing the drift baseline. Shared by the class apply /
   *  unapply / extract gestures. No-op (returns false) on an unresolved element. */
  const writeElementClass = useCallback(
    async (next: string): Promise<boolean> => {
      const sel = selection;
      const res = sel?.resolution;
      if (!res || (res.status !== 'resolved' && res.status !== 'multi')) {
        onToast?.('Select an element whose source can be resolved first.', 'error');
        return false;
      }
      // Drift baseline = the LIVE source className (selectedSigRef), not the
      // possibly-stale `selection` state — so a burst of applies/unapplies before
      // React re-renders each still writes against the right old value.
      const prev = selectedSigRef.current?.className ?? res.class_name;
      if (next === prev) return true;
      post({ type: 'ss:suppressReload' });
      if (res.status === 'resolved') {
        await applyClassnameEdit(projectPath, res.file, res.line, prev, next);
      } else {
        // Honor the user's multi-location pick ('all' vs one index), same as commit().
        const mt = multiTargetRef.current;
        const edits = mt === 'all' ? res.locations : res.locations.filter((_, i) => i === mt);
        await applyClassnameEditMulti(projectPath, edits, prev, next);
      }
      // Keep BOTH the selection signature (drives the class-bar chips) and the
      // resolution baseline (drift guard) in sync with the element's new class.
      const nextSig = { ...sel.signature, className: next };
      setSelection({ ...sel, signature: nextSig, resolution: { ...res, class_name: next } });
      selectedSigRef.current = nextSig;
      // Reflect on the element itself (in element mode the live class is the element).
      if (editTargetRef.current.kind === 'element') setLiveClass(next);
      post({ type: 'ss:mutate', className: next, rules: [] });
      post({ type: 'ss:commit' });
      return true;
    },
    [selection, projectPath, onToast, post, setLiveClass]
  );

  /** The selected element's current className — read from the live class in
   *  element mode, or the (kept-fresh) signature while a class is being edited.
   *  The structural gestures below operate on THIS, never on a class's @apply. */
  const currentElementClass = useCallback(
    () =>
      editTargetRef.current.kind === 'element'
        ? currentClassRef.current
        : (selectedSigRef.current?.className ?? ''),
    []
  );

  /** Append an existing custom class to the selected element. Does NOT switch the
   *  edit target — so several classes can be added in a row without the panel
   *  yanking you into editing each one. */
  const applyClass = useCallback(
    async (name: string) => {
      const current = currentElementClass().split(/\s+/).filter(Boolean);
      if (current.includes(name)) return; // already on the element
      try {
        await writeElementClass([...current, name].join(' '));
        recordCommit('custom_class_applied');
      } catch (err) {
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [currentElementClass, writeElementClass, onToast, recordCommit]
  );

  /** Remove a custom class from the selected element (the class stays defined in
   *  CSS). Falls back to editing the element only if the removed class was the
   *  active edit target. */
  const unapplyClass = useCallback(
    async (name: string) => {
      const next = currentElementClass()
        .split(/\s+/)
        .filter((t) => t && t !== name)
        .join(' ');
      const wasEditing =
        editTargetRef.current.kind === 'class' && editTargetRef.current.name === name;
      try {
        const ok = await writeElementClass(next);
        if (ok && wasEditing) editElement();
        recordCommit('custom_class_unapplied');
      } catch (err) {
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [currentElementClass, writeElementClass, editElement, onToast, recordCommit]
  );

  /** Webflow-style "create class from styles": move the element's utility tokens
   *  into a new named class, keeping any classes it already had, then replace the
   *  utilities on the element with the bare class name and edit the class. (The
   *  element briefly shows unstyled until HMR compiles the new rule's `@apply`.) */
  const createClassFromStyles = useCallback(
    async (name: string) => {
      const elTokens = currentElementClass().split(/\s+/).filter(Boolean);
      const classNames = new Set(customClasses.map((c) => c.name));
      const candidateUtilities = elTokens.filter((t) => !classNames.has(t));
      try {
        // Tokens that are plain custom classes (not utilities) can't go in @apply —
        // applying them would break the Tailwind build. Keep those on the element.
        const unsafe = new Set(await classifyApplyTokens(projectPath, candidateUtilities));
        const utilities = candidateUtilities.filter((t) => !unsafe.has(t));
        // Element keeps its existing classes + any non-utility tokens we couldn't move.
        const kept = elTokens.filter((t) => classNames.has(t) || unsafe.has(t));
        if (utilities.length === 0) {
          onToast?.('This element has no Tailwind utilities to extract into a class.', 'error');
          return;
        }
        const list = await createCustomClass(projectPath, name, utilities);
        setCustomClasses(list);
        recordCommit('custom_class_created', {
          token_count: utilities.length,
          kept_count: kept.length,
        });
        const ok = await writeElementClass([...kept, name].join(' '));
        if (!ok) {
          // The class was created but couldn't be applied — still let the user edit it.
          onToast?.(`Created .${name}, but couldn't update the element.`, 'error');
        }
        editClass(name, utilities);
        if (unsafe.size > 0) {
          onToast?.(`Kept ${[...unsafe].join(', ')} on the element (not a utility).`, 'success');
        }
      } catch (err) {
        onToast?.(formatCommandError(asCommandError(err)), 'error');
      }
    },
    [
      projectPath,
      customClasses,
      currentElementClass,
      writeElementClass,
      editClass,
      onToast,
      recordCommit,
    ]
  );

  // NOTE: deleting a custom class (delete_custom_class backend command) is a
  // Phase-2 follow-up — it needs a confirmation flow in the bar since it removes
  // shared styles and leaves orphan class names in markup. Intentionally not
  // wired to UI yet (rather than shipped as a dead, unconfirmed action).

  /**
   * Replace the selected image's src in source (immediate write, like a text
   * commit — picking an asset IS the save) and swap the preview instantly.
   * Throws on failure so the picker can stay open for another try.
   */
  const replaceImage = useCallback(
    async (newSrc: string) => {
      const target = imageTargetRef.current;
      if (!target) {
        onToast?.('Lost track of this image — reselect it and try again.', 'error');
        throw new Error('no image target');
      }
      if (newSrc === target.src) return; // already this asset — nothing to write
      // Arm reload suppression before writing (same reasoning as a class commit).
      post({ type: 'ss:suppressReload' });
      try {
        await applySrcEdit(
          projectPath,
          target.file,
          target.line,
          target.column,
          target.src,
          newSrc
        );
        // Advance the drift baseline so consecutive replacements keep working.
        target.src = newSrc;
        setImageResolution((prev) =>
          prev?.status === 'resolved' ? { ...prev, src: newSrc } : prev
        );
        post({ type: 'ss:setSrc', value: newSrc }); // instant preview (HMR confirms)
        post({ type: 'ss:commit' });
        recordCommit('visual_image_saved');
        onToast?.('Image replaced', 'success');
      } catch (err) {
        logger.error('[VisualEditor] image write-back failed', { error: String(err) });
        onToast?.(formatCommandError(asCommandError(err)), 'error');
        throw err;
      }
    },
    [projectPath, onToast, post, recordCommit]
  );

  // Auto-save: debounce a silent commit after edits settle. Re-running on every
  // class change clears the prior timer (so a drag saves once, when it stops); the
  // resolved-and-dirty guard means it never fires on selection alone, and the
  // baseline-advance inside `commit` makes the next run a no-op (no loop).
  useEffect(() => {
    if (!autoSave) return;
    let dirty = false;
    if (editTarget.kind === 'class') {
      dirty = currentClass.trim() !== editTarget.baseline.trim();
    } else {
      const res = selection?.resolution;
      if (res?.status !== 'resolved' && res?.status !== 'multi') return;
      dirty = currentClass !== res.class_name;
    }
    if (!dirty) return;
    const id = window.setTimeout(() => void commit({ silent: true }), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [autoSave, currentClass, selection, editTarget, commit]);

  const toggleEditMode = useCallback(() => {
    // Fire lifecycle analytics from the user's toggle intent (read via ref so the
    // direction is never stale), outside the state updater so it runs exactly once.
    const turningOn = !editModeOnRef.current;
    editModeOnRef.current = turningOn;
    if (turningOn) {
      editStartedAtRef.current = Date.now();
      editsCommittedRef.current = 0;
      void trackEvent('visual_edit_started');
    } else {
      const startedAt = editStartedAtRef.current;
      void trackEvent('visual_edit_stopped', {
        duration_ms: startedAt != null ? Date.now() - startedAt : undefined,
        edits_committed: editsCommittedRef.current,
      });
      editStartedAtRef.current = null;
    }
    setEditModeOn((prev) => {
      // Turning off: clear the current selection (event-handler context, so
      // these state updates batch without a cascading-render effect).
      if (prev) {
        setSelection(null);
        setLiveClass('');
        setImageTarget(null);
        setEditTarget({ kind: 'element' });
        selectedSigRef.current = null;
      }
      return !prev;
    });
  }, [setLiveClass, setImageTarget, setEditTarget]);

  return {
    editMode,
    toggleEditMode,
    selection,
    currentClass,
    usage,
    /** Image-src editability of the current selection (drives the Image section). */
    imageResolution,
    /** Write a new src to source and swap the preview (immediate save). */
    replaceImage,
    multiTarget,
    setMultiTarget,
    autoSave,
    toggleAutoSave,
    stepSpacing,
    setBoxSide,
    // Enum controls apply an absolute token (twMerge swaps the prior one) plus an
    // inline-style preview — same path as spacing, just not relative to a scale.
    applyEnum: applyToken,
    reset,
    commit,
    // ── Custom classes (Webflow-style) ───────────────────────────────────────
    /** What the controls currently edit (the element, or a shared class). */
    editTarget,
    /** Switch the controls back to the selected element's own className. */
    editElement,
    /** Switch the controls to a custom class's `@apply` list. */
    editClass,
    /** The project's custom classes (for the class bar + apply menu). */
    customClasses,
    /** Whether a writable Tailwind entry stylesheet exists (gates create). */
    classEntryReady,
    /** Append an existing custom class to the element and edit it. */
    applyClass,
    /** Remove a custom class from the element (keeps it defined in CSS). */
    unapplyClass,
    /** Extract the element's utilities into a new named class and edit it. */
    createClassFromStyles,
  };
}
