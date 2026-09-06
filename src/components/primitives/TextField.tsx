import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

/** Props for the canonical single-line text input primitive. */
export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Adds the invalid class and aria-invalid state without feature-level duplication. */
  invalid?: boolean;
  /** Optional trailing unit/value slot for compact property fields. */
  suffix?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { className, invalid = false, suffix, 'aria-invalid': ariaInvalid, ...props },
  ref
) {
  const input = (
    <input
      ref={ref}
      className={['ss-text-field', invalid ? 'ss-text-field--invalid' : null, className]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || ariaInvalid}
      {...props}
    />
  );

  if (suffix === undefined) return input;

  return (
    <span className="ss-text-field-shell">
      {input}
      <span className="ss-text-field__suffix">{suffix}</span>
    </span>
  );
});

/** Props for the canonical multi-line text input primitive. */
export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Adds the invalid class and aria-invalid state without feature-level duplication. */
  invalid?: boolean;
}

/**
 * The multi-line sibling of TextField, sharing its surface, border and focus
 * ring. Use it wherever a feature would otherwise style a bare `<textarea>` and
 * inherit the browser's white box.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, invalid = false, 'aria-invalid': ariaInvalid, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={[
        'ss-text-field',
        'ss-text-field--multiline',
        invalid ? 'ss-text-field--invalid' : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || ariaInvalid}
      {...props}
    />
  );
});
