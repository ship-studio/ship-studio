/**
 * A checkbox that looks like the rest of the app.
 *
 * A real `<input type="checkbox">` underneath, visually hidden and covered by a
 * drawn box. That is the whole trick, and it is the reason this is not a
 * `<div role="checkbox">`: the input keeps the space bar, the focus ring, the
 * form semantics and the screen-reader announcement for free, and the drawn box
 * only has to follow its state through `:checked` and `:focus-visible`.
 *
 * `accent-color` on a bare input was the previous answer. It tints the native
 * control and nothing else — the size, the radius and the check mark stay the
 * platform's, which is why the old comment checkboxes looked borrowed from a
 * settings dialog rather than part of Harbr.
 *
 * @module components/primitives/Checkbox
 */

import type { ChangeEvent } from 'react';
import { CheckIcon } from '@/components/icons';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name. Required: an unlabelled checkbox is unusable. */
  label: string;
  disabled?: boolean;
  className?: string;
  /** Stops a row click from also firing when the box is inside a button. */
  stopPropagation?: boolean;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  className,
  stopPropagation = false,
}: CheckboxProps) {
  return (
    <span
      className={`checkbox${className ? ` ${className}` : ''}`}
      onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
    >
      <input
        type="checkbox"
        className="checkbox__input"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
      />
      <span className="checkbox__box" aria-hidden>
        <CheckIcon size={10} />
      </span>
    </span>
  );
}
