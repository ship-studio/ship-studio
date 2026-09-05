/**
 * CSS-Mode visual editor controller — a SEPARATE feature from the Tailwind
 * visual editor (`useVisualEditor`), with the same selection/preview experience
 * but a CSS-rule write model: a clicked element resolves to the CSS rule its
 * class points at, and edits set declarations on that rule (any property, any
 * value) which apply to every element sharing the class.
 *
 * It reuses the in-iframe `ss:*` postMessage protocol (`select_script.html`):
 * - `ss:activate` / `ss:deactivate` toggle the selection layer (re-armed on HMR).
 * - `ss:select` reports the clicked element's signature.
 * - `ss:mutateClass` injects raw declarations scoped to the class selector for
 *   instant live preview (no write) — this IS the class-first model.
 * - `ss:suppressReload` + `ss:commit` bracket a write so the dev server's reload
 *   doesn't briefly revert the just-saved edit.
 *
 * Backend boundary: `lib/edit-css` over `commands/edit_css.rs`. Security: only
 * messages from the preview iframe's own contentWindow are trusted (it hosts
 * untrusted project content).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveCssRule,
  setCssDeclaration,
  createCssClass,
  listStylesheets,
  listCssClasses,
  toCssSignature,
  type CssResolution,
  type CssDeclaration,
} from '../lib/edit-css';
import {
  resolveClassnameSource,
  applyClassnameEdit,
  applyClassnameEditMulti,
  type ElementSignature,
} from '../lib/edit';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';

/** A Tauri-rejected `CommandError` is an object — `String(err)` would render it
 *  as "[object Object]". Format it to the human message. */
function toastText(err: unknown): string {
  return formatCommandError(asCommandError(err));
}

export interface CssSelection {
  signature: ElementSignature;
  /** null while the backend resolve is in flight. */
  resolution: CssResolution | null;
  /** How many elements on the page share this class (a save updates all). */
  instanceCount: number;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  /** Feature availability (server ready + a CSS-mode project type). */
  enabled: boolean;
  /** Required: write failures must always surface — never silently swallowed. */
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function useCssEditor({ iframeRef, projectPath, enabled, onToast }: Params) {
  const [editModeOn, setEditModeOn] = useState(false);
  const editMode = enabled && editModeOn;

  const [selection, setSelection] = useState<CssSelection | null>(null);
  const [authoredSheets, setAuthoredSheets] = useState<string[]>([]);
  const [allClasses, setAllClasses] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Mirror edit-mode direction + per-session counters for lifecycle analytics.
  const editModeOnRef = useRef(false);
  useEffect(() => {
    editModeOnRef.current = editModeOn;
  }, [editModeOn]);
  const editStartedAtRef = useRef<number | null>(null);
  const editsCommittedRef = useRef(0);

  // Staleness token: a value resolve/save that started before a newer selection
  // must not clobber it.
  const selTokenRef = useRef(0);

  // Which class chip is being edited (null = the element's last class, the
  // backend default) and which pseudo-state (null = default). Mirrored into refs
  // so the class/state setters and the message handler read fresh values.
  const [targetClass, setTargetClassState] = useState<string | null>(null);
  const [pseudo, setPseudoState] = useState<string | null>(null);
  // The active breakpoint (min-width px, null = base). Edits target the matching
  // @media block. Mirrored into a ref so callbacks read it without re-binding.
  const [breakpointMinPx, setBreakpointMinPxState] = useState<number | null>(null);
  const breakpointRef = useRef<number | null>(null);
  const targetClassRef = useRef<string | null>(null);
  const pseudoRef = useRef<string | null>(null);
  const selectedSigRef = useRef<ElementSignature | null>(null);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  // Activate the in-iframe selection layer while editing; re-arm across HMR
  // reloads (each reload resets the script to inert).
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

  // Load the project's stylesheets when edit mode opens (the create-rule target).
  useEffect(() => {
    if (!editMode) return;
    let cancelled = false;
    void listStylesheets(projectPath)
      .then((sheets) => !cancelled && setAuthoredSheets(sheets))
      .catch(() => !cancelled && setAuthoredSheets([]));
    void listCssClasses(projectPath)
      .then((cls) => !cancelled && setAllClasses(cls))
      .catch(() => !cancelled && setAllClasses([]));
    return () => {
      cancelled = true;
    };
  }, [editMode, projectPath]);

  // Resolve clicked elements to their CSS rule.
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { type?: string; signature?: ElementSignature; count?: number } | null;
      if (!d || d.type !== 'ss:select' || !d.signature) return;

      const sig = d.signature;
      const instanceCount = d.count ?? 1;
      const token = ++selTokenRef.current;
      // A fresh element resets the class/state target to defaults.
      selectedSigRef.current = sig;
      targetClassRef.current = null;
      pseudoRef.current = null;
      setTargetClassState(null);
      setPseudoState(null);
      setSelection({ signature: sig, resolution: null, instanceCount });
      // Clear any leftover class preview from a prior selection.
      post({ type: 'ss:clearClassPreview' });

      void (async () => {
        try {
          const resolution = await resolveCssRule(
            projectPath,
            toCssSignature(sig),
            breakpointRef.current
          );
          if (selTokenRef.current === token) {
            setSelection({ signature: sig, resolution, instanceCount });
          }
        } catch (err) {
          logger.error('[CssEditor] resolve failed', { error: toastText(err) });
          if (selTokenRef.current === token) {
            // A real failure — do NOT fall back to `not_found`, which would
            // wrongly offer "create rule" for a class that may already exist.
            setSelection({
              signature: sig,
              resolution: { status: 'error', reason: toastText(err) },
              instanceCount,
            });
          }
        }
      })();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [editMode, projectPath, post, iframeRef]);

  /** The active resolved rule, or null when the selection isn't an editable rule. */
  const resolvedRule = selection?.resolution?.status === 'resolved' ? selection.resolution : null;

  /** Re-resolve the current element for a given class + state, updating the
   *  resolution in place (keeps the same selection signature/instanceCount). */
  const reresolve = useCallback(
    async (tClass: string | null, ps: string | null) => {
      const sig = selectedSigRef.current;
      if (!sig) return;
      const token = ++selTokenRef.current;
      try {
        const resolution = await resolveCssRule(
          projectPath,
          toCssSignature(sig, tClass, ps),
          breakpointRef.current
        );
        if (selTokenRef.current === token) {
          setSelection((prev) => (prev ? { ...prev, resolution } : prev));
        }
      } catch (err) {
        logger.error('[CssEditor] reresolve failed', { error: toastText(err) });
      }
    },
    [projectPath]
  );

  /** Edit which class chip the controls target. */
  const setTargetClass = useCallback(
    (name: string) => {
      targetClassRef.current = name;
      setTargetClassState(name);
      void reresolve(name, pseudoRef.current);
    },
    [reresolve]
  );

  /** Edit which pseudo-state the controls target (null = default). */
  const setPseudo = useCallback(
    (ps: string | null) => {
      pseudoRef.current = ps;
      setPseudoState(ps);
      void reresolve(targetClassRef.current, ps);
    },
    [reresolve]
  );

  /** Edit which breakpoint (min-width px, null = base) the controls target. */
  const setBreakpoint = useCallback(
    (minPx: number | null) => {
      breakpointRef.current = minPx;
      setBreakpointMinPxState(minPx);
      void reresolve(targetClassRef.current, pseudoRef.current);
    },
    [reresolve]
  );

  /** Rewrite the selected element's `class` attribute in source (and live in the
   *  preview), via the class-attribute resolver/editor. Returns false when the
   *  element's classes can't be resolved to source. */
  const writeClassAttr = useCallback(
    async (nextClass: string) => {
      const sig = selectedSigRef.current;
      if (!sig) return false;
      const res = await resolveClassnameSource(projectPath, sig);
      if (res.status !== 'resolved' && res.status !== 'multi') {
        // A dynamic/computed className the editor declines to rewrite is a
        // by-design refusal, not a malfunction — 'error' toasts auto-file bug
        // reports (issue #870).
        onToast("Can't edit this element's classes in source — change them in code.", 'info');
        return false;
      }
      const prev = res.class_name;
      if (nextClass === prev) return true;
      post({ type: 'ss:suppressReload' });
      if (res.status === 'resolved') {
        await applyClassnameEdit(projectPath, res.file, res.line, prev, nextClass);
      } else {
        await applyClassnameEditMulti(projectPath, res.locations, prev, nextClass);
      }
      const nextSig = { ...sig, className: nextClass };
      selectedSigRef.current = nextSig;
      setSelection((p) => (p ? { ...p, signature: nextSig } : p));
      post({ type: 'ss:mutate', className: nextClass, rules: [] });
      post({ type: 'ss:commit' });
      return true;
    },
    [projectPath, onToast, post]
  );

  /** Add a class to the selected element and edit its rule. */
  const addClass = useCallback(
    async (name: string) => {
      const n = name.trim().replace(/^\./, '');
      const sig = selectedSigRef.current;
      if (!n || !sig) return;
      const tokens = sig.className.split(/\s+/).filter(Boolean);
      if (tokens.includes(n)) {
        setTargetClass(n);
        return;
      }
      try {
        if (!(await writeClassAttr([...tokens, n].join(' ')))) return;
        targetClassRef.current = n;
        setTargetClassState(n);
        await reresolve(n, pseudoRef.current);
        void trackEvent('visual_edit_saved', { kind: 'class', mode: 'css' });
      } catch (err) {
        onToast(toastText(err), 'error');
      }
    },
    [writeClassAttr, reresolve, setTargetClass, onToast]
  );

  /** Remove a class from the selected element (the class stays defined in CSS). */
  const removeClass = useCallback(
    async (name: string) => {
      const sig = selectedSigRef.current;
      if (!sig) return;
      const next = sig.className.split(/\s+/).filter((t) => t && t !== name);
      try {
        if (!(await writeClassAttr(next.join(' ')))) return;
        if (targetClassRef.current === name) {
          targetClassRef.current = null;
          setTargetClassState(null);
        }
        await reresolve(targetClassRef.current, pseudoRef.current);
        void trackEvent('visual_edit_saved', { kind: 'class', mode: 'css' });
      } catch (err) {
        onToast(toastText(err), 'error');
      }
    },
    [writeClassAttr, reresolve, onToast]
  );

  /** Live-preview a single property on the resolved rule's selector (no write). */
  const previewDeclaration = useCallback(
    (property: string, value: string | null) => {
      if (!resolvedRule) return;
      post({
        type: 'ss:mutateClass',
        selector: resolvedRule.selector,
        rules: [{ minPx: breakpointRef.current ?? 0, decls: { [property]: value } }],
      });
    },
    [post, resolvedRule]
  );

  /** Persist one declaration (or remove it when `value` is null) to source. */
  const saveDeclaration = useCallback(
    async (property: string, value: string | null) => {
      if (!resolvedRule) return;
      const { file, selector } = resolvedRule;
      post({ type: 'ss:suppressReload' });
      setSaving(true);
      try {
        await setCssDeclaration(
          projectPath,
          file,
          selector,
          property,
          value,
          breakpointRef.current
        );
        // Advance the local declarations so consecutive edits keep working.
        setSelection((prev) => {
          if (prev?.resolution?.status !== 'resolved') return prev;
          const decls = prev.resolution.declarations.filter(
            (d) => d.property.toLowerCase() !== property.toLowerCase()
          );
          if (value !== null) decls.push({ property, value, important: false });
          return { ...prev, resolution: { ...prev.resolution, declarations: decls } };
        });
        post({ type: 'ss:commit' });
        editsCommittedRef.current += 1;
        void trackEvent('visual_edit_saved', { kind: 'style', mode: 'css' });
      } catch (err) {
        logger.error('[CssEditor] write-back failed', { error: toastText(err) });
        onToast(toastText(err), 'error');
      } finally {
        setSaving(false);
      }
    },
    [projectPath, onToast, post, resolvedRule]
  );

  /** Apply several declaration changes to the resolved rule in one go (the Code
   *  view's Save). Writes are sequential — they touch the same file — then the
   *  rule is re-resolved so the local declarations stay truthful. */
  const saveDeclarations = useCallback(
    async (changes: { property: string; value: string | null }[]) => {
      const sel = selection;
      if (!resolvedRule || !sel || changes.length === 0) return;
      const { file, selector } = resolvedRule;
      const bp = breakpointRef.current;
      post({ type: 'ss:suppressReload' });
      setSaving(true);
      try {
        for (const c of changes) {
          await setCssDeclaration(projectPath, file, selector, c.property, c.value, bp);
        }
        const resolution = await resolveCssRule(projectPath, toCssSignature(sel.signature), bp);
        setSelection((prev) => (prev ? { ...prev, resolution } : prev));
        post({ type: 'ss:commit' });
        editsCommittedRef.current += changes.length;
        void trackEvent('visual_edit_saved', { kind: 'style', mode: 'css', count: changes.length });
      } catch (err) {
        logger.error('[CssEditor] bulk write-back failed', { error: toastText(err) });
        onToast(toastText(err), 'error');
      } finally {
        setSaving(false);
      }
    },
    [projectPath, onToast, post, resolvedRule, selection]
  );

  /** Create a rule for the current selection's class (the `not_found` case) in
   *  the chosen authored stylesheet, then re-resolve so it becomes editable. */
  const createRule = useCallback(
    async (file: string, selector: string, declarations: CssDeclaration[] = []) => {
      const sel = selection;
      if (!sel) return;
      const bp = breakpointRef.current;
      try {
        await createCssClass(projectPath, file, selector, declarations, bp);
        const resolution = await resolveCssRule(projectPath, toCssSignature(sel.signature), bp);
        setSelection({ ...sel, resolution });
        void trackEvent('visual_edit_saved', { kind: 'rule', mode: 'css' });
        onToast(`Created ${selector}`, 'success');
      } catch (err) {
        logger.error('[CssEditor] create rule failed', { error: toastText(err) });
        onToast(toastText(err), 'error');
      }
    },
    [projectPath, onToast, selection]
  );

  const toggleEditMode = useCallback(() => {
    const turningOn = !editModeOnRef.current;
    editModeOnRef.current = turningOn;
    if (turningOn) {
      editStartedAtRef.current = Date.now();
      editsCommittedRef.current = 0;
      void trackEvent('visual_edit_started', { mode: 'css' });
    } else {
      const startedAt = editStartedAtRef.current;
      void trackEvent('visual_edit_stopped', {
        mode: 'css',
        duration_ms: startedAt != null ? Date.now() - startedAt : undefined,
        edits_committed: editsCommittedRef.current,
      });
      editStartedAtRef.current = null;
    }
    setEditModeOn((prev) => {
      if (prev) setSelection(null);
      return !prev;
    });
  }, []);

  return {
    editMode,
    toggleEditMode,
    selection,
    authoredSheets,
    allClasses,
    saving,
    previewDeclaration,
    saveDeclaration,
    saveDeclarations,
    createRule,
    /** The class chip currently being edited (null = the element's last class). */
    targetClass,
    setTargetClass,
    /** The pseudo-state being edited (null = default), e.g. "hover". */
    pseudo,
    setPseudo,
    breakpointMinPx,
    setBreakpoint,
    addClass,
    removeClass,
  };
}
