/**
 * Dismissible warning banner shown when editing the main branch.
 *
 * Displayed below the workspace header to warn users they're editing
 * the production branch directly. Can be dismissed for the session,
 * or permanently hidden for the project via checkbox.
 *
 * @module components/MainBranchBanner
 */

import { useState, useEffect } from 'react';
import { WarningIcon, CloseIcon, BranchIcon } from '../icons';
import { getHideMainBranchWarning, setHideMainBranchWarning } from '../../lib/project';
import '../../styles/features/main-branch-banner.css';

interface MainBranchBannerProps {
  /** Absolute path to the project directory */
  projectPath: string;
  /** Callback to create a new branch */
  onCreateBranch?: () => void;
}

export function MainBranchBanner({ projectPath, onCreateBranch }: MainBranchBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [shouldHide, setShouldHide] = useState<boolean | null>(null);
  const [hideForProject, setHideForProject] = useState(false);

  // Load persisted preference on mount
  useEffect(() => {
    getHideMainBranchWarning(projectPath)
      .then(setShouldHide)
      .catch(() => setShouldHide(false));
  }, [projectPath]);

  // Still loading preference
  if (shouldHide === null) {
    return null;
  }

  // Permanently hidden for this project
  if (shouldHide) {
    return null;
  }

  // Dismissed for current session
  if (isDismissed) {
    return null;
  }

  const handleDismiss = () => {
    if (hideForProject) {
      // Save preference to persist across sessions
      void setHideMainBranchWarning(projectPath, true);
    }
    setIsDismissed(true);
  };

  return (
    <div className="main-branch-banner">
      <div className="main-branch-banner-content">
        <WarningIcon size={16} />
        <span className="main-branch-banner-text">
          You're editing <strong>main</strong> directly.
          <span className="main-branch-banner-text-extra">
            {' '}
            Changes will go live immediately when published.
          </span>
        </span>
        {onCreateBranch && (
          <button className="main-branch-banner-action" onClick={onCreateBranch}>
            <BranchIcon size={12} />
            Create branch
          </button>
        )}
      </div>
      <label className="main-branch-banner-checkbox">
        <input
          type="checkbox"
          checked={hideForProject}
          onChange={(e) => setHideForProject(e.target.checked)}
        />
        <span>Don't show again</span>
      </label>
      <button className="main-branch-banner-close" onClick={handleDismiss} title="Dismiss">
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
