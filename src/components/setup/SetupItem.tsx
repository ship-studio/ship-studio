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
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import SetupItemErrorGraphic from '@/assets/graphics/setup-item-error.svg?react';
import SetupItemEmptyGraphic from '@/assets/graphics/setup-item-empty.svg?react';
import SetupItemBlockedGraphic from '@/assets/graphics/setup-item-blocked.svg?react';
import { SuccessIcon } from '@/components/icons';

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

function getStatusIcon(status: SetupItemStatus) {
  switch (status) {
    case 'ready':
      return (
        <SuccessIcon
          size={20}
          className="setup-item-icon setup-item-icon-check"
          aria-hidden="true"
        />
      );
    case 'error':
      return (
        <SetupItemErrorGraphic
          width={20}
          height={20}
          className="setup-item-icon setup-item-icon-error"
          aria-hidden="true"
        />
      );
    case 'in_progress':
      return <Spinner className="setup-item-spinner" />;
    case 'blocked':
      return (
        <SetupItemBlockedGraphic
          width={20}
          height={20}
          className="setup-item-icon setup-item-icon-blocked"
          aria-hidden="true"
        />
      );
    default:
      return (
        <SetupItemEmptyGraphic
          width={20}
          height={20}
          className="setup-item-icon setup-item-icon-empty"
          aria-hidden="true"
        />
      );
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
        <Button variant="secondary" onClick={onAction} disabled={isAnyActionInProgress}>
          Retry
        </Button>
      </div>
    );
  }

  // Not installed shows Install button with time estimate
  if (item.status === 'not_installed') {
    const timeEstimate = SETUP_TIME_ESTIMATES[item.id];
    return (
      <div className="setup-item-action-row">
        {timeEstimate && <span className="setup-item-time-estimate">{timeEstimate}</span>}
        <Button variant="primary" onClick={onAction} disabled={isAnyActionInProgress}>
          Install
        </Button>
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
          <Button variant="ghost" onClick={onSkip} disabled={isAnyActionInProgress}>
            Skip
          </Button>
        )}
        <Button variant="primary" onClick={onAction} disabled={isAnyActionInProgress}>
          Connect
        </Button>
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
