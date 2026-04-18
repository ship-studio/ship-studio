import { useEffect, useMemo, useState } from 'react';
import { ModalFrame } from './primitives/ModalFrame';
import { listProjects } from '../lib/project';
import { logger } from '../lib/logger';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectProject: (projectPath: string) => void;
  currentProjectPath: string | null;
}

function initials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '··';
  const parts = cleaned.split(/[\s\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

export function ProjectPickerModal({
  isOpen,
  onClose,
  onSelectProject,
  currentProjectPath,
}: Props) {
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err) => {
        logger.error('[ProjectPickerModal] Failed to list projects', { error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, filter]);

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title="Open a project"
      className="project-picker-modal"
      ariaLabel="Open a project"
    >
      <div className="project-picker-body">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search projects..."
          className="project-picker-search"
          autoFocus
          spellCheck={false}
        />
        <ul className="project-picker-list">
          {filtered.length === 0 ? (
            <li className="project-picker-empty">
              {projects.length === 0 ? 'Loading projects…' : 'No matches'}
            </li>
          ) : (
            filtered.map((p) => {
              const isCurrent = p.path === currentProjectPath;
              return (
                <li key={p.path}>
                  <button
                    type="button"
                    className="project-picker-item"
                    onClick={() => {
                      onClose();
                      if (!isCurrent) onSelectProject(p.path);
                    }}
                  >
                    <span className="project-picker-item-initials" aria-hidden="true">
                      {initials(p.name)}
                    </span>
                    <span className="project-picker-item-name" title={p.name}>
                      {p.name}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </ModalFrame>
  );
}
