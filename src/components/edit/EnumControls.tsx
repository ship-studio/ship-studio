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

/** A bordered container frame + filled bars — conveys "items inside a flex box".
 *  `vertical` draws the cross-axis (align-items) framing instead of main-axis. */
function FramedBars({ bars }: { bars: [number, number, number, number][] }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {bars.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="currentColor" />
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
  // justify-content: 3 bars distributed along the main (horizontal) axis inside a frame.
  'justify-start': (
    <FramedBars
      bars={[
        [5, 8, 2.5, 8],
        [8.5, 8, 2.5, 8],
        [12, 8, 2.5, 8],
      ]}
    />
  ),
  'justify-center': (
    <FramedBars
      bars={[
        [7.5, 8, 2.5, 8],
        [11, 8, 2.5, 8],
        [14.5, 8, 2.5, 8],
      ]}
    />
  ),
  'justify-end': (
    <FramedBars
      bars={[
        [10, 8, 2.5, 8],
        [13.5, 8, 2.5, 8],
        [17, 8, 2.5, 8],
      ]}
    />
  ),
  'justify-between': (
    <FramedBars
      bars={[
        [5, 8, 2.5, 8],
        [10.75, 8, 2.5, 8],
        [16.5, 8, 2.5, 8],
      ]}
    />
  ),
  // align-items: 3 bars aligned along the cross (vertical) axis inside a frame.
  'items-start': (
    <FramedBars
      bars={[
        [6, 5, 3, 7],
        [10.5, 5, 3, 7],
        [15, 5, 3, 7],
      ]}
    />
  ),
  'items-center': (
    <FramedBars
      bars={[
        [6, 8.5, 3, 7],
        [10.5, 8.5, 3, 7],
        [15, 8.5, 3, 7],
      ]}
    />
  ),
  'items-end': (
    <FramedBars
      bars={[
        [6, 12, 3, 7],
        [10.5, 12, 3, 7],
        [15, 12, 3, 7],
      ]}
    />
  ),
  'items-stretch': (
    <FramedBars
      bars={[
        [6, 5, 3, 14],
        [10.5, 5, 3, 14],
        [15, 5, 3, 14],
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
