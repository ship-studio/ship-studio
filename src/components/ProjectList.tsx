/**
 * ProjectList component that displays the main dashboard with all projects.
 *
 * This is the home screen of the application, showing:
 * - Grid of project cards with thumbnails and metadata
 * - Search filtering with Cmd+K keyboard shortcut
 * - Sorting options (last opened, name, last deployed)
 * - Integration status bar (GitHub, Vercel, Claude)
 * - Project creation and deletion
 *
 * @module components/ProjectList
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DashboardProject, getDashboardProjects } from '../lib/project';
import { DashboardHeader } from './DashboardHeader';
import { ProjectCard } from './ProjectCard';
import { IntegrationBar } from './IntegrationBar';
import { ChevronIcon, CheckIcon } from './icons';
import { useClickOutside } from '../hooks/useClickOutside';

/** Basic project info for selection callback */
interface Project {
  name: string;
  path: string;
  thumbnail: string | null;
}

/** Dashboard project with loaded thumbnail data */
interface ProjectWithThumbnail extends DashboardProject {
  /** Base64-encoded thumbnail image data */
  thumbnailData: string | null;
}

/** Available sort options for the project list */
type SortOption = 'last_opened' | 'name' | 'last_deployed';

/** Props for the ProjectList component */
interface ProjectListProps {
  /** Callback when a project is selected to open */
  onSelectProject: (project: Project) => void;
  /** Callback to open the create project wizard */
  onCreateProject: () => void;
  /** Callback to open the import project wizard */
  onImportProject?: () => void;
}

export function ProjectList({
  onSelectProject,
  onCreateProject,
  onImportProject,
}: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<DashboardProject | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Search and sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('last_opened');
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  const sortDropdownRef = useRef<HTMLDivElement>(null);

  // Close sort dropdown when clicking outside
  const closeSortDropdown = useCallback(() => setShowSortDropdown(false), []);
  useClickOutside(sortDropdownRef, closeSortDropdown, showSortDropdown);

  const loadProjects = async () => {
    try {
      const projectList = await getDashboardProjects();

      // Load thumbnails for each project
      const projectsWithThumbnails = await Promise.all(
        projectList.map(async (project) => {
          let thumbnailData: string | null = null;
          if (project.thumbnail) {
            try {
              thumbnailData = await invoke<string | null>('get_project_thumbnail', {
                projectPath: project.path,
              });
            } catch (e) {
              console.error('Failed to load thumbnail for', project.name, e);
            }
          }
          return { ...project, thumbnailData };
        })
      );

      setProjects(projectsWithThumbnails);
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  // Filtered and sorted projects
  const filteredProjects = useMemo(() => {
    let result = [...projects];

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'last_deployed':
          // Projects without deployment go last
          if (!a.last_deployed && !b.last_deployed) return a.name.localeCompare(b.name);
          if (!a.last_deployed) return 1;
          if (!b.last_deployed) return -1;
          // Parse relative time for sorting (rough approximation)
          return parseRelativeTime(a.last_deployed) - parseRelativeTime(b.last_deployed);
        case 'last_opened':
        default:
          if (!a.last_opened && !b.last_opened) return a.name.localeCompare(b.name);
          if (!a.last_opened) return 1;
          if (!b.last_opened) return -1;
          return b.last_opened - a.last_opened;
      }
    });

    return result;
  }, [projects, searchQuery, sortBy]);

  const handleDelete = async (project: DashboardProject) => {
    setDeleting(true);
    try {
      await invoke('delete_project', { path: project.path });
      setDeleteConfirm(null);
      await loadProjects();
    } catch (error) {
      console.error('Failed to delete project:', error);
      alert('Failed to delete project: ' + String(error));
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="project-list-loading">
        <div className="spinner" />
        <p>Loading projects...</p>
      </div>
    );
  }

  const sortLabels: Record<SortOption, string> = {
    last_opened: 'Last opened',
    name: 'Name',
    last_deployed: 'Last deployed',
  };

  return (
    <div className="project-list dashboard">
      <DashboardHeader
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onCreateProject={onCreateProject}
        onImportProject={onImportProject}
      />

      <div className="dashboard-section-header">
        <span className="dashboard-section-title">
          Projects {filteredProjects.length > 0 && `(${filteredProjects.length})`}
        </span>
        <div className="dashboard-section-controls">
          <div className="sort-dropdown" ref={sortDropdownRef}>
            <button
              className="sort-dropdown-btn"
              onClick={() => setShowSortDropdown(!showSortDropdown)}
            >
              {sortLabels[sortBy]}
              <ChevronIcon />
            </button>
            {showSortDropdown && (
              <div className="sort-dropdown-menu">
                {(Object.keys(sortLabels) as SortOption[]).map((option) => (
                  <button
                    key={option}
                    className={`sort-dropdown-item ${sortBy === option ? 'active' : ''}`}
                    onClick={() => {
                      setSortBy(option);
                      setShowSortDropdown(false);
                    }}
                  >
                    {sortLabels[option]}
                    {sortBy === option && <CheckIcon />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {filteredProjects.length === 0 ? (
        <div className="project-list-empty">
          {searchQuery ? (
            <>
              <p>No projects found</p>
              <p className="hint">Try a different search term</p>
            </>
          ) : (
            <>
              <p>No projects yet</p>
              <p className="hint">Create your first project to get started</p>
            </>
          )}
        </div>
      ) : (
        <div className="project-grid">
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.path}
              project={project}
              thumbnailData={project.thumbnailData}
              onSelect={() => onSelectProject(project)}
              onDelete={() => setDeleteConfirm(project)}
              onOpenSite={
                project.production_url
                  ? () => {
                      const url = project.production_url!;
                      void openUrl(url.startsWith('http') ? url : `https://${url}`);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      <IntegrationBar />

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Project?</h3>
            <p>
              Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
            </p>
            <p className="hint">This will permanently delete all files in this project.</p>
            <div className="modal-actions">
              <button onClick={() => setDeleteConfirm(null)} disabled={deleting}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => void handleDelete(deleteConfirm)}
                disabled={deleting}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function parseRelativeTime(timeStr: string): number {
  // Parse strings like "2h ago", "3d ago", "5m ago", "just now"
  if (timeStr === 'just now') return 0;
  const match = timeStr.match(/^(\d+)([mhd]) ago$/);
  if (!match) return Infinity;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'm':
      return value;
    case 'h':
      return value * 60;
    case 'd':
      return value * 60 * 24;
    default:
      return Infinity;
  }
}
