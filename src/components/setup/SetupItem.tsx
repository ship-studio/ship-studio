/**
 * Individual setup item row in the onboarding checklist.
 *
 * Displays status (ready/missing/in-progress/error/blocked) with
 * appropriate icons and action buttons.
 */

import {
  SetupItem as SetupItemType,
  SetupItemStatus,
  SETUP_PROGRESS_MESSAGES,
  SETUP_TIME_ESTIMATES,
  BREW_PACKAGES,
} from '../../lib/setup';
import { Spinner } from '../primitives/Spinner';

interface SetupItemProps {
  item: SetupItemType;
  /** Names of items blocking this one */
  blockedBy?: string[];
  /** Called when user clicks Install or Connect */
  onAction?: () => void;
  /** Called when user clicks Skip for optional items */
  onSkip?: () => void;
  /** Whether this specific action is currently in progress */
  isActionInProgress?: boolean;
  /** Whether any action across all items is in progress (disables all buttons) */
  isAnyActionInProgress?: boolean;
  /** Whether this item is optional and can be skipped */
  isOptional?: boolean;
}

/** Checkmark icon for ready items */
function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      className="setup-item-icon setup-item-icon-check"
    >
      <circle cx="10" cy="10" r="10" fill="#7FE89A" />
      <path
        d="M6 10l3 3 5-6"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** X icon for error items */
function ErrorIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      className="setup-item-icon setup-item-icon-error"
    >
      <circle cx="10" cy="10" r="10" fill="var(--error)" />
      <path d="M7 7l6 6M13 7l-6 6" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Empty circle for not installed/not authenticated */
function EmptyCircleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      className="setup-item-icon setup-item-icon-empty"
    >
      <circle cx="10" cy="10" r="9" stroke="var(--border)" strokeWidth="2" fill="none" />
    </svg>
  );
}

/** Lock icon for blocked items */
function BlockedIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      className="setup-item-icon setup-item-icon-blocked"
    >
      <circle
        cx="10"
        cy="10"
        r="9"
        stroke="var(--text-muted)"
        strokeWidth="2"
        fill="none"
        strokeDasharray="4 2"
      />
    </svg>
  );
}

function getStatusIcon(status: SetupItemStatus) {
  switch (status) {
    case 'ready':
      return <CheckIcon />;
    case 'error':
      return <ErrorIcon />;
    case 'in_progress':
      return <Spinner style={{ color: 'var(--accent)' }} />;
    case 'blocked':
      return <BlockedIcon />;
    default:
      return <EmptyCircleIcon />;
  }
}

function getActionButton(
  item: SetupItemType,
  blockedBy: string[] | undefined,
  onAction: (() => void) | undefined,
  onSkip: (() => void) | undefined,
  isAnyActionInProgress: boolean | undefined,
  isOptional: boolean | undefined
): React.ReactNode {
  // Ready items show version/username
  if (item.status === 'ready') {
    const info = item.username || item.version;
    if (info) {
      return <span className="setup-item-info">{info}</span>;
    }
    return null;
  }

  // Blocked items: frame as "becomes available", not "stuck". "Unlocks" reads
  // correctly for both install items and connect/auth items (which don't install).
  if (item.status === 'blocked' && blockedBy && blockedBy.length > 0) {
    return <span className="setup-item-blocked-text">Unlocks after {blockedBy[0]}</span>;
  }

  // In-progress items show the progress message
  if (item.status === 'in_progress') {
    return (
      <div className="setup-item-progress-container">
        <span className="setup-item-progress-text">
          {SETUP_PROGRESS_MESSAGES[item.id] || 'Working...'}
        </span>
        {BREW_PACKAGES.has(item.id) && (
          <span className="setup-item-progress-hint">This may take a few minutes</span>
        )}
      </div>
    );
  }

  // Error items show error message and retry button
  if (item.status === 'error') {
    return (
      <div className="setup-item-error-container">
        <span className="setup-item-error-text">{item.errorMessage || 'Something went wrong'}</span>
        <button
          className="setup-item-btn setup-item-btn-retry"
          onClick={onAction}
          disabled={isAnyActionInProgress}
        >
          Retry
        </button>
      </div>
    );
  }

  // Not installed shows Install button with time estimate
  if (item.status === 'not_installed') {
    const timeEstimate = SETUP_TIME_ESTIMATES[item.id];
    return (
      <div className="setup-item-action-row">
        {timeEstimate && <span className="setup-item-time-estimate">{timeEstimate}</span>}
        <button
          className="setup-item-btn setup-item-btn-install"
          onClick={onAction}
          disabled={isAnyActionInProgress}
        >
          Install
        </button>
      </div>
    );
  }

  // Not authenticated shows Connect button with time estimate (and Skip for optional items)
  if (item.status === 'not_authenticated') {
    const timeEstimate = SETUP_TIME_ESTIMATES[item.id];
    return (
      <div className="setup-item-action-row">
        {timeEstimate && <span className="setup-item-time-estimate">{timeEstimate}</span>}
        {isOptional && onSkip && (
          <button
            className="setup-item-btn setup-item-btn-skip"
            onClick={onSkip}
            disabled={isAnyActionInProgress}
          >
            Skip
          </button>
        )}
        <button
          className="setup-item-btn setup-item-btn-connect"
          onClick={onAction}
          disabled={isAnyActionInProgress}
        >
          Connect
        </button>
      </div>
    );
  }

  return null;
}

export function SetupItem({
  item,
  blockedBy,
  onAction,
  onSkip,
  isAnyActionInProgress,
  isOptional,
}: SetupItemProps) {
  const statusClass = `setup-item-status-${item.status.replace('_', '-')}`;
  const optionalClass = isOptional ? 'setup-item-optional' : '';

  return (
    <div className={`setup-item ${statusClass} ${optionalClass}`}>
      <div className="setup-item-icon-container">{getStatusIcon(item.status)}</div>
      <div className="setup-item-name">
        {item.friendlyName}
        {isOptional && item.status !== 'ready' && (
          <span className="setup-item-optional-badge">Optional</span>
        )}
      </div>
      <div className="setup-item-action">
        {getActionButton(item, blockedBy, onAction, onSkip, isAnyActionInProgress, isOptional)}
      </div>
    </div>
  );
}
