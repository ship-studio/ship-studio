/**
 * Redline controller — owns the change-request list (the "Request a change"
 * half of the unified selection-driven edit mode) and the postMessage bridge
 * that draws numbered badges on the live preview (the `ss:annotate:*` protocol).
 *
 * Selection is now HOST-driven: the unified panel owns the `ss:select` stream
 * and, when the user adds a request for the selected element, calls
 * {@link addRequestForSelection} with the already-resolved source location. The
 * hook no longer activates an in-iframe overlay, no longer picks elements, and
 * no longer listens for inbound `ss:redline:*` messages — it only mints the
 * annotation and tells the iframe to badge the currently-selected element.
 *
 * Flow: `addRequestForSelection({signature, locator, resolvedLocation, …})` →
 * dispatch `pick` (+ `label` when given, + `resolve` when a source location is
 * supplied) → post `ss:annotate:set {id, number}` so the iframe draws the badge
 * → fire `findComponentUsage` in the background to patch the "appears in N
 * places" scope hint. `remove`/`focus`/`clear` drive `ss:annotate:remove` /
 * `ss:annotate:focus` / `ss:annotate:clear`. `sendToAgent` serializes the
 * session to a {@link RedlineDocument}, writes the markdown changelog (+ an
 * annotated PNG when available) to `.redline/` via the Rust
 * `write_redline_export` command, then hands the agent a single prompt — the
 * "send requests as one prompt" half of the unified Apply-all.
 *
 * The annotation-state grammar is a pure {@link redlineReducer} so it can be
 * unit-tested without React or Tauri; the hook only wires the badge bridge and
 * the async usage patch around it.
 */

import { useReducer, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { findComponentUsage, type ElementSignature, type SourceLocation } from '../lib/edit';
import {
  resequence,
  buildMarkdown,
  exportSlug,
  type RedlineAnnotation,
  type RedlineLocator,
  type RedlineDocument,
} from '../lib/redline';
import { logger } from '../lib/logger';

/** A bounding box in viewport coordinates, as sent by the overlay. */
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

// ───────────────────────────── Reducer ──────────────────────────────────────

/** The pure annotation-list state the reducer owns. `usageById` is the
 *  "appears in N places" scope hint per annotation, filled in asynchronously. */
export interface RedlineState {
  annotations: RedlineAnnotation[];
  usageById: Record<string, number>;
}

export const initialRedlineState: RedlineState = { annotations: [], usageById: {} };

/** Every mutation to the redline annotation list. Async resolution lands via the
 *  `resolve` / `usage` actions once the backend answers. */
export type RedlineAction =
  | {
      type: 'pick';
      id: string;
      signature: ElementSignature;
      locator: RedlineLocator;
      rect: Rect;
      createdAt: string;
    }
  | {
      type: 'textedit';
      id: string;
      signature: ElementSignature;
      locator: RedlineLocator;
      rect: Rect;
      oldText: string;
      newText: string;
      hasInlineMarkup: boolean;
      createdAt: string;
    }
  | { type: 'label'; id: string; text: string }
  | {
      type: 'resolve';
      id: string;
      resolvedLocation: { file: string; line: number; column: number } | null;
      confidence?: string;
    }
  | { type: 'usage'; id: string; count: number }
  | { type: 'remove'; id: string }
  | { type: 'reorder'; fromId: string; toIndex: number }
  | { type: 'clear' };

/** Renumber annotations 1..N in array order — the same contract as
 *  {@link resequence}, but operating on the bare list the reducer holds. */
function renumber(annotations: RedlineAnnotation[]): RedlineAnnotation[] {
  return annotations.map((a, i) => (a.number === i + 1 ? a : { ...a, number: i + 1 }));
}

/**
 * Pure reducer for the redline annotation list. Add/remove/reorder resequence
 * the numbers so they stay contiguous; `resolve`/`usage` patch a single
 * annotation in place once the async backend resolution lands.
 */
export function redlineReducer(state: RedlineState, action: RedlineAction): RedlineState {
  switch (action.type) {
    case 'pick': {
      const annotation: RedlineAnnotation = {
        id: action.id,
        number: state.annotations.length + 1,
        kind: 'change',
        label: '',
        signature: action.signature,
        locator: action.locator,
        resolvedLocation: null,
        rect: action.rect,
        createdAt: action.createdAt,
      };
      return { ...state, annotations: renumber([...state.annotations, annotation]) };
    }
    case 'textedit': {
      const annotation: RedlineAnnotation = {
        id: action.id,
        number: state.annotations.length + 1,
        kind: 'textedit',
        label: '',
        signature: action.signature,
        locator: action.locator,
        resolvedLocation: null,
        rect: action.rect,
        oldText: action.oldText,
        newText: action.newText,
        hasInlineMarkup: action.hasInlineMarkup,
        createdAt: action.createdAt,
      };
      return { ...state, annotations: renumber([...state.annotations, annotation]) };
    }
    case 'label': {
      const annotations = state.annotations.map((a) =>
        a.id === action.id ? { ...a, label: action.text } : a
      );
      return { ...state, annotations };
    }
    case 'resolve': {
      const annotations = state.annotations.map((a) =>
        a.id === action.id
          ? { ...a, resolvedLocation: action.resolvedLocation, confidence: action.confidence }
          : a
      );
      return { ...state, annotations };
    }
    case 'usage': {
      // Drop usage for an annotation that was removed before its resolve landed.
      if (!state.annotations.some((a) => a.id === action.id)) return state;
      return { ...state, usageById: { ...state.usageById, [action.id]: action.count } };
    }
    case 'remove': {
      const annotations = renumber(state.annotations.filter((a) => a.id !== action.id));
      const { [action.id]: _dropped, ...usageById } = state.usageById;
      return { annotations, usageById };
    }
    case 'reorder': {
      const from = state.annotations.findIndex((a) => a.id === action.fromId);
      if (from === -1) return state;
      const next = state.annotations.slice();
      const [moved] = next.splice(from, 1);
      const to = Math.max(0, Math.min(action.toIndex, next.length));
      next.splice(to, 0, moved);
      return { ...state, annotations: renumber(next) };
    }
    case 'clear':
      return initialRedlineState;
    default:
      return state;
  }
}

// ───────────────────────────── Hook ─────────────────────────────────────────

interface UseRedlineParams {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Retained for caller compatibility; no longer gates anything (selection +
   *  requests are host-driven now, so there is no in-iframe overlay to toggle). */
  enabled?: boolean;
  projectPath: string;
  /** The page the redline targets — recorded in the export + drives the slug. */
  pageUrl: string;
  /** The page's title — recorded in the export header. */
  pageTitle: string;
  /** Hand the assembled change-request prompt to the agent terminal. */
  onSendToClaude: (prompt: string) => void;
  /** Capture a real PNG of the preview (with the numbered badges) as raw bytes —
   *  Tauri serializes the byte vector as a JS `number[]`. Optional: when absent or
   *  it resolves `null`, the export ships the markdown changelog without a PNG. */
  captureRedlinePng?: () => Promise<number[] | null>;
  showToast?: (message: string, type?: 'success' | 'error') => void;
}

/** Build a fresh, monotonic-ish annotation id (overlay picks may not carry one). */
let redlineSeq = 0;
function newId(): string {
  redlineSeq += 1;
  return `rl-${Date.now().toString(36)}-${redlineSeq}`;
}

/** The agent prompt: read the exported changelog + screenshot, apply each
 *  numbered change trusting the Source line first, use exact Old→New for text,
 *  keep edits scoped, don't commit, report per item. */
function buildAgentPrompt(slug: string): string {
  return [
    `Read .redline/${slug}.md (and the sibling .redline/${slug}.png screenshot if present), then apply every numbered change request in it to this codebase.`,
    '',
    'Rules:',
    '- For each item, trust the "Source: file:line" line first — it is the real source location resolved from the running dev server. The selector and locator are fallbacks only.',
    '- For a text replacement, use the exact Old text → New text strings verbatim. Search the source for the Old text and replace it with the New text.',
    '- Keep every edit minimal and scoped to the request. Do not refactor unrelated code.',
    '- Do NOT commit. Leave the changes in the working tree for review.',
    '- Report back per item: Done / Skipped (reason) / Needs clarification.',
  ].join('\n');
}

/**
 * Redline mode controller. Returns the live annotation list, the per-annotation
 * usage map, and the mutation + export handlers per the redline contract.
 */
export function useRedline({
  iframeRef,
  projectPath,
  pageUrl,
  pageTitle,
  onSendToClaude,
  captureRedlinePng,
  showToast,
}: UseRedlineParams) {
  const [state, dispatch] = useReducer(redlineReducer, initialRedlineState);
  const [sending, setSending] = useReducer((_: boolean, next: boolean) => next, false);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  // Patch the "appears in N places" scope hint for a resolved request, in the
  // background. Best-effort: usage is a hint, so failures are swallowed, and the
  // `usage` reducer action drops the result if the request was already removed.
  const patchUsage = useCallback(
    async (id: string, file: string, line: number) => {
      try {
        const report = await findComponentUsage(projectPath, file, line);
        dispatch({ type: 'usage', id, count: report.sites.length });
      } catch {
        /* usage is a hint — ignore failures */
      }
    },
    [projectPath]
  );

  // Host-driven entry point: the unified panel owns the `ss:select` stream and
  // the source resolution, then calls this to record a change request for the
  // currently-selected element. Mints an id, dispatches the same reducer actions
  // the old overlay-driven path used (`pick`, then `label` when given, then
  // `resolve` when a source location was supplied), badges the selected element
  // via `ss:annotate:set`, kicks off the usage patch, and returns the id.
  const addRequestForSelection = useCallback(
    ({
      signature,
      locator,
      resolvedLocation,
      confidence,
      rect,
      label,
    }: {
      signature: ElementSignature;
      locator: RedlineLocator;
      resolvedLocation: SourceLocation | null;
      confidence?: string;
      rect: Rect;
      label: string;
    }): string => {
      const id = newId();
      const createdAt = new Date().toISOString();
      // The number this request will take: append → length + 1, mirroring the
      // reducer's `pick` numbering. Computed before dispatch so the badge message
      // carries the right number (the reducer's `renumber` keeps it contiguous).
      const number = state.annotations.length + 1;

      dispatch({ type: 'pick', id, signature, locator, rect, createdAt });
      if (label.trim()) dispatch({ type: 'label', id, text: label });
      if (resolvedLocation) {
        dispatch({ type: 'resolve', id, resolvedLocation, confidence });
        void patchUsage(id, resolvedLocation.file, resolvedLocation.line);
      }

      post({ type: 'ss:annotate:set', id, number });
      return id;
    },
    [post, patchUsage, state.annotations.length]
  );

  const updateLabel = useCallback((id: string, text: string) => {
    dispatch({ type: 'label', id, text });
  }, []);

  const remove = useCallback(
    (id: string) => {
      dispatch({ type: 'remove', id });
      post({ type: 'ss:annotate:remove', id }); // tell the iframe to drop its badge
    },
    [post]
  );

  const reorder = useCallback((fromId: string, toIndex: number) => {
    dispatch({ type: 'reorder', fromId, toIndex });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: 'clear' });
    post({ type: 'ss:annotate:clear' }); // wipe every badge from the iframe
  }, [post]);

  const focus = useCallback(
    (id: string) => {
      post({ type: 'ss:annotate:focus', id }); // scrollIntoView the badge's element
    },
    [post]
  );

  // Keep the in-iframe badge numbers in sync with the (re)numbered annotations.
  // remove/reorder renumber the list 1..N; without this the on-page badges keep
  // their stale numbers and the captured screenshot markers desync from the
  // markdown order at sendToAgent time.
  const badgeNumbering = state.annotations.map((a) => `${a.id}:${a.number}`).join('|');
  useEffect(() => {
    post({
      type: 'ss:annotate:renumber',
      entries: state.annotations.map((a) => ({ id: a.id, number: a.number })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only when the id→number mapping changes
  }, [badgeNumbering, post]);

  // Build the export document from the current annotations + live viewport,
  // capture a real annotated PNG of the preview, write the markdown changelog (+
  // the PNG) to `.redline/`, hand the agent a prompt, then self-clear the queue so
  // the send is one atomic done-action (request list + badges reset together). On
  // failure the queue is kept untouched and the error is toasted.
  const sendToAgent = useCallback(async () => {
    setSending(true);
    try {
      const now = new Date();
      const doc: RedlineDocument = resequence({
        schemaVersion: 1,
        projectPath,
        pageUrl,
        pageTitle,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        },
        annotations: state.annotations,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const slug = exportSlug(pageUrl, now);
      const markdown = buildMarkdown(doc, `${slug}.png`);
      // Capture a real PNG of the preview (badges are real DOM in the iframe).
      // Best-effort: a null capture ships the changelog without an embedded PNG.
      const png = (await captureRedlinePng?.()) ?? [];
      await invoke('write_redline_export', { projectPath, slug, markdown, png });
      onSendToClaude(buildAgentPrompt(slug));
      // Send succeeded — reset the queue + badges atomically (a complete action).
      clear();
    } catch (err) {
      logger.error('[Redline] export failed', { error: String(err) });
      showToast?.(String(err), 'error');
    } finally {
      setSending(false);
    }
  }, [
    projectPath,
    pageUrl,
    pageTitle,
    state.annotations,
    onSendToClaude,
    captureRedlinePng,
    clear,
    showToast,
  ]);

  return {
    /** The change requests, newest contract name. Alias of `annotations`. */
    requests: state.annotations,
    annotations: state.annotations,
    usageById: state.usageById,
    addRequestForSelection,
    updateLabel,
    remove,
    reorder,
    clear,
    focus,
    sendToAgent,
    sending,
  };
}
