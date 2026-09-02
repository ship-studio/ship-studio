import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'ghost'
  | 'warning'
  | 'variable';

export type ButtonSize = 'default' | 'compact' | 'medium' | 'large';
export type ButtonWidth = 'hug' | 'fill';

export function buttonClassNames({
  variant = 'default',
  size = 'default',
  width = 'hug',
  className,
  leftIcon,
  rightIcon,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: ButtonWidth;
  className?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
} = {}) {
  return [
    'button',
    `button--${variant}`,
    `button--size-${size}`,
    `button--width-${width}`,
    leftIcon || rightIcon ? 'button--has-icon' : null,
    width === 'fill' ? 'button--fill button--block' : 'button--hug',
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Props for the canonical action button. Extends the native button attributes
 * (`onClick`, `disabled`, `title`, …) and forwards its ref; `type` defaults to
 * `"button"` so forms don't submit by accident.
 *
 * - `variant` — visual emphasis. `default` = neutral Figma solid,
 *   `secondary` = neutral outline, `primary` = green CTA, `danger` =
 *   red-tinted destructive action, `ghost` = borderless low-emphasis action,
 *   `warning` = amber warning action, and `variable` = purple variable action.
 * - `size` — `default` (30px), `compact` for dense rows and toolbars, or
 *   `large` for prominent actions.
 * - `width` — `hug` (default) sizes to content; `fill` stretches to the
 *   container. `block` remains as a backwards-compatible alias for `fill`.
 * - `leftIcon` / `rightIcon` — icon nodes rendered beside the label with the
 *   standard gap (size 14 is the house convention).
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: ButtonWidth;
  block?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'default',
    width = 'hug',
    block,
    leftIcon,
    rightIcon,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const classes = buttonClassNames({
    variant,
    size,
    width: block ? 'fill' : width,
    className,
    leftIcon,
    rightIcon,
  });

  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {leftIcon && <span className="button__icon">{leftIcon}</span>}
      {children}
      {rightIcon && <span className="button__icon">{rightIcon}</span>}
    </button>
  );
});
