/**
 * Chat input area with auto-resizing textarea.
 *
 * Enter sends the message, Shift+Enter inserts a newline.
 * Shows a Send button (becomes Cancel during streaming).
 */

import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';

interface ChatInputProps {
  onSend: (message: string) => void;
  isStreaming: boolean;
  onCancel: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export interface ChatInputHandle {
  focus: () => void;
  setValue: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, isStreaming, onCancel, disabled = false, placeholder = 'Send a message...' },
  ref
) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus();
    },
    setValue(text: string) {
      setValue(text);
    },
  }));

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const maxHeight = 6 * 20; // ~6 lines
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [value]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isStreaming) return;
    onSend(trimmed);
    setValue('');
  }, [value, disabled, isStreaming, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div className="chat-input-area">
      <div className="chat-input-wrapper">
        <textarea
          ref={textareaRef}
          className="chat-input-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
        />
        {isStreaming ? (
          <button className="chat-input-btn chat-input-cancel" onClick={onCancel} title="Cancel">
            Stop
          </button>
        ) : (
          <button
            className="chat-input-btn chat-input-send"
            onClick={handleSubmit}
            disabled={disabled || !value.trim()}
            title="Send (Enter)"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
});
