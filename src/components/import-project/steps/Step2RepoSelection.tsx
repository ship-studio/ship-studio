/**
 * Step2RepoSelection — second wizard step for ImportProject. Shows a
 * searchable list of GitHub repositories from the selected owner.
 *
 * @module components/import-project/steps/Step2RepoSelection
 */

import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import type { GitHubRepo } from '../../../lib/github';

export interface Step2RepoSelectionProps {
  selectedOwner: string | null;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  loadingRepos: boolean;
  filteredRepos: GitHubRepo[];
  selectedRepo: GitHubRepo | null;
  onRepoSelect: (repo: GitHubRepo) => void;
  error: string | null;
  onBack: () => void;
  onImport: () => void;
  onCancel: () => void;
}

export function Step2RepoSelection({
  selectedOwner,
  searchQuery,
  onSearchChange,
  loadingRepos,
  filteredRepos,
  selectedRepo,
  onRepoSelect,
  error,
  onBack,
  onImport,
  onCancel,
}: Step2RepoSelectionProps) {
  return (
    <div className="create-modal-content import-repo-step">
      <div className="create-modal-header">
        <div>
          <h2>Import Project</h2>
          <p className="template-context">
            {selectedOwner === '__collaborator__' ? (
              <>Repos shared with you</>
            ) : (
              <>
                From <strong>{selectedOwner}</strong>
              </>
            )}
          </p>
        </div>
        <button
          className="create-modal-close"
          onClick={onCancel}
          type="button"
          title="Close"
          aria-label="Close"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="import-search">
        <input
          type="text"
          placeholder="Search repositories..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>

      <div className="import-repo-list">
        {loadingRepos ? (
          <div className="import-repo-loading">
            <Spinner style={{ color: 'var(--text-primary)' }} />
            <span>Loading repositories...</span>
          </div>
        ) : filteredRepos.length === 0 ? (
          <div className="import-repo-empty">
            {searchQuery ? (
              <p>No repositories found matching "{searchQuery}"</p>
            ) : (
              <p>No repositories found</p>
            )}
          </div>
        ) : (
          filteredRepos.map((repo) => (
            <button
              key={repo.name}
              className={`import-repo-item ${selectedRepo?.name === repo.name ? 'selected' : ''}`}
              onClick={() => onRepoSelect(repo)}
            >
              <div className="import-repo-header">
                <span className="import-repo-name">{repo.name}</span>
                {repo.isPrivate && <span className="import-repo-badge private">Private</span>}
                {repo.primaryLanguage && (
                  <span className="import-repo-badge lang">{repo.primaryLanguage.name}</span>
                )}
              </div>
              {repo.description && <p className="import-repo-description">{repo.description}</p>}
            </button>
          ))
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="create-actions">
        <Button variant="secondary" type="button" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" type="button" disabled={!selectedRepo} onClick={onImport}>
          Import Project
        </Button>
      </div>
    </div>
  );
}
