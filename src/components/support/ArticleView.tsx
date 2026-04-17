/**
 * Single article view with rendered markdown content.
 */

import { useState, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getArticle, recordArticleView } from '../../lib/support';
import type { LibraryArticle } from '../../lib/support';
import type { SupportView } from './SupportPanel';

interface ArticleViewProps {
  slug: string;
  onNavigate: (view: SupportView) => void;
}

export function ArticleView({ slug, onNavigate }: ArticleViewProps) {
  const [article, setArticle] = useState<LibraryArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const result = await getArticle(slug);
        if (cancelled) return;
        if (!result) {
          setError('Article not found.');
        } else {
          setArticle(result);
          void recordArticleView(slug);
        }
      } catch {
        if (!cancelled) setError('Failed to load article.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    setError(null);
    void load();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return <div className="support-loading">Loading article...</div>;
  }

  if (error || !article) {
    return <div className="support-error">{error || 'Article not found.'}</div>;
  }

  const rendered = marked.parse(article.content || '', { async: false });
  const htmlContent = DOMPurify.sanitize(String(rendered));

  return (
    <>
      <div className="support-article-header">
        <h3 className="support-article-title">{article.title}</h3>
        <div className="support-article-meta">
          {article.category && <span className="support-article-category">{article.category}</span>}
        </div>
      </div>

      <div className="support-article-content" dangerouslySetInnerHTML={{ __html: htmlContent }} />

      <div className="support-article-footer">
        <p>Still need help?</p>
        <button
          className="support-action-btn"
          onClick={() => onNavigate({ type: 'new-ticket', ticketType: 'support' })}
        >
          <span className="action-icon">💬</span>
          Contact Support
          <span className="action-arrow">→</span>
        </button>
      </div>
    </>
  );
}
