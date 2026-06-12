import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * Props for the canonical action button. Extends the native button attributes
 * (`onClick`, `disabled`, `title`, …) and forwards its ref; `type` defaults to
 * `"button"` so forms don't submit by accident.
 *
 * - `variant` — visual emphasis. `primary` = green CTA (the one main action of
 *   a view), `secondary` (default) = outlined neutral action, `danger` =
 *   red-tinted destructive action, `ghost` = borderless low-emphasis action.
 * - `size` — `md` (default) or `sm` for dense rows and toolbars.
 * - `block` — stretch to the full width of the container.
 * - `leftIcon` / `rightIcon` — icon nodes rendered beside the label with the
 *   standard gap (size 14 is the house convention).
 */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  block?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
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
  const classes = [
    'button',
    `button--${variant}`,
    size === 'sm' ? 'button--sm' : null,
    block ? 'button--block' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
