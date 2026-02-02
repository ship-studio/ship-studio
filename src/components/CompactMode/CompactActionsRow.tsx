/**
 * Compact Mode Actions Row - Row 2 of compact mode UI.
 *
 * Contains icon-only action buttons:
 * - Health status indicator (colored dot) + restart
 * - Assets button
 * - .env button
 * - Create Repo button (if not connected)
 * - Branch indicator
 * - PR status indicator
 * - Publish button
 *
 * @module components/CompactMode/CompactActionsRow
 */

import {
  ResetIcon,
  ImageIcon,
  BranchIcon,
  PullRequestIcon,
  GitHubIcon,
  UploadIcon,
} from '../icons';

export interface CompactActionsRowProps {
  /** Dev server health status */
  serverHealth: 'healthy' | 'unhealthy' | 'starting';
  /** Current git branch name */
  currentBranch: string | null;
  /** Whether there are uncommitted changes */
  hasUncommittedChanges: boolean;
  /** PR status for current branch */
  prStatus: 'none' | 'open' | 'merged' | 'closed';
  /** GitHub connection status */
  isGitHubConnected: boolean;
  /** Callback to restart dev server */
  onRestartServer: () => void;
  /** Callback to open assets panel */
  onOpenAssets: () => void;
  /** Callback to open .env editor */
  onOpenEnvEditor: () => void;
  /** Callback to open create repo modal */
  onCreateRepo: () => void;
  /** Callback to switch branch */
  onSwitchBranch: () => void;
  /** Callback to create PR */
  onCreatePR: () => void;
  /** Callback to publish */
  onPublish: () => void;
}

export function CompactActionsRow({
  serverHealth,
  currentBranch,
  hasUncommittedChanges,
  prStatus,
  isGitHubConnected,
  onRestartServer,
  onOpenAssets,
  onOpenEnvEditor,
  onCreateRepo,
  onSwitchBranch,
  onCreatePR,
  onPublish,
}: CompactActionsRowProps) {
  // Check if on main/production branch
  const isMainBranch = currentBranch === 'main' || currentBranch === 'master';

  // Health indicator color
  const healthColor =
    serverHealth === 'healthy' ? '#4ecdc4' : serverHealth === 'starting' ? '#f0a000' : '#f44747';

  // PR status indicator
  const getPrStatusIndicator = () => {
    switch (prStatus) {
      case 'open':
        return <span className="compact-pr-badge open">PR</span>;
      case 'merged':
        return <span className="compact-pr-badge merged">Merged</span>;
      case 'closed':
        return <span className="compact-pr-badge closed">Closed</span>;
      default:
        return null;
    }
  };

  return (
    <div className="compact-actions-row">
      {/* Left side - Action buttons */}
      <div className="compact-actions-left">
        {/* Server Health & Restart */}
        <button
          className="compact-action-btn"
          onClick={onRestartServer}
          title={`Server: ${serverHealth} - Click to restart`}
          aria-label={`Restart server (currently ${serverHealth})`}
        >
          <span className="compact-health-dot" style={{ backgroundColor: healthColor }} />
          <ResetIcon size={12} />
        </button>

        {/* Assets */}
        <button
          className="compact-action-btn"
          onClick={onOpenAssets}
          title="Assets"
          aria-label="Assets"
        >
          <ImageIcon size={14} />
        </button>

        {/* .env */}
        <button
          className="compact-action-btn"
          onClick={onOpenEnvEditor}
          title="Environment Variables"
          aria-label="Environment Variables"
        >
          <span className="compact-env-icon">$</span>
        </button>

        {/* Create Repo (if not connected) */}
        {!isGitHubConnected && (
          <button
            className="compact-action-btn"
            onClick={onCreateRepo}
            title="Create Repository"
            aria-label="Create Repository"
          >
            <GitHubIcon size={14} />
          </button>
        )}

        {/* Divider */}
        <div className="compact-actions-divider" />

        {/* Branch */}
        <button
          className={`compact-action-btn compact-branch-btn ${isMainBranch ? 'main-branch' : ''}`}
          onClick={onSwitchBranch}
          title={`Branch: ${currentBranch || 'main'}`}
        >
          <BranchIcon size={12} />
          <span className="compact-branch-name">{currentBranch || 'main'}</span>
          {isMainBranch && <span className="compact-live-badge">Live</span>}
          {hasUncommittedChanges && <span className="compact-unsaved-dot" />}
        </button>

        {/* PR Status */}
        {prStatus !== 'none' ? (
          <button
            className="compact-action-btn"
            onClick={onCreatePR}
            title="Pull Request"
            aria-label="Pull Request"
          >
            <PullRequestIcon size={12} />
            {getPrStatusIndicator()}
          </button>
        ) : isGitHubConnected ? (
          <button
            className="compact-action-btn"
            onClick={onCreatePR}
            title="Create Pull Request"
            aria-label="Create Pull Request"
          >
            <PullRequestIcon size={12} />
          </button>
        ) : null}
      </div>

      {/* Right side - Publish only */}
      <div className="compact-actions-right">
        <button
          className="compact-action-btn compact-publish-btn"
          onClick={onPublish}
          title="Publish"
          aria-label="Publish"
        >
          <UploadIcon size={12} />
        </button>
      </div>
    </div>
  );
}
