import { useEffect, useRef } from 'react';
import type { Project } from '../lib/project';
import { sessionRegistry } from '../lib/sessionRegistry';
import { useModal } from '../contexts/ModalContext';
import { basename } from '../lib/paths';

interface Params {
  /** Pinned-row paths, in sidebar order. */
  pinnedPaths: string[];
  /** Project-open handler, same as the one the sidebar uses. */
  handleSelectProject: (project: Project) => void | Promise<void>;
}

/**
 * Global Cmd/Ctrl+1..9 shortcuts to jump to the Nth project in the
 * sidebar's effective order: pinned rows first, then active sessions
 * (deduped against pinned, sorted by path — matches `WorkspaceSidebar`).
 *
 * The ordering is read fresh on each keystroke from a ref + the session
 * registry, so pin changes / new active sessions are reflected without
 * re-registering the listener.
 */
export function useProjectNumberShortcuts({ pinnedPaths, handleSelectProject }: Params): void {
  const palette = useModal('commandPalette');
  const latest = useRef({ pinnedPaths, handleSelectProject, closePalette: palette.close });

  useEffect(() => {
    latest.current = { pinnedPaths, handleSelectProject, closePalette: palette.close };
  }, [pinnedPaths, handleSelectProject, palette.close]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key.length !== 1 || e.key < '1' || e.key > '9') return;

      const index = parseInt(e.key, 10) - 1;
      const { pinnedPaths: pins, handleSelectProject: open, closePalette } = latest.current;

      const pinSet = new Set(pins);
      const activePaths = sessionRegistry
        .snapshotAll()
        .map((s) => s.projectPath)
        .filter((p) => !pinSet.has(p))
        .sort((a, b) => a.localeCompare(b));

      const ordered = [...pins, ...activePaths];
      const path = ordered[index];
      if (!path) return;

      e.preventDefault();
      e.stopPropagation();
      closePalette();
      const name = basename(path) || 'Project';
      void open({ name, path, thumbnail: null });
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, []);
}
