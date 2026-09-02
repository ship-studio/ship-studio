import { forwardRef } from 'react';
import { Button, type ButtonProps } from './Button';

/** Props for a button-family menu trigger with controlled expanded state. */
export interface MenuButtonProps extends Omit<ButtonProps, 'aria-expanded' | 'aria-haspopup'> {
  expanded: boolean;
}

export const MenuButton = forwardRef<HTMLButtonElement, MenuButtonProps>(function MenuButton(
  { expanded, ...props },
  ref
) {
  return <Button ref={ref} aria-haspopup="menu" aria-expanded={expanded} {...props} />;
});
