/**
 * MonorepoPickerModal — shown the first time a monorepo project is opened
 * (whether from GitHub import, local-folder add, or just clicking the card).
 * Asks the user to commit to one app, or to use the repo root. The choice is
 * persisted to `.shipstudio/project.json` so it never re-prompts.
 *
 * Reuses the wizard picker's UI but presents it as a standalone modal so it
 * can fire from the dashboard outside of the import flow.
 *
 * @module components/MonorepoPickerModal
 */

import {
  Step3WorkspacePicker,
  ROOT_PICK,
  type WorkspacePick,
} from './import-project/steps/Step3WorkspacePicker';
import { ModalFrame } from './primitives/ModalFrame';
import type { WorkspaceInfo } from '../lib/project';

interface MonorepoPickerModalProps {
  /** Human-readable project name shown in the header. */
  projectName: string;
  /** Apps discovered by `detect_workspaces`. */
  workspaces: WorkspaceInfo[];
  /** Currently focused option, or null if nothing is selected yet. */
  selectedPick: WorkspacePick | null;
  /** Update which row is highlighted. */
  onSelect: (pick: WorkspacePick) => void;
  /** Commit the current selection. */
  onConfirm: () => void;
  /** Cancel and abort opening the project. */
  onCancel: () => void;
}

export function MonorepoPickerModal({
  projectName,
  workspaces,
  selectedPick,
  onSelect,
  onConfirm,
  onCancel,
}: MonorepoPickerModalProps) {
  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      className="monorepo-picker-modal"
      showCloseButton={false}
      ariaLabel={`Pick a workspace for ${projectName}`}
    >
      <Step3WorkspacePicker
        repoName={projectName}
        workspaces={workspaces}
        selectedPick={selectedPick}
        onSelect={onSelect}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </ModalFrame>
  );
}

export { ROOT_PICK };
export type { WorkspacePick };
