import { forwardRef, type ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';

/** Props for an accessible icon-only member of the shared button family. */
export interface IconButtonProps extends Omit<
  ButtonProps,
  'children' | 'leftIcon' | 'rightIcon' | 'aria-label'
> {
  icon: ReactNode;
  'aria-label': string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, className, ...props },
  ref
) {
  return (
    <Button
      ref={ref}
      className={`button--icon-only ${className ?? ''}`}
      leftIcon={icon}
      {...props}
    />
  );
});
