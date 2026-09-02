import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type PropertyFieldVariant = 'value' | 'select' | 'variable';
export type PropertyFieldSize = 'default' | 'compact';

/** Builds the canonical class list for property-field variants, sizes, and states. */
export function propertyFieldClassNames({
  variant = 'value',
  size = 'default',
  className,
}: {
  variant?: PropertyFieldVariant;
  size?: PropertyFieldSize;
  className?: string;
} = {}) {
  return ['property-field', `property-field--${variant}`, `property-field--size-${size}`, className]
    .filter(Boolean)
    .join(' ');
}

/** Props for an interactive value or variable field in editor property panels. */
export interface PropertyFieldProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PropertyFieldVariant;
  size?: PropertyFieldSize;
}

/**
 * Interactive editor value, kept separate from Button because selecting or
 * editing a property value is not an action CTA. State color belongs to the
 * accompanying label; fields stay neutral except for CSS variable values.
 */
export const PropertyField = forwardRef<HTMLButtonElement, PropertyFieldProps>(
  function PropertyField(
    { variant = 'value', size = 'default', className, type = 'button', ...rest },
    ref
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={propertyFieldClassNames({ variant, size, className })}
        {...rest}
      />
    );
  }
);
