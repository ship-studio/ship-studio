/**
 * Thin wrappers over the agent-management backend commands surfaced on the
 * dashboard (install/auth/uninstall lifecycle, rich per-agent status).
 *
 * Keep `invoke` calls here so components import typed functions instead.
 *
 * @module lib/agents-management
 */

import { invoke } from '@tauri-apps/api/core';

/** Rich per-agent status returned by the backend for the dashboard panel. */
export interface AgentStatus {
  id: string;
  displayName: string;
  binaryName: string;
  installed: boolean;
  version: string | null;
  authed: boolean;
  isDefault: boolean;
  installSupported: boolean;
  uninstallSupported: boolean;
}

/** Fetch every known agent's status in one round-trip. */
export async function getAgentsStatus(): Promise<AgentStatus[]> {
  return invoke<AgentStatus[]>('get_agents_status');
}

/** Remove an agent's auth indicator files; binary is left intact. */
export async function signOutAgent(agentId: string): Promise<void> {
  return invoke('sign_out_agent', { agentId });
}

/** Run the agent's uninstall command (best-effort, idempotent). */
export async function uninstallAgent(agentId: string): Promise<string> {
  return invoke<string>('uninstall_agent', { agentId });
}
