/**
 * Edit a selected element's source HTML by hand. Resolves the element to its
 * source markup span (open tag → close tag), shows it in a highlighted editor,
 * and writes the edited markup back on Save (drift-guarded against the resolved
 * baseline).
 *
 * Layout: the tab fills its panel cell via `position: absolute; inset: 0` (its
 * `.ss-tree-panel__body--code` parent is the positioning context). This is
 * deliberate — flex/intrinsic sizing of the highlighted editor was collapsing
 * the column to a partial width; absolute-fill is immune to it. Three rows: a
 * header showing the element being edited, the editor (or a status message),
 * and the Revert/Save footer.
 *
 * Mounted keyed by the selection in the tree panel's Code view, so a new
 * selection remounts and re-resolves once.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { CodeOverlayEditor } from './CodeOverlayEditor';
import { MultiSourceControl } from './MultiSourceControl';
import { useOptionalToast } from '../../contexts/ToastContext';
import { resolveElementHtml, applyElementHtml } from '../../lib/edit-html';
import { asCommandError, formatCommandError } from '../../lib/errors';
import type { ElementSignature, SourceLocation } from '../../lib/edit';

/** Friendly, prefix-free message for the panel — the backend's Validation
 *  reasons are already complete sentences, so show them verbatim. */
function editorErrorText(e: unknown): string {
  const err = asCommandError(e);
  return err.type === 'Validation' ? err.reason : formatCommandError(err);
}

interface Props {
  projectPath: string;
  signature: ElementSignature;
}

export function ElementHtmlEditor({ projectPath, signature }: Props) {
  const { showToast } = useOptionalToast();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  // Set when the markup lives at several identical source spots: Save writes
  // to all of them (default) or the one the user picked — same edit-all /
  // pick-one affordance as the class editor (issue #287).
  const [locations, setLocations] = useState<SourceLocation[] | null>(null);
  const [multiTarget, setMultiTarget] = useState<'all' | number>('all');
  const baselineRef = useRef('');
  const sigRef = useRef(signature);
  sigRef.current = signature;

  // Resolve once on mount (the parent remounts on a new selection).
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    resolveElementHtml(projectPath, sigRef.current)
      .then((res) => {
        if (cancelled) return;
        baselineRef.current = res.html;
        setText(res.html);
        setLocations(res.locations && res.locations.length > 1 ? res.locations : null);
        setMultiTarget('all');
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(editorErrorText(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const dirty = text !== baselineRef.current;
  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const target = locations && multiTarget !== 'all' ? locations[multiTarget] : undefined;
      const applied = await applyElementHtml(
        projectPath,
        sigRef.current,
        baselineRef.current,
        text,
        target
      );
      baselineRef.current = text;
      showToast(applied > 1 ? `Markup saved in ${applied} places` : 'Markup saved', 'success');
    } catch (e) {
      // A `Validation` rejection is the backend declining by design (drift, or
      // an element it won't guess a write target for) — its reason is already
      // an actionable sentence. An 'error' toast would re-file it as a bug on
      // every occurrence via useToasts' `source: 'toast'` reporting (#785).
      const expected = asCommandError(e).type === 'Validation';
      showToast(editorErrorText(e), expected ? 'info' : 'error');
    } finally {
      setSaving(false);
    }
  };

  // What you're editing: the tag, plus its first class for orientation.
  const firstClass = signature.className.trim().split(/\s+/).filter(Boolean)[0] ?? '';

  return (
    <div className="ss-htmltab">
      <div className="ss-htmltab__head">
        <code className="ss-htmltab__tag">&lt;{signature.tagName || 'element'}&gt;</code>
        {firstClass && <span className="ss-htmltab__cls">.{firstClass}</span>}
      </div>

      {status === 'ready' && locations && (
        <MultiSourceControl locations={locations} target={multiTarget} onChange={setMultiTarget} />
      )}

      <div className="ss-htmltab__main">
        {status === 'loading' && <div className="ss-htmltab__msg">Loading markup…</div>}
        {status === 'error' && (
          <div className="ss-htmltab__msg">
            {error || 'This element can’t be edited as markup.'}
          </div>
        )}
        {status === 'ready' && <CodeOverlayEditor value={text} onChange={setText} lang="html" />}
      </div>

      {status === 'ready' && (
        <div className="ss-htmltab__foot">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => setText(baselineRef.current)}
          >
            Revert
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  );
}
