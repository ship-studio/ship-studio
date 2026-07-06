/**
 * Control label that doubles as a Reset affordance — Webflow-style. When the value
 * is set ON the active breakpoint (not inherited), the label name is clickable; a
 * floating "Reset" button pops up next to the cursor, and clicking it clears the
 * value back to its inherited/default state. Floating (not inline) so it never
 * shifts the control row's layout. Inherited/unset labels render as plain text.
 */

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { LayerDot } from './LayerDot';
import { type Breakpoint } from '../../lib/edit';

interface Props {
  label: string;
  /** Where the effective value came from (from readLayer). */
  definedAt: Breakpoint | null;
  /** The breakpoint currently being edited. */
  active: Breakpoint;
  /** Clear the value at the active breakpoint. */
  onReset: () => void;
}

export function ResettableLabel({ label, definedAt, active, onReset }: Props) {
  // Resettable only when the value is set on THIS breakpoint (a solid LayerDot).
  const setHere = definedAt !== null && definedAt.name === active.name;
  const [pop, setPop] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLButtonElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Dismiss the floating Reset on outside click / Escape / scroll.
  useDismissOnOutsidePointer(pop !== null, popRef, () => setPop(null), {
    isOutside: (t) => !popRef.current?.contains(t) && !btnRef.current?.contains(t),
  });
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPop(null);
    const onScroll = () => setPop(null);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [pop]);

  if (!setHere) {
    return (
      <span className="ss-edit-panel__label">
        {label}
        <LayerDot definedAt={definedAt} active={active} />
      </span>
    );
  }

  // Open the floating Reset just to the lower-right of the cursor, clamped on-screen.
  const openAt = (e: ReactMouseEvent) => {
    const M = 8;
    const W = 72;
    const H = 28;
    const left = Math.min(e.clientX + 10, window.innerWidth - W - M);
    const top = Math.min(e.clientY + 10, window.innerHeight - H - M);
    setPop({ top, left });
  };

  return (
    <span className="ss-edit-panel__label ss-edit-panel__label--resettable">
      <button
        ref={btnRef}
        type="button"
        className="ss-edit-panel__labelbtn"
        aria-expanded={pop !== null}
        onClick={openAt}
        title={`Set on ${active.name} — click to reset`}
      >
        {label}
        <LayerDot definedAt={definedAt} active={active} />
      </button>
      {pop &&
        createPortal(
          <button
            ref={popRef}
            type="button"
            className="ss-reset-pop"
            style={{ top: pop.top, left: pop.left }}
            onClick={() => {
              onReset();
              setPop(null);
            }}
          >
            Reset
          </button>,
          document.body
        )}
    </span>
  );
}
