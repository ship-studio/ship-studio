/**
 * Step1AccountSelection — first wizard step for ImportProject. Shows the
 * list of GitHub accounts (personal, orgs, collaborator access) for the
 * user to select one.
 *
 * @module components/import-project/steps/Step1AccountSelection
 */

import { Button } from '../../primitives/Button';
import { CloseIcon, CollaboratorsIcon } from '@/components/icons';

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
          <CloseIcon size={20} />
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
            <CollaboratorsIcon size={16} />
          </div>
          <div className="import-owner-info">
            <span className="import-owner-name">Collaborator Access</span>
            <span className="import-owner-type">Repos shared with you</span>
          </div>
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="create-actions">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
