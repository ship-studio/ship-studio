/**
 * Client Agent frontend wrapper.
 *
 * Provides type-safe wrappers around Tauri invoke calls for the
 * Client AI agent (deepagents sidecar).
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
  /** Current plan/todo state from the agent's write_todos tool. */
  plan?: PlanTodo[];
  status?: 'streaming' | 'complete' | 'error';
}

/** Information about a tool call during agent execution. */
export interface ToolCallInfo {
  name: string;
  input: unknown;
  output?: unknown;
  status: 'running' | 'complete' | 'error';
  startedAt: number;
  completedAt?: number;
  /** Actual execution time measured in the sidecar (milliseconds). */
  durationMs?: number;
}

/** A single task in the agent's plan (from write_todos). */
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

/** Curated model available for the Client agent. */
export interface ClientModel {
  id: string;
  name: string;
  tier: 'free' | 'standard' | 'premium';
  description: string;
}

// ============ Model Configuration ============

/** Special model ID that enables smart routing with specialized sub-agents. */
export const TUNED_MODEL_ID = 'tuned';

/**
 * Available models for the Client agent.
 *
 * "Tuned" uses smart routing:
 *   Orchestrator: GLM-4.7 ($0.30/$1.40 per 1M tokens)
 *   Explorer: GLM-4.7 Flash ($0.06/$0.40)
 *   Coder: MiMo-V2-Flash ($0.09/$0.29)
 *   Tester: MiniMax M2.1 ($0.28/$1.20)
 *
 * All other models run in unified mode — the same model for
 * the orchestrator and all sub-agents.
 *
 * All models are under $1.50/1M output tokens. No premium models.
 */
export const CLIENT_MODELS: ClientModel[] = [
  {
    id: TUNED_MODEL_ID,
    name: 'Tuned',
    tier: 'standard',
    description: 'Smart routing — specialized models per task',
  },
  {
    id: 'xiaomi/mimo-v2-flash',
    name: 'MiMo-V2-Flash',
    tier: 'free',
    description: '309B MoE — SWE-bench competitive, $0.09/$0.29 per 1M',
  },
  {
    id: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek V3.2',
    tier: 'standard',
    description: 'Matches GPT-4o quality at 1/40th the cost',
  },
  {
    id: 'z-ai/glm-4.7',
    name: 'GLM-4.7',
    tier: 'standard',
    description: 'Strong reasoning and agent execution',
  },
  {
    id: 'minimax/minimax-m2.5',
    name: 'MiniMax M2.5',
    tier: 'standard',
    description: '80.2% SWE-Bench Verified, coding specialist',
  },
  {
    id: 'z-ai/glm-4.7-flash',
    name: 'GLM-4.7 Flash',
    tier: 'free',
    description: 'Ultra-fast and cheap — $0.06/$0.40 per 1M',
  },
];

/** Default model — smart routing with specialized sub-agents. */
export const DEFAULT_MODEL = CLIENT_MODELS[0];

// ============ Invoke Wrappers ============

/** Start the Client agent sidecar for the current window. */
export async function startClientAgent(
  windowLabel: string,
  projectPath: string,
  apiKey: string,
  model: string
): Promise<void> {
  return invoke('start_client_agent', { windowLabel, projectPath, apiKey, model });
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

/** Change the LLM model mid-session. */
export async function setClientModel(windowLabel: string, model: string): Promise<void> {
  return invoke('set_client_model', { windowLabel, model });
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

// ============ Utilities ============

/** Generate a unique message ID. */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Get a model config by its ID. Falls back to the default model. */
export function getModelById(modelId: string): ClientModel {
  return CLIENT_MODELS.find((m) => m.id === modelId) ?? DEFAULT_MODEL;
}
