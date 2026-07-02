/**
 * Floating structural-edit toolbar — + (insert) / duplicate / delete — attached
 * to the canvas selection box. Host-side (rendered inside the preview iframe
 * wrapper, absolutely positioned from the selection rect the iframe reports via
 * `ss:select` / `ss:selRect`), so the insert palette is a real React menu with
 * house primitives instead of in-iframe imperative DOM.
 *
 * Hidden while inline text editing is active (it would cover the formatting
 * bubble) and while there's no selection.
 */

import { useEffect, useRef, useState } from 'react';
import { PlusIcon, CopyIcon, TrashIcon } from '../icons';
import { Spinner } from '../primitives/Spinner';
import { InsertMenu } from './InsertMenu';
import { VOID_ELEMENTS, type ElementKind, type InsertPosition } from '../../lib/edit-structure';
import type { StructureSelection } from '../../hooks/useElementStructure';

interface Props {
  selection: StructureSelection | null;
  /** The iframe wrapper's size — the coordinate space of the selection rect. */
  bounds: { w: number; h: number } | null;
  busy: boolean;
  /** True while inline text editing is active. */
  hidden: boolean;
  onInsert: (position: InsertPosition, kind: ElementKind) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Imperative opener for the Cmd+K "Insert element…" command. */
  openMenuRef?: React.MutableRefObject<(() => void) | null>;
}

const TOOLBAR_W = 104;
const TOOLBAR_H = 30;
const GAP = 6;

export function ElementToolbar({
  selection,
  bounds,
  busy,
  hidden,
  onInsert,
  onDuplicate,
  onDelete,
  openMenuRef,
}: Props) {
  const [menuAnchor, setMenuAnchor] = useState<{
    left: number;
    top: number;
    bottom: number;
  } | null>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  // Cmd+K "Insert element…" opens the palette on the current selection — an
  // imperative handle so the command is a plain event (no nonce/effect dance).
  useEffect(() => {
    if (!openMenuRef) return;
    openMenuRef.current = () => {
      const r = plusRef.current?.getBoundingClientRect();
      if (r) setMenuAnchor({ left: r.left, top: r.top, bottom: r.bottom });
    };
    return () => {
      openMenuRef.current = null;
    };
  }, [openMenuRef]);

  // A new selection moves the toolbar out from under an open palette — close it
  // (render-time state adjustment, the sanctioned "derive from prop change" pattern).
  const sigKey = selection ? `${selection.signature.tagName}|${selection.signature.className}` : '';
  const [lastSigKey, setLastSigKey] = useState(sigKey);
  if (sigKey !== lastSigKey) {
    setLastSigKey(sigKey);
    setMenuAnchor(null);
  }

  const rect = selection?.rect;
  if (!selection || !rect || hidden) return null;

  // Above the selection box; below it when there's no headroom. Clamped to the
  // wrapper so it never escapes the preview area.
  const maxLeft = (bounds?.w ?? Infinity) - TOOLBAR_W - 4;
  const maxTop = (bounds?.h ?? Infinity) - TOOLBAR_H - 4;
  const above = rect.top >= TOOLBAR_H + GAP + 4;
  const top = Math.max(
    4,
    Math.min(above ? rect.top - TOOLBAR_H - GAP : rect.top + rect.height + GAP, maxTop)
  );
  const left = Math.max(4, Math.min(rect.left, maxLeft));

  const insideDisabled = VOID_ELEMENTS.has(selection.signature.tagName);

  return (
    <>
      <div className="ss-el-toolbar" style={{ top, left }} data-testid="element-toolbar">
        {busy ? (
          <span className="ss-el-toolbar__busy">
            <Spinner size="sm" />
          </span>
        ) : (
          <>
            <button
              ref={plusRef}
              type="button"
              className="ss-el-toolbar__btn"
              aria-label="Insert element"
              title="Insert element"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAnchor((open) =>
                  open ? null : { left: r.left, top: r.top, bottom: r.bottom }
                );
              }}
            >
              <PlusIcon size={13} />
            </button>
            <button
              type="button"
              className="ss-el-toolbar__btn"
              aria-label="Duplicate element"
              title="Duplicate element"
              onClick={onDuplicate}
            >
              <CopyIcon size={12} />
            </button>
            <button
              type="button"
              className="ss-el-toolbar__btn ss-el-toolbar__btn--danger"
              aria-label="Delete element"
              title="Delete element"
              onClick={onDelete}
            >
              <TrashIcon size={12} />
            </button>
          </>
        )}
      </div>
      <InsertMenu
        anchor={menuAnchor}
        insideDisabled={insideDisabled}
        onInsert={onInsert}
        onClose={() => setMenuAnchor(null)}
      />
    </>
  );
}
