/**
 * Individual chat message bubble.
 *
 * Renders user messages, assistant messages (with markdown),
 * and inline tool call indicators in chronological order.
 * Groups consecutive completed tool calls for compact display.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  ChatMessage as ChatMessageType,
  ContentBlock,
  ToolCallInfo,
  PlanTodo,
} from '../../lib/client-agent';
import { formatTokenCount } from '../../lib/client-agent';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallIndicator } from './ToolCallIndicator';

/** Nautical-themed thinking phrases — because this is Ship Studio. */
const THINKING_PHRASES = [
  'Thinking\u2026',
  'Charting a course\u2026',
  'Hoisting the sails\u2026',
  'Navigating\u2026',
  'Scanning the horizon\u2026',
  'Plotting coordinates\u2026',
  'Adjusting the rigging\u2026',
  'Reading the stars\u2026',
  'Catching the wind\u2026',
  'Raising the anchor\u2026',
  'Setting sail\u2026',
  'Checking the compass\u2026',
  'Trimming the jib\u2026',
  'Swabbing the deck\u2026',
  'Battening the hatches\u2026',
  'Full speed ahead\u2026',
  'Sounding the depths\u2026',
  'Tying the knots\u2026',
  'Loading the cargo\u2026',
  'Docking maneuvers\u2026',
];

/** Pick a random phrase, cycling every few seconds while visible. */
function useThinkingPhrase(active: boolean): string {
  const [phrase, setPhrase] = useState(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]
  );
  const indexRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    // Pick a fresh random one when it first becomes active
    indexRef.current = Math.floor(Math.random() * THINKING_PHRASES.length);
    setPhrase(THINKING_PHRASES[indexRef.current]);

    const id = setInterval(() => {
      // Advance to a different random phrase (avoid repeating the current one)
      let next = Math.floor(Math.random() * (THINKING_PHRASES.length - 1));
      if (next >= indexRef.current) next++;
      indexRef.current = next;
      setPhrase(THINKING_PHRASES[next]);
    }, 3000);
    return () => clearInterval(id);
  }, [active]);

  return phrase;
}

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  showPlanApproval?: boolean;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
}

export function ChatMessage({
  message,
  isStreaming = false,
  showPlanApproval = false,
  onPlanApprove,
  onPlanReject,
}: ChatMessageProps) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  // Show the thinking indicator whenever the agent is streaming and
  // no tool is actively running. This covers both "before first token"
  // and "between tool calls" so the user always sees the agent is working.
  const hasRunningTools = message.toolCalls?.some((tc) => tc.status === 'running') ?? false;
  const showThinking = isStreaming && message.status === 'streaming' && !hasRunningTools;
  const thinkingPhrase = useThinkingPhrase(showThinking);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [message.content]);

  return (
    <div className={`chat-message chat-message--${message.role}`}>
      {!isUser && (
        <div className="chat-message-avatar">
          <span className="chat-avatar-icon">{'>'}_</span>
        </div>
      )}
      <div className="chat-message-body">
        {/* User messages: simple text */}
        {isUser && message.content && (
          <div className="chat-message-content">
            <span>{message.content}</span>
          </div>
        )}

        {/* Plan indicator — shown at top of assistant message when agent has a plan */}
        {!isUser && message.plan && message.plan.length > 0 && (
          <PlanIndicator
            todos={message.plan}
            showApproval={showPlanApproval}
            onApprove={onPlanApprove}
            onReject={onPlanReject}
          />
        )}

        {/* Assistant messages: render content blocks in chronological order */}
        {!isUser && message.contentBlocks && message.contentBlocks.length > 0 ? (
          <AssistantBlocks
            blocks={message.contentBlocks}
            isStreaming={isStreaming && message.status === 'streaming'}
          />
        ) : !isUser ? (
          // Fallback for messages without contentBlocks (e.g. older messages)
          <>
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="chat-message-tools">
                {message.toolCalls.map((tc, i) => (
                  <ToolCallIndicator key={`${tc.name}-${i}`} toolCall={tc} />
                ))}
              </div>
            )}
            {message.content && (
              <div className="chat-message-content">
                <MarkdownRenderer content={message.content} />
                {isStreaming && message.status === 'streaming' && <span className="chat-cursor" />}
              </div>
            )}
          </>
        ) : null}

        {/* Thinking indicator — shown at the bottom whenever the agent
            is streaming and no tool is currently executing */}
        {showThinking && (
          <div className="chat-thinking">
            <div className="chat-thinking-dots">
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
            </div>
            <span>{thinkingPhrase}</span>
          </div>
        )}

        {/* Copy button — shown on completed messages with content */}
        {message.content && message.status === 'complete' && (
          <div className="chat-message-actions">
            <button className="chat-message-action" onClick={handleCopy} title="Copy message">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ Sub-components ============

/** A visual block group — text, single tool, or a collapsed group of tools. */
type BlockGroup =
  | { kind: 'text'; content: string; index: number }
  | { kind: 'tool'; toolCall: ToolCallInfo; index: number }
  | { kind: 'tool-group'; tools: ToolCallInfo[]; startIndex: number };

/** Groups consecutive completed tool blocks for compact display. */
function groupContentBlocks(blocks: ContentBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let pendingTools: ToolCallInfo[] = [];
  let pendingStartIndex = 0;

  function flushTools() {
    if (pendingTools.length === 0) return;
    if (pendingTools.length <= 3) {
      pendingTools.forEach((tc, i) => {
        groups.push({ kind: 'tool', toolCall: tc, index: pendingStartIndex + i });
      });
    } else {
      groups.push({ kind: 'tool-group', tools: [...pendingTools], startIndex: pendingStartIndex });
    }
    pendingTools = [];
  }

  blocks.forEach((block, i) => {
    if (block.type === 'text') {
      flushTools();
      groups.push({ kind: 'text', content: block.content, index: i });
    } else {
      if (block.toolCall.status === 'complete') {
        if (pendingTools.length === 0) pendingStartIndex = i;
        pendingTools.push(block.toolCall);
      } else {
        // Running/error tools flush any pending group and render individually
        flushTools();
        groups.push({ kind: 'tool', toolCall: block.toolCall, index: i });
      }
    }
  });
  flushTools();

  return groups;
}

/** Renders an ordered sequence of text and tool-call blocks. */
function AssistantBlocks({
  blocks,
  isStreaming,
}: {
  blocks: ContentBlock[];
  isStreaming: boolean;
}) {
  const groups = groupContentBlocks(blocks);

  return (
    <>
      {groups.map((group) => {
        if (group.kind === 'text') {
          return (
            <div key={`text-${group.index}`} className="chat-message-content">
              <MarkdownRenderer content={group.content} />
              {/* Show cursor on the last text block while streaming */}
              {isStreaming && group.index === blocks.length - 1 && <span className="chat-cursor" />}
            </div>
          );
        }
        if (group.kind === 'tool-group') {
          return <ToolGroup key={`group-${group.startIndex}`} tools={group.tools} />;
        }
        // single tool
        return (
          <div key={`tool-${group.index}`} className="chat-message-tools">
            <ToolCallIndicator toolCall={group.toolCall} />
          </div>
        );
      })}
    </>
  );
}

/** Collapsed group of completed tool calls (> 3 in a row). */
function ToolGroup({ tools }: { tools: ToolCallInfo[] }) {
  const [expanded, setExpanded] = useState(false);

  const totalDuration = tools.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
  const durationStr =
    totalDuration > 0
      ? totalDuration < 1000
        ? `${Math.round(totalDuration)}ms`
        : `${(totalDuration / 1000).toFixed(1)}s`
      : null;

  // Show tokens from the LLM reasoning step that triggered these tools
  const stepTokens = tools.find((tc) => tc.stepTokens && tc.stepTokens > 0)?.stepTokens ?? 0;
  const tokensStr = stepTokens > 0 ? formatTokenCount(stepTokens) : null;

  return (
    <div className="chat-tool-group">
      <button className="chat-tool-group-header" onClick={() => setExpanded(!expanded)}>
        <span className="chat-tool-status complete">{'\u2713'}</span>
        <span className="chat-tool-group-label">{tools.length} tool calls</span>
        {tokensStr && <span className="chat-tool-tokens">{tokensStr}</span>}
        {durationStr && <span className="chat-tool-duration">{durationStr}</span>}
        <span className={`chat-tool-chevron ${expanded ? 'expanded' : ''}`}>{'\u25B8'}</span>
      </button>
      {expanded && (
        <div className="chat-tool-group-items">
          {tools.map((tc, i) => (
            <ToolCallIndicator key={`group-tool-${i}`} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline plan/todo progress indicator. */
function PlanIndicator({
  todos,
  showApproval = false,
  onApprove,
  onReject,
}: {
  todos: PlanTodo[];
  showApproval?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;

  return (
    <div className="chat-plan">
      <button className="chat-plan-header" onClick={() => setExpanded(!expanded)}>
        <span className="chat-plan-progress">
          {completed}/{todos.length}
        </span>
        <span className="chat-plan-label">
          {showApproval
            ? 'Awaiting approval'
            : inProgress > 0
              ? 'Working...'
              : completed === todos.length
                ? 'Plan complete'
                : 'Planning'}
        </span>
        <span className={`chat-tool-chevron ${expanded ? 'expanded' : ''}`}>{'\u25B8'}</span>
      </button>
      {expanded && (
        <div className="chat-plan-items">
          {todos.map((todo, idx) => (
            <div key={idx} className={`chat-plan-item ${todo.status}`}>
              <span className="chat-plan-item-icon">
                {todo.status === 'completed'
                  ? '\u2713'
                  : todo.status === 'in_progress'
                    ? '\u25CF'
                    : '\u25CB'}
              </span>
              <span className="chat-plan-item-text">{todo.content}</span>
            </div>
          ))}
        </div>
      )}
      {showApproval && (
        <div className="chat-plan-actions">
          <button className="chat-plan-approve" onClick={onApprove}>
            Approve Plan
          </button>
          <button className="chat-plan-reject" onClick={onReject}>
            Request Changes
          </button>
        </div>
      )}
    </div>
  );
}
