/**
 * Selectable template card for the "Start from Scratch" grid in Create Project.
 *
 * Wraps the shared {@link Button} primitive (ghost variant) so the grid card
 * participates in the design-system button system, while keeping its grid-card
 * layout via the `stack-card` classes (which override the base button box model;
 * feature CSS loads after base.css). Renders the template name, the description,
 * and a check mark when selected.
 *
 * @module components/dashboard/TemplateCard
 */

import type { ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { CheckIcon } from '@/components/icons';

interface TemplateCardProps {
  name: string;
  description: string;
  /** Whether this card is the active selection (drives the ring + check). */
  selected: boolean;
  onSelect: () => void;
  /** Optional third line under the description, e.g. a cadence or size. */
  meta?: ReactNode;
}

export function TemplateCard({ name, description, selected, onSelect, meta }: TemplateCardProps) {
  return (
    <Button
      variant="ghost"
      className={`stack-card${selected ? ' stack-card-selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="stack-card-name">{name}</span>
      <span className="stack-card-desc">{description}</span>
      {meta && <span className="stack-card-meta">{meta}</span>}
      {selected && (
        <div className="stack-card-check">
          <CheckIcon size={14} />
        </div>
      )}
    </Button>
  );
}
