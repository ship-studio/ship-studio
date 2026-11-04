/**
 * What a phone shows. The words are fixed here, by kind: the relay is never
 * told what an agent said or what it is called, so it cannot pass either on.
 */

import type { Kind, SendBody } from './schema';

export const TITLES: Record<Kind, string> = {
  needs_you: 'An agent needs you',
  finished: 'An agent finished',
  message: 'New message from an agent',
};

/** How a provider answered, in the three ways the relay acts on. */
export type Outcome =
  | { kind: 'sent' }
  /** The token is dead (uninstalled, or not for this app): forget it. */
  | { kind: 'gone' }
  | { kind: 'failed'; status: number };

/** One collapse key per agent and kind: a newer alert replaces the older. */
export function collapseKey(send: SendBody): string {
  return send.agent ? `${send.kind}.${send.agent}` : send.kind;
}

const encoder = new TextEncoder();

export function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A signed JWT. WebCrypto's ECDSA output is already JOSE's r‖s form. */
export async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  algorithm: Parameters<SubtleCrypto['sign']>[0]
): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(algorithm, key, encoder.encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}
