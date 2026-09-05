/**
 * AccountColorPicker — shared workspace colour selector used when creating
 * and editing a Workspace.
 *
 * @module components/accounts/AccountColorPicker
 */

import { ACCOUNT_COLORS } from '../../lib/accounts';
import { Button } from '../primitives/Button';

interface AccountColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

export function AccountColorPicker({ value, onChange }: AccountColorPickerProps) {
  return (
    <div className="account-color-picker" role="group" aria-label="Workspace color">
      {ACCOUNT_COLORS.map((color) => (
        <Button
          key={color}
          variant="ghost"
          size="compact"
          className={`account-color-swatch ${color === value ? 'selected' : ''}`}
          style={{ background: color }}
          onClick={() => onChange(color)}
          title={color}
          aria-label={`Use ${color} as the workspace color`}
          aria-pressed={color === value}
        />
      ))}
    </div>
  );
}
