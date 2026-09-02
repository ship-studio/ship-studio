/**
 * Context menu for element-tree rows — Insert element…, Duplicate, Delete.
 * Right-clicking a row selects it first (through the normal ss:selectNode
 * path), so every action operates on the row the user aimed at. "Insert…"
 * hands off to the shared InsertMenu at the same spot.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DuplicateIcon, PlusIcon, TrashIcon } from '@/components/icons';

interface Props {
  /** Cursor position (viewport coords); null = closed. */
  pos: { x: number; y: number } | null;
  onInsert: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const MENU_W = 176;

export function ElementTreeContextMenu({ pos, onInsert, onDuplicate, onDelete, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as HTMLElement)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [pos, onClose]);

  if (!pos) return null;

  const left = Math.max(8, Math.min(pos.x, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(pos.y, window.innerHeight - 120));

  const item = (label: string, icon: React.ReactNode, run: () => void, danger = false) => (
    <button
      type="button"
      className={`ss-tree-menu__item${danger ? ' ss-tree-menu__item--danger' : ''}`}
      onClick={() => {
        run();
        onClose();
      }}
    >
      {icon}
      {label}
    </button>
  );

  return createPortal(
    <div
      ref={menuRef}
      className="ss-tree-menu"
      role="menu"
      style={{ position: 'fixed', left, top, width: MENU_W }}
    >
      {item('Insert element…', <PlusIcon size={12} />, onInsert)}
      {item('Duplicate', <DuplicateIcon size={12} />, onDuplicate)}
      {item('Delete', <TrashIcon size={12} />, onDelete, true)}
    </div>,
    document.body
  );
}
