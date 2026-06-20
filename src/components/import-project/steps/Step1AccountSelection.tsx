/**
 * Step1AccountSelection — first wizard step for ImportProject. Shows the
 * list of GitHub accounts (personal, orgs, collaborator access) for the
 * user to select one.
 *
 * @module components/import-project/steps/Step1AccountSelection
 */

export interface Step1AccountSelectionProps {
  username: string | null;
  orgs: string[];
  selectedOwner: string | null;
  error: string | null;
  onOwnerSelect: (owner: string) => void;
  onCancel: () => void;
}

export function Step1AccountSelection({
  username,
  orgs,
  selectedOwner,
  error,
  onOwnerSelect,
  onCancel,
}: Step1AccountSelectionProps) {
  return (
    <div className="create-modal-content">
      <div className="create-modal-header">
        <div>
          <h2>Import Project</h2>
          <p>Select a GitHub account</p>
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

      <div className="import-owner-list">
        {username && (
          <button
            className={`import-owner-btn ${selectedOwner === username ? 'selected' : ''}`}
            onClick={() => onOwnerSelect(username)}
          >
            <div className="import-owner-avatar">{username[0].toUpperCase()}</div>
            <div className="import-owner-info">
              <span className="import-owner-name">{username}</span>
              <span className="import-owner-type">Personal</span>
            </div>
          </button>
        )}
        {orgs.map((org) => (
          <button
            key={org}
            className={`import-owner-btn ${selectedOwner === org ? 'selected' : ''}`}
            onClick={() => onOwnerSelect(org)}
          >
            <div className="import-owner-avatar org">{org[0].toUpperCase()}</div>
            <div className="import-owner-info">
              <span className="import-owner-name">{org}</span>
              <span className="import-owner-type">Organization</span>
            </div>
          </button>
        ))}
        {/* Collaborator repos - repos owned by others where user has access */}
        <button
          className={`import-owner-btn ${selectedOwner === '__collaborator__' ? 'selected' : ''}`}
          onClick={() => onOwnerSelect('__collaborator__')}
        >
          <div className="import-owner-avatar collab">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="import-owner-info">
            <span className="import-owner-name">Collaborator Access</span>
            <span className="import-owner-type">Repos shared with you</span>
          </div>
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="create-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
