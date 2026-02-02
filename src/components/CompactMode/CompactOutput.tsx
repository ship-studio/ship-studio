/**
 * Compact Mode Output - Scrollable terminal output area.
 *
 * Displays terminal output when compact mode is expanded.
 * Auto-scrolls to latest output and shows a subtle loading indicator
 * when receiving new content.
 *
 * @module components/CompactMode/CompactOutput
 */

import { useRef, useEffect } from 'react';
import { ChevronIcon } from '../icons';

export interface CompactOutputProps {
  /** Terminal output lines to display */
  lines: string[];
  /** Whether new output is being received */
  isReceiving: boolean;
  /** Callback to collapse the output area */
  onCollapse: () => void;
}

export function CompactOutput({ lines, isReceiving, onCollapse }: CompactOutputProps) {
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="compact-output">
      <div className="compact-output-header">
        <span className="compact-output-title">
          Output
          {isReceiving && <span className="compact-receiving-indicator" />}
        </span>
        <button
          type="button"
          className="compact-collapse-btn"
          onClick={onCollapse}
          title="Collapse output"
          aria-label="Collapse output"
        >
          <ChevronIcon size={12} />
        </button>
      </div>
      <div ref={outputRef} className="compact-output-content">
        {lines.length === 0 ? (
          <div className="compact-output-empty">Waiting for output...</div>
        ) : (
          lines.map((line, index) => (
            <div key={index} className="compact-output-line">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
