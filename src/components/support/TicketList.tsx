/**
 * User's ticket history view.
 * Uses ChatClient.conversations.list() for authenticated ticket listing.
 */

import { useState, useEffect } from 'react';
import { listTickets, formatRelativeTime } from '../../lib/support';
import type { Conversation } from '../../lib/support';
import type { SupportView } from './SupportPanel';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface TicketListProps {
  onNavigate: (view: SupportView) => void;
}

export function TicketList({ onNavigate }: TicketListProps) {
  const [tickets, setTickets] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    listTickets()
      .then((result) => {
        if (!cancelled) setTickets(result);
      })
      .catch((e) => {
        if (!cancelled) setError(formatCommandError(asCommandError(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="support-loading">Loading tickets...</div>;
  }

  if (error) {
    return <div className="support-error">{error}</div>;
  }

  if (tickets.length === 0) {
    return (
      <div className="support-empty">
        <div className="support-empty-icon">📋</div>
        <p>No tickets yet — we're here when you need us.</p>
      </div>
    );
  }

  return (
    <div className="support-ticket-list">
      {tickets.map((ticket) => (
        <button
          key={ticket.id}
          className="support-ticket-item"
          onClick={() =>
            onNavigate({
              type: 'conversation',
              ticketId: ticket.id,
              subject: ticket.subject,
            })
          }
        >
          <div className="support-ticket-item-header">
            <span className="support-ticket-item-subject">{ticket.subject}</span>
            <span className={`support-ticket-status ${ticket.status.toLowerCase()}`}>
              {ticket.status}
            </span>
          </div>
          <div className="support-ticket-item-meta">{formatRelativeTime(ticket.createdAt)}</div>
        </button>
      ))}
    </div>
  );
}
