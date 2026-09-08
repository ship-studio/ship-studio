/**
 * The answer control: a vertical list of options, one per row, answerable from
 * the keyboard.
 *
 * A list rather than the old card grid, for two reasons. A grid makes the user
 * compare five things at once, which is the opposite of one-question-at-a-time;
 * and a row has space for a sentence, so each option can explain itself to
 * someone who has never heard of any of them.
 *
 * Every option gets a letter (A, B, C…). Typing the letter picks it. That is
 * the small thing that makes the flow feel quick to people who type, without
 * costing anything for people who click.
 */

import { ReactNode, useCallback, useEffect } from 'react';
import { CheckIcon } from '@/components/icons';

export interface FlowOption<T extends string> {
  value: T;
  label: string;
  /** One line, in plain language. Assume they've heard of none of these. */
  description: string;
  icon?: ReactNode;
  /** Quiet trailing note — "Already installed", "Recommended". */
  note?: string;
  /** Renders the row as already satisfied. */
  satisfied?: boolean;
}

const LETTERS = 'ABCDEFGHIJ';

interface FlowChoiceProps<T extends string> {
  options: FlowOption<T>[];
  onSelect: (value: T) => void;
  /** Suppresses the keyboard shortcuts while something else owns the keys. */
  disabled?: boolean;
}

export function FlowChoice<T extends string>({ options, onSelect, disabled }: FlowChoiceProps<T>) {
  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      if (disabled) return;
      // Don't steal keys from a field, and don't fight browser/OS shortcuts.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const index = LETTERS.indexOf(event.key.toUpperCase());
      if (index === -1 || index >= options.length) return;
      event.preventDefault();
      onSelect(options[index].value);
    },
    [disabled, onSelect, options]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  return (
    <div className="flow-choice" role="list">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="listitem"
          className={`flow-choice-row ${option.satisfied ? 'satisfied' : ''}`}
          onClick={() => onSelect(option.value)}
          disabled={disabled}
          // Staggered entrance: rows arrive in reading order, not all at once.
          style={{ animationDelay: `${index * 45}ms` }}
        >
          <span className="flow-choice-key" aria-hidden="true">
            {LETTERS[index]}
          </span>

          {/* The slot is always rendered, empty or not: an option without an
              icon must not pull its own label left out of the column. */}
          <span className={`flow-choice-icon ${option.icon ? '' : 'empty'}`}>{option.icon}</span>

          <span className="flow-choice-text">
            <span className="flow-choice-label">{option.label}</span>
            <span className="flow-choice-description">{option.description}</span>
          </span>

          {option.satisfied ? (
            <span className="flow-choice-check" aria-label="Already set up">
              <CheckIcon size={14} />
            </span>
          ) : (
            option.note && <span className="flow-choice-note">{option.note}</span>
          )}
        </button>
      ))}
    </div>
  );
}
