/**
 * Visual editor properties panel (v1 slice).
 *
 * Renders for the element selected in the preview and exposes ONE control — a
 * Tailwind padding stepper — to prove the full loop: live DOM mutation on step,
 * surgical source write-back on "Save". Ambiguous/dynamic elements are shown
 * read-only with the reason, matching the resolver's safe fallback.
 */

import { Button } from '../primitives/Button';
import { paddingValue } from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';

interface Props {
  selection: Selection | null;
  /** The class string currently applied live (what "Save" will persist). */
  currentClass: string;
  /** Step the padding one notch up (1) or down (-1) the Tailwind scale. */
  onStep: (dir: 1 | -1) => void;
  onCommit: () => void;
  onClose: () => void;
}

export function VisualEditorPanel({ selection, currentClass, onStep, onCommit, onClose }: Props) {
  const resolution = selection?.resolution ?? null;
  const dirty = resolution?.status === 'resolved' && currentClass !== resolution.class_name;

  return (
    <div className="ss-edit-panel" data-testid="visual-editor-panel">
      <div className="ss-edit-panel__header">
        <span className="ss-edit-panel__title">Edit</span>
        <button className="ss-edit-panel__close" onClick={onClose} aria-label="Exit edit mode">
          ×
        </button>
      </div>

      <div className="ss-edit-panel__body">
        {!selection && (
          <p className="ss-edit-panel__hint">
            Click any element in the preview to edit its spacing.
          </p>
        )}

        {selection && !resolution && <p className="ss-edit-panel__hint">Resolving source…</p>}

        {resolution?.status === 'read_only' && (
          <p className="ss-edit-panel__readonly">{resolution.reason}</p>
        )}

        {resolution?.status === 'ambiguous' && (
          <p className="ss-edit-panel__readonly">
            {resolution.reason}
            <br />
            <span className="ss-edit-panel__muted">
              {resolution.candidate_count} possible locations
            </span>
          </p>
        )}

        {resolution?.status === 'resolved' && (
          <>
            <div className="ss-edit-panel__source">
              <code>
                {resolution.file}:{resolution.line}
              </code>
              <span className="ss-edit-panel__badge">{resolution.confidence}</span>
            </div>

            <div className="ss-edit-panel__control">
              <label className="ss-edit-panel__label">Padding</label>
              <div className="ss-edit-panel__stepper">
                <Button size="sm" variant="secondary" onClick={() => onStep(-1)}>
                  −
                </Button>
                <span className="ss-edit-panel__value">{paddingValue(currentClass) ?? '—'}</span>
                <Button size="sm" variant="secondary" onClick={() => onStep(1)}>
                  ＋
                </Button>
              </div>
            </div>

            <div className="ss-edit-panel__classes" title={currentClass}>
              {currentClass}
            </div>

            <Button size="sm" variant="primary" block disabled={!dirty} onClick={onCommit}>
              {dirty ? 'Save to source' : 'Saved'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
