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
  type ExactSourceTarget,
  insertElement,
  moveElement,
  pasteElement,
  type ElementKind,
  type InsertPosition,
} from '../lib/edit-structure';
import { resolveElementHtml, type ElementHtml } from '../lib/edit-html';
import { asCommandError, formatCommandError } from '../lib/errors';
import { useFrameRebind } from './useFrameRebind';
import { useSelectionCleared } from './useSelectionCleared';
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

export interface ElementClipboard {
  html: string;
  sourceClassName: string;
  sourceNodeId: number;
  mode: 'copy' | 'cut';
}

interface ResolvedDragNode {
  signature: ElementSignature;
}

/**
 * Convert a fresh source snapshot into the byte-exact proof understood by
 * `move_element`. A multi-instance result deliberately has no proof for the
 * selected row, so it remains on the fail-closed resolver path instead of
 * moving whichever identical copy happened to be returned first.
 */
function exactDragTarget(anchor: ElementHtml): ExactSourceTarget | undefined {
  if (anchor.locations?.length) return undefined;
  if (
    typeof anchor.sourceStart !== 'number' ||
    typeof anchor.sourceEnd !== 'number' ||
    typeof anchor.sourceHash !== 'string'
  ) {
    return undefined;
  }
  return {
    file: anchor.file,
    start: anchor.sourceStart,
    end: anchor.sourceEnd,
    expectedHash: anchor.sourceHash,
    expectedHtml: anchor.html,
  };
}

/** Build the truthful identity to replay after a structural reparent/move. */
export function movedElementReselectSignature(
  source: ElementSignature,
  target: ElementSignature,
  position: InsertPosition
): ElementSignature {
  const ancestorClasses =
    position === 'inside' ? [target.className, ...target.ancestorClasses] : target.ancestorClasses;
  return {
    className: source.className,
    tagName: source.tagName,
    text: source.text,
    ancestorClasses: ancestorClasses.filter(Boolean),
  };
}

type ElementShortcutKey = 'c' | 'x' | 'v' | 'd' | 'backspace';

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]') ||
    target.closest('[contenteditable=""], [contenteditable="true"]') !== null
  );
}

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  /** Active whenever either styling editor's edit mode is on. */
  enabled: boolean;
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

/** `resolveDragNodes` rejections: the preview no longer has the dragged node or
 *  its drop target, or never answered before the timeout. */
const DRAG_NODES_GONE = 'The source or target is no longer present in the preview.';
const DRAG_NODES_TIMEOUT = 'The preview changed before the move could be resolved.';

/** How long after a write the iframe `load` handler still replays the reselect. */
const RESELECT_WINDOW_MS = 8000;

/**
 * The backend's element-resolution errors are worded for the raw-markup editor
 * ("its markup becomes editable", "editing it here") — confusing when the user
 * clicked insert/duplicate/delete on the canvas. Rephrase the known resolution
 * failures for the structural-edit context (issues #318/#320); anything else
 * passes through unchanged.
 */
export function structuralEditMessage(message: string): string {
  if (message.includes('no class in source to anchor')) {
    return 'This element has no class for Ship Studio to find it in your code. Add a class to it first (the Add class action), then try again.';
  }
  if (
    message.includes('several places whose markup differs') ||
    message.includes('several identical places')
  ) {
    return 'This element appears in several places in your code, so changing it from the canvas could affect the wrong one. Select a more specific element, or ask your agent to make this change.';
  }
  if (message.includes("can't be matched to its source markup")) {
    return "This element can't be matched to its source code (its classes are generated dynamically). Ask your agent to make this change instead.";
  }
  // STRUCTURAL_TAGS guard (edit_structure.rs): the document's own <html>/<head>/
  // <body> can't be removed or displaced. A by-design refusal, but the raw
  // wording reads like an internal rule (issues #723/#740).
  const structural = /<(html|head|body)> can't be (deleted|duplicated)\./.exec(message);
  if (structural) {
    return `<${structural[1]}> is part of the page itself, so it can't be ${structural[2]}. Pick an element inside it instead.`;
  }
  const insertNextTo = /Can't insert next to <(html|head|body)>/.exec(message);
  if (insertNextTo) {
    return `Nothing can sit beside <${insertNextTo[1]}> — it's part of the page itself. Use "Insert inside" instead.`;
  }
  // `splice_inside`'s guard for any open-tag-only span — a void tag, or a
  // custom component / SVG shape written self-closing (`<Card />`), which the
  // toolbar's VOID_ELEMENTS gate can't see (issue #1085). Its reason is
  // already user-facing; drop the "Validation failed for `position`:" prefix.
  if (message.includes("This element can't contain children")) {
    return "This element can't contain children — insert before or after it instead.";
  }
  // The drift guards: the file changed (HMR, a formatter, an agent) between
  // selecting the element and writing to it (issue #1078).
  if (/(source|target) no longer matches — reselect the element/.test(message)) {
    return 'The source changed since you selected this element — reselect it and try again.';
  }
  // `move_element`'s guards (edit_structure.rs). By design, but worded as
  // internal rules (issues #1104/#1056).
  if (message.includes('an element cannot be moved inside its own descendant')) {
    return "You can't drop an element inside itself or one of its own children.";
  }
  if (message.includes('an element cannot be moved relative to itself')) {
    return "You can't drop an element onto itself. Drop it before, after, or inside another element.";
  }
  if (message.includes('source and target must belong to the same source file')) {
    return 'Elements can only be moved within the same file. Ask your agent to move it to another file.';
  }
  const unmovable = /<(html|head|body)> cannot be moved/.exec(message);
  if (unmovable) {
    return `<${unmovable[1]}> is part of the page itself, so it can't be moved. Pick an element inside it instead.`;
  }
  const childless = /<([^>\s]+)> cannot contain children/.exec(message);
  if (childless) {
    return `<${childless[1]}> can't contain children — drop it before or after instead.`;
  }
  const besideStructural = /nothing can be placed beside <(html|head|body)>/.exec(message);
  if (besideStructural) {
    return `Nothing can sit beside <${besideStructural[1]}> — it's part of the page itself. Drop it inside instead.`;
  }
  if (message.includes('this component root cannot have a sibling')) {
    return 'This is the root of a component, so nothing can sit beside it. Drop it inside instead.';
  }
  // The preview reloaded (HMR) while a drag was resolving its nodes, so the
  // dragged element or its drop target was gone — a race, not a bug (#1043).
  if (message === DRAG_NODES_GONE || message === DRAG_NODES_TIMEOUT) {
    return 'The page changed before the move could finish — try dragging it again.';
  }
  // `element_span` walked off the end of the file looking for this element's
  // closing tag — raw internal wording that meant nothing to the user (issue
  // #789). Rephrased, but NOT treated as expected below: it still points at
  // markup the span mapper can't read, which is worth a report.
  if (message.includes("couldn't map this element to its source markup")) {
    return "Ship Studio couldn't read this element's full markup in your code. Select a more specific element, or ask your agent to make this change.";
  }
  return message;
}

/**
 * Whether a structural-edit failure is a by-design refusal rather than a bug:
 * the backend declining to guess (ambiguous/unanchorable element) or the
 * structural-tag guard. These already give the user an accurate, actionable
 * message, so they route to `logger.warn` + a non-'error' toast instead of the
 * bug pipeline (issues #402/#515/#723/#740).
 */
export function isExpectedStructuralRefusal(message: string): boolean {
  return (
    message.includes('no class in source to anchor') ||
    message.includes('several places whose markup differs') ||
    message.includes('several identical places') ||
    message.includes("can't be matched to its source markup") ||
    // The classless-anchor ladder refusing to pick among look-alike tags — its
    // own wording is already user-facing and names what it searched (#318/#818).
    message.includes("Couldn't tell which <") ||
    message.includes('without a class in source') ||
    /<(html|head|body)> can't be (deleted|duplicated)\./.test(message) ||
    /Can't insert next to <(html|head|body)>/.test(message) ||
    // Self-closing span has no inside (#1085), and the drift guards (#1078).
    message.includes("This element can't contain children") ||
    /(source|target) no longer matches — reselect the element/.test(message) ||
    // move_element's by-design guards (#1104/#1056).
    message.includes('an element cannot be moved inside its own descendant') ||
    message.includes('an element cannot be moved relative to itself') ||
    message.includes('source and target must belong to the same source file') ||
    /<(html|head|body)> cannot be moved/.test(message) ||
    /<[^>\s]+> cannot contain children/.test(message) ||
    /nothing can be placed beside <(html|head|body)>/.test(message) ||
    message.includes('this component root cannot have a sibling') ||
    // A drag racing a preview reload (#1043).
    message === DRAG_NODES_GONE ||
    message === DRAG_NODES_TIMEOUT
  );
}

export function useElementStructure({ iframeRef, projectPath, enabled, onToast }: Params) {
  const [selection, setSelection] = useState<StructureSelection | null>(null);
  // Inline text editing is in progress — the toolbar hides so it can't cover
  // the contenteditable or the formatting bubble.
  const [textEditing, setTextEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clipboard, setClipboard] = useState<ElementClipboard | null>(null);

  const selectionRef = useRef<StructureSelection | null>(null);
  selectionRef.current = selection;
  const clipboardRef = useRef<ElementClipboard | null>(null);
  const updateClipboard = useCallback((next: ElementClipboard | null) => {
    clipboardRef.current = next;
    setClipboard(next);
  }, []);
  const shortcutActionsRef = useRef<
    | {
        [key in ElementShortcutKey]: () => void;
      }
    | null
  >(null);
  const busyRef = useRef(false);
  // The new element's expected signature, replayed until the reload lands.
  const pendingReselectRef = useRef<{ sig: ElementSignature; at: number } | null>(null);
  const reselectTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Action queued behind an ss:selectNode round-trip (tree context menu).
  const pendingActionRef = useRef<{ nodeId: number; run: () => void } | null>(null);
  const dragRequestIdRef = useRef(0);
  const dragRequestsRef = useRef(
    new Map<
      string,
      {
        resolve: (value: { source: ResolvedDragNode; target: ResolvedDragNode }) => void;
        reject: (reason: unknown) => void;
      }
    >()
  );

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  const resolveDragNodes = useCallback(
    (sourceId: number, targetId: number) =>
      new Promise<{ source: ResolvedDragNode; target: ResolvedDragNode }>((resolve, reject) => {
        const requestId = `drag-${++dragRequestIdRef.current}`;
        dragRequestsRef.current.set(requestId, { resolve, reject });
        post({ type: 'ss:resolveDragNodes', requestId, sourceId, targetId });
        window.setTimeout(() => {
          const pending = dragRequestsRef.current.get(requestId);
          if (!pending) return;
          dragRequestsRef.current.delete(requestId);
          pending.reject(new Error(DRAG_NODES_TIMEOUT));
        }, 2000);
      }),
    [post]
  );

  // The preview's initialization shim captures keys before the page can
  // consume them, but only while structural editing is enabled. Re-send the
  // flag after every iframe load because a navigation creates a fresh frame.
  useEffect(() => {
    const sendShortcutState = () => post({ type: 'ss:setElementStructureShortcuts', enabled });
    sendShortcutState();
    const iframe = iframeRef.current;
    iframe?.addEventListener('load', sendShortcutState);
    return () => iframe?.removeEventListener('load', sendShortcutState);
  }, [enabled, iframeRef, post]);
  // Nothing is selected any more — either the editor moved to another preview
  // frame (the breakpoint canvas), so the toolbar's selection box belongs to the
  // frame we left, or the user clicked the canvas background and dropped it.
  const forgetSelection = useCallback(() => {
    setSelection(null);
    setTextEditing(false);
    pendingReselectRef.current = null;
    pendingActionRef.current = null;
  }, []);
  useFrameRebind(iframeRef, forgetSelection);
  useSelectionCleared(iframeRef, forgetSelection);

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
        key?: ElementShortcutKey;
        requestId?: string;
        source?: ResolvedDragNode | null;
        target?: ResolvedDragNode | null;
      } | null;
      if (!d) return;

      if (d.type === 'ss:resolvedDragNodes' && d.requestId) {
        const pending = dragRequestsRef.current.get(d.requestId);
        if (!pending) return;
        dragRequestsRef.current.delete(d.requestId);
        if (d.source && d.target) pending.resolve({ source: d.source, target: d.target });
        else pending.reject(new Error(DRAG_NODES_GONE));
      } else if (
        d.type === 'ss:elementShortcut' &&
        (d.key === 'c' || d.key === 'x' || d.key === 'v' || d.key === 'd' || d.key === 'backspace')
      ) {
        const action = shortcutActionsRef.current?.[d.key];
        if (action) action();
      } else if (d.type === 'ss:select' && d.signature) {
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
        const message = formatCommandError(asCommandError(err));
        // Wording and reportability are decided separately: a failure can
        // deserve better phrasing AND still be a bug worth filing (issue #789).
        const friendly = structuralEditMessage(message);
        const expected = isExpectedStructuralRefusal(message);
        if (expected) {
          // A known by-design refusal (ambiguous/unanchorable element, or the
          // structural-tag guard). The user already gets an accurate toast;
          // logger.error would ship it to the bug pipeline on every occurrence
          // even though #299 already classified these as non-reportable on the
          // Rust side (issues #402/#723/#740).
          logger.warn('[ElementStructure] structural edit refused', { error: message });
        } else {
          logger.error('[ElementStructure] structural edit failed', { error: message });
        }
        // Recognized refusals also skip the 'error' toast type: error toasts
        // re-enter telemetry through useToasts' `source: 'toast'` reporting
        // path, re-reporting what the logger.warn branch above deliberately
        // kept out (issues #437/#515). 'info' keeps the toast visible without
        // filing a bug.
        onToast?.(friendly, expected ? 'info' : 'error');
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
        void trackEvent('visual_edit_saved', { kind: 'insert' });
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
        void trackEvent('visual_edit_saved', { kind: 'duplicate' });
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
        void trackEvent('visual_edit_saved', { kind: 'delete' });
        onToast?.(
          sel.count > 1 ? `Element deleted — affects ${sel.count} copies` : 'Element deleted',
          'success'
        );
      }),
    [projectPath, runAction, onToast]
  );

  const copy = useCallback(
    () =>
      runAction(async () => {
        const sel = selectionRef.current;
        if (!sel || sel.nodeId == null) return;
        const { html } = await resolveElementHtml(projectPath, sel.signature);
        updateClipboard({
          html,
          sourceClassName: sel.signature.className,
          sourceNodeId: sel.nodeId,
          mode: 'copy',
        });
        onToast?.('Element copied', 'success');
      }),
    [projectPath, runAction, updateClipboard, onToast]
  );

  const cut = useCallback(
    () =>
      runAction(async () => {
        const sel = selectionRef.current;
        if (!sel || sel.nodeId == null) return;
        const { html } = await resolveElementHtml(projectPath, sel.signature);
        await deleteElement(projectPath, sel.signature, html);
        updateClipboard({
          html,
          sourceClassName: sel.signature.className,
          sourceNodeId: sel.nodeId,
          mode: 'cut',
        });
        setSelection(null);
        onToast?.('Element cut', 'success');
      }),
    [projectPath, runAction, updateClipboard, onToast]
  );

  const paste = useCallback(
    () =>
      runAction(async () => {
        const sel = selectionRef.current;
        const currentClipboard = clipboardRef.current;
        if (!sel || !currentClipboard) return;
        const inserted = await pasteElement(
          projectPath,
          sel.signature,
          currentClipboard.html,
          currentClipboard.sourceClassName
        );
        scheduleReselect({
          className: inserted.className,
          tagName: inserted.tagName,
          ancestorClasses: [sel.signature.className, ...sel.signature.ancestorClasses].filter(
            Boolean
          ),
        });
        if (currentClipboard.mode === 'cut') updateClipboard(null);
        onToast?.('Element pasted', 'success');
      }),
    [projectPath, runAction, scheduleReselect, updateClipboard, onToast]
  );

  const commitMove = useCallback(
    async (
      resolved: { source: ResolvedDragNode; target: ResolvedDragNode },
      position: InsertPosition,
      canvasMoveId?: string
    ) => {
      try {
        // The iframe can only provide rendered DOM markup. React/JSX changes
        // that representation (`className` -> `class`, drops expressions and
        // props), so resolve the fresh signatures back to their authored
        // source spans before invoking the exact backend drift guards.
        const [sourceHtml, targetHtml] = await Promise.all([
          resolveElementHtml(projectPath, resolved.source.signature),
          resolveElementHtml(projectPath, resolved.target.signature),
        ]);
        const sourceTarget = exactDragTarget(sourceHtml);
        const targetTarget = exactDragTarget(targetHtml);
        if (sourceTarget && targetTarget) {
          await moveElement(
            projectPath,
            resolved.source.signature,
            resolved.target.signature,
            sourceHtml.html,
            targetHtml.html,
            position,
            sourceTarget,
            targetTarget
          );
        } else {
          // Keep compatibility with an older backend while it reloads. The
          // Rust fallback still refuses an unresolved multi-instance class;
          // never guess by passing the first identical snapshot as exact.
          await moveElement(
            projectPath,
            resolved.source.signature,
            resolved.target.signature,
            sourceHtml.html,
            targetHtml.html,
            position
          );
        }
        // The iframe observer will request a fresh tree after HMR. Requesting
        // once here also covers a backend write whose dev server coalesces the
        // mutation before the observer is ready.
        post({ type: 'ss:requestTree' });
        scheduleReselect(
          movedElementReselectSignature(
            resolved.source.signature,
            resolved.target.signature,
            position
          )
        );
        if (canvasMoveId) {
          post({ type: 'ss:canvasMoveResult', moveId: canvasMoveId, ok: true });
        }
        onToast?.('Element moved', 'success');
      } catch (error) {
        // A rejected fresh-resolution or backend drift guard must not leave
        // the projected DOM order looking authoritative. The iframe remains
        // the source of truth; ask it for a fresh snapshot before surfacing
        // the existing structured failure message.
        post({ type: 'ss:requestTree' });
        if (canvasMoveId) {
          post({ type: 'ss:canvasMoveResult', moveId: canvasMoveId, ok: false });
        }
        throw error;
      }
    },
    [onToast, post, projectPath, scheduleReselect]
  );

  const move = useCallback(
    (sourceNodeId: number, targetNodeId: number, position: InsertPosition) =>
      runAction(async () => {
        const resolved = await resolveDragNodes(sourceNodeId, targetNodeId);
        await commitMove(resolved, position);
      }),
    [commitMove, resolveDragNodes, runAction]
  );

  // Canvas sorting is projected inside the iframe so the authored page can
  // reflow in its own layout engine. The iframe sends signatures captured
  // before that projection; commit them through the same guarded source path
  // as an Elements-panel move, then retain or roll back the projection.
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as {
        type?: string;
        moveId?: string;
        source?: ResolvedDragNode;
        target?: ResolvedDragNode;
        position?: InsertPosition;
      } | null;
      if (
        data?.type !== 'ss:canvasMove' ||
        !data.moveId ||
        !data.source?.signature ||
        !data.target?.signature ||
        (data.position !== 'before' && data.position !== 'after' && data.position !== 'inside')
      ) {
        return;
      }
      if (busyRef.current) {
        post({ type: 'ss:canvasMoveResult', moveId: data.moveId, ok: false });
        return;
      }
      void runAction(() =>
        commitMove({ source: data.source!, target: data.target! }, data.position!, data.moveId)
      );
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [commitMove, enabled, iframeRef, post, runAction]);

  shortcutActionsRef.current = {
    c: () => void copy(),
    x: () => void cut(),
    v: () => void paste(),
    d: () => void duplicate(),
    backspace: () => void remove(),
  };

  // The tree and context-menu live in the host window; the canvas lives in a
  // cross-origin iframe. Handle the same shortcuts in both documents, while
  // leaving native text-entry and inline editing alone.
  useEffect(() => {
    if (!enabled) return;
    const runShortcut = (event: Event, shortcutKey: ElementShortcutKey) => {
      if (
        event.defaultPrevented ||
        (event instanceof KeyboardEvent && event.isComposing) ||
        isTextEntryTarget(event.target)
      ) {
        return;
      }

      const currentSelection = selectionRef.current;
      if (!currentSelection || currentSelection.nodeId == null) return;
      if (shortcutKey === 'v' && !clipboardRef.current) return;

      event.preventDefault();
      shortcutActionsRef.current?.[shortcutKey]();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || isTextEntryTarget(event.target)) return;

      const key = event.key.toLowerCase();
      const isModifierShortcut =
        (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
      const isDeleteShortcut =
        key === 'backspace' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      if (
        !isDeleteShortcut &&
        !(isModifierShortcut && (key === 'c' || key === 'x' || key === 'v' || key === 'd'))
      ) {
        return;
      }

      runShortcut(event, key as ElementShortcutKey);
    };

    // macOS menu-bar Copy/Cut/Paste commands dispatch clipboard events rather
    // than a keydown event. Route those through the same element actions.
    const handleClipboard = (event: ClipboardEvent) => {
      const shortcutKey = event.type === 'copy' ? 'c' : event.type === 'cut' ? 'x' : 'v';
      runShortcut(event, shortcutKey);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('copy', handleClipboard, true);
    document.addEventListener('cut', handleClipboard, true);
    document.addEventListener('paste', handleClipboard, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('copy', handleClipboard, true);
      document.removeEventListener('cut', handleClipboard, true);
      document.removeEventListener('paste', handleClipboard, true);
    };
  }, [enabled]);

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
    copy,
    cut,
    paste,
    move,
    hasClipboard: clipboard !== null,
    clipboardSourceNodeId: clipboard?.mode === 'copy' ? clipboard.sourceNodeId : null,
    selectAndRun,
  };
}
