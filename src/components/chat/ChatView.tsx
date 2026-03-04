/**
 * Main chat view container for the Client agent.
 *
 * Manages the sidecar lifecycle, event subscription, and message state.
 * Implements TerminalHandle for compatibility with the tab management system.
 */

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { TerminalHandle, AgentStatus } from '../Terminal';
import type {
  ChatMessage,
  ToolCallInfo,
  ContentBlock,
  ClientAgentEvent,
  PlanTodo,
} from '../../lib/client-agent';
import {
  startClientAgent,
  stopClientAgent,
  sendChatMessage,
  cancelGeneration,
  clearChatHistory as clearChatHistoryRpc,
  resumeGeneration,
  listenForAgentEvents,
  generateMessageId,
  getModelById,
  formatTokenCount,
  DEFAULT_MODEL,
  CLIENT_MODELS,
} from '../../lib/client-agent';
import {
  getOpenRouterApiKey,
  setOpenRouterApiKey,
  getClientAgentModel,
  setClientAgentModel,
  getClientAgentHitlEnabled,
  setClientAgentHitlEnabled,
  getClientAgentSpendingLimit,
} from '../../lib/client-settings';
import { ChatMessages } from './ChatMessages';
import { ChatInput, type ChatInputHandle } from './ChatInput';

interface ChatViewProps {
  projectPath: string;
  onStatusChange?: (status: AgentStatus, title: string) => void;
}

export const ChatView = forwardRef<TerminalHandle, ChatViewProps>(function ChatView(
  { projectPath, onStatusChange },
  ref
) {
  // ============ State ============
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL.id);
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // Token tracking
  const [totalTokens, setTotalTokens] = useState(0);

  // HITL state
  const [hitlEnabled, setHitlEnabled] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    toolName: string;
    toolInput: unknown;
  } | null>(null);

  const inputRef = useRef<ChatInputHandle>(null);
  const windowLabel = useRef(getCurrentWindow().label);
  const unlistenRef = useRef<(() => void) | null>(null);
  const streamContentRef = useRef('');
  const activeToolCallsRef = useRef<ToolCallInfo[]>([]);
  const contentBlocksRef = useRef<ContentBlock[]>([]);
  const initGenRef = useRef(0); // tracks initialization generation to prevent stale updates
  const handleAgentEventRef = useRef<(event: ClientAgentEvent) => void>(() => {});
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ============ Terminal Handle (tab management compatibility) ============
  useImperativeHandle(ref, () => ({
    focus() {
      inputRef.current?.focus();
    },
    write(data: string) {
      // External write = submit as a message
      if (data.trim()) {
        void handleSend(data.trim());
      }
    },
    paste(data: string) {
      inputRef.current?.setValue(data);
      inputRef.current?.focus();
    },
    kill() {
      unlistenRef.current?.();
      unlistenRef.current = null;
      void stopClientAgent(windowLabel.current).catch(() => {});
    },
  }));

  // ============ Close dropdown on outside click ============
  useEffect(() => {
    if (!showModelDropdown) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showModelDropdown]);

  // ============ Event Handler ============
  const handleAgentEvent = useCallback(
    (event: ClientAgentEvent) => {
      const { eventType, data } = event;

      switch (eventType) {
        case 'ready':
          setIsInitialized(true);
          setError(null);
          break;

        case 'stream/token': {
          const token = (data.token as string) || '';
          streamContentRef.current += token;

          // Append token to the last text block, or create a new one
          const blocks = contentBlocksRef.current;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.content += token;
          } else {
            blocks.push({ type: 'text', content: token });
          }

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageId
                ? { ...msg, content: streamContentRef.current, contentBlocks: [...blocks] }
                : msg
            )
          );
          break;
        }

        case 'stream/toolStart': {
          const toolCall: ToolCallInfo = {
            name: (data.name as string) || 'unknown',
            input: data.input,
            status: 'running',
            startedAt: Date.now(),
            stepTokens: typeof data.stepTokens === 'number' ? data.stepTokens : undefined,
          };
          activeToolCallsRef.current = [...activeToolCallsRef.current, toolCall];

          // Add tool block to the ordered sequence
          contentBlocksRef.current.push({ type: 'tool', toolCall });

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageId
                ? {
                    ...msg,
                    toolCalls: [...activeToolCallsRef.current],
                    contentBlocks: [...contentBlocksRef.current],
                  }
                : msg
            )
          );
          onStatusChange?.('thinking', 'Executing tool...');
          break;
        }

        case 'stream/toolEnd': {
          const toolName = (data.name as string) || 'unknown';
          const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined;
          activeToolCallsRef.current = activeToolCallsRef.current.map((tc) =>
            tc.name === toolName && tc.status === 'running'
              ? {
                  ...tc,
                  status: 'complete',
                  output: data.output,
                  completedAt: Date.now(),
                  durationMs,
                }
              : tc
          );

          // Update the matching tool block in the ordered sequence
          for (let i = contentBlocksRef.current.length - 1; i >= 0; i--) {
            const block = contentBlocksRef.current[i];
            if (
              block.type === 'tool' &&
              block.toolCall.name === toolName &&
              block.toolCall.status === 'running'
            ) {
              block.toolCall = {
                ...block.toolCall,
                status: 'complete',
                output: data.output,
                completedAt: Date.now(),
                durationMs,
              };
              break;
            }
          }

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageId
                ? {
                    ...msg,
                    toolCalls: [...activeToolCallsRef.current],
                    contentBlocks: [...contentBlocksRef.current],
                  }
                : msg
            )
          );
          break;
        }

        case 'stream/planUpdate': {
          // Normalize plan data from deepagents write_todos tool
          const rawTodos = data.todos;
          if (Array.isArray(rawTodos)) {
            const plan: PlanTodo[] = rawTodos.map((t: unknown) => {
              if (typeof t === 'string') {
                return { content: t, status: 'pending' as const };
              }
              const obj = t as Record<string, unknown>;
              return {
                content: (obj.content ?? obj.task ?? obj.description ?? String(t)) as string,
                status: (obj.status ?? 'pending') as PlanTodo['status'],
              };
            });
            setMessages((prev) =>
              prev.map((msg) => (msg.id === streamingMessageId ? { ...msg, plan } : msg))
            );
          }
          break;
        }

        case 'stream/tokenUsage': {
          const cumulativeInput = (data.cumulativeInput as number) ?? 0;
          const cumulativeOutput = (data.cumulativeOutput as number) ?? 0;
          setTotalTokens(cumulativeInput + cumulativeOutput);
          break;
        }

        case 'stream/costWarning': {
          const percentUsed = (data.percentUsed as number) ?? 0;
          const limit = (data.limit as number) ?? 0;
          // Insert a system message about cost warning
          const warningMsg: ChatMessage = {
            id: generateMessageId(),
            role: 'system',
            content: `Spending limit warning: ${percentUsed}% of $${limit.toFixed(2)} used.`,
            timestamp: Date.now(),
            status: 'complete',
          };
          setMessages((prev) => [...prev, warningMsg]);
          break;
        }

        case 'stream/interrupt': {
          // HITL: agent paused, waiting for approval
          setPendingApproval({
            toolName: (data.toolName as string) || 'unknown',
            toolInput: data.toolInput,
          });
          onStatusChange?.('waiting', 'Awaiting approval');
          break;
        }

        case 'stream/done':
          // Finalize the streaming message
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageId ? { ...msg, status: 'complete' } : msg
            )
          );
          setIsStreaming(false);
          setStreamingMessageId(null);
          streamContentRef.current = '';
          activeToolCallsRef.current = [];
          contentBlocksRef.current = [];
          onStatusChange?.('waiting', 'Client');
          break;

        case 'stream/error': {
          const errorMsg = (data.error as string) || 'Unknown error';
          const errorText = `\n\n_Error: ${errorMsg}_`;
          // Add error as a text content block so it renders in the ordered sequence
          contentBlocksRef.current.push({ type: 'text', content: errorText });
          streamContentRef.current += errorText;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageId
                ? {
                    ...msg,
                    status: 'error',
                    content: streamContentRef.current,
                    contentBlocks: [...contentBlocksRef.current],
                  }
                : msg
            )
          );
          setIsStreaming(false);
          setStreamingMessageId(null);
          streamContentRef.current = '';
          activeToolCallsRef.current = [];
          contentBlocksRef.current = [];
          onStatusChange?.('waiting', 'Client');
          break;
        }

        case 'error': {
          const errData = data as { message?: string };
          setError(errData.message || 'Agent error');
          setIsStreaming(false);
          setStreamingMessageId(null);
          onStatusChange?.('waiting', 'Client');
          break;
        }

        case 'exit':
          setIsInitialized(false);
          setIsStreaming(false);
          setError('Agent process exited unexpectedly. Click Retry to restart.');
          break;

        case 'response':
          // RPC response acknowledgements — no UI action needed
          break;
      }
    },
    [streamingMessageId, onStatusChange]
  );

  // Keep the ref pointing to the latest handler so the Tauri event
  // listener (registered once) always dispatches to the current closure.
  handleAgentEventRef.current = handleAgentEvent;

  // ============ Lifecycle ============
  useEffect(() => {
    // Bump generation so stale async callbacks are ignored.
    const gen = ++initGenRef.current;
    void initialize(gen);

    return () => {
      // Only unsubscribe from events. Do NOT stop the sidecar here —
      // React StrictMode double-mounts cause cleanup to race with the
      // next mount's startClientAgent. The Rust side already kills any
      // existing sidecar for the same window before spawning a new one.
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  async function initialize(gen: number) {
    try {
      // Remove any stale event listener before starting. This ensures we
      // don't receive an 'exit' event from the OLD sidecar that Rust kills
      // during startClientAgent.
      unlistenRef.current?.();
      unlistenRef.current = null;

      // Check for API key
      const apiKey = await getOpenRouterApiKey();
      if (!apiKey) {
        if (gen === initGenRef.current) setNeedsApiKey(true);
        return;
      }

      // Get selected model (fall back to default if not set)
      const savedModel = await getClientAgentModel();
      const model = savedModel || DEFAULT_MODEL.id;
      if (gen !== initGenRef.current) return;
      setSelectedModel(model);

      // Load HITL and spending limit settings
      const savedHitl = await getClientAgentHitlEnabled();
      if (gen !== initGenRef.current) return;
      setHitlEnabled(savedHitl);

      const spendingLimit = await getClientAgentSpendingLimit();
      if (gen !== initGenRef.current) return;

      // Start the sidecar — Rust kills any existing sidecar for this
      // window first, then spawns a new one and sends the initialize RPC.
      await startClientAgent(
        windowLabel.current,
        projectPath,
        apiKey,
        model,
        savedHitl,
        spendingLimit || undefined
      );
      if (gen !== initGenRef.current) return;

      // NOW subscribe to events for the new sidecar (after old one is gone).
      // Use the ref indirection so the listener always calls the latest handler
      // (handleAgentEvent captures streamingMessageId which changes per-message).
      const unlisten = await listenForAgentEvents((event) => handleAgentEventRef.current(event));
      if (gen !== initGenRef.current) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;

      setIsInitialized(true);
      setError(null);
      onStatusChange?.('waiting', 'Client');
    } catch (err) {
      if (gen !== initGenRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to start Client agent: ${message}`);
    }
  }

  // ============ Actions ============
  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isStreaming) return;

      // Add user message
      const userMsg: ChatMessage = {
        id: generateMessageId(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        status: 'complete',
      };

      // Add placeholder for assistant response
      const assistantMsg: ChatMessage = {
        id: generateMessageId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
        toolCalls: [],
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setStreamingMessageId(assistantMsg.id);
      streamContentRef.current = '';
      activeToolCallsRef.current = [];
      contentBlocksRef.current = [];
      onStatusChange?.('thinking', 'Client');

      try {
        await sendChatMessage(windowLabel.current, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsg.id
              ? { ...msg, status: 'error', content: `_Error: ${message}_` }
              : msg
          )
        );
        setIsStreaming(false);
        setStreamingMessageId(null);
        onStatusChange?.('waiting', 'Client');
      }
    },
    [isStreaming, onStatusChange]
  );

  const handleCancel = useCallback(async () => {
    try {
      await cancelGeneration(windowLabel.current);
    } catch {
      // Best-effort cancel
    }
    setIsStreaming(false);
    setStreamingMessageId(null);
    onStatusChange?.('waiting', 'Client');
  }, [onStatusChange]);

  const handleClearChat = useCallback(async () => {
    setMessages([]);
    setTotalTokens(0);
    try {
      await clearChatHistoryRpc(windowLabel.current);
    } catch {
      // Best-effort
    }
  }, []);

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (modelId === selectedModel || isStreaming) return;
      setSelectedModel(modelId);
      setShowModelDropdown(false);
      // Save preference
      await setClientAgentModel(modelId);
      // Restart sidecar with new model
      setIsInitialized(false);
      setTotalTokens(0);
      void initialize(++initGenRef.current);
    },
    [selectedModel, isStreaming]
  );

  const handleToggleHitl = useCallback(async () => {
    if (isStreaming) return;
    const newValue = !hitlEnabled;
    setHitlEnabled(newValue);
    await setClientAgentHitlEnabled(newValue);
    // Restart sidecar since interruptOn is set at agent creation time
    setIsInitialized(false);
    setTotalTokens(0);
    void initialize(++initGenRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitlEnabled, isStreaming]);

  const handleApproval = useCallback(
    async (approved: boolean) => {
      setPendingApproval(null);
      onStatusChange?.('thinking', 'Client');
      try {
        await resumeGeneration(windowLabel.current, approved);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: generateMessageId(),
            role: 'system',
            content: `_Error resuming: ${message}_`,
            timestamp: Date.now(),
            status: 'error',
          },
        ]);
        setIsStreaming(false);
        setStreamingMessageId(null);
        onStatusChange?.('waiting', 'Client');
      }
    },
    [onStatusChange]
  );

  // ============ API Key Setup ============
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  const handleSaveApiKey = useCallback(async () => {
    const key = apiKeyInput.trim();
    if (!key) return;

    setIsSavingKey(true);
    setApiKeyError(null);
    try {
      await setOpenRouterApiKey(key);
      setNeedsApiKey(false);
      // Re-initialize now that we have a key
      void initialize(++initGenRef.current);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApiKeyError(`Failed to save API key: ${message}`);
    } finally {
      setIsSavingKey(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyInput]);

  if (needsApiKey) {
    return (
      <div className="chat-view">
        <div className="chat-setup">
          <div className="chat-setup-icon">{'>'}_</div>
          <h3 className="chat-setup-title">Configure OpenRouter API Key</h3>
          <p className="chat-setup-description">
            The Client agent uses OpenRouter to connect to AI models. You'll need an API key to get
            started.
          </p>
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="chat-setup-link"
          >
            Get an API key at openrouter.ai/keys
          </a>
          <div className="chat-setup-form">
            <input
              type="password"
              className="chat-setup-input"
              placeholder="sk-or-v1-..."
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && apiKeyInput.trim()) {
                  void handleSaveApiKey();
                }
              }}
              autoFocus
            />
            <button
              className="btn-primary chat-setup-btn"
              onClick={() => void handleSaveApiKey()}
              disabled={!apiKeyInput.trim() || isSavingKey}
            >
              {isSavingKey ? 'Saving...' : 'Save & Start'}
            </button>
          </div>
          {apiKeyError && <p className="chat-setup-error">{apiKeyError}</p>}
          <p className="chat-setup-hint">
            Your key is stored locally and never sent to Ship Studio servers.
          </p>
        </div>
      </div>
    );
  }

  // ============ Error State ============
  if (error && !isInitialized) {
    return (
      <div className="chat-view">
        <div className="chat-setup">
          <div className="chat-setup-icon chat-error-icon">!</div>
          <h3 className="chat-setup-title">Connection Error</h3>
          <p className="chat-setup-description">{error}</p>
          <button
            className="btn-secondary"
            onClick={() => {
              setError(null);
              void initialize(++initGenRef.current);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ============ Main Chat UI ============
  const currentModel = getModelById(selectedModel);

  // Format tool input for the approval modal
  const formatToolInput = (input: unknown): string => {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  };

  // Human-friendly tool name for the approval modal
  const toolLabel = (name: string): string => {
    const labels: Record<string, string> = {
      write_file: 'Write file',
      edit_file: 'Edit file',
      execute: 'Run command',
      git_commit: 'Git commit',
    };
    return labels[name] ?? name;
  };

  return (
    <div className="chat-view">
      {/* Header with model selector, HITL toggle, token counter, and actions */}
      <div className="chat-header">
        <div className="chat-header-left" ref={dropdownRef}>
          <button
            className="chat-model-selector"
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            disabled={isStreaming}
          >
            <span className="chat-model-name">{currentModel.name}</span>
            <span className="chat-model-chevron">{'\u25BE'}</span>
          </button>
          {showModelDropdown && (
            <div className="chat-model-dropdown">
              {CLIENT_MODELS.map((model) => (
                <button
                  key={model.id}
                  className={`chat-model-option ${model.id === selectedModel ? 'active' : ''}`}
                  onClick={() => void handleModelChange(model.id)}
                >
                  <span className="chat-model-option-name">{model.name}</span>
                  <span className={`chat-model-tier ${model.tier}`}>{model.tier}</span>
                  {model.id === selectedModel && (
                    <span className="chat-model-check">{'\u2713'}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="chat-header-right">
          {totalTokens > 0 && (
            <span className="chat-token-counter" title={`Total tokens used this session`}>
              {formatTokenCount(totalTokens)} tokens
            </span>
          )}
          <button
            className={`chat-header-btn chat-hitl-toggle ${hitlEnabled ? 'active' : ''}`}
            onClick={() => void handleToggleHitl()}
            title={
              hitlEnabled
                ? 'Shield ON — confirms before destructive actions'
                : 'Shield OFF — agent runs freely'
            }
            disabled={isStreaming}
          >
            {hitlEnabled ? '\u{1F6E1}' : '\u{1F6E1}'}
          </button>
          <button
            className="chat-header-btn"
            onClick={() => void handleClearChat()}
            title="Clear chat"
            disabled={isStreaming}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Messages */}
      <ChatMessages messages={messages} streamingMessageId={streamingMessageId} />

      {/* HITL Approval Modal */}
      {pendingApproval && (
        <div className="chat-approval-overlay">
          <div className="chat-approval-modal">
            <div className="chat-approval-header">
              Agent wants to: <strong>{toolLabel(pendingApproval.toolName)}</strong>
            </div>
            <pre className="chat-approval-input">{formatToolInput(pendingApproval.toolInput)}</pre>
            <div className="chat-approval-actions">
              <button className="btn-primary" onClick={() => void handleApproval(true)}>
                Approve
              </button>
              <button className="btn-secondary" onClick={() => void handleApproval(false)}>
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <ChatInput
        ref={inputRef}
        onSend={(text) => void handleSend(text)}
        isStreaming={isStreaming}
        onCancel={() => void handleCancel()}
        disabled={(!isInitialized && !error) || !!pendingApproval}
        placeholder={
          pendingApproval
            ? 'Waiting for approval...'
            : !isInitialized
              ? 'Connecting...'
              : 'Send a message...'
        }
      />
    </div>
  );
});
