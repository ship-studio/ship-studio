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
} from '../../lib/setup';

interface SetupItemProps {
  item: SetupItemType;
  /** Names of items blocking this one */
  blockedBy?: string[];
  /** Called when user clicks Install or Connect */
  onAction?: () => void;
  /** Whether this specific action is currently in progress */
  isActionInProgress?: boolean;
  /** Whether any action across all items is in progress (disables all buttons) */
  isAnyActionInProgress?: boolean;
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
      <circle cx="10" cy="10" r="10" fill="var(--success)" />
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

/** Spinner for in-progress items */
function SpinnerIcon() {
  return <div className="setup-item-spinner" />;
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
      return <SpinnerIcon />;
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
  isAnyActionInProgress: boolean | undefined
): React.ReactNode {
  // Ready items show version/username
  if (item.status === 'ready') {
    const info = item.username || item.version;
    if (info) {
      return <span className="setup-item-info">{info}</span>;
    }
    return null;
  }

  // Blocked items show what they're waiting for
  if (item.status === 'blocked' && blockedBy && blockedBy.length > 0) {
    return <span className="setup-item-blocked-text">Waiting for {blockedBy[0]}</span>;
  }

  // In-progress items show the progress message
  if (item.status === 'in_progress') {
    return (
      <span className="setup-item-progress-text">
        {SETUP_PROGRESS_MESSAGES[item.id] || 'Working...'}
      </span>
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

  // Not installed shows Install button
  if (item.status === 'not_installed') {
    return (
      <button
        className="setup-item-btn setup-item-btn-install"
        onClick={onAction}
        disabled={isAnyActionInProgress}
      >
        Install
      </button>
    );
  }

  // Not authenticated shows Connect button
  if (item.status === 'not_authenticated') {
    return (
      <button
        className="setup-item-btn setup-item-btn-connect"
        onClick={onAction}
        disabled={isAnyActionInProgress}
      >
        Connect
      </button>
    );
  }

  return null;
}

export function SetupItem({ item, blockedBy, onAction, isAnyActionInProgress }: SetupItemProps) {
  const statusClass = `setup-item-status-${item.status.replace('_', '-')}`;

  return (
    <div className={`setup-item ${statusClass}`}>
      <div className="setup-item-icon-container">{getStatusIcon(item.status)}</div>
      <div className="setup-item-name">{item.friendlyName}</div>
      <div className="setup-item-action">
        {getActionButton(item, blockedBy, onAction, isAnyActionInProgress)}
      </div>
    </div>
  );
}
