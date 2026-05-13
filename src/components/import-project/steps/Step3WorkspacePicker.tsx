/**
 * Step3WorkspacePicker — shown between clone and install when the imported
 * repo is a monorepo. Lets the user pick which app the project will focus on.
 * The choice is locked for the project's lifetime — to work on another app
 * from the same repo, the user re-imports it.
 *
 * @module components/import-project/steps/Step3WorkspacePicker
 */

import { Button } from '../../primitives/Button';
import type { WorkspaceInfo } from '../../../lib/project';

export interface Step3WorkspacePickerProps {
  repoName: string;
  workspaces: WorkspaceInfo[];
  selectedSubpath: string | null;
  onSelect: (subpath: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Step3WorkspacePicker({
  repoName,
  workspaces,
  selectedSubpath,
  onSelect,
  onConfirm,
  onCancel,
}: Step3WorkspacePickerProps) {
  return (
    <div className="create-modal-content import-repo-step">
      <div className="create-modal-header">
        <div>
          <h2>Pick a workspace</h2>
          <p className="template-context">
            <strong>{repoName}</strong> is a monorepo. Choose the app you want to focus on — this
            choice is locked once you import. To work on another app from the same repo, import it
            again.
          </p>
        </div>
      </div>

      <div className="workspace-picker-list">
        {workspaces.map((ws) => {
          const isSelected = ws.relativePath === selectedSubpath;
          return (
            <button
              key={ws.relativePath}
              type="button"
              className={`workspace-picker-item${isSelected ? ' selected' : ''}`}
              onClick={() => onSelect(ws.relativePath)}
            >
              <div className="workspace-picker-item-main">
                <div className="workspace-picker-item-name">{ws.name}</div>
                <div className="workspace-picker-item-path">{ws.relativePath}</div>
              </div>
              <div className="workspace-picker-item-meta">
                {ws.devScript && (
                  <code className="workspace-picker-item-script">{ws.devScript}</code>
                )}
                {ws.portHint !== null && (
                  <span className="workspace-picker-item-port">:{ws.portHint}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="create-modal-footer">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={!selectedSubpath}>
          Continue
        </Button>
      </div>
    </div>
  );
}
