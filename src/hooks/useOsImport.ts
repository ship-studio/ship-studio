/**
 * OS file-import drag-and-drop for the code-browser file tree.
 *
 * Subscribes to Tauri's webview drag-drop event (files dragged from Finder /
 * the desktop), hit-tests the drop position to a folder inside the tree's
 * `[data-os-drop-zone]` region (drop-on-file → its parent, empty space → root),
 * highlights that folder while dragging, and hands the absolute OS paths to
 * `onImport`. Drops that land outside the zone are ignored here so the
 * terminal's paste-on-drop can handle them instead.
 *
 * @module hooks/useOsImport
 */

import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { cssCandidatesForDrop, type PhysicalPosition } from '../lib/osDrop';
import { parentDir } from './useTreeDnd';

interface UseOsImportArgs {
  /** The `data-os-drop-zone` identifier marking the file-tree container. */
  zone: string;
  /** When false, the listener is not attached. */
  enabled?: boolean;
  /** Copy `paths` (absolute OS paths) into `toDir` (project-relative; `''` = root). */
  onImport: (paths: string[], toDir: string) => void;
}

export interface OsImport {
  /** Target folder under the OS-drag cursor (`''` = root), or null when off-zone. */
  dropTargetDir: string | null;
}

export function useOsImport({ zone, enabled = true, onImport }: UseOsImportArgs): OsImport {
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  // Keep the latest onImport in a ref so the subscription effect doesn't need to
  // re-attach the webview listener every time the callback identity changes.
  const onImportRef = useRef(onImport);
  useEffect(() => {
    onImportRef.current = onImport;
  }, [onImport]);

  useEffect(() => {
    if (!enabled) {
      // Drop any lingering highlight so a disable transition (e.g. a search
      // filter going active) doesn't leave a stale drop target visible.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset transient UI state when the listener is disabled
      setDropTargetDir(null);
      return;
    }

    // Resolve a physical drop position to the target folder, or null when the
    // point is not inside *our* drop zone. The drop position's coordinate space
    // differs by platform (logical on macOS, physical on Windows), so we try
    // each candidate CSS point and use the first that lands inside our zone.
    const resolveTarget = (pos: PhysicalPosition): string | null => {
      for (const c of cssCandidatesForDrop(pos)) {
        const el = document.elementFromPoint(c.x, c.y);
        const zoneEl = el?.closest<HTMLElement>('[data-os-drop-zone]');
        if (!zoneEl || zoneEl.dataset.osDropZone !== zone) continue;
        const row = el?.closest<HTMLElement>('[data-tree-path]');
        const path = row?.dataset.treePath;
        if (path != null) return row?.dataset.treeDir === '1' ? path : parentDir(path);
        return ''; // over the zone but not on a row → project root
      }
      return null;
    };

    let unlisten: UnlistenFn | null = null;
    let mounted = true;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter' || p.type === 'over') {
          setDropTargetDir(resolveTarget(p.position));
        } else if (p.type === 'drop') {
          const target = resolveTarget(p.position);
          setDropTargetDir(null);
          if (target !== null && p.paths.length > 0) onImportRef.current(p.paths, target);
        } else {
          setDropTargetDir(null); // leave
        }
      })
      .then((fn) => {
        if (mounted) unlisten = fn;
        else fn();
      });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [enabled, zone]);

  return { dropTargetDir };
}
