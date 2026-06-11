/**
 * Visual editor controller.
 *
 * Owns edit-mode state and the message bridge to the in-iframe selection script
 * (`SELECT_SCRIPT` in `src-tauri/src/proxy/mod.rs`):
 *  - toggling edit mode posts `ss:activate` / `ss:deactivate`
 *  - incoming `ss:select` messages are resolved to a source location
 *  - `previewClass` posts `ss:mutate` for instant DOM feedback (no write)
 *  - `commit` writes the merged className back to source via the backend
 *
 * The selection script re-initializes inert on every (HMR) reload, so we
 * re-post `ss:activate` on each iframe `load` while edit mode is on.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { twMerge } from 'tailwind-merge';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  applyClassnameEditMulti,
  resolveTextSource,
  applyTextEdit,
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
  type TextResolution,
  type ImageResolution,
  type UsageReport,
} from '../lib/edit';
import { logger } from '../lib/logger';

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

  // Inline text editing: the resolved text target for the current selection (null
  // when the element's text isn't a plain editable literal). Mirrored into a ref so
  // the ss:textCommit handler reads the latest without re-subscribing. `text` is the
  // source baseline used as the drift guard on write-back.
  const [textResolution, setTextResolution] = useState<TextResolution | null>(null);
  // Bumps each time a double-click lands on dynamic text the iframe bounced out of
  // — drives a one-shot pulse on the DynamicTextHelp hand-off so the user notices it.
  const [textBlockedNonce, setTextBlockedNonce] = useState(0);
  const textTargetRef = useRef<{ file: string; line: number; column: number; text: string } | null>(
    null
  );
  const setTextTarget = useCallback((res: TextResolution | null) => {
    textTargetRef.current =
      res?.status === 'resolved'
        ? { file: res.file, line: res.line, column: res.column, text: res.text }
        : null;
    setTextResolution(res);
  }, []);
  // The signature of the current selection, mirrored for on-demand text resolution if
  // a commit arrives before the (async) select-time resolve has landed.
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

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
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
      const d = e.data as {
        type?: string;
        signature?: ElementSignature;
        count?: number;
        leafText?: boolean;
        text?: string;
      } | null;
      if (!d) return;

      // The element turned out not to be editable (dynamic text) — the iframe bounced
      // out of the optimistic edit. No toast: the panel shows the "copy a request for
      // your agent" hand-off (DynamicTextHelp) for the still-selected element.
      if (d.type === 'ss:textBlocked') {
        setTextBlockedNonce((n) => n + 1);
        return;
      }

      // Inline text edit was confirmed in the iframe — write the new text to source.
      if (d.type === 'ss:textCommit' && typeof d.text === 'string') {
        const next = d.text;
        const sig = selectedSigRef.current;
        // Arm reload suppression before writing (same reasoning as a class commit).
        post({ type: 'ss:suppressReload' });
        void (async () => {
          try {
            // The select-time resolve may not have landed yet (fast double-click →
            // type → commit); resolve on demand so the edit is never dropped silently.
            let target = textTargetRef.current;
            if (!target) {
              if (!sig) throw new Error('Lost track of this element — reselect it and try again.');
              const res = await resolveTextSource(projectPath, sig);
              if (res.status !== 'resolved')
                throw new Error(res.reason || 'This text isn’t editable.');
              target = { file: res.file, line: res.line, column: res.column, text: res.text };
              textTargetRef.current = target;
            }
            if (next === target.text) {
              post({ type: 'ss:commit' }); // unchanged — just re-baseline, no write
              return;
            }
            await applyTextEdit(
              projectPath,
              target.file,
              target.line,
              target.column,
              target.text,
              next
            );
            // Advance the drift baseline so consecutive text edits keep working.
            target.text = next;
            setTextResolution((prev) =>
              prev?.status === 'resolved' ? { ...prev, text: next } : prev
            );
            post({ type: 'ss:commit' });
            onToast?.('Saved to source', 'success');
          } catch (err) {
            logger.error('[VisualEditor] text write-back failed', { error: String(err) });
            onToast?.(String(err), 'error');
            // Couldn't save — put the original text back in the preview.
            post({ type: 'ss:textRevert' });
          }
        })();
        return;
      }

      if (d.type !== 'ss:select' || !d.signature) return;
      const sig = d.signature;
      const instanceCount = d.count ?? 1;
      const leafText = !!d.leafText;
      selectedSigRef.current = sig;
      setSelection({ signature: sig, resolution: null, instanceCount });
      setLiveClass(sig.className);
      setMultiTarget('all'); // a fresh selection defaults to editing all occurrences
      setUsage(null);
      setTextTarget(null); // optimistic; iframe allows editing until told otherwise
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
          onToast?.(String(err), 'error');
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
      // Text-editability runs in parallel: only for single-text-node leaves. The
      // iframe gates inline editing on the verdict we post back (ss:textInfo).
      if (leafText) {
        void (async () => {
          try {
            const textRes = await resolveTextSource(projectPath, sig);
            // Ignore if the selection changed underneath us.
            if (usageTokenRef.current !== usageToken) return;
            setTextTarget(textRes);
            post({ type: 'ss:textInfo', editable: textRes.status === 'resolved' });
          } catch {
            if (usageTokenRef.current === usageToken)
              post({ type: 'ss:textInfo', editable: false });
          }
        })();
      } else {
        post({ type: 'ss:textInfo', editable: false });
      }
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
    setLiveClass,
    setMultiTarget,
    setTextTarget,
    setImageTarget,
  ]);

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
      post({ type: 'ss:mutate', className: merged, rules });
    },
    [post, setLiveClass, activeBreakpoint]
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
      post({
        type: 'ss:mutate',
        className: merged,
        rules: [{ minPx: activeBreakpoint.minPx, decls }],
      });
    },
    [post, setLiveClass, activeBreakpoint, known]
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
      post({
        type: 'ss:mutate',
        className: merged,
        rules: [{ minPx: activeBreakpoint.minPx, decls }],
      });
    },
    [post, setLiveClass, activeBreakpoint, known]
  );

  /** Persist the current live class to source. `silent` suppresses the success
   *  toast (used by auto-save, which shouldn't toast on every debounced write —
   *  errors still surface). */
  const commit = useCallback(
    async (opts?: { silent?: boolean }) => {
      const sel = selection;
      const res = sel?.resolution;
      if (!res || (res.status !== 'resolved' && res.status !== 'multi')) return;
      const next = currentClassRef.current;
      if (next === res.class_name) return; // nothing changed
      // Arm the reload-suppression window BEFORE writing: Astro's full-reload fires
      // the instant the file changes, which can beat the post-write ss:commit. Setting
      // it here means the reload our own save triggers is reliably swallowed (so the
      // live preview doesn't briefly revert), while agent edits still reload.
      post({ type: 'ss:suppressReload' });
      try {
        if (res.status === 'resolved') {
          await applyClassnameEdit(projectPath, res.file, res.line, res.class_name, next);
        } else {
          // Multi: write to all matching source spots, or the one the user picked.
          const target = multiTargetRef.current;
          const edits =
            target === 'all' ? res.locations : res.locations.filter((_, i) => i === target);
          await applyClassnameEditMulti(projectPath, edits, res.class_name, next);
        }
        // Advance the drift baseline so consecutive edits keep working.
        setSelection({ ...sel, resolution: { ...res, class_name: next } });
        // Tell the in-iframe script this live state is now the saved baseline, so
        // deactivating (closing the panel) doesn't revert the just-saved edit
        // before HMR re-renders it from source.
        post({ type: 'ss:commit' });
        if (!opts?.silent) onToast?.('Saved to source', 'success');
      } catch (err) {
        logger.error('[VisualEditor] write-back failed', { error: String(err) });
        onToast?.(String(err), 'error');
      }
    },
    [selection, projectPath, onToast, post]
  );

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
        onToast?.('Image replaced', 'success');
      } catch (err) {
        logger.error('[VisualEditor] image write-back failed', { error: String(err) });
        onToast?.(String(err), 'error');
        throw err;
      }
    },
    [projectPath, onToast, post]
  );

  // Auto-save: debounce a silent commit after edits settle. Re-running on every
  // class change clears the prior timer (so a drag saves once, when it stops); the
  // resolved-and-dirty guard means it never fires on selection alone, and the
  // baseline-advance inside `commit` makes the next run a no-op (no loop).
  useEffect(() => {
    if (!autoSave) return;
    const res = selection?.resolution;
    if (res?.status !== 'resolved' && res?.status !== 'multi') return;
    if (currentClass === res.class_name) return; // clean
    const id = window.setTimeout(() => void commit({ silent: true }), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [autoSave, currentClass, selection, commit]);

  const toggleEditMode = useCallback(() => {
    setEditModeOn((prev) => {
      // Turning off: clear the current selection (event-handler context, so
      // these state updates batch without a cascading-render effect).
      if (prev) {
        setSelection(null);
        setLiveClass('');
        setTextTarget(null);
        setImageTarget(null);
        selectedSigRef.current = null;
      }
      return !prev;
    });
  }, [setLiveClass, setTextTarget, setImageTarget]);

  return {
    editMode,
    toggleEditMode,
    selection,
    currentClass,
    usage,
    /** Text-editability of the current selection (drives the panel's hint). */
    textResolution,
    /** Image-src editability of the current selection (drives the Image section). */
    imageResolution,
    /** Write a new src to source and swap the preview (immediate save). */
    replaceImage,
    /** Bumps when a double-click hits dynamic text — pulses the hand-off block. */
    textBlockedNonce,
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
  };
}
