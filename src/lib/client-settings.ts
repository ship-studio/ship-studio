/**
 * Client Agent settings management.
 *
 * Persists OpenRouter API key and spending limits
 * via the Tauri backend's AppState.
 *
 * @module lib/client-settings
 */

import { invoke } from '@tauri-apps/api/core';

/** Get the stored OpenRouter API key (null if not set). */
export async function getOpenRouterApiKey(): Promise<string | null> {
  return invoke<string | null>('get_openrouter_api_key');
}

/** Set or clear the OpenRouter API key. */
export async function setOpenRouterApiKey(apiKey: string | null): Promise<void> {
  return invoke('set_openrouter_api_key', { apiKey });
}

/** Get the monthly spending limit in USD. */
export async function getClientAgentSpendingLimit(): Promise<number> {
  return invoke<number>('get_client_agent_spending_limit');
}

/** Set the monthly spending limit in USD. */
export async function setClientAgentSpendingLimit(limit: number): Promise<void> {
  return invoke('set_client_agent_spending_limit', { limit });
}

/** Get whether human-in-the-loop is enabled for the Client agent. */
export async function getClientAgentHitlEnabled(): Promise<boolean> {
  return invoke<boolean>('get_client_agent_hitl_enabled');
}

/** Set whether human-in-the-loop is enabled. */
export async function setClientAgentHitlEnabled(enabled: boolean): Promise<void> {
  return invoke('set_client_agent_hitl_enabled', { enabled });
}
