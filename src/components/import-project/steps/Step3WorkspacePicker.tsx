/**
 * Step3WorkspacePicker — shown between clone and install when the imported
 * repo is a monorepo. Lets the user pick which app the project will focus on,
 * or opt to use the repo root as-is. Reused inside `MonorepoPickerModal` so
 * the same UI appears on the dashboard when an unconfigured monorepo is
 * opened.
 *
 * The choice is locked for the project's lifetime — to work on another app
 * from the same repo, the user re-imports it.
 *
 * @module components/import-project/steps/Step3WorkspacePicker
 */

import { Button } from '../../primitives/Button';
import { BranchIcon } from '../../icons';
import type { WorkspaceInfo } from '../../../lib/project';

/** What the picker can return. Avoids the old `__root__` magic-string sentinel. */
export type WorkspacePick = { kind: 'root' } | { kind: 'app'; relativePath: string };

export const ROOT_PICK: WorkspacePick = { kind: 'root' };

/** True when the two picks point at the same option. */
export function picksEqual(a: WorkspacePick | null, b: WorkspacePick | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'app' && b.kind === 'app') return a.relativePath === b.relativePath;
  return true;
}

export interface Step3WorkspacePickerProps {
  repoName: string;
  workspaces: WorkspaceInfo[];
  /** Currently focused option, or null if nothing is selected yet. */
  selectedPick: WorkspacePick | null;
  onSelect: (pick: WorkspacePick) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Step3WorkspacePicker({
  repoName,
  workspaces,
  selectedPick,
  onSelect,
  onConfirm,
  onCancel,
}: Step3WorkspacePickerProps) {
  const rootSelected = selectedPick?.kind === 'root';

  return (
    <div className="workspace-picker">
      <div className="workspace-picker-header">
        <h2 className="workspace-picker-title">Pick a workspace</h2>
        <p className="workspace-picker-subtitle">
          <strong>{repoName}</strong> is a monorepo. Pick which app to focus on — the choice is
          locked once you confirm. To work on a different app, re-import the repo.
        </p>
      </div>

      <div className="workspace-picker-list">
        <button
          type="button"
          className={`workspace-picker-item is-root${rootSelected ? ' selected' : ''}`}
          onClick={() => onSelect(ROOT_PICK)}
        >
          <div className="workspace-picker-item-icon">
            <FolderStackIcon />
          </div>
          <div className="workspace-picker-item-text">
            <div className="workspace-picker-item-name">Use the whole repo</div>
            <div className="workspace-picker-item-sub">
              Best for libraries or when a root dev script orchestrates everything
            </div>
          </div>
        </button>

        {workspaces.map((ws) => {
          const isSelected =
            selectedPick?.kind === 'app' && selectedPick.relativePath === ws.relativePath;
          return (
            <button
              key={ws.relativePath}
              type="button"
              className={`workspace-picker-item${isSelected ? ' selected' : ''}`}
              onClick={() => onSelect({ kind: 'app', relativePath: ws.relativePath })}
            >
              <div className="workspace-picker-item-icon">
                <BranchIcon size={14} />
              </div>
              <div className="workspace-picker-item-text">
                <div className="workspace-picker-item-name">{ws.name}</div>
                <div className="workspace-picker-item-sub workspace-picker-item-sub-mono">
                  {ws.relativePath}
                </div>
              </div>
              <div className="workspace-picker-item-meta">
                {ws.devScript && (
                  <code className="workspace-picker-item-script" title={ws.devScript}>
                    {ws.devScript}
                  </code>
                )}
                {ws.portHint !== null && (
                  <span className="workspace-picker-item-port">:{ws.portHint}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="workspace-picker-footer">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={!selectedPick}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function FolderStackIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 16V6a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2Z" />
      <path d="M21 11H8a2 2 0 0 0-2 2v9" />
    </svg>
  );
}
