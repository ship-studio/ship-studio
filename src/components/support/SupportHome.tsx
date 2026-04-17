/**
 * Support home view with search, popular articles, help actions, and ticket link.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { searchArticles, getPopularArticles, listTickets } from '../../lib/support';
import type { LibraryArticle } from '@cstar.help/js/library';
import type { SupportView } from './SupportPanel';
import { trackEvent } from '../../lib/analytics';

interface SupportHomeProps {
  onNavigate: (view: SupportView) => void;
}

export function SupportHome({ onNavigate }: SupportHomeProps) {
  const [query, setQuery] = useState('');
  const [articles, setArticles] = useState<LibraryArticle[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [ticketCount, setTicketCount] = useState<number | null>(null);
  const [loadingArticles, setLoadingArticles] = useState(true);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Clean up search timer on unmount
  useEffect(() => {
    return () => clearTimeout(searchTimer.current);
  }, []);

  // Load popular articles on mount
  useEffect(() => {
    let cancelled = false;
    getPopularArticles(6)
      .then((results) => {
        if (!cancelled) setArticles(results);
      })
      .catch(() => {
        if (!cancelled) setArticles([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingArticles(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load ticket count on mount
  useEffect(() => {
    let cancelled = false;
    listTickets()
      .then((tickets) => {
        if (!cancelled) setTicketCount(tickets.length);
      })
      .catch(() => {
        // Not critical, hide ticket count
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced search
  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    clearTimeout(searchTimer.current);

    if (!value.trim()) {
      setIsSearching(false);
      // Reload popular articles
      getPopularArticles(6)
        .then(setArticles)
        .catch(() => setArticles([]));
      return;
    }

    searchTimer.current = setTimeout(() => {
      setIsSearching(true);
      searchArticles(value)
        .then((results) => {
          setArticles(results);
          void trackEvent('support_article_searched', { query: value });
        })
        .catch(() => setArticles([]))
        .finally(() => setIsSearching(false));
    }, 300);
  }, []);

  return (
    <div className="support-home">
      {/* Search */}
      <div className="support-search">
        <span className="support-search-icon">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          type="text"
          placeholder="Search articles..."
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {/* Articles */}
      <div className="support-section-label">
        {query.trim() ? 'Search Results' : 'Popular Articles'}
      </div>
      <div className="support-article-list">
        {loadingArticles && !query.trim() ? (
          <div className="support-loading">Loading articles...</div>
        ) : isSearching ? (
          <div className="support-loading">Searching...</div>
        ) : articles.length === 0 ? (
          <div className="support-empty">
            {query.trim() ? 'No articles found. Try a different search.' : 'No articles available.'}
          </div>
        ) : (
          articles.map((article) => (
            <button
              key={article.slug}
              className="support-article-item"
              onClick={() => {
                onNavigate({ type: 'article', slug: article.slug });
                void trackEvent('support_article_viewed', {
                  article_slug: article.slug,
                });
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              {article.title}
            </button>
          ))
        )}
      </div>

      {/* Get Help */}
      <div className="support-section-label">Get Help</div>
      <div className="support-actions">
        <button
          className="support-action-btn"
          onClick={() => onNavigate({ type: 'new-ticket', ticketType: 'bug' })}
        >
          <span className="action-icon">🐛</span>
          Report a Bug
          <span className="action-arrow">→</span>
        </button>
        <button
          className="support-action-btn"
          onClick={() => onNavigate({ type: 'new-ticket', ticketType: 'feature' })}
        >
          <span className="action-icon">💡</span>
          Request a Feature
          <span className="action-arrow">→</span>
        </button>
        <button
          className="support-action-btn"
          onClick={() => onNavigate({ type: 'new-ticket', ticketType: 'support' })}
        >
          <span className="action-icon">💬</span>
          General Support
          <span className="action-arrow">→</span>
        </button>
      </div>

      {/* Your Tickets */}
      <div className="support-section-label">Your Tickets</div>
      <button className="support-tickets-link" onClick={() => onNavigate({ type: 'tickets' })}>
        📋 View your tickets
        {ticketCount !== null && ticketCount > 0 && (
          <span className="support-ticket-badge">{ticketCount}</span>
        )}
        <span className="action-arrow" style={{ marginLeft: 'auto' }}>
          →
        </span>
      </button>
    </div>
  );
}
