/**
 * Control label carrying the value-provenance states — Webflow-style:
 *  - set at the ACTIVE breakpoint → blue, clickable; a floating "Reset" pops up
 *    beside the cursor and clears the value back to its inherited/default state.
 *  - inherited from an ANCESTOR element's styles → orange tag, clickable; opens
 *    the provenance popover (where it comes from + "Set here explicitly").
 *  - anything else renders as plain text; a breakpoint-defined-but-lower value
 *    still shows its hollow LayerDot.
 * Floating (not inline) so it never shifts the control row's layout.
 */

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { InheritancePopover } from './InheritancePopover';
import { LayerDot } from './LayerDot';
import { type Breakpoint, type InheritedProp } from '../../lib/edit';

interface Props {
  label: string;
  /** Where the effective value came from (from readLayer). */
  definedAt: Breakpoint | null;
  /** The breakpoint currently being edited. */
  active: Breakpoint;
  /** Clear the value at the active breakpoint. */
  onReset: () => void;
  /** Ancestor-defined effective value feeding this control — only passed when
   *  nothing is set on the element itself across the cascade ≤ active bp. */
  inherited?: InheritedProp | null;
  /** Adopt the inherited value as a local utility on this element. */
  onAdopt?: () => void;
  /** Panel context for the provenance popover's source resolution/jump. */
  projectPath?: string;
  onOpenInCode?: (file: string, line: number) => void;
}

export function ResettableLabel({
  label,
  definedAt,
  active,
  onReset,
  inherited = null,
  onAdopt,
  projectPath,
  onOpenInCode,
}: Props) {
  // Resettable only when the value is set ON THIS breakpoint (a solid LayerDot).
  const setHere = definedAt !== null && definedAt.name === active.name;
  const [pop, setPop] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Dismiss any open popover on outside click / Escape / scroll.
  useDismissOnOutsidePointer(pop !== null, popRef, () => setPop(null), {
    isOutside: (t) =>
      !popRef.current?.contains(t) && !cardRef.current?.contains(t) && !btnRef.current?.contains(t),
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

  if (!setHere && !(inherited && onAdopt !== undefined)) {
    // Plain / breakpoint-inherited (hollow dot only — orange is reserved for
    // ancestor-inherited values).
    return (
      <span className="ss-edit-panel__label">
        {label}
        <LayerDot definedAt={definedAt} active={active} />
      </span>
    );
  }

  // Open a popover just to the lower-right of the cursor, clamped on-screen.
  const openAt = (e: ReactMouseEvent) => {
    const M = 8;
    const left = Math.min(e.clientX + 10, window.innerWidth - 240 - M);
    const top = Math.min(e.clientY + 10, window.innerHeight - 200 - M);
    setPop({ top, left });
  };

  if (inherited && onAdopt !== undefined) {
    return (
      <span className="ss-edit-panel__label ss-edit-panel__label--resettable ss-edit-panel__label--inherited">
        <button
          ref={btnRef}
          type="button"
          className="ss-edit-panel__labelbtn"
          aria-expanded={pop !== null}
          onClick={openAt}
          title={`Inherited from <${inherited.tagName} class="${inherited.className.split(/\s+/)[0] ?? ''}"> — click for details`}
        >
          {label}
        </button>
        {pop &&
          projectPath &&
          createPortal(
            <div
              ref={cardRef}
              className="ss-inherit-pop__anchor"
              style={{ top: pop.top, left: pop.left }}
            >
              <InheritancePopover
                inherited={inherited}
                projectPath={projectPath}
                onAdopt={onAdopt}
                onOpenInCode={onOpenInCode}
                onClose={() => setPop(null)}
              />
            </div>,
            document.body
          )}
      </span>
    );
  }

  return (
    <span className="ss-edit-panel__label ss-edit-panel__label--resettable ss-edit-panel__label--modified">
      <button
        ref={btnRef}
        type="button"
        className="ss-edit-panel__labelbtn"
        aria-expanded={pop !== null}
        onClick={(e) => {
          if (e.altKey) {
            onReset();
            return;
          }
          openAt(e);
        }}
        title={`Set on ${active.name} — click to reset, Alt-click to reset immediately`}
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
