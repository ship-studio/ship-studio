/**
 * The conversation search field, and the popover that carries it in compact
 * mode. It is hidden until asked for (the search button in the Agents header,
 * ⌘F, or the palette); Esc, or leaving it empty, puts it away again.
 *
 * @module components/agents/AgentsSearchBox
 */

import { useRef, type RefObject } from 'react';
import { SearchField } from '../primitives/SearchField';
import { AgentsSearchResults, moveHitFocus } from './AgentsSearchResults';
import { useClickOutside } from '../../hooks/useClickOutside';
import type { SearchHit } from '../../lib/agents';

export interface AgentsSearchState {
  open: boolean;
  query: string;
  setQuery: (query: string) => void;
  close: () => void;
}

interface AgentsSearchBoxProps {
  search: AgentsSearchState;
  field: RefObject<HTMLInputElement | null>;
  className?: string;
}

export function AgentsSearchBox({ search, field, className }: AgentsSearchBoxProps) {
  return (
    <SearchField
      ref={field}
      density="compact"
      className={className}
      value={search.query}
      onChange={search.setQuery}
      placeholder="Search conversations"
      aria-label="Search conversations"
      clearLabel="Clear search"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          search.close();
        } else {
          moveHitFocus(e, field);
        }
      }}
      onBlur={(e) => {
        // Empty and left behind: put it away. Focus moving to the clear button
        // or a hit inside the same scope is not leaving.
        const next = e.relatedTarget as Node | null;
        const scope = e.currentTarget.closest('[data-agents-search-scope]');
        if (next && scope?.contains(next)) return;
        if (!search.query.trim()) search.close();
      }}
    />
  );
}

interface AgentsSearchPopoverProps {
  search: AgentsSearchState;
  field: RefObject<HTMLInputElement | null>;
  onOpenHit: (hit: SearchHit) => void;
}

/** Compact mode has no sidebar, so ⌘F opens the same search over the chat. */
export function AgentsSearchPopover({ search, field, onOpenHit }: AgentsSearchPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, search.close, search.open);
  if (!search.open) return null;
  return (
    <div
      ref={ref}
      className="agents-search-popover"
      role="search"
      data-agents-search-scope
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          search.close();
        }
      }}
    >
      <AgentsSearchBox search={search} field={field} className="agents-search-popover__field" />
      {search.query.trim() && (
        <div className="agents-search-popover__results">
          <AgentsSearchResults
            query={search.query}
            field={field}
            onOpen={(hit) => {
              onOpenHit(hit);
              search.close();
            }}
          />
        </div>
      )}
    </div>
  );
}
