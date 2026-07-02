/**
 * Structural element editing — owns the insert / duplicate / delete flow shared
 * by BOTH styling editors, the same way `useTextEditing` owns inline text.
 * Mounted once in Preview.tsx, active whenever either editor's edit mode is on.
 *
 * Flow: `ss:select` tracks the current selection (signature + viewport rect +
 * same-class count); `ss:selRect` keeps the rect fresh on scroll/resize so the
 * host-side toolbar follows the selection box. Actions call the
 * `edit_structure` backend commands, then schedule a reselect of the NEW
 * element: its generated class makes the signature unique, so `ss:reselect`
 * snaps the selection onto it as soon as the dev server's reload/HMR lands.
 *
 * `selectAndRun` covers the element tree's context menu on an unselected row:
 * it posts `ss:selectNode` and runs the queued action when the matching
 * `ss:select` round-trip lands (so every action operates on a live signature).
 *
 * Boundaries: lib/edit-structure wrappers over the Rust backend; the iframe
 * `ss:*` message protocol.
 *
 * Gotchas: incoming messages are trusted only when `e.source` is the preview
 * iframe's contentWindow — a forged message would otherwise drive source
 * writes. Reselect fires on timers AND on iframe `load` (delayed past the
 * styling editors' own load-replay of the OLD signature, so the new element
 * wins and becomes their `lastSignature` via the ss:select round-trip).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ElementSignature } from '../lib/edit';
import {
  deleteElement,
  duplicateElement,
  ELEMENT_KINDS,
  insertElement,
  type ElementKind,
  type InsertPosition,
} from '../lib/edit-structure';
import { resolveElementHtml } from '../lib/edit-html';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface StructureSelection {
  signature: ElementSignature;
  rect: SelectionRect | null;
  /** Same-class elements in the DOM — >1 means an edit lands on all of them. */
  count: number;
  nodeId: number | null;
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  /** Active whenever either styling editor's edit mode is on. */
  enabled: boolean;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

/** How long after a write the iframe `load` handler still replays the reselect. */
const RESELECT_WINDOW_MS = 8000;

export function useElementStructure({ iframeRef, projectPath, enabled, onToast }: Params) {
  const [selection, setSelection] = useState<StructureSelection | null>(null);
  // Inline text editing is in progress — the toolbar hides so it can't cover
  // the contenteditable or the formatting bubble.
  const [textEditing, setTextEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectionRef = useRef<StructureSelection | null>(null);
  selectionRef.current = selection;
  const busyRef = useRef(false);
  // The new element's expected signature, replayed until the reload lands.
  const pendingReselectRef = useRef<{ sig: ElementSignature; at: number } | null>(null);
  const reselectTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Action queued behind an ss:selectNode round-trip (tree context menu).
  const pendingActionRef = useRef<{ nodeId: number; run: () => void } | null>(null);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  // Drop all transient state when edit mode closes.
  useEffect(() => {
    if (enabled) return;
    setSelection(null);
    setTextEditing(false);
    pendingReselectRef.current = null;
    pendingActionRef.current = null;
    reselectTimersRef.current.forEach(clearTimeout);
    reselectTimersRef.current = [];
  }, [enabled]);
  useEffect(() => () => reselectTimersRef.current.forEach(clearTimeout), []);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe — a forged
      // message from other embedded content must not drive source writes.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as {
        type?: string;
        signature?: ElementSignature;
        count?: number;
        nodeId?: number;
        rect?: SelectionRect;
      } | null;
      if (!d) return;

      if (d.type === 'ss:select' && d.signature) {
        setSelection({
          signature: d.signature,
          rect: d.signature.rect ?? null,
          count: d.count ?? 1,
          nodeId: d.nodeId ?? null,
        });
        const queued = pendingActionRef.current;
        if (queued && queued.nodeId === d.nodeId) {
          pendingActionRef.current = null;
          // Run after this state lands so the action reads the fresh selection.
          setTimeout(queued.run, 0);
        }
      } else if (d.type === 'ss:selRect' && d.rect) {
        setSelection((prev) => (prev ? { ...prev, rect: d.rect ?? null } : prev));
      } else if (d.type === 'ss:textBegin') {
        setTextEditing(true);
      } else if (d.type === 'ss:textCommit' || d.type === 'ss:textCancel') {
        setTextEditing(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [enabled, iframeRef]);

  // After a structural write the reload is WANTED (no suppression); replay the
  // reselect once the fresh document loads. Delayed past the styling editors'
  // own load-replay (~60ms) of the OLD signature so the new element wins.
  useEffect(() => {
    if (!enabled) return;
    const iframe = iframeRef.current;
    const onLoad = () => {
      const pending = pendingReselectRef.current;
      if (!pending || Date.now() - pending.at > RESELECT_WINDOW_MS) return;
      setTimeout(() => post({ type: 'ss:reselect', signature: pending.sig }), 200);
    };
    iframe?.addEventListener('load', onLoad);
    return () => iframe?.removeEventListener('load', onLoad);
  }, [enabled, iframeRef, post]);

  /** Snap the selection onto the new element once the reload/HMR lands. Timed
   *  replays cover HMR-without-full-reload (React Fast Refresh). */
  const scheduleReselect = useCallback(
    (sig: ElementSignature) => {
      pendingReselectRef.current = { sig, at: Date.now() };
      reselectTimersRef.current.forEach(clearTimeout);
      reselectTimersRef.current = [500, 1500].map((ms) =>
        setTimeout(() => post({ type: 'ss:reselect', signature: sig }), ms)
      );
    },
    [post]
  );

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await action();
      } catch (err) {
        logger.error('[ElementStructure] structural edit failed', { error: String(err) });
        onToast?.(String(err), 'error');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onToast]
  );

  const insert = useCallback(
    (position: InsertPosition, kind: ElementKind) =>
      runAction(async () => {
        const sel = selectionRef.current;
        if (!sel) return;
        const inserted = await insertElement(projectPath, sel.signature, position, kind);
        const meta = ELEMENT_KINDS.find((k) => k.kind === kind);
        scheduleReselect({
          className: inserted.className,
          tagName: inserted.tagName,
          text: meta?.text || undefined,
          // Inside: the anchor becomes the parent; before/after: same ancestors.
          ancestorClasses:
            position === 'inside'
              ? [sel.signature.className, ...sel.signature.ancestorClasses].filter(Boolean)
              : sel.signature.ancestorClasses,
        });
        void trackEvent('visual_element_inserted');
        onToast?.(`Added ${meta?.label ?? kind}`, 'success');
      }),
    [projectPath, runAction, scheduleReselect, onToast]
  );

  const duplicate = useCallback(
    () =>
      runAction(async () => {
        const sel = selectionRef.current;
        if (!sel) return;
        const inserted = await duplicateElement(projectPath, sel.signature);
        scheduleReselect({
          className: inserted.className,
          tagName: inserted.tagName,
          text: sel.signature.text,
          ancestorClasses: sel.signature.ancestorClasses,
        });
        void trackEvent('visual_element_duplicated');
        onToast?.('Element duplicated', 'success');
      }),
    [projectPath, runAction, scheduleReselect, onToast]
  );

  const remove = useCallback(
    () =>
      runAction(async () => {
        const sel = selectionRef.current;
        if (!sel) return;
        // Resolve at action time so the drift baseline is fresh.
        const { html } = await resolveElementHtml(projectPath, sel.signature);
        await deleteElement(projectPath, sel.signature, html);
        setSelection(null);
        void trackEvent('visual_element_deleted');
        onToast?.(
          sel.count > 1 ? `Element deleted — affects ${sel.count} copies` : 'Element deleted',
          'success'
        );
      }),
    [projectPath, runAction, onToast]
  );

  /** Select a tree node, then run `action` once its ss:select lands — the tree
   *  context menu can act on rows that aren't the current selection. */
  const selectAndRun = useCallback(
    (nodeId: number, action: () => void) => {
      const sel = selectionRef.current;
      if (sel?.nodeId === nodeId) {
        action();
        return;
      }
      pendingActionRef.current = { nodeId, run: action };
      post({ type: 'ss:selectNode', id: nodeId });
      // Don't let a missed round-trip (node vanished) fire on a later selection.
      setTimeout(() => {
        if (pendingActionRef.current?.nodeId === nodeId) pendingActionRef.current = null;
      }, 2000);
    },
    [post]
  );

  return {
    /** The current canvas selection (signature + tracked viewport rect). */
    selection,
    /** True while a structural command is in flight (toolbar busy state). */
    busy,
    /** True while inline text editing is active (toolbar hides). */
    textEditing,
    insert,
    duplicate,
    remove,
    selectAndRun,
  };
}
