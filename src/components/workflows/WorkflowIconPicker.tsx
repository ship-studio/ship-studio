/**
 * The emoji that stands in for a workflow, Notion-style.
 *
 * A curated grid rather than a full emoji keyboard: the useful set for
 * "what does this workflow watch" is small and picking from it is faster than
 * searching 3,000 glyphs. The field below the grid accepts anything, so the
 * curation is a shortcut, not a ceiling — paste any emoji (or press ⌃⌘Space)
 * and it takes it.
 *
 * @module components/workflows/WorkflowIconPicker
 */

import { useState } from 'react';
import { Dropdown } from '../primitives/Dropdown';
import { Button } from '../primitives/Button';

interface WorkflowIconPickerProps {
  value: string | null;
  /** Used to derive the placeholder glyph before one is chosen. */
  name: string;
  onChange: (icon: string | null) => void;
}

/** Grouped by what a workflow tends to be *about*. */
const EMOJI_GROUPS: { label: string; emoji: string[] }[] = [
  {
    label: 'Watching',
    emoji: ['🔒', '🛡️', '🔍', '🕵️', '🚨', '⚠️', '🧯', '📡', '🔦', '👀'],
  },
  {
    label: 'Quality',
    emoji: ['✨', '🧹', '🧪', '🧬', '📐', '🎨', '🪛', '🧱', '♻️', '✅'],
  },
  {
    label: 'Upkeep',
    emoji: ['📦', '🔧', '⚙️', '🩺', '💊', '🪫', '🔋', '📉', '📈', '🗓️'],
  },
  {
    label: 'Reading',
    emoji: ['📰', '📚', '🧭', '🌍', '💡', '🧠', '☕', '🐝', '🚀', '🎯'],
  },
];

export function WorkflowIconPicker({ value, name, onChange }: WorkflowIconPickerProps) {
  const [custom, setCustom] = useState('');

  // Before a workflow is named there is nothing to derive from, so the button
  // shows a neutral prompt rather than a letter that will change under you.
  const fallback = name.trim() ? name.trim().charAt(0).toUpperCase() : '🙂';

  return (
    <Dropdown
      menuClassName="workflow-icon-menu"
      onOpenChange={(open) => {
        if (!open) setCustom('');
      }}
      trigger={(props) => (
        <button
          type="button"
          className={`workflow-icon-trigger${value ? ' has-icon' : ''}`}
          title="Pick an icon"
          aria-label={value ? `Icon: ${value}. Change it` : 'Pick an icon'}
          {...props}
        >
          <span aria-hidden>{value ?? fallback}</span>
        </button>
      )}
    >
      <div className="workflow-icon-panel">
        {EMOJI_GROUPS.map((group) => (
          <div key={group.label} className="workflow-icon-group">
            <span className="workflow-icon-group-label">{group.label}</span>
            <div className="workflow-icon-grid">
              {group.emoji.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={`workflow-icon-option${value === emoji ? ' is-selected' : ''}`}
                  aria-label={emoji}
                  aria-pressed={value === emoji}
                  onClick={() => onChange(emoji)}
                >
                  <span aria-hidden>{emoji}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="workflow-icon-custom">
          <input
            type="text"
            className="workflow-icon-custom-input"
            value={custom}
            placeholder="Or paste any emoji"
            aria-label="Custom emoji"
            maxLength={8}
            onChange={(event) => {
              const next = event.target.value;
              setCustom(next);
              const trimmed = next.trim();
              // Commit as you type — a single emoji is the whole input, so
              // there is nothing to confirm.
              if (trimmed) onChange(trimmed);
            }}
          />
          <Button variant="ghost" size="compact" disabled={!value} onClick={() => onChange(null)}>
            Remove
          </Button>
        </div>
      </div>
    </Dropdown>
  );
}
