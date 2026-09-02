import { forwardRef } from 'react';
import { Button, type ButtonProps } from './Button';

/** Props for a button-family control with an explicit boolean pressed state. */
export interface ToggleButtonProps extends Omit<ButtonProps, 'aria-pressed'> {
  pressed: boolean;
}

export const ToggleButton = forwardRef<HTMLButtonElement, ToggleButtonProps>(function ToggleButton(
  { pressed, ...props },
  ref
) {
  return <Button ref={ref} aria-pressed={pressed} {...props} />;
});
