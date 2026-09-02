import { forwardRef } from 'react';
import { Button, type ButtonProps } from './Button';

export type TextButtonVariant = 'default' | 'primary' | 'accent' | 'danger';

/** Props for an inline text action that retains shared button semantics. */
export interface TextButtonProps extends Omit<ButtonProps, 'variant' | 'size' | 'block'> {
  variant?: TextButtonVariant;
}

/**
 * Inline text action with button semantics.
 *
 * TextButton deliberately has different geometry from Button: it inherits the
 * surrounding line height and has no control-height, padding, surface, radius,
 * shadow, or press-scale. It still delegates to Button for native attributes,
 * ref forwarding, disabled/focus behavior, width handling, and icon slots.
 */
export const TextButton = forwardRef<HTMLButtonElement, TextButtonProps>(function TextButton(
  { variant = 'default', className, ...props },
  ref
) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      className={`text-button text-button--${variant} ${className ?? ''}`}
      {...props}
    />
  );
});
