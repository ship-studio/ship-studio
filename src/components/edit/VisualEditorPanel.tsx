/**
 * Visual editor properties panel.
 *
 * Renders for the element selected in the preview and exposes the spacing
 * controls (padding / margin / gap) as live steppers: each step mutates the DOM
 * instantly and persists to source on "Save". Ambiguous/dynamic elements are
 * shown read-only with the reason, matching the resolver's safe fallback.
 */

import type { CSSProperties } from 'react';
import { Button } from '../primitives/Button';
import { SpacingBox } from './SpacingBox';
import { EnumControls } from './EnumControls';
import { ColorControls } from './ColorControls';
import { scaleValue, type BoxType, type Side } from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';

interface Props {
  selection: Selection | null;
  /** The class string currently applied live (what "Save" will persist). */
  currentClass: string;
  /** Step the gap utility one notch up (1) or down (-1). */
  onStepGap: (dir: 1 | -1) => void;
  /** Set one side of padding/margin to an absolute value (box-model editor). */
  onSetSide: (type: BoxType, side: Side, n: number) => void;
  /** Apply an enum option's token + inline-style preview. */
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onCommit: () => void;
  onClose: () => void;
  /** Inline position/size (the panel is portaled to <body> and positioned by the
   *  host from the measured canvas rect). */
  style?: CSSProperties;
}

export function VisualEditorPanel({
  selection,
  currentClass,
  onStepGap,
  onSetSide,
  onApplyEnum,
  onCommit,
  onClose,
  style,
}: Props) {
  const resolution = selection?.resolution ?? null;
  const dirty = resolution?.status === 'resolved' && currentClass !== resolution.class_name;

  return (
    <div className="ss-edit-panel" data-testid="visual-editor-panel" style={style}>
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
              {resolution.confidence !== 'unique' && (
                <span
                  className="ss-edit-panel__badge ss-edit-panel__badge--approx"
                  title="These classes appear more than once in your code, so the source was located by surrounding context — double-check before saving."
                >
                  approx.
                </span>
              )}
            </div>

            {selection && selection.instanceCount > 1 && (
              <p className="ss-edit-panel__multi">
                Editing {selection.instanceCount} elements that share this source
              </p>
            )}

            <SpacingBox currentClass={currentClass} onSetSide={onSetSide} />

            <div className="ss-edit-panel__control">
              <label className="ss-edit-panel__label">Gap</label>
              <div className="ss-edit-panel__stepper">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Decrease gap"
                  onClick={() => onStepGap(-1)}
                >
                  −
                </Button>
                <span className="ss-edit-panel__value">
                  {scaleValue(currentClass, 'gap') ?? '—'}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Increase gap"
                  onClick={() => onStepGap(1)}
                >
                  ＋
                </Button>
              </div>
            </div>

            <EnumControls currentClass={currentClass} onApplyEnum={onApplyEnum} />

            <div className="ss-edit-panel__control">
              <label className="ss-edit-panel__label">Opacity</label>
              <input
                type="range"
                className="ss-edit-panel__slider"
                aria-label="Opacity"
                min={0}
                max={100}
                step={5}
                value={scaleValue(currentClass, 'opacity') ?? 100}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onApplyEnum(`opacity-${n}`, { opacity: String(n / 100) });
                }}
              />
            </div>

            <ColorControls currentClass={currentClass} onApplyEnum={onApplyEnum} />

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
