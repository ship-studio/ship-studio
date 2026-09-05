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
import { DuplicateIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { Spinner } from '../primitives/Spinner';
import { InsertMenu } from './InsertMenu';
import { getElementIcon } from './element-icons';
import {
  STRUCTURAL_ELEMENTS,
  VOID_ELEMENTS,
  type ElementKind,
  type InsertPosition,
} from '../../lib/edit-structure';
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

const TOOLBAR_W = 260;
const TOOLBAR_H = 30;
const GAP = 3;

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
  // <html>/<head>/<body> ARE the page — the backend refuses to duplicate,
  // delete, or insert beside them, so don't offer it (issues #723/#740).
  const structural = STRUCTURAL_ELEMENTS.has(selection.signature.tagName);
  const structuralTitle = `<${selection.signature.tagName}> is part of the page itself`;
  const tagName = selection.signature.tagName.toLowerCase();
  const elementIcon = getElementIcon(tagName);
  const firstClass = selection.signature.className.split(/\s+/).find(Boolean);
  const selector = firstClass ? `.${firstClass}` : null;
  const selectionLabel = selector ? `${tagName} ${selector}` : tagName;

  return (
    <>
      <div className="ss-el-toolbar" style={{ top, left }} data-testid="element-toolbar">
        <div
          className="ss-el-toolbar__selection"
          role="group"
          aria-label={`Selected element: ${selectionLabel}`}
        >
          {elementIcon ? (
            <span className="ss-el-toolbar__tag-icon" title={`<${tagName}>`}>
              {elementIcon}
            </span>
          ) : (
            <span className="ss-el-toolbar__tag">{tagName}</span>
          )}
          {selector && <span className="ss-el-toolbar__selector">{selector}</span>}
        </div>
        {busy ? (
          <div className="ss-el-toolbar__actions" role="group" aria-label="Element actions">
            <span className="ss-el-toolbar__busy">
              <Spinner size="sm" />
            </span>
          </div>
        ) : (
          <div className="ss-el-toolbar__actions" role="group" aria-label="Element actions">
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
              <PlusIcon size={12} className="ss-el-toolbar__control-icon" />
            </button>
            <button
              type="button"
              className="ss-el-toolbar__btn"
              aria-label="Duplicate element"
              title={structural ? structuralTitle : 'Duplicate element'}
              disabled={structural}
              onClick={onDuplicate}
            >
              <DuplicateIcon size={12} className="ss-el-toolbar__control-icon" />
            </button>
            <button
              type="button"
              className="ss-el-toolbar__btn ss-el-toolbar__btn--danger"
              aria-label="Delete element"
              title={structural ? structuralTitle : 'Delete element'}
              disabled={structural}
              onClick={onDelete}
            >
              <TrashIcon size={12} className="ss-el-toolbar__control-icon" />
            </button>
          </div>
        )}
      </div>
      <InsertMenu
        anchor={menuAnchor}
        insideDisabled={insideDisabled}
        outsideDisabled={structural}
        onInsert={onInsert}
        onClose={() => setMenuAnchor(null)}
      />
    </>
  );
}
