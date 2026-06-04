/**
 * Renders the visual editor's enum controls, each in its configured variant:
 *  - icons     → segmented buttons with an icon per option (align / justify / items)
 *  - dropdown  → a custom themed dropdown (weight, size, radius, …)
 *  - segmented → text buttons
 * All variants apply the option's token + inline-style preview via onApplyEnum.
 */

import type { ReactNode } from 'react';
import { activeEnumToken, ENUM_CONTROLS, type EnumControl } from '../../lib/edit';
import { EnumDropdown } from './EnumDropdown';

const lineProps = { strokeWidth: 2, strokeLinecap: 'round' as const };
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      {children}
    </svg>
  );
}

/** Filled bars representing flex children. justify-* varies their horizontal
 *  cluster (bars same height, x shifts); items-* varies their vertical position
 *  (bars same x spread, y/height shifts). No frame — it just added clutter at 16px. */
function Bars({ bars }: { bars: [number, number, number, number][] }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      {bars.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1.2" fill="currentColor" />
      ))}
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
  // justify-content (main/horizontal axis): 3 equal bars, cluster shifts left → right.
  'justify-start': (
    <Bars
      bars={[
        [3, 6, 3.5, 12],
        [8, 6, 3.5, 12],
        [13, 6, 3.5, 12],
      ]}
    />
  ),
  'justify-center': (
    <Bars
      bars={[
        [5.75, 6, 3.5, 12],
        [10.25, 6, 3.5, 12],
        [14.75, 6, 3.5, 12],
      ]}
    />
  ),
  'justify-end': (
    <Bars
      bars={[
        [7.5, 6, 3.5, 12],
        [12.5, 6, 3.5, 12],
        [17.5, 6, 3.5, 12],
      ]}
    />
  ),
  'justify-between': (
    <Bars
      bars={[
        [3, 6, 3.5, 12],
        [10.25, 6, 3.5, 12],
        [17.5, 6, 3.5, 12],
      ]}
    />
  ),
  // align-items (cross/vertical axis): 3 evenly-spread bars, block shifts top → bottom.
  'items-start': (
    <Bars
      bars={[
        [4.5, 3, 4, 9],
        [10, 3, 4, 9],
        [15.5, 3, 4, 9],
      ]}
    />
  ),
  'items-center': (
    <Bars
      bars={[
        [4.5, 7.5, 4, 9],
        [10, 7.5, 4, 9],
        [15.5, 7.5, 4, 9],
      ]}
    />
  ),
  'items-end': (
    <Bars
      bars={[
        [4.5, 12, 4, 9],
        [10, 12, 4, 9],
        [15.5, 12, 4, 9],
      ]}
    />
  ),
  'items-stretch': (
    <Bars
      bars={[
        [4.5, 3, 4, 18],
        [10, 3, 4, 18],
        [15.5, 3, 4, 18],
      ]}
    />
  ),
};

interface Props {
  currentClass: string;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
}

function Control({ control, currentClass, onApplyEnum }: { control: EnumControl } & Props) {
  const active = activeEnumToken(currentClass, control);

  let body: ReactNode;
  if (control.variant === 'dropdown') {
    body = (
      <EnumDropdown
        label={control.label}
        value={active}
        options={control.options}
        onChange={(token) => {
          const opt = control.options.find((o) => o.token === token);
          if (opt) onApplyEnum(opt.token, opt.style);
        }}
      />
    );
  } else {
    const isIcons = control.variant === 'icons';
    body = (
      <div className="ss-edit-panel__segmented" role="group" aria-label={control.label}>
        {control.options.map((o) => (
          <button
            key={o.token}
            type="button"
            className={`ss-edit-panel__seg${isIcons ? ' ss-edit-panel__seg--icon' : ''}${
              active === o.token ? ' active' : ''
            }`}
            aria-label={o.label}
            aria-pressed={active === o.token}
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
