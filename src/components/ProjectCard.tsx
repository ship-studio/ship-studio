/**
 * ProjectCard component that displays a single project in the dashboard grid.
 *
 * Shows project thumbnail (or placeholder), name, git branch, uncommitted changes
 * count, and deployment status. Provides hover actions for opening the live site
 * or launching in an IDE.
 *
 * @module components/ProjectCard
 */

import { DashboardProject } from '../lib/project';
import { BranchIcon, ExternalLinkIcon, CodeIcon } from './icons';

/** Props for the ProjectCard component */
interface ProjectCardProps {
  /** Project data including name, path, git info, and deployment URLs */
  project: DashboardProject;
  /** Base64-encoded thumbnail image (or null for placeholder) */
  thumbnailData: string | null;
  /** Callback when the card is clicked to open the project */
  onSelect: () => void;
  /** Callback when delete button is clicked */
  onDelete: () => void;
  /** Callback to open the production URL in browser (if deployed) */
  onOpenSite?: () => void;
  /** Callback to open the project in VS Code or Cursor */
  onOpenIde?: () => void;
}

export function ProjectCard({
  project,
  thumbnailData,
  onSelect,
  onDelete,
  onOpenSite,
  onOpenIde,
}: ProjectCardProps) {
  const hasChanges = project.uncommitted_count !== null && project.uncommitted_count > 0;

  return (
    <div className="project-card">
      <div
        className="project-card-thumbnail"
        onClick={onSelect}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        {thumbnailData ? (
          <img src={thumbnailData} alt={project.name} />
        ) : (
          <div className="project-card-placeholder">
            <span>No preview</span>
          </div>
        )}
        {/* Hover actions overlay */}
        <div className="project-card-overlay">
          <div className="project-card-quick-actions">
            {project.production_url && onOpenSite && (
              <button
                className="quick-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSite();
                }}
                title="Open live site"
              >
                <ExternalLinkIcon size={16} />
              </button>
            )}
            {onOpenIde && (
              <button
                className="quick-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenIde();
                }}
                title="Open in IDE"
              >
                <CodeIcon size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="project-card-info">
        <div className="project-card-details">
          <span className="project-card-name">{project.name}</span>
          <div className="project-card-meta">
            {project.git_branch && (
              <span className="project-card-branch">
                <BranchIcon />
                <span className="project-card-branch-name">{project.git_branch}</span>
              </span>
            )}
            {hasChanges && (
              <span className="project-card-changes">{project.uncommitted_count} uncommitted</span>
            )}
          </div>
          <div className="project-card-deployment">
            {project.deployment_state ? (
              <>
                <span className={`status-dot status-${project.deployment_state.toLowerCase()}`} />
                {project.production_url ? (
                  <span className="project-card-url">{formatUrl(project.production_url)}</span>
                ) : (
                  <span className="project-card-deploy-time">{project.last_deployed}</span>
                )}
              </>
            ) : (
              <span className="project-card-not-deployed">Not deployed</span>
            )}
          </div>
        </div>
        <button
          className="project-card-menu"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete project"
        >
          &bull;&bull;&bull;
        </button>
      </div>
    </div>
  );
}

function formatUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
