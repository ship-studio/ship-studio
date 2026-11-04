/**
 * Search results across every agent's conversation, shown in the sidebar in
 * place of the agent list while there's a query. Grouped by agent, newest
 * first; clicking a hit opens that chat and flashes the line.
 *
 * @module components/agents/AgentsSearchResults
 */

import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  formatHitTime,
  groupHits,
  highlightRuns,
  hitSpeaker,
  searchAgents,
  type SearchHit,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { AgentAvatar } from './AgentAvatar';

/** Wait this long after the last keystroke before scanning. */
const DEBOUNCE_MS = 140;

interface Results {
  query: string;
  hits: SearchHit[];
  error: string | null;
}

/** Hits for `query`, debounced; `null` until the first answer for it arrives. */
function useSearch(query: string): Results | null {
  const [results, setResults] = useState<Results | null>(null);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      searchAgents(query)
        .then((hits) => live && setResults({ query, hits, error: null }))
        .catch(
          (err) =>
            live && setResults({ query, hits: [], error: formatCommandError(asCommandError(err)) })
        );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  return results;
}

/** Up/Down moves between hits; Up from the first goes back to the field. */
export function moveHitFocus(
  e: KeyboardEvent<HTMLElement>,
  field: RefObject<HTMLInputElement | null>
) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  // The sidebar's field and its results live in different parts of the
  // sidebar; there is only ever one result list on screen.
  const hits = Array.from(document.querySelectorAll<HTMLElement>('.agents-search__hit'));
  if (hits.length === 0) return;
  e.preventDefault();
  const index = hits.indexOf(document.activeElement as HTMLElement);
  const next = index + (e.key === 'ArrowDown' ? 1 : -1);
  if (next < 0) field.current?.focus();
  else hits[Math.min(next, hits.length - 1)].focus();
}

interface AgentsSearchResultsProps {
  query: string;
  field: RefObject<HTMLInputElement | null>;
  onOpen: (hit: SearchHit) => void;
}

export function AgentsSearchResults({ query, field, onOpen }: AgentsSearchResultsProps) {
  const trimmed = query.trim();
  const results = useSearch(trimmed);
  // Keep showing the last answer while the next one is on its way.
  if (!results) return null;
  if (results.error) return <p className="agents-search__note">{results.error}</p>;
  if (results.hits.length === 0) {
    return results.query === trimmed ? (
      <p className="agents-search__note">Nothing matches “{trimmed}”.</p>
    ) : null;
  }
  return (
    <div
      className="agents-search"
      role="list"
      aria-label="Search results"
      aria-busy={results.query !== trimmed || undefined}
      onKeyDown={(e) => moveHitFocus(e, field)}
    >
      {groupHits(results.hits).map(({ agentId, hits }) => (
        <div key={agentId} className="agents-search__group" role="listitem">
          <div className="agents-search__agent">
            <AgentAvatar name={hits[0].agentName} color={hits[0].agentColor} />
            <span className="agents-search__agent-name">{hits[0].agentName}</span>
          </div>
          {hits.map((hit) => {
            const speaker = hitSpeaker(hit);
            return (
              <button
                key={hit.messageId}
                type="button"
                tabIndex={0}
                className="agents-search__hit"
                onClick={() => onOpen(hit)}
              >
                <span className="agents-search__snippet">
                  {speaker && <span className="agents-search__speaker">{speaker}: </span>}
                  {highlightRuns(hit.snippet, results.query).map((run, i) =>
                    run.match ? <mark key={i}>{run.text}</mark> : run.text
                  )}
                </span>
                <span className="agents-search__time">{formatHitTime(hit.ts)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
