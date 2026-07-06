/**
 * Inline text editing — owns the double-click-to-edit-copy flow shared by BOTH
 * styling editors (Tailwind `useVisualEditor` and vanilla-CSS
 * `useCssCascadeEditor`). Text editing is an edit-mode capability, not a
 * styling-editor one: the iframe selection script gates and commits text the
 * same way regardless of project type, so the handler lives here and is mounted
 * once in Preview.tsx, active whenever EITHER editor's edit mode is on.
 *
 * Flow: an `ss:select` resolves the clicked leaf's text to source and posts the
 * editability verdict back (`ss:textInfo`) — the iframe gates double-click
 * editing on it. On confirm the iframe posts `ss:textCommit`; we write the new
 * text to source (`applyTextEdit`) and post `ss:commit` to re-baseline, or
 * `ss:textRevert` on failure so the optimistic edit is undone.
 *
 * Exposes `textResolution` (drives the Tailwind panel's read-only hint) and
 * `textBlockedNonce` (pulses the dynamic-text hand-off). The CSS cascade panel
 * has no text UI — it just benefits from the working commit path.
 *
 * Boundaries: lib/edit wrappers (`resolveTextSource`/`applyTextEdit`) over the
 * Rust edit backend; the iframe `ss:*` message protocol.
 *
 * Gotchas: incoming messages are trusted only when `e.source` is the preview
 * iframe's contentWindow — the iframe hosts untrusted project content, and a
 * forged `ss:textCommit` would otherwise write to the user's files. Writes arm
 * `ss:suppressReload` BEFORE touching disk: Astro's full reload can beat the
 * post-write `ss:commit`, briefly reverting the preview. The resolved target is
 * mirrored into a ref so the commit handler reads fresh state without
 * re-subscribing, and the select-time resolve is guarded by its own staleness
 * token so a fast click-through can't post a stale `ss:textInfo`.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  resolveTextSource,
  applyTextEdit,
  type ElementSignature,
  type TextResolution,
} from '../lib/edit';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';

interface Params {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  projectPath: string;
  /** Active whenever either styling editor's edit mode is on. */
  enabled: boolean;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function useTextEditing({ iframeRef, projectPath, enabled, onToast }: Params) {
  // The resolved text target for the current selection (null when the element's
  // text isn't a plain editable literal). Mirrored into a ref so the ss:textCommit
  // handler reads the latest without re-subscribing. `text` is the source baseline
  // used as the drift guard on write-back.
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
  // The signature of the current selection, mirrored for on-demand text resolution
  // if a commit arrives before the (async) select-time resolve has landed.
  const selectedSigRef = useRef<ElementSignature | null>(null);
  // Staleness guard for the select-time resolve — bumped on each new selection so a
  // fast click-through can't let an older resolve post the wrong ss:textInfo.
  const selectTokenRef = useRef(0);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  // Drop any stale selection state when edit mode closes, so a target from a prior
  // session can't bleed into the next one.
  useEffect(() => {
    if (enabled) return;
    selectedSigRef.current = null;
    textTargetRef.current = null;
    setTextResolution(null);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe. The iframe
      // hosts untrusted project content; a forged `ss:textCommit` from another
      // frame would otherwise write to the user's source files.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as {
        type?: string;
        signature?: ElementSignature;
        leafText?: boolean;
        text?: string;
      } | null;
      if (!d) return;

      // The element turned out not to be editable (dynamic text) — the iframe bounced
      // out of the optimistic edit. No toast: the Tailwind panel shows the "copy a
      // request for your agent" hand-off (DynamicTextHelp) for the still-selected element.
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
            void trackEvent('visual_text_saved');
            onToast?.('Saved to source', 'success');
          } catch (err) {
            logger.error('[TextEditing] text write-back failed', { error: String(err) });
            onToast?.(formatCommandError(asCommandError(err)), 'error');
            // Couldn't save — put the original text back in the preview.
            post({ type: 'ss:textRevert' });
          }
        })();
        return;
      }

      // A fresh selection: resolve its text-editability and post the verdict back.
      // The iframe gates inline editing on it (single-text-node leaves only).
      if (d.type !== 'ss:select' || !d.signature) return;
      const sig = d.signature;
      selectedSigRef.current = sig;
      setTextTarget(null); // optimistic; iframe allows editing until told otherwise
      const token = ++selectTokenRef.current;
      if (d.leafText) {
        void (async () => {
          try {
            const textRes = await resolveTextSource(projectPath, sig);
            // Ignore if the selection changed underneath us.
            if (selectTokenRef.current !== token) return;
            setTextTarget(textRes);
            post({ type: 'ss:textInfo', editable: textRes.status === 'resolved' });
          } catch {
            if (selectTokenRef.current === token) post({ type: 'ss:textInfo', editable: false });
          }
        })();
      } else {
        post({ type: 'ss:textInfo', editable: false });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [enabled, projectPath, onToast, post, iframeRef, setTextTarget]);

  return {
    /** Text-editability of the current selection (drives the panel's hint). */
    textResolution,
    /** Bumps when a double-click hits dynamic text — pulses the hand-off block. */
    textBlockedNonce,
  };
}
