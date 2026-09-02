/**
 * AccountCard — a single workspace tile in the workspace picker grid.
 *
 * @module components/accounts/AccountCard
 */

import { SettingsIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import type { Account } from '../../lib/accounts';

interface AccountCardProps {
  account: Account;
  isActive: boolean;
  onSelect: () => void;
  onOpenSettings: () => void;
}

export function AccountCard({ account, isActive, onSelect, onOpenSettings }: AccountCardProps) {
  return (
    <div className={`account-card${isActive ? ' active' : ''}`} onClick={onSelect}>
      <div className="account-card-avatar" style={{ background: account.color }}>
        {account.name.trim().charAt(0).toUpperCase() || '?'}
      </div>
      <div className="account-card-info">
        <div className="account-card-details">
          <div className="account-card-name">{account.name}</div>
          {isActive && <div className="account-card-badge">Current</div>}
        </div>
        <IconButton
          variant="ghost"
          size="compact"
          className="account-card-settings"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings();
          }}
          aria-label={`${account.name} settings`}
          title="Workspace settings"
          icon={<SettingsIcon size={14} />}
        />
      </div>
    </div>
  );
}
