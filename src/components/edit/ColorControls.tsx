/**
 * Text + background color controls. A native color picker writes an arbitrary
 * Tailwind value (`text-[#rrggbb]` / `bg-[#rrggbb]`) and previews via inline
 * color/background-color. Named Tailwind colors already on the element can't be
 * mapped back to a swatch, so the picker just starts from black in that case.
 */

import { COLOR_CONTROLS, arbitraryColor, colorToken } from '../../lib/edit';

interface Props {
  currentClass: string;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
}

export function ColorControls({ currentClass, onApplyEnum }: Props) {
  return (
    <>
      {COLOR_CONTROLS.map((c) => {
        const current = arbitraryColor(currentClass, c.prefix);
        return (
          <div className="ss-edit-panel__control" key={c.prefix}>
            <label className="ss-edit-panel__label">{c.label}</label>
            <div className="ss-edit-panel__color">
              <input
                type="color"
                className="ss-edit-panel__color-input"
                aria-label={c.label}
                value={current ?? '#000000'}
                onChange={(e) =>
                  onApplyEnum(colorToken(c.prefix, e.target.value), { [c.css]: e.target.value })
                }
              />
              <span className="ss-edit-panel__color-hex">{current ?? '—'}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
