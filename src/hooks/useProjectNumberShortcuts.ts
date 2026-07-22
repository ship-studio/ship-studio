import { useEffect, useRef } from 'react';
import type { Project } from '../lib/project';
import { sessionRegistry } from '../lib/sessionRegistry';
import { useModal } from '../contexts/ModalContext';
import { basename } from '../lib/paths';
import { familyRootOf, ensureFamilyRoot } from '../lib/worktreeFamilies';

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
      // One entry per repository family (a project and its worktrees are one
      // sidebar row), name-ordered — must mirror WorkspaceSidebar's grouping.
      // Roots come from the shared git-truth cache; kick off resolution for
      // any session path not yet resolved so the ordering converges.
      const snaps = sessionRegistry.snapshotAll();
      for (const s of snaps) ensureFamilyRoot(s.projectPath);
      const seen = new Set<string>();
      const activePaths = snaps
        .map((s) => familyRootOf(s.projectPath))
        .filter((p) => !pinSet.has(p))
        .filter((p) => (seen.has(p) ? false : (seen.add(p), true)))
        .sort((a, b) => (basename(a) || a).localeCompare(basename(b) || b) || a.localeCompare(b));

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
