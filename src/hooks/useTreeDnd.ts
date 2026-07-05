/**
 * Drag-and-drop state for the code-browser file tree (in-tree MOVE).
 *
 * Handles the HTML5 drag-and-drop interactions for relocating a file/folder by
 * dragging it onto another folder: drop target computation (drop-on-file →
 * its parent folder, drop-on-root → project root), validity checks (no-op,
 * self/descendant), the drop-target highlight, and the invalid-drop cursor.
 * The actual move + collision handling is delegated to `onMove`.
 *
 * OS imports (dragging from Finder) come through Tauri's `tauri://drag-drop`
 * event on a separate channel, not this hook — but both reuse the pure
 * {@link parentDir}/{@link isSelfOrDescendant} helpers exported here.
 *
 * @module hooks/useTreeDnd
 */

import { useCallback, useRef, useState } from 'react';

/** Private MIME so in-tree drags are distinguishable from arbitrary drags. */
const TREE_PATH_MIME = 'application/x-shipstudio-tree-path';

/** Parent directory of a project-relative path (`''` for a top-level entry). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * True when `toDir` is `fromPath` itself or one of its descendants — i.e.
 * relocating `fromPath` (a folder) into `toDir` would nest it inside itself.
 * Mirrors the backend `is_self_or_descendant` guard.
 */
export function isSelfOrDescendant(fromPath: string, toDir: string): boolean {
  if (!fromPath) return false;
  return toDir === fromPath || toDir.startsWith(`${fromPath}/`);
}

/** A valid move = not the root, not into itself/a descendant, not a no-op. */
export function isValidMove(fromPath: string, toDir: string): boolean {
  if (!fromPath) return false;
  if (isSelfOrDescendant(fromPath, toDir)) return false;
  if (parentDir(fromPath) === toDir) return false; // already lives there
  return true;
}

interface DropNode {
  path: string;
  isDirectory: boolean;
}

interface UseTreeDndArgs {
  /** Relocate `fromPath` into `toDir` (project-relative; `''` = project root). */
  onMove: (fromPath: string, toDir: string) => void;
  /** When false, dragging is disabled (e.g. while a search filter is active). */
  enabled?: boolean;
}

export interface TreeDnd {
  /** Path currently being dragged (drives the source row's dragging style). */
  draggingPath: string | null;
  /** Effective target folder under the cursor (`''` = root), or null. */
  dropTargetDir: string | null;
  /** True while a drag is in progress. */
  isDragging: boolean;
  onItemDragStart: (e: React.DragEvent, node: DropNode) => void;
  onItemDragOver: (e: React.DragEvent, node: DropNode) => void;
  onItemDrop: (e: React.DragEvent, node: DropNode) => void;
  onItemDragEnd: () => void;
  /** Wire onto the empty space of the tree container for "drop to root". */
  onRootDragOver: (e: React.DragEvent) => void;
  onRootDrop: (e: React.DragEvent) => void;
}

/** The folder a drop on `node` targets: the folder itself, or a file's parent. */
function targetDirFor(node: DropNode): string {
  return node.isDirectory ? node.path : parentDir(node.path);
}

export function useTreeDnd({ onMove, enabled = true }: UseTreeDndArgs): TreeDnd {
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  // Read the dragged path synchronously inside dragover/drop without waiting for
  // a re-render (dataTransfer.getData is unavailable during dragover).
  const draggingPathRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    draggingPathRef.current = null;
    setDraggingPath(null);
    setDropTargetDir(null);
  }, []);

  const onItemDragStart = useCallback(
    (e: React.DragEvent, node: DropNode) => {
      if (!enabled) return;
      draggingPathRef.current = node.path;
      setDraggingPath(node.path);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TREE_PATH_MIME, node.path);
    },
    [enabled]
  );

  const onItemDragOver = useCallback(
    (e: React.DragEvent, node: DropNode) => {
      const from = draggingPathRef.current;
      if (!enabled || !from) return;
      e.stopPropagation(); // don't let the root handler also process this
      const toDir = targetDirFor(node);
      if (isValidMove(from, toDir)) {
        e.preventDefault(); // required to allow the drop
        e.dataTransfer.dropEffect = 'move';
        setDropTargetDir(toDir);
      } else {
        e.dataTransfer.dropEffect = 'none';
        setDropTargetDir(null);
      }
    },
    [enabled]
  );

  const onItemDrop = useCallback(
    (e: React.DragEvent, node: DropNode) => {
      const from = draggingPathRef.current;
      if (!enabled || !from) return;
      e.preventDefault();
      e.stopPropagation();
      const toDir = targetDirFor(node);
      if (isValidMove(from, toDir)) onMove(from, toDir);
      reset();
    },
    [enabled, onMove, reset]
  );

  const onRootDragOver = useCallback(
    (e: React.DragEvent) => {
      const from = draggingPathRef.current;
      if (!enabled || !from) return;
      if (isValidMove(from, '')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropTargetDir('');
      } else {
        e.dataTransfer.dropEffect = 'none';
        setDropTargetDir(null);
      }
    },
    [enabled]
  );

  const onRootDrop = useCallback(
    (e: React.DragEvent) => {
      const from = draggingPathRef.current;
      if (!enabled || !from) return;
      e.preventDefault();
      if (isValidMove(from, '')) onMove(from, '');
      reset();
    },
    [enabled, onMove, reset]
  );

  return {
    draggingPath,
    dropTargetDir,
    isDragging: draggingPath !== null,
    onItemDragStart,
    onItemDragOver,
    onItemDrop,
    onItemDragEnd: reset,
    onRootDragOver,
    onRootDrop,
  };
}
