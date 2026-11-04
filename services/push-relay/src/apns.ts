/** Apple Push Notification service, with token (JWT) auth from the `.p8` key. */

import { collapseKey, pemToDer, signJwt, TITLES, type Outcome } from './alert';
import type { Env } from './env';
import type { SendBody } from './schema';
import type { DeviceRow } from './store';

/** Apple wants a provider token reused, and refreshed within the hour. */
const TOKEN_TTL_MS = 50 * 60 * 1000;
/** Undelivered alerts are stale after this. */
const EXPIRY_S = 60 * 60;

let cached: { jwt: string; at: number; keyId: string } | null = null;

export function apnsConfigured(env: Env): boolean {
  return Boolean(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
}

/** For tests, and after Apple rejects the token. */
export function resetApnsToken() {
  cached = null;
}

async function providerToken(env: Env, now: number): Promise<string> {
  if (cached && cached.keyId === env.APNS_KEY_ID && now - cached.at < TOKEN_TTL_MS) {
    return cached.jwt;
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(env.APNS_KEY!),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const jwt = await signJwt(
    { alg: 'ES256', kid: env.APNS_KEY_ID },
    { iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) },
    key,
    { name: 'ECDSA', hash: 'SHA-256' }
  );
  cached = { jwt, at: now, keyId: env.APNS_KEY_ID! };
  return jwt;
}

/**
 * The whole payload. `body` is where expo-notifications reads a remote
 * notification's `data` from on iOS; it carries only the agent id and kind.
 */
export function apnsPayload(send: SendBody) {
  const needsYou = send.kind === 'needs_you';
  return {
    aps: {
      alert: { title: TITLES[send.kind] },
      ...(send.badge !== undefined ? { badge: send.badge } : {}),
      ...(needsYou ? { sound: 'default' } : {}),
      // The agent is blocked on an answer; Focus may let that through.
      'interruption-level': needsYou ? 'time-sensitive' : 'active',
      ...(send.agent ? { 'thread-id': send.agent } : {}),
    },
    body: { kind: send.kind, ...(send.agent ? { agentId: send.agent } : {}) },
  };
}

export async function sendApns(
  env: Env,
  device: DeviceRow,
  send: SendBody,
  now: number
): Promise<Outcome> {
  const host =
    device.environment === 'development' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const response = await fetch(`https://${host}/3/device/${device.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${await providerToken(env, now)}`,
      'apns-topic': env.APNS_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(now / 1000) + EXPIRY_S),
      'apns-collapse-id': collapseKey(send),
      'content-type': 'application/json',
    },
    body: JSON.stringify(apnsPayload(send)),
  });
  if (response.ok) return { kind: 'sent' };
  const reason = await response
    .json<{ reason?: string }>()
    .then((r) => r.reason ?? '')
    .catch(() => '');
  if (
    response.status === 410 ||
    reason === 'BadDeviceToken' ||
    reason === 'DeviceTokenNotForTopic' ||
    reason === 'Unregistered'
  ) {
    return { kind: 'gone' };
  }
  if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') resetApnsToken();
  return { kind: 'failed', status: response.status };
}
