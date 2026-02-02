/**
 * Compact Mode Input Row - Row 1 of compact mode UI.
 *
 * Contains:
 * - Full-width text input field
 * - Send button
 *
 * @module components/CompactMode/CompactInputRow
 */

import { useRef, useCallback, KeyboardEvent } from 'react';
import { SendIcon } from '../icons';

export interface CompactInputRowProps {
  /** Current input value */
  value: string;
  /** Callback when input changes */
  onChange: (value: string) => void;
  /** Callback when send is triggered */
  onSend: () => void;
}

export function CompactInputRow({ value, onChange, onSend }: CompactInputRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Only send if input is not empty
        if (e.currentTarget.value.trim()) {
          onSend();
        }
      }
    },
    [onSend]
  );

  return (
    <div className="compact-input-row">
      <div className="compact-input-wrapper">
        <input
          ref={inputRef}
          type="text"
          className="compact-input"
          placeholder="Ask Claude..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="compact-send-btn"
          onClick={onSend}
          disabled={!value.trim()}
          title="Send (Enter)"
        >
          <SendIcon size={14} />
        </button>
      </div>
    </div>
  );
}
