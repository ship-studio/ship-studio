/**
 * Client Agent frontend wrapper.
 *
 * Provides type-safe wrappers around Tauri invoke calls for the
 * Anthropic Agent SDK sidecar.
 *
 * @module lib/client-agent
 */

import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ============ Types ============

/** A single chat message in the conversation. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  /** Ordered sequence of text and tool-call blocks for chronological rendering. */
  contentBlocks?: ContentBlock[];
  /** Current plan/todo state from the agent's TodoWrite tool. */
  plan?: PlanTodo[];
  status?: 'streaming' | 'complete' | 'error';
}

/** Information about a tool call during agent execution. */
export interface ToolCallInfo {
  name: string;
  /** Unique tool_use_id from the Agent SDK — used to match toolStart/toolEnd. */
  toolUseId?: string;
  input: unknown;
  output?: unknown;
  status: 'running' | 'complete' | 'error';
  startedAt: number;
  completedAt?: number;
  /** Actual execution time measured in the sidecar (milliseconds). */
  durationMs?: number;
  /** Tokens from the LLM reasoning step that triggered this tool call. */
  stepTokens?: number;
}

/** A single task in the agent's plan (from TodoWrite). */
export interface PlanTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** An ordered content block — either text or a tool call.
 *  Used to render text and tool calls interleaved chronologically. */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool'; toolCall: ToolCallInfo };

/** Event payload emitted from the Rust backend. */
export interface ClientAgentEvent {
  eventType: string;
  data: Record<string, unknown>;
}

/** Token usage and cost from the Agent SDK.
 *  Per-step token counts stream in live; cumulativeCost arrives at the end. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Authoritative cost — only set when the query() result arrives. */
  cumulativeCost?: number;
}

// ============ Invoke Wrappers ============

/** Start the Client agent sidecar for the current window. */
export async function startClientAgent(
  windowLabel: string,
  projectPath: string,
  apiKey: string,
  hitlEnabled?: boolean,
  spendingLimit?: number | null,
  model?: string | null
): Promise<void> {
  return invoke('start_client_agent', {
    windowLabel,
    projectPath,
    apiKey,
    hitlEnabled,
    spendingLimit,
    model,
  });
}

/** Stop the Client agent sidecar for the current window. */
export async function stopClientAgent(windowLabel: string): Promise<void> {
  return invoke('stop_client_agent', { windowLabel });
}

/** Send a chat message to the Client agent. */
export async function sendChatMessage(windowLabel: string, message: string): Promise<void> {
  return invoke('send_chat_message', { windowLabel, message });
}

/** Cancel the current generation. */
export async function cancelGeneration(windowLabel: string): Promise<void> {
  return invoke('cancel_generation', { windowLabel });
}

/** Clear the conversation history. */
export async function clearChatHistory(windowLabel: string): Promise<void> {
  return invoke('clear_chat_history', { windowLabel });
}

/** Resume after a HITL interrupt (approve or reject the pending tool call). */
export async function resumeGeneration(windowLabel: string, approved: boolean): Promise<void> {
  return invoke('resume_generation', { windowLabel, approved });
}

// ============ Event Listeners ============

/** Subscribe to Client agent events from the sidecar. Returns an unlisten function.
 * Uses window-scoped listening since the Rust backend emits via emit_to(window_label). */
export async function listenForAgentEvents(
  callback: (event: ClientAgentEvent) => void
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<ClientAgentEvent>('client-agent-event', (e) =>
    callback(e.payload)
  );
}

// ============ OpenRouter Models ============

/** Model info from OpenRouter's API. */
export interface OpenRouterModel {
  id: string;
  label: string;
  provider: string;
  inputPrice: number; // per million tokens
  outputPrice: number; // per million tokens
}

/** Curated list of model IDs we want to show (in display order). */
const CURATED_MODEL_IDS = [
  'anthropic/claude-sonnet-4.6',
  'google/gemini-3-flash-preview',
  'minimax/minimax-m2.5',
  'deepseek/deepseek-v3.2',
  'xiaomi/mimo-v2-flash',
  'moonshotai/kimi-k2.5',
];

/** Hardcoded fallback in case the API fetch fails. */
const FALLBACK_MODELS: OpenRouterModel[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    inputPrice: 3,
    outputPrice: 15,
  },
  {
    id: 'google/gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    provider: 'Google',
    inputPrice: 0.5,
    outputPrice: 3,
  },
  {
    id: 'minimax/minimax-m2.5',
    label: 'MiniMax M2.5',
    provider: 'MiniMax',
    inputPrice: 0.3,
    outputPrice: 1.2,
  },
  {
    id: 'deepseek/deepseek-v3.2',
    label: 'DeepSeek V3.2',
    provider: 'DeepSeek',
    inputPrice: 0.25,
    outputPrice: 0.4,
  },
  {
    id: 'xiaomi/mimo-v2-flash',
    label: 'MiMo-V2-Flash',
    provider: 'Xiaomi',
    inputPrice: 0.09,
    outputPrice: 0.29,
  },
  {
    id: 'moonshotai/kimi-k2.5',
    label: 'Kimi K2.5',
    provider: 'Moonshot',
    inputPrice: 0.45,
    outputPrice: 2.2,
  },
];

let cachedModels: OpenRouterModel[] | null = null;
let fetchPromise: Promise<OpenRouterModel[]> | null = null;

/** Fetch curated models from OpenRouter with live pricing. Cached for session. */
export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (cachedModels) return cachedModels;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/models');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as {
        data: Array<{
          id: string;
          name: string;
          pricing?: { prompt?: string; completion?: string };
        }>;
      };

      const modelMap = new Map(json.data.map((m) => [m.id, m]));
      const models: OpenRouterModel[] = [];

      for (const id of CURATED_MODEL_IDS) {
        const m = modelMap.get(id);
        if (!m) continue;
        const provider = id.split('/')[0];
        const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
        // OpenRouter prices are per-token, convert to per-million
        const inputPrice = parseFloat(m.pricing?.prompt ?? '0') * 1_000_000;
        const outputPrice = parseFloat(m.pricing?.completion ?? '0') * 1_000_000;
        models.push({
          id: m.id,
          label: m.name,
          provider: providerName,
          inputPrice,
          outputPrice,
        });
      }

      cachedModels = models.length > 0 ? models : FALLBACK_MODELS;
      return cachedModels;
    } catch {
      cachedModels = FALLBACK_MODELS;
      return cachedModels;
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

/** Format price for display (e.g., "$3 / $15"). */
export function formatModelPrice(model: OpenRouterModel): string {
  const fmt = (n: number) => {
    if (n === 0) return '$0';
    if (n < 0.01) return `$${n.toFixed(3)}`;
    if (n < 1) return `$${n.toFixed(2)}`;
    return `$${Math.round(n)}`;
  };
  return `${fmt(model.inputPrice)} / ${fmt(model.outputPrice)}`;
}

/** Pre-flattened model data for components that can't resolve OpenRouterModel generics. */
export interface FlatModelData {
  ids: string[];
  labels: Record<string, string>;
  prices: Record<string, string>;
}

/** Fetch models and return pre-flattened maps (avoids TS lint issues in consumers). */
export async function fetchFlatModelData(): Promise<FlatModelData> {
  const models = await fetchOpenRouterModels();
  const ids: string[] = [];
  const labels: Record<string, string> = {};
  const prices: Record<string, string> = {};
  for (const m of models) {
    ids.push(m.id);
    labels[m.id] = m.label;
    prices[m.id] = formatModelPrice(m);
  }
  return { ids, labels, prices };
}

// ============ Chat History Persistence ============

const CHAT_HISTORY_PREFIX = 'shipstudio-chat-history:';
const MAX_PERSISTED_MESSAGES = 200;

/** Save chat messages to localStorage for a project. */
export function saveChatHistory(projectPath: string, messages: ChatMessage[]): void {
  try {
    // Only persist the last N messages to avoid bloating storage
    const toSave = messages.slice(-MAX_PERSISTED_MESSAGES).map((msg) => ({
      ...msg,
      // Strip tool output from persisted messages (can be large)
      toolCalls: msg.toolCalls?.map((tc) => ({
        ...tc,
        output: undefined,
        input: tc.name === 'Bash' ? tc.input : undefined, // Keep bash commands for context
      })),
      contentBlocks: msg.contentBlocks?.map((b) =>
        b.type === 'tool' ? { ...b, toolCall: { ...b.toolCall, output: undefined } } : b
      ),
    }));
    localStorage.setItem(CHAT_HISTORY_PREFIX + projectPath, JSON.stringify(toSave));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/** Load chat messages from localStorage for a project. */
export function loadChatHistory(projectPath: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_PREFIX + projectPath);
    if (!raw) return [];
    const messages = JSON.parse(raw) as ChatMessage[];
    // Mark all as complete (they're historical)
    return messages.map((msg) => ({
      ...msg,
      status: msg.status === 'streaming' ? 'complete' : msg.status,
    }));
  } catch {
    return [];
  }
}

/** Clear persisted chat history for a project. */
export function clearPersistedChatHistory(projectPath: string): void {
  localStorage.removeItem(CHAT_HISTORY_PREFIX + projectPath);
}

// ============ Utilities ============

/** Generate a unique message ID. */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Format a dollar amount for display (e.g., 0.0023 → "$0.002", 1.5 → "$1.50"). */
export function formatCost(dollars: number): string {
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Format a token count with K/M suffixes for compact display. */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 100_000) return `${(count / 1000).toFixed(1)}K`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}K`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
