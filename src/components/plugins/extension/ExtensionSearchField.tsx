import { forwardRef, type InputHTMLAttributes } from 'react';
import { SearchIcon } from '@/components/icons';

/** Props for the shared extension-manager search input. */
export interface ExtensionSearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className'
> {
  className?: string;
}

/** Search input shell shared by extension managers. */
export const ExtensionSearchField = forwardRef<HTMLInputElement, ExtensionSearchFieldProps>(
  function ExtensionSearchField({ className, ...props }, ref) {
    return (
      <div className={['extension-search-field', className].filter(Boolean).join(' ')}>
        <span className="extension-search-field__icon" aria-hidden="true">
          <SearchIcon size={12} />
        </span>
        <input ref={ref} className="extension-search-field__input" {...props} />
      </div>
    );
  }
);
