/**
 * Apps agents can use: the user's Claude Code MCP servers, which every agent
 * turn loads. Mirrors `agents::apps` (src-tauri/src/agents/apps.rs).
 *
 * @module lib/agentApps
 */

import { invoke } from '@tauri-apps/api/core';

/** Where a server is set up, which decides whether this panel may remove it. */
export type AgentAppSource = 'user' | 'claudeAi' | 'other';

export interface AgentApp {
  name: string;
  /** The server's URL, or the command for a local one. */
  target: string;
  /** As Claude Code reported it: `connected`, `needs_auth`, `error` or `unknown`. */
  status: string;
  source: AgentAppSource;
}

export interface AgentAppSuggestion {
  serverName: string;
  title: string;
  blurb: string;
  url: string;
  added: boolean;
}

export interface AgentApps {
  connected: AgentApp[];
  suggestions: AgentAppSuggestion[];
}

export const listAgentApps = () => invoke<AgentApps>('agents_apps_list');
export const addAgentApp = (serverName: string) => invoke<void>('agents_apps_add', { serverName });
export const removeAgentApp = (name: string) => invoke<void>('agents_apps_remove', { name });

const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  needs_auth: 'Needs sign-in',
  error: 'Can’t connect',
};

/** The status in words; nothing when Claude Code didn't say. */
export const appStatusLabel = (status: string): string | null => STATUS_LABEL[status] ?? null;

/** "claude.ai Google Drive" → "Google Drive": the connector, in its own name. */
export function appTitle(app: Pick<AgentApp, 'name' | 'source'>): string {
  return app.source === 'claudeAi' ? app.name.replace(/^claude\.ai\s+/, '') : app.name;
}

/** A URL's host ("mcp.figma.com"); a local server's command as it is. */
export function appTarget(target: string): string {
  try {
    const url = new URL(target);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host;
  } catch {
    /* a command, not a URL */
  }
  return target;
}

/** Why a row has no Remove: it's managed where it was set up. */
export function appManagedWhere(source: AgentAppSource): string | null {
  if (source === 'claudeAi') return 'Managed on claude.ai';
  if (source === 'other') return 'Set up in a project or plugin';
  return null;
}
