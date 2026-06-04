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

/** Three thin vertical strokes representing flex children — same stroke language
 *  as the text-align icons. justify-* keeps them full-height and shifts the
 *  cluster horizontally; items-* spreads them at fixed x and shifts their
 *  (shorter) vertical extent, so the two rows read as one consistent set. */
function VLines({ lines }: { lines: [number, number, number][] }) {
  return (
    <Icon>
      {lines.map(([x, y1, y2], i) => (
        <line key={i} x1={x} y1={y1} x2={x} y2={y2} {...lineProps} />
      ))}
    </Icon>
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
  // justify-content (main/horizontal axis): 3 full-height strokes, cluster shifts left → right.
  'justify-start': (
    <VLines
      lines={[
        [4, 6, 18],
        [8, 6, 18],
        [12, 6, 18],
      ]}
    />
  ),
  'justify-center': (
    <VLines
      lines={[
        [8, 6, 18],
        [12, 6, 18],
        [16, 6, 18],
      ]}
    />
  ),
  'justify-end': (
    <VLines
      lines={[
        [12, 6, 18],
        [16, 6, 18],
        [20, 6, 18],
      ]}
    />
  ),
  'justify-between': (
    <VLines
      lines={[
        [4, 6, 18],
        [12, 6, 18],
        [20, 6, 18],
      ]}
    />
  ),
  // align-items (cross/vertical axis): 3 evenly-spread strokes, extent shifts top → bottom.
  'items-start': (
    <VLines
      lines={[
        [6, 4, 11],
        [12, 4, 11],
        [18, 4, 11],
      ]}
    />
  ),
  'items-center': (
    <VLines
      lines={[
        [6, 8.5, 15.5],
        [12, 8.5, 15.5],
        [18, 8.5, 15.5],
      ]}
    />
  ),
  'items-end': (
    <VLines
      lines={[
        [6, 13, 20],
        [12, 13, 20],
        [18, 13, 20],
      ]}
    />
  ),
  'items-stretch': (
    <VLines
      lines={[
        [6, 4, 20],
        [12, 4, 20],
        [18, 4, 20],
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
