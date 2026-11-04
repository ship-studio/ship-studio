/**
 * Pairing and the plain-HTTP endpoints.
 *
 * The QR code holds a link, not a secret: a one-time pairing code that dies
 * after five minutes or one use, and the ways to reach the Mac. The device
 * token that follows is issued over the encrypted connection and never shown.
 */

import type { DevicePlatform, Route } from './model';
import type { ProtocolRange } from './version';

export const PAIRING_SCHEME = 'shipstudio-companion';
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** What a pairing QR code (or a pasted link) carries. */
export interface PairingLink {
  /** Link format version, independent of the protocol version. */
  v: 1;
  /** One-time pairing code, 128 bits, base32. */
  code: string;
  /** The Mac's stable id, so a re-pair replaces rather than duplicates it. */
  serverId: string;
  /** The Mac's name, for "Pair with Julian's MacBook Pro?". */
  name: string;
  routes: Route[];
}

/** `shipstudio-companion://pair?d=<base64url(JSON)>`. A custom scheme, so the camera opens the app. */
export function formatPairingLink(link: PairingLink): string {
  return `${PAIRING_SCHEME}://pair?d=${toBase64Url(JSON.stringify(link))}`;
}

/** The link's contents, or null for anything that isn't a well-formed v1 pairing link. */
export function parsePairingLink(text: string): PairingLink | null {
  const match = new RegExp(`^${PAIRING_SCHEME}://pair\\?d=([A-Za-z0-9_-]+)$`).exec(text.trim());
  if (!match) return null;
  try {
    const link = JSON.parse(fromBase64Url(match[1])) as Partial<PairingLink>;
    if (link.v !== 1 || typeof link.code !== 'string' || typeof link.serverId !== 'string') {
      return null;
    }
    if (typeof link.name !== 'string' || !Array.isArray(link.routes) || !link.routes.length) {
      return null;
    }
    const routesOk = link.routes.every(
      (r) =>
        (r.kind === 'tailscale' || r.kind === 'lan') &&
        typeof r.url === 'string' &&
        r.url.startsWith('https://') &&
        // A LAN route is only usable with its certificate pin.
        (r.kind !== 'lan' || typeof r.pin === 'string')
    );
    return routesOk ? (link as PairingLink) : null;
  } catch {
    return null;
  }
}

/** `POST /v1/pair`. Held open until the user allows or denies it on the Mac (at most 120 s). */
export interface PairRequest {
  code: string;
  device: {
    name: string;
    platform: DevicePlatform;
    model?: string;
    appVersion: string;
    build: 'official' | 'self';
  };
  protocol: ProtocolRange;
  /**
   * X25519 public key, base64url. Unused by direct routes; kept so the future
   * relay can encrypt end to end without pairing again.
   */
  publicKey: string;
}

export type PairResponse =
  | {
      ok: true;
      deviceId: string;
      /** 256-bit device token. Shown nowhere; the phone keeps it in the keychain. */
      token: string;
      serverId: string;
      /** For the future relay. Empty until a Mac issues one (P1 doesn't). */
      serverPublicKey: string;
    }
  | {
      ok: false;
      reason: 'expired' | 'used' | 'denied' | 'timeout' | 'update_app' | 'update_mac';
      message: string;
    };

/**
 * The HTTP endpoints besides pairing. All take `Authorization: Bearer <token>`.
 * Big files stay off the socket so a 25 MB upload never holds up a message.
 */
export const HTTP = {
  pair: '/v1/pair',
  ws: '/v1/ws',
  /** PUT, raw body; `X-Name` header (URI-encoded) and `Content-Type`. Answers a `BlobRef`. Staged for 1 hour. */
  uploadBlob: '/v1/blobs',
  /** GET: a blob the Mac produced (screenshot, fetched path). Supports `Range`. */
  blob: (blobId: string) => `/v1/blobs/${encodeURIComponent(blobId)}`,
  /** GET: a chat attachment, by its path relative to the agent's home. `?w=` for an image thumbnail. */
  attachment: (agentId: string, path: string) =>
    `/v1/agents/${encodeURIComponent(agentId)}/attachments/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
} as const;

// ---- base64url without Buffer (the phone has no Node) -----------------------

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
