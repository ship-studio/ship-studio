/** Firebase Cloud Messaging (HTTP v1), for Android. Optional: off without its secret. */

import { collapseKey, pemToDer, signJwt, TITLES, type Outcome } from './alert';
import type { Env } from './env';
import type { SendBody } from './schema';
import type { DeviceRow } from './store';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cached: { token: string; until: number } | null = null;

export function resetFcmToken() {
  cached = null;
}

function account(env: Env): ServiceAccount | null {
  try {
    const a = JSON.parse(env.FCM_SERVICE_ACCOUNT ?? '') as Partial<ServiceAccount>;
    return a.project_id && a.client_email && a.private_key ? (a as ServiceAccount) : null;
  } catch {
    return null;
  }
}

export function fcmConfigured(env: Env): boolean {
  return account(env) !== null;
}

/** A Google OAuth access token from the service account, cached until near expiry. */
async function accessToken(a: ServiceAccount, now: number): Promise<string> {
  if (cached && now < cached.until) return cached.token;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(a.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: a.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    },
    key,
    { name: 'RSASSA-PKCS1-v1_5' }
  );
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`oauth ${response.status}`);
  const { access_token, expires_in } = await response.json<{
    access_token: string;
    expires_in: number;
  }>();
  cached = { token: access_token, until: now + (expires_in - 300) * 1000 };
  return access_token;
}

export function fcmMessage(device: DeviceRow, send: SendBody) {
  const tag = collapseKey(send);
  return {
    message: {
      token: device.token,
      notification: { title: TITLES[send.kind] },
      // FCM data values must be strings.
      data: { kind: send.kind, ...(send.agent ? { agentId: send.agent } : {}) },
      android: {
        priority: 'HIGH',
        collapse_key: tag,
        notification: {
          tag,
          ...(send.badge !== undefined ? { notification_count: send.badge } : {}),
        },
      },
    },
  };
}

export async function sendFcm(
  env: Env,
  device: DeviceRow,
  send: SendBody,
  now: number
): Promise<Outcome> {
  const a = account(env)!;
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken(a, now)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(fcmMessage(device, send)),
    }
  );
  if (response.ok) return { kind: 'sent' };
  const text = await response.text().catch(() => '');
  if (response.status === 404 || text.includes('UNREGISTERED')) return { kind: 'gone' };
  if (response.status === 401) resetFcmToken();
  return { kind: 'failed', status: response.status };
}
