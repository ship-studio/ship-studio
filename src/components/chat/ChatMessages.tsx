/**
 * Scrollable chat message list.
 *
 * Auto-scrolls to bottom on new messages unless the user has scrolled up.
 * Uses native scrolling (not OverlayScrollbars) to avoid layout wrapping issues.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { ChatMessage as ChatMessageType } from '../../lib/client-agent';
import { ChatMessage } from './ChatMessage';

interface ChatMessagesProps {
  messages: ChatMessageType[];
  streamingMessageId: string | null;
  planNeedsApproval?: boolean;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
}

export function ChatMessages({
  messages,
  streamingMessageId,
  planNeedsApproval = false,
  onPlanApprove,
  onPlanReject,
}: ChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Track manual scrolling
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    userScrolledUp.current = !atBottom;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Auto-scroll to bottom when new messages arrive or stream updates
  useEffect(() => {
    if (userScrolledUp.current) return;
    if (!containerRef.current) return;

    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [messages, streamingMessageId]);

  if (messages.length === 0) {
    return (
      <div className="chat-messages chat-messages-empty" data-os-init="" ref={containerRef}>
        <div className="chat-empty-state">
          <div className="chat-empty-icon">{'>'}_</div>
          <div className="chat-empty-title">Client Agent</div>
          <div className="chat-empty-description">
            Ask me to help with your project — I can read and edit files, run commands, and plan
            complex tasks.
          </div>
        </div>
      </div>
    );
  }

  // Find the last assistant message to attach plan approval buttons
  const lastAssistantId = planNeedsApproval
    ? [...messages].reverse().find((m) => m.role === 'assistant')?.id
    : null;

  return (
    <div className="chat-messages" data-os-init="" ref={containerRef}>
      {messages.map((msg) => (
        <ChatMessage
          key={msg.id}
          message={msg}
          isStreaming={msg.id === streamingMessageId}
          showPlanApproval={msg.id === lastAssistantId}
          onPlanApprove={onPlanApprove}
          onPlanReject={onPlanReject}
        />
      ))}
    </div>
  );
}
