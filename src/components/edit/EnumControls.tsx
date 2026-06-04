/**
 * Renders the visual editor's enum controls, each in its configured variant:
 *  - icons     → segmented buttons with an icon per option (e.g. text align)
 *  - dropdown  → a native select (e.g. font weight, size, radius)
 *  - segmented → text buttons
 * All variants apply the option's token + inline-style preview via onApplyEnum.
 */

import type { ReactNode } from 'react';
import { activeEnumToken, ENUM_CONTROLS, type EnumControl } from '../../lib/edit';

interface Props {
  currentClass: string;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
}

const lineProps = { strokeWidth: 2, strokeLinecap: 'round' as const };
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      {children}
    </svg>
  );
}

/** Icon per option token (only icon-variant controls need these). */
const ICONS: Record<string, ReactNode> = {
  'text-left': (
    <Icon>
      <line x1="3" y1="6" x2="21" y2="6" {...lineProps} />
      <line x1="3" y1="12" x2="15" y2="12" {...lineProps} />
      <line x1="3" y1="18" x2="17" y2="18" {...lineProps} />
    </Icon>
  ),
  'text-center': (
    <Icon>
      <line x1="3" y1="6" x2="21" y2="6" {...lineProps} />
      <line x1="7" y1="12" x2="17" y2="12" {...lineProps} />
      <line x1="5" y1="18" x2="19" y2="18" {...lineProps} />
    </Icon>
  ),
  'text-right': (
    <Icon>
      <line x1="3" y1="6" x2="21" y2="6" {...lineProps} />
      <line x1="9" y1="12" x2="21" y2="12" {...lineProps} />
      <line x1="7" y1="18" x2="21" y2="18" {...lineProps} />
    </Icon>
  ),
};

function Control({ control, currentClass, onApplyEnum }: { control: EnumControl } & Props) {
  const active = activeEnumToken(currentClass, control);

  let body: ReactNode;
  if (control.variant === 'dropdown') {
    body = (
      <select
        className="ss-edit-panel__select"
        aria-label={control.label}
        value={active ?? ''}
        onChange={(e) => {
          const opt = control.options.find((o) => o.token === e.target.value);
          if (opt) onApplyEnum(opt.token, opt.style);
        }}
      >
        {active === null && <option value="">—</option>}
        {control.options.map((o) => (
          <option key={o.token} value={o.token}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    const isIcons = control.variant === 'icons';
    body = (
      <div className="ss-edit-panel__segmented">
        {control.options.map((o) => (
          <button
            key={o.token}
            type="button"
            className={`ss-edit-panel__seg${isIcons ? ' ss-edit-panel__seg--icon' : ''}${
              active === o.token ? ' active' : ''
            }`}
            aria-label={o.label}
            title={o.label}
            onClick={() => onApplyEnum(o.token, o.style)}
          >
            {isIcons ? ICONS[o.token] : o.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="ss-edit-panel__control">
      <label className="ss-edit-panel__label">{control.label}</label>
      {body}
    </div>
  );
}

export function EnumControls({ currentClass, onApplyEnum }: Props) {
  return (
    <>
      {ENUM_CONTROLS.map((control) => (
        <Control
          key={control.label}
          control={control}
          currentClass={currentClass}
          onApplyEnum={onApplyEnum}
        />
      ))}
    </>
  );
}
