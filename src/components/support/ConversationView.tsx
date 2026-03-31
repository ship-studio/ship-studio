/**
 * Single ticket conversation using ChatClient SDK for messages.
 * Subscribes to real-time message updates via onMessage.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getTicketMessages,
  sendTicketMessage,
  onTicketMessage,
  formatRelativeTime,
} from '../../lib/support';
import type { WidgetMessage } from '../../lib/support';
import { trackEvent } from '../../lib/analytics';

interface ConversationViewProps {
  ticketId: string;
}

export function ConversationView({ ticketId }: ConversationViewProps) {
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Load messages and subscribe to real-time updates
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    getTicketMessages(ticketId)
      .then((msgs) => {
        if (!cancelled) {
          setMessages(msgs);
          setLoading(false);
          setTimeout(scrollToBottom, 50);

          // Subscribe to new messages after initial load
          unsubscribe = onTicketMessage(ticketId, (msg) => {
            setMessages((prev) => {
              // Deduplicate — the message might already be in the list
              if (prev.some((m) => m.id === msg.id)) return prev;
              return [...prev, msg];
            });
            setTimeout(scrollToBottom, 50);
          });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [ticketId, scrollToBottom]);

  const handleSend = async () => {
    const text = reply.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      const sent = await sendTicketMessage(ticketId, text);
      setMessages((prev) => {
        if (prev.some((m) => m.id === sent.id)) return prev;
        return [...prev, sent];
      });
      setReply('');
      void trackEvent('support_ticket_replied', { $screen_name: 'Support' });
      setTimeout(scrollToBottom, 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="support-messages">
        <div className="support-loading">Loading messages...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="support-messages">
        <div className="support-error">{error}</div>
      </div>
    );
  }

  return (
    <>
      <div className="support-messages">
        {messages.length === 0 && (
          <div className="support-empty">
            <p>No messages yet. Your ticket has been submitted.</p>
          </div>
        )}
        {messages.map((msg) => {
          const isCustomer = msg.sender === 'customer';
          return (
            <div key={msg.id} className={`support-message ${isCustomer ? 'customer' : 'agent'}`}>
              <span className="support-message-sender">
                {isCustomer ? 'You' : msg.sender_name || 'Ship Studio Team'}
              </span>
              <div className="support-message-bubble">{msg.content}</div>
              <span className="support-message-time">{formatRelativeTime(msg.created_at)}</span>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      <div className="support-reply-input">
        <input
          type="text"
          placeholder="Type a reply..."
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={sending}
        />
        <button onClick={() => void handleSend()} disabled={!reply.trim() || sending}>
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </>
  );
}
