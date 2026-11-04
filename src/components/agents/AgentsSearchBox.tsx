/**
 * Conversation search. In Agents mode the sidebar's top field searches every
 * conversation (⌘K stays the palette); its results take the agent list's
 * place while there's a query. With no sidebar to hold it (compact width, or
 * the rail collapsed) the same field comes up over the chat instead.
 *
 * Esc anywhere in Agents mode puts search away (AgentsView); Enter opens the
 * first hit; Up and Down move between hits.
 *
 * @module components/agents/AgentsSearchBox
 */

import { useRef, type RefObject } from 'react';
import { SearchIcon } from '@/components/icons';
import { SearchField } from '../primitives/SearchField';
import { AgentsSearchResults, moveHitFocus } from './AgentsSearchResults';
import { useClickOutside } from '../../hooks/useClickOutside';
import { kbd } from '../../lib/shortcuts';
import type { SearchHit } from '../../lib/agents';

export interface AgentsSearchState {
  query: string;
  setQuery: (query: string) => void;
  /** Clear the query (and close the popover), handing focus back to the composer. */
  close: () => void;
}

interface AgentsSearchBoxProps {
  search: AgentsSearchState;
  field: RefObject<HTMLInputElement | null>;
  className?: string;
  /** In the popover: leaving it empty puts it away. */
  closeOnBlur?: boolean;
}

export function AgentsSearchBox({ search, field, className, closeOnBlur }: AgentsSearchBoxProps) {
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
        } else if (e.key === 'Enter') {
          e.preventDefault();
          document.querySelector<HTMLElement>('.agents-search__hit')?.click();
        } else {
          moveHitFocus(e, field);
        }
      }}
      onBlur={(e) => {
        if (!closeOnBlur) return;
        const next = e.relatedTarget as Node | null;
        const scope = e.currentTarget.closest('[data-agents-search-scope]');
        if (next && scope?.contains(next)) return;
        if (!search.query.trim()) search.close();
      }}
    />
  );
}

/** The sidebar's top field in Agents mode, in the palette trigger's place and look. */
export function AgentsTopSearch({
  search,
  field,
  collapsed,
  onOpen,
}: {
  search: AgentsSearchState;
  field: RefObject<HTMLInputElement | null>;
  /** The rail is collapsed: just the magnifier, which opens the popover. */
  collapsed: boolean;
  onOpen: () => void;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        tabIndex={0}
        className="workspace-sidebar-filter"
        onClick={onOpen}
        title={`Search conversations (${kbd('mod', 'F')})`}
        aria-label="Search conversations"
      >
        <SearchIcon size={12} />
      </button>
    );
  }
  return (
    <div className="agents-top-search" role="search">
      <AgentsSearchBox search={search} field={field} className="agents-top-search__field" />
      {!search.query && (
        <span className="workspace-sidebar-filter-shortcut agents-top-search__kbd" aria-hidden>
          {kbd('mod', 'F')}
        </span>
      )}
    </div>
  );
}

interface AgentsSearchPopoverProps {
  search: AgentsSearchState;
  open: boolean;
  field: RefObject<HTMLInputElement | null>;
  onOpenHit: (hit: SearchHit) => void;
}

/** No sidebar to hold it, so ⌘F opens the same search over the chat. */
export function AgentsSearchPopover({ search, open, field, onOpenHit }: AgentsSearchPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, search.close, open);
  if (!open) return null;
  return (
    <div ref={ref} className="agents-search-popover" role="search" data-agents-search-scope>
      <AgentsSearchBox
        search={search}
        field={field}
        closeOnBlur
        className="agents-search-popover__field"
      />
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
