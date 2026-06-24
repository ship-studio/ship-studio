/**
 * Thin wrappers over the agent-management backend commands surfaced on the
 * dashboard (install/auth/uninstall lifecycle, rich per-agent status).
 *
 * Keep `invoke` calls here so components import typed functions instead.
 *
 * @module lib/agents-management
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Rich per-agent status returned by the backend for the dashboard panel. */
export interface AgentStatus {
  id: string;
  displayName: string;
  binaryName: string;
  installed: boolean;
  version: string | null;
  authed: boolean;
  /** Signed-in account email when known (currently Claude Code, per active
   *  workspace). Null when not connected or identity is unknown. */
  authEmail: string | null;
  /** True when previously connected but the credential expired — drives the
   *  red stroke + inline Reconnect. Never true for the never-connected state. */
  needsReconnect: boolean;
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

/**
 * Backend-owned PTY connect flow for a (non-default) workspace's Claude login.
 *
 * `claude setup-token` is interactive — it prints an auth URL and waits for the
 * user to paste back a code — so the backend runs it in a real pseudo-terminal,
 * streams the output here as `claude-connect-data` events, and accepts
 * keystrokes via {@link claudeConnectWrite}. The reader thread scrapes the
 * printed `sk-ant-…` token, stores it in the workspace vault, redacts it from
 * the stream, and emits `claude-connect-captured` — so the secret is handled
 * entirely in Rust and never reaches this layer. `email` is display-only.
 *
 * Wired event-style (mirrors {@link module:lib/ptySession}): the caller owns a
 * stable `sessionId`, calls `start` once, subscribes to the data/captured/exit
 * events, and calls {@link claudeConnectClose} on teardown.
 */
export async function claudeConnectStart(args: {
  sessionId: string;
  accountId: string;
  email?: string;
  cols: number;
  rows: number;
}): Promise<void> {
  await invoke('claude_connect_start', {
    sessionId: args.sessionId,
    id: args.accountId,
    email: args.email ?? null,
    cols: args.cols,
    rows: args.rows,
  });
}

/** Forward keystrokes (e.g. the pasted code) to a connect PTY. */
export async function claudeConnectWrite(sessionId: string, data: string): Promise<void> {
  const bytes = Array.from(new TextEncoder().encode(data));
  await invoke('claude_connect_write', { sessionId, data: bytes });
}

/** Resize a connect PTY to match the on-screen terminal. */
export async function claudeConnectResize(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  await invoke('claude_connect_resize', { sessionId, cols, rows });
}

/** Kill a connect PTY and drop its backend registry entry. Idempotent. */
export async function claudeConnectClose(sessionId: string): Promise<void> {
  await invoke('claude_connect_close', { sessionId });
}

/** Subscribe to a connect session's terminal output (raw bytes for xterm). */
export async function onClaudeConnectData(
  sessionId: string,
  handler: (bytes: Uint8Array) => void
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; data: number[] }>('claude-connect-data', (event) => {
    if (event.payload.sessionId !== sessionId) return;
    handler(new Uint8Array(event.payload.data));
  });
}

/** Fires once the token has been captured + stored in Rust (the success
 *  signal). Payload never carries the token. */
export async function onClaudeConnectCaptured(
  sessionId: string,
  handler: () => void
): Promise<UnlistenFn> {
  return listen<{ sessionId: string }>('claude-connect-captured', (event) => {
    if (event.payload.sessionId !== sessionId) return;
    handler();
  });
}

/** Fires when the connect process exits (clean or not). */
export async function onClaudeConnectExit(
  sessionId: string,
  handler: (exitCode: number) => void
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; exitCode: number }>('claude-connect-exit', (event) => {
    if (event.payload.sessionId !== sessionId) return;
    handler(event.payload.exitCode);
  });
}

/** Disconnect a workspace's Claude login (clears its stored token + email). */
export async function disconnectClaudeAccount(accountId: string): Promise<void> {
  return invoke('disconnect_claude_account', { id: accountId });
}
