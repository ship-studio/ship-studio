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

import { useState, useEffect, useCallback, useRef } from 'react';
import { twMerge } from 'tailwind-merge';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  steppedScale,
  scaleValue,
  boxSideToken,
  boxInlineStyle,
  SPACING_CONTROLS,
  SPACING_REM,
  type SpacingKind,
  type BoxType,
  type Side,
  type ElementSignature,
  type Resolution,
} from '../lib/edit';
import { logger } from '../lib/logger';

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  /** Feature availability (e.g. Next.js project + server ready). */
  enabled: boolean;
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

export function useVisualEditor({ iframeRef, projectPath, enabled, onToast }: Params) {
  // User intent; the *effective* mode below also requires the feature be enabled,
  // so it flips off automatically when the server restarts (no reset effect).
  const [editModeOn, setEditModeOn] = useState(false);
  const editMode = enabled && editModeOn;

  const [selection, setSelection] = useState<Selection | null>(null);
  /** The class string currently applied live in the iframe (merge baseline). */
  const [currentClass, setCurrentClass] = useState('');
  // Mirror into a ref so `applyToken`/`commit` callbacks read the latest value
  // without re-subscribing. Written only through `setLiveClass` (never in render).
  const currentClassRef = useRef('');
  const setLiveClass = useCallback((value: string) => {
    currentClassRef.current = value;
    setCurrentClass(value);
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

  // Resolve clicked elements.
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: MessageEvent) => {
      const d = e.data as { type?: string; signature?: ElementSignature; count?: number } | null;
      if (!d || d.type !== 'ss:select' || !d.signature) return;
      const sig = d.signature;
      const instanceCount = d.count ?? 1;
      setSelection({ signature: sig, resolution: null, instanceCount });
      setLiveClass(sig.className);
      void (async () => {
        try {
          const resolution = await resolveClassnameSource(projectPath, sig);
          setSelection({ signature: sig, resolution, instanceCount });
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
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [editMode, projectPath, onToast, setLiveClass]);

  /**
   * Merge a Tailwind token into the live class and preview it (no write).
   *
   * `style` is an inline-style patch applied alongside the class. It exists
   * because Tailwind's JIT only emits CSS for classes found in source — a
   * freshly-typed class like `p-14` has no compiled rule, so the class alone
   * shows nothing until it's saved and recompiled. The inline value (equal to
   * what the class resolves to) drives the live preview; the class is what gets
   * persisted. Both agree, so Save → HMR hands off with no visible change.
   */
  const applyToken = useCallback(
    (token: string, style?: Record<string, string>) => {
      const merged = twMerge(currentClassRef.current, token);
      setLiveClass(merged);
      post({ type: 'ss:mutate', className: merged, style });
    },
    [post, setLiveClass]
  );

  /** Set one side of a box (padding/margin) to an absolute value. Previews all
   *  four longhands inline (JIT-independent) and merges the side token into the class. */
  const setBoxSide = useCallback(
    (type: BoxType, side: Side, n: number) => {
      const merged = twMerge(currentClassRef.current, boxSideToken(type, side, n));
      setLiveClass(merged);
      post({ type: 'ss:mutate', className: merged, style: boxInlineStyle(merged, type) });
    },
    [post, setLiveClass]
  );

  /** Step a spacing utility (padding/margin/gap) by one integer, computed from
   *  the freshest live class (the ref, not a render-time snapshot) so rapid
   *  clicks don't drift. Drives the live preview with an inline value (Tailwind
   *  spacing = N × 0.25rem) so it shows even when Tailwind hasn't compiled the class. */
  const stepSpacing = useCallback(
    (kind: SpacingKind, dir: 1 | -1) => {
      const ctrl = SPACING_CONTROLS.find((c) => c.kind === kind);
      if (!ctrl) return;
      const token = steppedScale(currentClassRef.current, ctrl.prefix, dir);
      const n = scaleValue(token, ctrl.prefix) ?? 0;
      applyToken(token, { [ctrl.css]: `${n * SPACING_REM}rem` });
    },
    [applyToken]
  );

  /** Persist the current live class to source. */
  const commit = useCallback(async () => {
    const sel = selection;
    if (!sel || sel.resolution?.status !== 'resolved') return;
    const next = currentClassRef.current;
    const { file, line, class_name } = sel.resolution;
    if (next === class_name) return; // nothing changed
    try {
      await applyClassnameEdit(projectPath, file, line, class_name, next);
      // Advance the drift baseline so consecutive edits keep working.
      setSelection({ ...sel, resolution: { ...sel.resolution, class_name: next } });
      // Tell the in-iframe script this live state is now the saved baseline, so
      // deactivating (closing the panel) doesn't revert the just-saved edit
      // before HMR re-renders it from source.
      post({ type: 'ss:commit' });
      onToast?.('Saved to source', 'success');
    } catch (err) {
      logger.error('[VisualEditor] write-back failed', { error: String(err) });
      onToast?.(String(err), 'error');
    }
  }, [selection, projectPath, onToast, post]);

  const toggleEditMode = useCallback(() => {
    setEditModeOn((prev) => {
      // Turning off: clear the current selection (event-handler context, so
      // these state updates batch without a cascading-render effect).
      if (prev) {
        setSelection(null);
        setLiveClass('');
      }
      return !prev;
    });
  }, [setLiveClass]);

  return {
    editMode,
    toggleEditMode,
    selection,
    currentClass,
    stepSpacing,
    setBoxSide,
    // Enum controls apply an absolute token (twMerge swaps the prior one) plus an
    // inline-style preview — same path as spacing, just not relative to a scale.
    applyEnum: applyToken,
    commit,
  };
}
