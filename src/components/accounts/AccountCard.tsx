/**
 * AccountCard — one workspace tile in the workspace picker grid.
 *
 * Same recipe as the onboarding agent picker (square card, identity tile,
 * name, one-line meta, quiet status caption) so the two "pick one" screens
 * read as siblings. The tile itself is a real button; the settings gear is a
 * sibling control rather than a nested one, which keeps the markup valid and
 * both targets keyboard-reachable.
 *
 * @module components/accounts/AccountCard
 */

import type { CSSProperties } from 'react';
import { SettingsIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import type { Account } from '../../lib/accounts';

interface AccountCardProps {
  account: Account;
  isActive: boolean;
  onSelect: () => void;
  onOpenSettings: () => void;
  disabled?: boolean;
}

/**
 * One line about where this workspace keeps its projects. Only the custom
 * root is known for certain here — the built-in default resolves to the app's
 * projects folder, which the user may have moved, so it is described rather
 * than spelled out (CLAUDE.md: never display data we don't reliably know).
 */
export function describeProjectsRoot(account: Account): string {
  const root = account.projectsRoot?.trim();
  if (!root) return 'Default projects folder';
  const segments = root.split(/[\\/]+/).filter(Boolean);
  const leaf = segments[segments.length - 1];
  return leaf ? `Projects in ${leaf}` : 'Custom projects folder';
}

export function AccountCard({
  account,
  isActive,
  onSelect,
  onOpenSettings,
  disabled,
}: AccountCardProps) {
  const initial = account.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div className={`account-pick-card${isActive ? ' is-current' : ''}`} role="listitem">
      <button
        type="button"
        className="account-pick-card-main"
        onClick={onSelect}
        disabled={disabled}
        aria-current={isActive ? 'true' : undefined}
        aria-label={isActive ? `${account.name} (current workspace)` : `Switch to ${account.name}`}
      >
        <span
          className="account-pick-card-avatar"
          style={{ '--account-color': account.color } as CSSProperties}
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className="account-pick-card-name">{account.name}</span>
        <span className="account-pick-card-desc">{describeProjectsRoot(account)}</span>
        {isActive && <span className="account-pick-card-status">Current</span>}
      </button>
      <IconButton
        variant="ghost"
        size="compact"
        className="account-pick-card-settings"
        onClick={onOpenSettings}
        disabled={disabled}
        aria-label={`${account.name} settings`}
        title="Workspace settings"
        icon={<SettingsIcon size={14} />}
      />
    </div>
  );
}
