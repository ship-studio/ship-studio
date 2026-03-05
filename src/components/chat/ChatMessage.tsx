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
  // ── Classic nautical ──────────────────────────────────────────
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

  // ── More sailing & seafaring ──────────────────────────────────
  'Unfurling the mainsail\u2026',
  'Tacking into the wind\u2026',
  'Dropping anchor\u2026',
  'Rigging the spinnaker\u2026',
  'Weighing anchor\u2026',
  'Splicing the mainbrace\u2026',
  'Lashing the helm\u2026',
  'Reading the tide charts\u2026',
  'Signaling the fleet\u2026',
  'Running before the wind\u2026',
  'Heaving to\u2026',
  'Checking the barometer\u2026',
  'Polishing the brass\u2026',
  'Reefing the sails\u2026',
  'Securing the boom\u2026',
  'Adjusting the ballast\u2026',
  'Coiling the ropes\u2026',
  'Taking a bearing\u2026',
  'Spotting land ho\u2026',
  'Furling the topsail\u2026',
  "Manning the crow's nest\u2026",
  'Consulting the sextant\u2026',
  'Following the North Star\u2026',
  'Launching the dinghy\u2026',
  'Hauling in the nets\u2026',
  'Studying the nautical charts\u2026',
  'Waxing the hull\u2026',
  'Mending the sails\u2026',
  'Stowing the anchor chain\u2026',
  'Lowering the gangplank\u2026',

  // ── Pirate / adventure ────────────────────────────────────────
  'Searching for buried treasure\u2026',
  'Walking the plank\u2026',
  'X marks the spot\u2026',
  'Decoding the treasure map\u2026',
  'Outrunning the kraken\u2026',
  'Counting the doubloons\u2026',
  'Raising the Jolly Roger\u2026',
  'Firing the cannons\u2026',
  'Plundering the code\u2026',
  'Boarding the mainframe\u2026',
  'Negotiating with mermaids\u2026',
  'Escaping Davy Jones\u2026',

  // ── Ship-building & engineering ───────────────────────────────
  'Caulking the seams\u2026',
  'Welding the keel\u2026',
  'Calibrating the gyroscope\u2026',
  'Pressure-testing the hull\u2026',
  'Spinning up the turbines\u2026',
  'Riveting the bulkhead\u2026',
  'Installing the rudder\u2026',
  'Tuning the engine\u2026',

  // ── Weather & ocean ───────────────────────────────────────────
  'Watching the clouds\u2026',
  'Riding the current\u2026',
  'Bracing for the storm\u2026',
  'Sailing into the sunset\u2026',
  'Navigating the doldrums\u2026',
  'Chasing the trade winds\u2026',
  'Crossing the equator\u2026',
  'Weathering the squall\u2026',

  // ── Shipping & logistics ──────────────────────────────────────
  'Shipping it\u2026',
  'Packing the containers\u2026',
  'Checking the manifest\u2026',
  'Clearing customs\u2026',
  'Filing the shipping label\u2026',
  'Tracking the shipment\u2026',
  'Express delivery incoming\u2026',

  // ── Memes & fun ───────────────────────────────────────────────
  'Downloading more RAM\u2026',
  'Asking the rubber duck\u2026',
  'Consulting Stack Overflow\u2026',
  'Blaming the intern\u2026',
  'It works on my machine\u2026',
  'Have you tried turning it off and on\u2026',
  'Reticulating splines\u2026',
  'Reversing the polarity\u2026',
  'Enhancing the algorithms\u2026',
  'Entering the mainframe\u2026',
  'Hacking the Gibson\u2026',
  'Dividing by zero\u2026',
  'Compiling the compiler\u2026',
  'Feeding the hamsters\u2026',
  'sudo make me a sandwich\u2026',
  'git push --force (just kidding)\u2026',
  'Googling the error message\u2026',
  'Updating the README (lol)\u2026',
  'Clearing the cache (again)\u2026',
  'npm install universe\u2026',
  'Mass-producing semicolons\u2026',
  'Befriending the bugs\u2026',
  'Warming up the GPU\u2026',
  'Reorganizing the node_modules\u2026',
  'Applying percussive maintenance\u2026',
  'Looking busy\u2026',
  'Pretending to type\u2026',
  'Reading the docs (for once)\u2026',
  'Summoning the mass of internet\u2026',
  'Negotiating with the API\u2026',
  'Praying to the demo gods\u2026',
  'Blowing on the cartridge\u2026',
  'Deleting node_modules (again)\u2026',
  'Turning coffee into code\u2026',
  'Rearranging deck chairs on the Titanic\u2026',
  'Abandoning ship (just kidding)\u2026',
  'All hands on deck\u2026',
  "I'm the captain now\u2026",
  "Ship it or it didn't happen\u2026",
];

/** Pick a random phrase, cycling every few seconds while visible.
 *  Returns a "typed" substring that animates in character-by-character. */
function useThinkingPhrase(active: boolean): string {
  const [phrase, setPhrase] = useState(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]
  );
  const [displayedLen, setDisplayedLen] = useState(0);
  const indexRef = useRef(0);
  const phraseRef = useRef(phrase);

  // Cycle to a new phrase every few seconds
  useEffect(() => {
    if (!active) return;
    indexRef.current = Math.floor(Math.random() * THINKING_PHRASES.length);
    const newPhrase = THINKING_PHRASES[indexRef.current];
    phraseRef.current = newPhrase;
    setPhrase(newPhrase);
    setDisplayedLen(0);

    const id = setInterval(() => {
      let next = Math.floor(Math.random() * (THINKING_PHRASES.length - 1));
      if (next >= indexRef.current) next++;
      indexRef.current = next;
      const np = THINKING_PHRASES[next];
      phraseRef.current = np;
      setPhrase(np);
      setDisplayedLen(0);
    }, 5000);
    return () => clearInterval(id);
  }, [active]);

  // Typewriter: reveal one character at a time
  useEffect(() => {
    if (!active) return;
    const target = phraseRef.current;
    if (displayedLen >= target.length) return;
    const id = setTimeout(() => setDisplayedLen((n) => n + 1), 35);
    return () => clearTimeout(id);
  }, [active, displayedLen]);

  return phrase.slice(0, displayedLen);
}

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  showPlanApproval?: boolean;
  onPlanApprove?: () => void;
  onPlanReject?: () => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  canEdit?: boolean;
}

export function ChatMessage({
  message,
  isStreaming = false,
  showPlanApproval = false,
  onPlanApprove,
  onPlanReject,
  onEditMessage,
  canEdit = false,
}: ChatMessageProps) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Show the thinking indicator whenever the agent is streaming and
  // no tool is actively running. This covers both "before first token"
  // and "between tool calls" so the user always sees the agent is working.
  const runningTool = message.toolCalls?.find((tc) => tc.status === 'running');
  const hasRunningTools = !!runningTool;
  const showThinking = isStreaming && message.status === 'streaming' && !hasRunningTools;
  const thinkingPhrase = useThinkingPhrase(showThinking);

  // For long-running tools (Agent/sub-agent), extract a description to show
  const runningToolStatus = (() => {
    if (!runningTool || !isStreaming) return null;
    if (runningTool.name === 'Agent') {
      const input = runningTool.input as Record<string, unknown> | undefined;
      const desc = input?.description as string | undefined;
      return desc ? `Sub-agent: ${desc}` : 'Running sub-agent\u2026';
    }
    return null;
  })();

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
        {/* User messages: simple text or inline editor */}
        {isUser && message.content && !isEditing && (
          <div className="chat-message-content">
            <span>{message.content}</span>
          </div>
        )}
        {isUser && isEditing && (
          <div className="chat-message-edit">
            <textarea
              ref={editRef}
              className="chat-message-edit-textarea"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const trimmed = editValue.trim();
                  if (trimmed && onEditMessage) {
                    onEditMessage(message.id, trimmed);
                    setIsEditing(false);
                  }
                } else if (e.key === 'Escape') {
                  setEditValue(message.content);
                  setIsEditing(false);
                }
              }}
              rows={2}
              autoFocus
            />
            <div className="chat-message-edit-actions">
              <button
                className="btn-primary chat-message-edit-save"
                onClick={() => {
                  const trimmed = editValue.trim();
                  if (trimmed && onEditMessage) {
                    onEditMessage(message.id, trimmed);
                    setIsEditing(false);
                  }
                }}
                disabled={!editValue.trim()}
              >
                Send
              </button>
              <button
                className="btn-secondary chat-message-edit-cancel"
                onClick={() => {
                  setEditValue(message.content);
                  setIsEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
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

        {/* Status indicator for long-running tools (sub-agents) */}
        {runningToolStatus && (
          <div className="chat-thinking">
            <div className="chat-thinking-dots">
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
            </div>
            <span>{runningToolStatus}</span>
          </div>
        )}

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

        {/* Message actions — copy, edit */}
        {message.content && message.status === 'complete' && !isEditing && (
          <div className="chat-message-actions">
            {isUser && canEdit && onEditMessage && (
              <button
                className="chat-message-action"
                onClick={() => {
                  setEditValue(message.content);
                  setIsEditing(true);
                }}
                title="Edit & resend"
              >
                Edit
              </button>
            )}
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
