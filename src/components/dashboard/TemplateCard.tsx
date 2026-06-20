/**
 * Selectable template card for the "Start from Scratch" grid in Create Project.
 *
 * Wraps the shared {@link Button} primitive (ghost variant) so the grid card
 * participates in the design-system button system, while keeping its grid-card
 * layout via the `stack-card` classes (which override the base button box model;
 * feature CSS loads after base.css). Renders the template name, an optional
 * "Recommended" badge, the description, and a check mark when selected.
 *
 * @module components/dashboard/TemplateCard
 */

import { Button } from '../primitives/Button';

interface TemplateCardProps {
  name: string;
  description: string;
  /** Whether this card is the active selection (drives the ring + check). */
  selected: boolean;
  /** Whether to show the neutral "Recommended" badge. */
  recommended: boolean;
  onSelect: () => void;
}

export function TemplateCard({
  name,
  description,
  selected,
  recommended,
  onSelect,
}: TemplateCardProps) {
  return (
    <Button
      variant="ghost"
      className={`stack-card${selected ? ' stack-card-selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="stack-card-name">
        {name}
        {recommended && (
          <svg
            className="stack-card-star"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="currentColor"
            role="img"
            aria-label="Recommended"
          >
            <title>Recommended</title>
            <path d="M11.48 3.5a.562.562 0 011.04 0l2.125 5.11a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
        )}
      </span>
      <span className="stack-card-desc">{description}</span>
      {selected && (
        <div className="stack-card-check">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      )}
    </Button>
  );
}
