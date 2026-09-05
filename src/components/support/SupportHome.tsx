/**
 * Support home view with search, popular articles, help actions, and ticket link.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { searchArticles, getPopularArticles, listTickets } from '../../lib/support';
import type { LibraryArticle } from '@cstar.help/js/library';
import type { SupportView } from './SupportPanel';
import { trackEvent } from '../../lib/analytics';
import { FileTextIcon, SearchIcon, SlackIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { SLACK_INVITE_URL } from '../../lib/links';

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
        .then((results) => setArticles(results))
        .catch(() => setArticles([]))
        .finally(() => setIsSearching(false));
    }, 300);
  }, []);

  return (
    <div className="support-home">
      {/* Slack community CTA */}
      <button
        className="support-slack-cta"
        onClick={() => {
          void openUrl(SLACK_INVITE_URL);
          void trackEvent('support_slack_cta_clicked');
        }}
      >
        <SlackIcon size={18} />
        <span className="support-slack-cta-text">
          <strong>Join the Slack</strong> — chat with the team and other builders.
        </span>
        <span className="support-slack-cta-arrow">→</span>
      </button>

      {/* Search */}
      <div className="support-search">
        <span className="support-search-icon">
          <SearchIcon size={14} />
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
              <FileTextIcon size={14} />
              {article.title}
            </button>
          ))
        )}
      </div>

      {/* Get Help */}
      <div className="support-section-label">Get Help</div>
      <div className="support-actions">
        <Button
          variant="secondary"
          width="fill"
          className="support-action-btn"
          onClick={() => onNavigate({ type: 'new-ticket', ticketType: 'bug' })}
        >
          <span className="action-icon">🐛</span>
          Report a Bug
          <span className="action-arrow">→</span>
        </Button>
        <Button
          variant="secondary"
          width="fill"
          className="support-action-btn"
          onClick={() => onNavigate({ type: 'new-ticket', ticketType: 'feature' })}
        >
          <span className="action-icon">💡</span>
          Request a Feature
          <span className="action-arrow">→</span>
        </Button>
        <Button
          variant="secondary"
          width="fill"
          className="support-action-btn"
          onClick={() => onNavigate({ type: 'new-ticket', ticketType: 'support' })}
        >
          <span className="action-icon">💬</span>
          General Support
          <span className="action-arrow">→</span>
        </Button>
      </div>

      {/* Your Tickets */}
      <div className="support-section-label">Your Tickets</div>
      <Button
        variant="secondary"
        width="fill"
        className="support-action-btn"
        onClick={() => onNavigate({ type: 'tickets' })}
      >
        📋 View your tickets
        {ticketCount !== null && ticketCount > 0 && (
          <span className="support-ticket-badge">{ticketCount}</span>
        )}
        <span className="action-arrow" style={{ marginLeft: 'auto' }}>
          →
        </span>
      </Button>
    </div>
  );
}
