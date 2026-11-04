/**
 * Ship Studio's push relay.
 *
 * The one thing a phone can't be reached by from a Mac is a push: Apple and
 * Google only accept them from whoever holds the app's key, and that key can't
 * ship inside a desktop app. So this Worker holds it, and does nothing else.
 *
 * - A Mac creates an *installation* and gets a secret (kept only as a hash here).
 * - With it, the Mac registers each paired phone's push token under an opaque
 *   handle, sends, and revokes.
 * - A send says only which phone, which kind of alert, an opaque agent id
 *   and a badge count. Any other field is refused, so no message, name or
 *   project can reach Apple or Google through here. The words a phone shows
 *   are fixed in `alert.ts`.
 * - Nothing is logged: no `console.*` here, and Workers Logs are off.
 *
 * Routes:
 *   POST   /v1/installations   → 201 { installationId, secret }
 *   PUT    /v1/devices/:ref    { platform, token, environment } → 204
 *   DELETE /v1/devices/:ref    → 204
 *   DELETE /v1/installation    → 204 (the Mac turned push off)
 *   POST   /v1/send            { device, kind, agent?, badge? } → 200 { sent: true }
 *
 * Full design and threat model: docs/push-relay.md.
 */

import type { Outcome } from './alert';
import { apnsConfigured, sendApns } from './apns';
import type { Env } from './env';
import { fcmConfigured, sendFcm } from './fcm';
import { Invalid, isOpaque, parseRegister, parseSend } from './schema';
import {
  authenticate,
  createInstallation,
  deleteDevice,
  deleteInstallation,
  forgetToken,
  getDevice,
  hit,
  putDevice,
} from './store';

const HOUR = 60 * 60 * 1000;
/** Sends per installation and per phone, per hour. */
export const SEND_PER_INSTALLATION = 600;
export const SEND_PER_DEVICE = 60;
/** Registrations and revokes per installation, per hour. */
export const REGISTER_PER_INSTALLATION = 30;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

const empty = (status = 204) => new Response(null, { status });
const error = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { error: code, ...extra });
const limited = () => json(429, { error: 'rate_limited' }, { 'retry-after': '3600' });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env, Date.now());
    } catch (e) {
      if (e instanceof Invalid) {
        const status = e.code === 'too_large' ? 413 : 400;
        return error(status, e.code, e.field ? { field: e.field } : {});
      }
      return error(500, 'internal');
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, now: number): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === '/v1/installations') {
    if (method !== 'POST') return error(405, 'method');
    // Counted by Cloudflare's limiter on the client address; never stored here.
    const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.CREATE_LIMITER.limit({ key: address });
    if (!success) return limited();
    return json(201, await createInstallation(env.DB, now));
  }

  const installation = await authenticate(env.DB, request.headers.get('authorization'));
  if (!installation) return error(401, 'unauthorized');

  if (pathname === '/v1/installation') {
    if (method !== 'DELETE') return error(405, 'method');
    await deleteInstallation(env.DB, installation);
    return empty();
  }

  const device = /^\/v1\/devices\/([^/]+)$/.exec(pathname)?.[1];
  if (device !== undefined) {
    if (!isOpaque(device)) return error(400, 'bad_field', { field: 'device' });
    if (method !== 'PUT' && method !== 'DELETE') return error(405, 'method');
    if (!(await hit(env.DB, `i:${installation}:reg`, REGISTER_PER_INSTALLATION, HOUR, now))) {
      return limited();
    }
    if (method === 'DELETE') {
      await deleteDevice(env.DB, installation, device);
      return empty();
    }
    const body = await parseRegister(request);
    if (!(await putDevice(env.DB, installation, device, body, now))) {
      return error(409, 'too_many_devices');
    }
    return empty();
  }

  if (pathname === '/v1/send') {
    if (method !== 'POST') return error(405, 'method');
    const send = await parseSend(request);
    const row = await getDevice(env.DB, installation, send.device);
    if (!row) return error(404, 'unknown_device');
    const configured = row.platform === 'ios' ? apnsConfigured(env) : fcmConfigured(env);
    if (!configured) return error(503, 'unconfigured', { platform: row.platform });
    const within =
      (await hit(env.DB, `i:${installation}:send`, SEND_PER_INSTALLATION, HOUR, now)) &&
      (await hit(env.DB, `d:${installation}:${send.device}`, SEND_PER_DEVICE, HOUR, now));
    if (!within) return limited();
    let outcome: Outcome;
    try {
      outcome =
        row.platform === 'ios'
          ? await sendApns(env, row, send, now)
          : await sendFcm(env, row, send, now);
    } catch {
      return error(502, 'provider_unreachable');
    }
    if (outcome.kind === 'gone') {
      await forgetToken(env.DB, row.token);
      return error(410, 'gone');
    }
    if (outcome.kind === 'failed') return error(502, 'provider', { status: outcome.status });
    return json(200, { sent: true });
  }

  return error(404, 'not_found');
}
