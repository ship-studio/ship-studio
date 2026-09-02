import type { ReactNode } from 'react';
import type { ButtonSize } from './Button';
import { ToggleButton } from './ToggleButton';

/** Describes one mutually exclusive choice in a segmented control. */
export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
  title?: string;
  className?: string;
  disabled?: boolean;
}

/** Props for a labelled, controlled group of mutually exclusive choices. */
export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentedControlOption<T>[];
  onValueChange: (value: T) => void;
  'aria-label': string;
  className?: string;
  size?: ButtonSize;
}

/**
 * A mutually exclusive set of compact choices.
 *
 * Use this for filters and settings that update a value in place. Use Tabs
 * when the choices navigate between panels, and ToggleButton for one boolean.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  className,
  size = 'compact',
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className={`segmented-control ${className ?? ''}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          variant="default"
          size={size}
          pressed={value === option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          title={option.title ?? option.ariaLabel}
          className={option.className}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </ToggleButton>
      ))}
    </div>
  );
}
