/**
 * Visual editor properties panel.
 *
 * Renders for the element selected in the preview and exposes the spacing
 * controls (padding / margin / gap) as live steppers: each step mutates the DOM
 * instantly and persists to source on "Save". Ambiguous/dynamic elements are
 * shown read-only with the reason, matching the resolver's safe fallback.
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '../primitives/Button';
import { SpacingBox } from './SpacingBox';
import { EnumControls } from './EnumControls';
import { ColorControls } from './ColorControls';
import { scaleValue, SPACING_REM, type BoxType, type Side } from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';

/** Editable numeric field for the gap value: click to type, Enter/blur to apply,
 *  stays in sync when the +/- steppers change the value externally (synced during
 *  render via the prev-value pattern — no effect). */
function GapField({ value, onSet }: { value: number | null; onSet: (n: number) => void }) {
  const display = value?.toString() ?? '';
  const [text, setText] = useState(display);
  const [lastDisplay, setLastDisplay] = useState(display);
  if (display !== lastDisplay) {
    setLastDisplay(display);
    setText(display);
  }

  const commit = () => {
    const n = parseInt(text, 10);
    if (!Number.isNaN(n) && n >= 0) onSet(n);
    else setText(value?.toString() ?? '');
  };

  return (
    <input
      className="ss-edit-panel__num"
      inputMode="numeric"
      aria-label="Gap"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

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
}

const PANEL_WIDTH = 240;

/** Initial top-right resting spot (clears the toolbar). Lazy so it reads the
 *  window once on mount; drag takes over from there. */
function initialPos() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  return { top: 96, left: Math.max(16, w - PANEL_WIDTH - 16) };
}

export function VisualEditorPanel({
  selection,
  currentClass,
  onStepGap,
  onSetSide,
  onApplyEnum,
  onCommit,
  onClose,
}: Props) {
  const resolution = selection?.resolution ?? null;
  const dirty = resolution?.status === 'resolved' && currentClass !== resolution.class_name;

  // Self-owned fixed position so the panel is draggable by its header. Fully
  // inline (no CSS-var/measurement dependency) so it can't drift out of view.
  const [pos, setPos] = useState(initialPos);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onHeaderPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Don't start a drag from the close button.
    if ((e.target as HTMLElement).closest('.ss-edit-panel__close')) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onHeaderPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const w = rootRef.current?.offsetWidth ?? PANEL_WIDTH;
    const left = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - 40));
    setPos({ top, left });
  }, []);

  const onHeaderPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <div
      ref={rootRef}
      className="ss-edit-panel"
      data-testid="visual-editor-panel"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        right: 'auto',
        zIndex: 1000,
        // Cap shorter than the viewport; the body scrolls, the footer stays put.
        maxHeight: `min(520px, calc(100vh - ${pos.top + 16}px))`,
      }}
    >
      <div
        className="ss-edit-panel__header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
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
                <GapField
                  value={scaleValue(currentClass, 'gap')}
                  onSet={(n) => onApplyEnum(`gap-${n}`, { gap: `${n * SPACING_REM}rem` })}
                />
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

            <ColorControls
              currentClass={currentClass}
              onApplyEnum={onApplyEnum}
              computed={{
                color: selection?.signature.computedColor,
                'background-color': selection?.signature.computedBackgroundColor,
              }}
            />

            <div className="ss-edit-panel__classes" title={currentClass}>
              {currentClass}
            </div>
          </>
        )}
      </div>

      {resolution?.status === 'resolved' && (
        <div className="ss-edit-panel__footer">
          {dirty ? (
            <Button size="sm" variant="primary" block onClick={onCommit}>
              Save to source
            </Button>
          ) : (
            <div className="ss-edit-panel__saved" aria-live="polite">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Saved
            </div>
          )}
        </div>
      )}
    </div>
  );
}
