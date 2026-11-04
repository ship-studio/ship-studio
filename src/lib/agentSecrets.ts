/**
 * Agents' secrets: mirrors `src-tauri/src/agents/secrets.rs`, the invoke
 * wrappers, and the composer's "that looks like a key" check.
 *
 * A value only ever travels from the card (or the composer) to Rust, which
 * puts it in the Keychain. Nothing here keeps one.
 *
 * @module lib/agentSecrets
 */

import { invoke } from '@tauri-apps/api/core';

export type SecretKind = 'password' | 'api_key' | 'token' | 'other';

/** One masked input and the variable it becomes. */
export interface SecretField {
  label: string;
  env: string;
}

/** What `request_secret` asked for, on its approval card. */
export interface SecretRequest {
  name: string;
  purpose: string;
  kind: SecretKind;
  fields: SecretField[];
  /** `secret:finance/stripe_key`. */
  reference: string;
}

/** A saved secret on an agent: never its value. */
export interface AgentSecret extends SecretRequest {
  id: string;
  createdAt: number;
  /** The last turn started with it in its environment. */
  lastUsedAt?: number;
}

export const saveSecret = (agentId: string, requestId: string, values: string[]) =>
  invoke<AgentSecret>('agents_save_secret', { agentId, requestId, values });
export const addSecret = (agentId: string, name: string, kind: SecretKind, value: string) =>
  invoke<AgentSecret>('agents_add_secret', { agentId, name, kind, value });
export const revokeSecret = (agentId: string, secretId: string) =>
  invoke<void>('agents_revoke_secret', { agentId, secretId });

/** `$STRIPE_KEY`, or `$BANK_USERNAME, $BANK_PASSWORD`. */
export const secretVars = (s: { fields: SecretField[] }) =>
  s.fields.map((f) => `$${f.env}`).join(', ');

/** Something in a draft that looks like a credential. */
export interface SecretMatch {
  value: string;
  /** "a Stripe key". */
  label: string;
  /** What to call it: becomes the variable. */
  name: string;
  kind: SecretKind;
}

/** Common key shapes, most specific first. Each pattern's last group is the value. */
const SHAPES: { re: RegExp; label: string; name: string; kind: SecretKind }[] = [
  {
    re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})/,
    label: 'a Stripe key',
    name: 'stripe_key',
    kind: 'api_key',
  },
  {
    re: /\b(sk-ant-[A-Za-z0-9_-]{20,})/,
    label: 'an Anthropic key',
    name: 'anthropic_key',
    kind: 'api_key',
  },
  {
    re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})/,
    label: 'an OpenAI key',
    name: 'openai_key',
    kind: 'api_key',
  },
  {
    re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/,
    label: 'a GitHub token',
    name: 'github_token',
    kind: 'token',
  },
  {
    re: /\b(AKIA[0-9A-Z]{16})\b/,
    label: 'an AWS access key',
    name: 'aws_access_key_id',
    kind: 'api_key',
  },
  {
    re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/,
    label: 'a Slack token',
    name: 'slack_token',
    kind: 'token',
  },
  {
    re: /\b(AIza[0-9A-Za-z_-]{35})/,
    label: 'a Google API key',
    name: 'google_api_key',
    kind: 'api_key',
  },
  {
    re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/,
    label: 'a token',
    name: 'token',
    kind: 'token',
  },
  {
    re: /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?([^\s"']{8,})/i,
    label: 'a credential',
    name: 'credential',
    kind: 'other',
  },
];

/** The first credential-shaped thing in `text`, or null. Never blocks anything. */
export function findSecret(text: string): SecretMatch | null {
  for (const shape of SHAPES) {
    const match = shape.re.exec(text);
    const value = match?.[match.length - 1];
    if (value) return { value, label: shape.label, name: shape.name, kind: shape.kind };
  }
  return null;
}
