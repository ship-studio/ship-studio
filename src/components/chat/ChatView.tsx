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
  formatCost,
  formatTokenCount,
} from '../../lib/client-agent';
import { invoke } from '@tauri-apps/api/core';
import {
  getOpenRouterApiKey,
  setOpenRouterApiKey,
  getClientAgentHitlEnabled,
  setClientAgentHitlEnabled,
  getClientAgentSpendingLimit,
  getClientAgentModel,
  setClientAgentModel,
} from '../../lib/client-settings';
import { ChatMessages } from './ChatMessages';
import { ChatInput, type ChatInputHandle } from './ChatInput';

/** Available models for the Client agent (OpenRouter model IDs).
 *  Prices are per million tokens (input/output) from OpenRouter. */
const CLIENT_MODELS = [
  {
    id: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    price: '$3 / $15',
  },
  {
    id: 'google/gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    provider: 'Google',
    price: '$0.50 / $3',
  },
  {
    id: 'minimax/minimax-m2.5',
    label: 'MiniMax M2.5',
    provider: 'MiniMax',
    price: '$0.30 / $1.20',
  },
  {
    id: 'deepseek/deepseek-v3.2',
    label: 'DeepSeek V3.2',
    provider: 'DeepSeek',
    price: '$0.25 / $0.40',
  },
  {
    id: 'xiaomi/mimo-v2-flash',
    label: 'MiMo-V2-Flash',
    provider: 'Xiaomi',
    price: '$0.09 / $0.29',
  },
  { id: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5', provider: 'Moonshot', price: '$0.45 / $2.20' },
] as const;

const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-4-6';

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
  const [claudeNotInstalled, setClaudeNotInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Token & cost tracking — tokens stream live, cost arrives at query end
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [totalCost, setTotalCost] = useState(0);

  // HITL state
  const [hitlEnabled, setHitlEnabled] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    toolName: string;
    toolInput: unknown;
  } | null>(null);
  const [autoApproveSession, setAutoApproveSession] = useState(false);

  // Plan-based approval state (shield mode)
  const [planNeedsApproval, setPlanNeedsApproval] = useState(false);

  // Model selection
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const inputRef = useRef<ChatInputHandle>(null);
  const windowLabel = useRef(getCurrentWindow().label);
  const unlistenRef = useRef<(() => void) | null>(null);
  const streamContentRef = useRef('');
  const activeToolCallsRef = useRef<ToolCallInfo[]>([]);
  const contentBlocksRef = useRef<ContentBlock[]>([]);
  const initGenRef = useRef(0); // tracks initialization generation to prevent stale updates
  const handleAgentEventRef = useRef<(event: ClientAgentEvent) => void>(() => {});

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
            toolUseId: (data.toolUseId as string) || undefined,
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
          const toolUseId = (data.toolUseId as string) || '';
          const toolName = (data.name as string) || 'unknown';
          const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined;

          // Match by toolUseId (unique per tool call) — falls back to name match
          activeToolCallsRef.current = activeToolCallsRef.current.map((tc) => {
            const matchById = toolUseId && tc.toolUseId === toolUseId;
            const matchByName = !toolUseId && tc.name === toolName && tc.status === 'running';
            if ((matchById || matchByName) && tc.status === 'running') {
              return {
                ...tc,
                status: 'complete',
                output: data.output,
                completedAt: Date.now(),
                durationMs,
              };
            }
            return tc;
          });

          // Update the matching tool block in the ordered sequence
          for (let i = contentBlocksRef.current.length - 1; i >= 0; i--) {
            const block = contentBlocksRef.current[i];
            if (block.type === 'tool' && block.toolCall.status === 'running') {
              const matchById = toolUseId && block.toolCall.toolUseId === toolUseId;
              const matchByName = !toolUseId && block.toolCall.name === toolName;
              if (matchById || matchByName) {
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
          // Fallback: plan update from on_tool_start (when write_todos runs
          // without interrupt, e.g. HITL disabled).  The primary path is via
          // stream/interrupt above when HITL is on.
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
          // Live per-step token counts
          if (typeof data.inputTokens === 'number') setTotalInputTokens(data.inputTokens);
          if (typeof data.outputTokens === 'number') setTotalOutputTokens(data.outputTokens);
          // Authoritative cost (only set on result message)
          if (typeof data.cumulativeCost === 'number') setTotalCost(data.cumulativeCost);
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
          const toolName = (data.toolName as string) || 'unknown';

          if (toolName === 'write_todos') {
            // Shield mode: agent proposed a plan via write_todos.
            // Extract the plan from the tool input and attach it to the
            // streaming message so the plan-detection useEffect shows
            // approval buttons once the stream ends (stream/done).
            const input = data.toolInput as Record<string, unknown> | undefined;
            const rawTodos = input?.todos ?? input;
            if (Array.isArray(rawTodos)) {
              const plan: PlanTodo[] = rawTodos.map((t: unknown) => {
                if (typeof t === 'string') {
                  return { content: t, status: 'pending' as const };
                }
                const obj = t as Record<string, unknown>;
                return {
                  content: (obj.content ?? obj.task ?? obj.description ?? String(t)) as string,
                  status: 'pending' as const, // always pending — plan hasn't been approved yet
                };
              });
              setMessages((prev) =>
                prev.map((msg) => (msg.id === streamingMessageId ? { ...msg, plan } : msg))
              );
            }
            // Don't set pendingApproval — the plan UI handles this via
            // planNeedsApproval + handlePlanApprove/handlePlanReject.
            onStatusChange?.('waiting', 'Awaiting plan approval');
          } else {
            // Regular HITL: agent paused on a destructive tool
            setPendingApproval({
              toolName,
              toolInput: data.toolInput,
            });
            onStatusChange?.('waiting', 'Awaiting approval');
          }
          break;
        }

        case 'stream/done': {
          // Force-close any tool calls still marked as 'running' — this handles
          // edge cases where on_tool_end was missed (e.g., sub-agent tools
          // suppressed or stream ended early).
          const now = Date.now();
          activeToolCallsRef.current = activeToolCallsRef.current.map((tc) =>
            tc.status === 'running' ? { ...tc, status: 'complete' as const, completedAt: now } : tc
          );
          for (const block of contentBlocksRef.current) {
            if (block.type === 'tool' && block.toolCall.status === 'running') {
              block.toolCall = { ...block.toolCall, status: 'complete', completedAt: now };
            }
          }

          // Finalize the streaming message
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === streamingMessageId) {
                return {
                  ...msg,
                  status: 'complete',
                  toolCalls: [...activeToolCallsRef.current],
                  contentBlocks: [...contentBlocksRef.current],
                };
              }
              return msg;
            })
          );
          setIsStreaming(false);
          setStreamingMessageId(null);
          streamContentRef.current = '';
          activeToolCallsRef.current = [];
          contentBlocksRef.current = [];
          onStatusChange?.('waiting', 'Client');
          break;
        }

        case 'stream/error': {
          const errorMsg = (data.message as string) || (data.error as string) || 'Unknown error';
          const errorText = `\n\n_Error: ${errorMsg}_`;
          // Add error as a text content block so it renders in the ordered sequence
          contentBlocksRef.current.push({ type: 'text', content: errorText });
          streamContentRef.current += errorText;

          // Force-close any running tool calls
          const errNow = Date.now();
          activeToolCallsRef.current = activeToolCallsRef.current.map((tc) =>
            tc.status === 'running' ? { ...tc, status: 'error' as const, completedAt: errNow } : tc
          );
          for (const block of contentBlocksRef.current) {
            if (block.type === 'tool' && block.toolCall.status === 'running') {
              block.toolCall = { ...block.toolCall, status: 'error', completedAt: errNow };
            }
          }

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageId
                ? {
                    ...msg,
                    status: 'error',
                    content: streamContentRef.current,
                    toolCalls: [...activeToolCallsRef.current],
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
          setPendingApproval(null);
          onStatusChange?.('waiting', 'Client');
          break;
        }

        case 'exit':
          setIsInitialized(false);
          setIsStreaming(false);
          setPendingApproval(null);
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

      // Check for Claude Code global install
      const claudeStatus = await invoke<{ installed: boolean; version: string | null }>(
        'check_claude_cli_status'
      );
      if (!claudeStatus.installed) {
        if (gen === initGenRef.current) setClaudeNotInstalled(true);
        return;
      }
      if (gen === initGenRef.current) setClaudeNotInstalled(false);

      // Check for API key
      const apiKey = await getOpenRouterApiKey();
      if (!apiKey) {
        if (gen === initGenRef.current) setNeedsApiKey(true);
        return;
      }

      // Load HITL and spending limit settings
      const savedHitl = await getClientAgentHitlEnabled();
      if (gen !== initGenRef.current) return;
      setHitlEnabled(savedHitl);

      const spendingLimit = await getClientAgentSpendingLimit();
      if (gen !== initGenRef.current) return;

      // Load saved model preference
      const savedModel = await getClientAgentModel();
      if (gen !== initGenRef.current) return;
      setSelectedModel(savedModel);

      // Start the sidecar — Rust kills any existing sidecar for this
      // window first, then spawns a new one and sends the initialize RPC.
      await startClientAgent(
        windowLabel.current,
        projectPath,
        apiKey,
        savedHitl,
        spendingLimit || undefined,
        savedModel
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
    setTotalCost(0);
    setTotalInputTokens(0);
    setTotalOutputTokens(0);
    try {
      await clearChatHistoryRpc(windowLabel.current);
    } catch {
      // Best-effort
    }
  }, []);

  const handleToggleHitl = useCallback(async () => {
    if (isStreaming) return;
    const newValue = !hitlEnabled;
    setHitlEnabled(newValue);
    setAutoApproveSession(false);
    await setClientAgentHitlEnabled(newValue);
    // Restart sidecar since permissionMode is set at agent creation time
    setIsInitialized(false);
    setTotalCost(0);
    setTotalInputTokens(0);
    setTotalOutputTokens(0);
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

  // ============ Plan-Based Approval (Shield Mode) ============

  // Detect when the agent has written a plan and is waiting for approval.
  // Triggers when: shield is on, streaming stopped, last assistant message
  // is complete and has a plan where all items are still pending.
  useEffect(() => {
    if (!hitlEnabled || isStreaming) {
      setPlanNeedsApproval(false);
      return;
    }
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (
      lastAssistant &&
      lastAssistant.status === 'complete' &&
      lastAssistant.plan &&
      lastAssistant.plan.length > 0 &&
      lastAssistant.plan.every((t) => t.status === 'pending')
    ) {
      setPlanNeedsApproval(true);
    } else {
      setPlanNeedsApproval(false);
    }
  }, [messages, hitlEnabled, isStreaming]);

  const handlePlanApprove = useCallback(() => {
    setPlanNeedsApproval(false);
    // Set up a new streaming message so the resumed stream has a target for tokens
    const newMsgId = generateMessageId();
    const assistantMsg: ChatMessage = {
      id: newMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [],
    };
    setMessages((prev) => [...prev, assistantMsg]);
    setIsStreaming(true);
    setStreamingMessageId(newMsgId);
    streamContentRef.current = '';
    activeToolCallsRef.current = [];
    contentBlocksRef.current = [];
    onStatusChange?.('thinking', 'Client');
    void handleApproval(true);
  }, [handleApproval, onStatusChange]);

  const handlePlanReject = useCallback(() => {
    setPlanNeedsApproval(false);
    // Set up a new streaming message for the agent's revised response
    const newMsgId = generateMessageId();
    const assistantMsg: ChatMessage = {
      id: newMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [],
    };
    setMessages((prev) => [...prev, assistantMsg]);
    setIsStreaming(true);
    setStreamingMessageId(newMsgId);
    streamContentRef.current = '';
    activeToolCallsRef.current = [];
    contentBlocksRef.current = [];
    onStatusChange?.('thinking', 'Client');
    void handleApproval(false);
  }, [handleApproval, onStatusChange]);

  // ============ Approval Keyboard Shortcuts ============
  useEffect(() => {
    if (!pendingApproval) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleApproval(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void handleApproval(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pendingApproval, handleApproval]);

  // ============ Auto-Approve in Session ============
  // When auto-approve is on and an interrupt arrives, immediately approve it.
  useEffect(() => {
    if (autoApproveSession && pendingApproval) {
      void handleApproval(true);
    }
  }, [autoApproveSession, pendingApproval, handleApproval]);

  // ============ Model Dropdown Close ============
  useEffect(() => {
    if (!showModelDropdown) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelDropdown]);

  const handleModelChange = useCallback(
    async (modelId: string) => {
      setShowModelDropdown(false);
      if (modelId === (selectedModel ?? DEFAULT_MODEL_ID)) return;
      setSelectedModel(modelId);
      await setClientAgentModel(modelId);
      // Restart sidecar with new model
      setIsInitialized(false);
      setTotalCost(0);
      setTotalInputTokens(0);
      setTotalOutputTokens(0);
      void initialize(++initGenRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedModel]
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

  // ============ Claude Code Not Installed ============
  if (claudeNotInstalled) {
    return (
      <div className="chat-view">
        <div className="chat-setup">
          <div className="chat-setup-icon">{'>'}_</div>
          <h3 className="chat-setup-title">Claude Code Required</h3>
          <p className="chat-setup-description">
            Ship Studio&apos;s AI agent requires Claude Code to be installed globally on your
            system. Claude Code powers the underlying agent runtime.
          </p>
          <a
            href="https://docs.anthropic.com/en/docs/claude-code"
            target="_blank"
            rel="noopener noreferrer"
            className="chat-setup-link"
          >
            Install Claude Code
          </a>
          <div className="chat-setup-form" style={{ marginTop: 12 }}>
            <button
              className="btn-primary chat-setup-btn"
              onClick={() => {
                setClaudeNotInstalled(false);
                void initialize(++initGenRef.current);
              }}
            >
              Retry
            </button>
          </div>
          <p className="chat-setup-hint">Run: npm install -g @anthropic-ai/claude-code</p>
        </div>
      </div>
    );
  }

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

  // Format tool input as a concise, human-readable summary for the approval modal
  const formatToolSummary = (name: string, input: unknown): string => {
    if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
    const data = input as Record<string, unknown>;

    switch (name) {
      case 'Write': {
        const path = (data.file_path ?? data.path) as string | undefined;
        const content = (data.content ?? '') as string;
        const lines = content.split('\n').length;
        return path ? `${path}\n(${lines} lines)` : `(${lines} lines)`;
      }
      case 'Edit': {
        const path = (data.file_path ?? data.path) as string | undefined;
        const oldStr = ((data.old_string ?? '') as string).slice(0, 200);
        const newStr = ((data.new_string ?? '') as string).slice(0, 200);
        return [
          path ?? 'unknown file',
          `- ${oldStr}${oldStr.length >= 200 ? '...' : ''}`,
          `+ ${newStr}${newStr.length >= 200 ? '...' : ''}`,
        ].join('\n');
      }
      case 'Bash': {
        const cmd = (data.command ?? data.cmd ?? '') as string;
        return cmd;
      }
      case 'git_add': {
        const paths = data.paths as string[] | undefined;
        return paths ? paths.join('\n') : '';
      }
      case 'git_commit': {
        return (data.message ?? '') as string;
      }
      default: {
        // Compact JSON for anything else
        try {
          return JSON.stringify(input, null, 2);
        } catch {
          return JSON.stringify(data);
        }
      }
    }
  };

  // Human-friendly tool name for the approval modal
  const toolLabel = (name: string): string => {
    const labels: Record<string, string> = {
      Read: 'Read file',
      Write: 'Write file',
      Edit: 'Edit file',
      Bash: 'Run command',
      Glob: 'Find files',
      Grep: 'Search files',
      WebSearch: 'Web search',
      WebFetch: 'Fetch page',
      TodoWrite: 'Update plan',
      git_status: 'Git status',
      git_diff: 'Git diff',
      git_log: 'Git log',
      git_add: 'Stage files',
      git_commit: 'Git commit',
    };
    return labels[name] ?? name;
  };

  return (
    <div className="chat-view">
      {/* Header with HITL toggle, cost counter, and actions */}
      <div className="chat-header">
        <div className="chat-header-left" ref={modelDropdownRef}>
          <button
            className="chat-model-selector"
            onClick={() => !isStreaming && setShowModelDropdown((v) => !v)}
            disabled={isStreaming}
          >
            <span className="chat-model-name">
              {CLIENT_MODELS.find((m) => m.id === (selectedModel ?? DEFAULT_MODEL_ID))?.label ??
                'Claude Sonnet 4.6'}
            </span>
            <span className="chat-model-chevron">{'\u25BE'}</span>
          </button>
          {showModelDropdown && (
            <div className="chat-model-dropdown">
              {CLIENT_MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`chat-model-option ${m.id === (selectedModel ?? DEFAULT_MODEL_ID) ? 'active' : ''}`}
                  onClick={() => void handleModelChange(m.id)}
                >
                  <span className="chat-model-option-label">{m.label}</span>
                  <span className="chat-model-option-price">{m.price}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="chat-header-right">
          {(totalInputTokens > 0 || totalCost > 0) && (
            <span
              className="chat-token-counter"
              title={`Input: ${totalInputTokens.toLocaleString()} | Output: ${totalOutputTokens.toLocaleString()}${totalCost > 0 ? ` | Cost: ${formatCost(totalCost)}` : ''}`}
            >
              {formatTokenCount(totalInputTokens + totalOutputTokens)}
              {totalCost > 0 && ` · ${formatCost(totalCost)}`}
            </span>
          )}
          <button
            className={`chat-header-btn chat-hitl-toggle ${hitlEnabled ? 'active' : ''} ${autoApproveSession ? 'auto-approve' : ''}`}
            onClick={() => {
              if (autoApproveSession) {
                // Clicking shield while auto-approve is on: turn off auto-approve, keep shield on
                setAutoApproveSession(false);
              } else {
                void handleToggleHitl();
              }
            }}
            title={
              autoApproveSession
                ? 'Auto-approve ON — click to re-enable per-tool approval'
                : hitlEnabled
                  ? 'Shield ON — confirms before destructive actions'
                  : 'Shield OFF — agent runs freely'
            }
            disabled={isStreaming}
          >
            {'\u{1F6E1}'}
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
      <ChatMessages
        messages={messages}
        streamingMessageId={streamingMessageId}
        planNeedsApproval={planNeedsApproval}
        onPlanApprove={handlePlanApprove}
        onPlanReject={handlePlanReject}
      />

      {/* HITL Approval Modal */}
      {pendingApproval && (
        <div className="chat-approval-overlay">
          <div className="chat-approval-modal">
            <div className="chat-approval-header">
              Agent wants to: <strong>{toolLabel(pendingApproval.toolName)}</strong>
            </div>
            <pre className="chat-approval-input">
              {formatToolSummary(pendingApproval.toolName, pendingApproval.toolInput)}
            </pre>
            <div className="chat-approval-actions">
              <button className="btn-primary" onClick={() => void handleApproval(true)}>
                Approve <span className="chat-approval-hint">Enter</span>
              </button>
              <button
                className="btn-primary chat-approve-all-btn"
                onClick={() => {
                  setAutoApproveSession(true);
                  void handleApproval(true);
                }}
                title="Auto-approve all tool calls for this session"
              >
                Approve All
              </button>
              <button className="btn-secondary" onClick={() => void handleApproval(false)}>
                Reject <span className="chat-approval-hint">Esc</span>
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
