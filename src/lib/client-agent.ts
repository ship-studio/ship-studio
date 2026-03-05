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
