/**
 * Support panel container with slide-out animation and view routing.
 *
 * Views:
 * - home: search, popular articles, action buttons, ticket link
 * - article: single article display
 * - new-ticket: ticket creation form (bug/feature/support)
 * - tickets: user's ticket history
 * - conversation: single ticket thread with real-time messages
 */

import { useState, useEffect, useCallback } from 'react';
import { SupportHome } from './SupportHome';
import { ArticleView } from './ArticleView';
import { NewTicketForm } from './NewTicketForm';
import { TicketList } from './TicketList';
import { ConversationView } from './ConversationView';
import { disconnectChat } from '../../lib/support';

export type SupportView =
  | { type: 'home' }
  | { type: 'article'; slug: string }
  | { type: 'new-ticket'; ticketType?: string }
  | { type: 'tickets' }
  | { type: 'conversation'; ticketId: string; subject: string };

interface SupportPanelProps {
  isOpen: boolean;
  onClose: () => void;
  projectPath?: string;
  projectName?: string;
}

export function SupportPanel({ isOpen, onClose, projectPath, projectName }: SupportPanelProps) {
  const [view, setView] = useState<SupportView>({ type: 'home' });

  const handleClose = useCallback(() => {
    setView({ type: 'home' });
    onClose();
  }, [onClose]);

  // Escape key closes panel
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, handleClose]);

  // Clean up chat client when panel unmounts
  useEffect(() => {
    return () => disconnectChat();
  }, []);

  const goHome = useCallback(() => setView({ type: 'home' }), []);
  const goBack = useCallback(() => {
    if (view.type === 'conversation') {
      setView({ type: 'tickets' });
    } else {
      setView({ type: 'home' });
    }
  }, [view.type]);

  const headerTitle = (() => {
    switch (view.type) {
      case 'home':
        return 'Support';
      case 'article':
        return 'Article';
      case 'new-ticket':
        return 'New Ticket';
      case 'tickets':
        return 'Your Tickets';
      case 'conversation':
        return view.subject;
    }
  })();

  const showBack = view.type !== 'home';

  return (
    <>
      {isOpen && <div className="support-overlay" onClick={handleClose} />}
      <div className={`support-panel ${isOpen ? 'open' : ''}`}>
        <div className="support-panel-header">
          {showBack && (
            <button
              className="support-back-btn"
              onClick={goBack}
              title="Go back"
              aria-label="Go back"
            >
              ←
            </button>
          )}
          <h2>{headerTitle}</h2>
          <button
            className="support-close-btn"
            onClick={handleClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          className={view.type === 'conversation' ? 'support-conversation' : 'support-panel-body'}
        >
          {view.type === 'home' && <SupportHome onNavigate={setView} />}
          {view.type === 'article' && <ArticleView slug={view.slug} onNavigate={setView} />}
          {view.type === 'new-ticket' && (
            <NewTicketForm
              initialType={view.ticketType}
              projectPath={projectPath}
              projectName={projectName}
              onSuccess={(conversation) =>
                setView({
                  type: 'conversation',
                  ticketId: conversation.id,
                  subject: conversation.subject,
                })
              }
              onCancel={goHome}
            />
          )}
          {view.type === 'tickets' && <TicketList onNavigate={setView} />}
          {view.type === 'conversation' && <ConversationView ticketId={view.ticketId} />}
        </div>
      </div>
    </>
  );
}
