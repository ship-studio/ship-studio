/**
 * Account (Workspace) management utilities.
 *
 * An Account ("Workspace" in the UI) isolates Claude Code login, GitHub CLI
 * login, and a small credential vault per org/client context. It's selected
 * once per session (at startup, or via "Switch Workspace") rather than
 * assigned per-project. Credential values are stored in the OS keychain —
 * this module only deals in presence/absence (AccountCredentialStatus),
 * never raw key/token values.
 *
 * @module lib/accounts
 */

import { invoke } from '@tauri-apps/api/core';

/** A Workspace for isolating Claude/GitHub config and credentials per org/client. */
export interface Account {
  id: string;
  name: string;
  /** Hex color for visual identification, e.g. "#6b7280" */
  color: string;
  /** True for the built-in Default workspace (cannot be deleted) */
  isDefault: boolean;
  /** Unix timestamp (ms) when the workspace was created */
  createdAt: number;
  /** Folder this workspace lists/creates projects in. Null/undefined → the
   *  built-in default (`~/ShipStudio`). Each workspace can use its own folder. */
  projectsRoot?: string | null;
}

/** Auth/credential status for a workspace (values stay in the keychain / CLI config). */
export interface AccountCredentialStatus {
  claudeAuthEmail: string | null;
  codexAuthEmail: string | null;
  opencodeAuthEmail: string | null;
  githubAuthEmail: string | null;
  hasAnthropicBaseUrl: boolean;
  hasVercelToken: boolean;
  hasGitName: boolean;
  hasGitEmail: boolean;
}

/** Credential key identifiers accepted by set/clear commands. */
export type CredentialKey =
  | 'anthropic_base_url'
  | 'vercel_token'
  | 'git_name'
  | 'git_email';

/** Human-readable labels for each credential key. */
export const CREDENTIAL_LABELS: Record<CredentialKey, string> = {
  anthropic_base_url: 'Anthropic Base URL',
  vercel_token: 'Vercel Token',
  git_name: 'Git Name',
  git_email: 'Git Email',
};

/**
 * One-line explanation of what each credential does, shown under its label so
 * users know exactly where the value gets used. Each is injected as an
 * environment variable into this workspace's terminals, git, and agent.
 */
export const CREDENTIAL_DESCRIPTIONS: Record<CredentialKey, string> = {
  anthropic_base_url:
    'Point Claude Code at a custom Anthropic endpoint (a proxy or gateway) instead of the default. Leave unset unless your org requires it.',
  vercel_token:
    'Lets this workspace publish to Vercel without an interactive login — use a token from a specific Vercel account or team.',
  git_name: "Sets the author name on commits made in this workspace's projects.",
  git_email: "Sets the author email on commits made in this workspace's projects.",
};

/** Credential keys that are sensitive (masked input). */
export const SENSITIVE_KEYS = new Set<CredentialKey>(['anthropic_base_url', 'vercel_token']);

/** Maps AccountCredentialStatus boolean field → CredentialKey. */
export const STATUS_FIELD_TO_KEY: Record<
  Exclude<
    keyof AccountCredentialStatus,
    'claudeAuthEmail' | 'codexAuthEmail' | 'opencodeAuthEmail' | 'githubAuthEmail'
  >,
  CredentialKey
> = {
  hasAnthropicBaseUrl: 'anthropic_base_url',
  hasVercelToken: 'vercel_token',
  hasGitName: 'git_name',
  hasGitEmail: 'git_email',
};

/** Predefined palette for workspace colors. */
export const ACCOUNT_COLORS = [
  '#6b7280', // gray (default)
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#06b6d4', // cyan
];

/**
 * Event fired on the window whenever the set of Workspaces (or the active one)
 * changes — create / update / delete / switch. `useActiveAccount` listens for
 * it so every workspace indicator (sidebar footer button, ⌘K command, etc.)
 * refreshes live instead of going stale until the next remount.
 */
export const ACCOUNTS_CHANGED_EVENT = 'shipstudio:accounts-changed';

function notifyAccountsChanged(): void {
  window.dispatchEvent(new Event(ACCOUNTS_CHANGED_EVENT));
}

export async function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>('list_accounts');
}

export async function createAccount(name: string, color: string): Promise<Account> {
  const account = await invoke<Account>('create_account', { name, color });
  notifyAccountsChanged();
  return account;
}

export async function updateAccount(id: string, name: string, color: string): Promise<Account> {
  const account = await invoke<Account>('update_account', { id, name, color });
  notifyAccountsChanged();
  return account;
}

export async function deleteAccount(id: string): Promise<void> {
  await invoke('delete_account', { id });
  notifyAccountsChanged();
}

export async function getActiveAccountId(): Promise<string> {
  return invoke<string>('get_active_account_id');
}

export async function setActiveAccountId(id: string): Promise<void> {
  await invoke('set_active_account_id', { id });
  notifyAccountsChanged();
}

export async function getAccountCredentialStatus(id: string): Promise<AccountCredentialStatus> {
  return invoke<AccountCredentialStatus>('get_account_credential_status', { id });
}

export async function setAccountCredential(
  id: string,
  key: CredentialKey,
  value: string
): Promise<void> {
  return invoke('set_account_credential', { id, key, value });
}

export async function clearAccountCredential(id: string, key: CredentialKey): Promise<void> {
  return invoke('clear_account_credential', { id, key });
}

export async function moveProjectToAccount(projectPath: string, accountId: string): Promise<void> {
  return invoke('move_project_to_account', { projectPath, accountId });
}

export async function getProjectAccountId(projectPath: string): Promise<string> {
  return invoke<string>('get_project_account_id', { projectPath });
}

/** The built-in Default workspace id (matches DEFAULT_ACCOUNT_ID in the backend). */
export const DEFAULT_ACCOUNT_ID = 'default';

/**
 * Tag a freshly created or imported project with the currently-active Workspace,
 * so it appears in the workspace the user is working in. The Default workspace
 * stays untagged (`account_id: null` — untagged always resolves to Default), so
 * this only stamps a real, non-default workspace.
 *
 * Call this once, at creation/import time. Opening a project must never change
 * its workspace. Best-effort: a failure here must not block opening the project.
 */
export async function assignActiveWorkspaceToNewProject(projectPath: string): Promise<void> {
  try {
    const activeId = await getActiveAccountId();
    if (activeId && activeId !== DEFAULT_ACCOUNT_ID) {
      await moveProjectToAccount(projectPath, activeId);
    }
  } catch {
    // Non-fatal: the project still opens; it just lands in Default until moved.
  }
}

