import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { SEND_PER_DEVICE } from '../src/index';
import { resetApnsToken } from '../src/apns';
import { resetFcmToken } from '../src/fcm';
import type { Env } from '../src/env';
import { sha256Hex } from '../src/store';

const IOS_TOKEN = 'a1'.repeat(32);
const FCM_TOKEN = 'fcm_token:' + 'x'.repeat(40);
const AGENT = '0123456789abcdef0123456789abcdef';

let apnsPublic: CryptoKey;
let apnsPem: string;
let fcmAccount: string;

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

beforeAll(async () => {
  const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  apnsPublic = ec.publicKey;
  apnsPem = toPem(
    (await crypto.subtle.exportKey('pkcs8', ec.privateKey)) as ArrayBuffer,
    'PRIVATE KEY'
  );
  const rsa = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  fcmAccount = JSON.stringify({
    project_id: 'shipstudio-test',
    client_email: 'push@shipstudio-test.iam.gserviceaccount.com',
    private_key: toPem(
      (await crypto.subtle.exportKey('pkcs8', rsa.privateKey)) as ArrayBuffer,
      'PRIVATE KEY'
    ),
  });
});

const relay = (overrides: Partial<Env> = {}): Env => ({
  DB: env.DB,
  CREATE_LIMITER: env.CREATE_LIMITER,
  APNS_TOPIC: env.APNS_TOPIC,
  APNS_KEY_ID: env.APNS_KEY_ID,
  APNS_TEAM_ID: env.APNS_TEAM_ID,
  APNS_KEY: apnsPem,
  ...overrides,
});

let ip = 0;
async function call(
  method: string,
  path: string,
  options: { auth?: string; body?: unknown; raw?: string; env?: Env; ip?: string } = {}
) {
  const headers: Record<string, string> = {
    'cf-connecting-ip': options.ip ?? `198.51.100.${++ip % 250}`,
  };
  if (options.auth) headers.authorization = `Bearer ${options.auth}`;
  const body =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await worker.fetch(
    new Request(`https://push.test${path}`, { method, headers, body }),
    options.env ?? relay()
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function install(): Promise<string> {
  const { status, body } = await call('POST', '/v1/installations');
  expect(status).toBe(201);
  return `${body.installationId}.${body.secret}`;
}

async function installWithPhone(
  platform: 'ios' | 'android' = 'ios',
  environment: 'production' | 'development' = 'production'
): Promise<string> {
  const auth = await install();
  const token = platform === 'ios' ? IOS_TOKEN : FCM_TOKEN;
  const r = await call('PUT', '/v1/devices/dev_phone', {
    auth,
    body: { platform, token, environment },
  });
  expect(r.status).toBe(204);
  return auth;
}

let fetchMock: ReturnType<typeof vi.fn>;
const logs = vi.fn();

beforeEach(() => {
  resetApnsToken();
  resetFcmToken();
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(logs);
  }
});

afterEach(() => {
  // Nothing about who or what is ever printed.
  expect(logs).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  logs.mockReset();
});

describe('installations', () => {
  it('issues a secret and keeps only its hash', async () => {
    const { body } = await call('POST', '/v1/installations');
    expect(body.installationId).toMatch(/^in_/);
    const row = await env.DB.prepare('SELECT secret_hash FROM installations WHERE id = ?1')
      .bind(body.installationId)
      .first<{ secret_hash: string }>();
    expect(row!.secret_hash).toBe(await sha256Hex(body.secret));
    expect(row!.secret_hash).not.toContain(body.secret);
  });

  it('refuses a wrong or missing secret', async () => {
    const auth = await install();
    const [id] = auth.split('.');
    expect(
      (await call('POST', '/v1/send', { body: { device: 'x', kind: 'finished' } })).status
    ).toBe(401);
    expect(
      (
        await call('POST', '/v1/send', {
          auth: `${id}.${'A'.repeat(43)}`,
          body: { device: 'x', kind: 'finished' },
        })
      ).status
    ).toBe(401);
  });

  it('limits creation per client address', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await call('POST', '/v1/installations', { ip: '203.0.113.9' })).status);
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
  });

  it('turning push off forgets the installation and its phones', async () => {
    const auth = await installWithPhone();
    expect((await call('DELETE', '/v1/installation', { auth })).status).toBe(204);
    expect(
      (await call('POST', '/v1/send', { auth, body: { device: 'dev_phone', kind: 'finished' } }))
        .status
    ).toBe(401);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE token = ?1')
      .bind(IOS_TOKEN)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

describe('the content-free contract', () => {
  it.each(['body', 'title', 'text', 'name', 'project'])(
    'refuses a send with `%s`',
    async (field) => {
      const auth = await installWithPhone();
      const r = await call('POST', '/v1/send', {
        auth,
        body: { device: 'dev_phone', kind: 'message', [field]: 'Deploy the payments fix' },
      });
      expect(r).toEqual({ status: 400, body: { error: 'unknown_field', field } });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ kind: 'urgent' }, 'kind'],
    [{ agent: 'Billing agent' }, 'agent'],
    [{ agent: 'a'.repeat(65) }, 'agent'],
    [{ badge: -1 }, 'badge'],
    [{ badge: 1.5 }, 'badge'],
    [{ device: '../x' }, 'device'],
  ])('refuses %j', async (patch, field) => {
    const auth = await installWithPhone();
    const r = await call('POST', '/v1/send', {
      auth,
      body: { device: 'dev_phone', kind: 'finished', ...patch },
    });
    expect(r).toEqual({ status: 400, body: { error: 'bad_field', field } });
  });

  it('refuses a registration with anything extra, or a malformed token', async () => {
    const auth = await install();
    const extra = await call('PUT', '/v1/devices/dev_phone', {
      auth,
      body: {
        platform: 'ios',
        token: IOS_TOKEN,
        environment: 'production',
        name: 'Julian’s iPhone',
      },
    });
    expect(extra.body).toEqual({ error: 'unknown_field', field: 'name' });
    const bad = await call('PUT', '/v1/devices/dev_phone', {
      auth,
      body: { platform: 'ios', token: 'nope' },
    });
    expect(bad.body).toEqual({ error: 'bad_field', field: 'token' });
  });

  it('refuses bodies that are not small JSON objects', async () => {
    const auth = await installWithPhone();
    expect((await call('POST', '/v1/send', { auth, raw: '[1]' })).body.error).toBe('bad_json');
    expect((await call('POST', '/v1/send', { auth, raw: 'x'.repeat(2000) })).status).toBe(413);
  });
});

describe('APNs', () => {
  it('sends a generic alert, signed with the team key', async () => {
    const auth = await installWithPhone();
    const r = await call('POST', '/v1/send', {
      auth,
      body: { device: 'dev_phone', kind: 'needs_you', agent: AGENT, badge: 3 },
    });
    expect(r).toEqual({ status: 200, body: { sent: true } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.push.apple.com/3/device/${IOS_TOKEN}`);
    const headers = init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe(env.APNS_TOPIC);
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-collapse-id']).toBe(`needs_you.${AGENT}`);
    expect(JSON.parse(init.body as string)).toEqual({
      aps: {
        alert: { title: 'An agent needs you' },
        badge: 3,
        sound: 'default',
        'interruption-level': 'time-sensitive',
        'thread-id': AGENT,
      },
      body: { kind: 'needs_you', agentId: AGENT },
    });

    const jwt = headers.authorization.replace(/^bearer /, '');
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({
      alg: 'ES256',
      kid: env.APNS_KEY_ID,
    });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c))).iss).toBe(env.APNS_TEAM_ID);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      apnsPublic,
      fromB64url(s),
      new TextEncoder().encode(`${h}.${c}`)
    );
    expect(ok).toBe(true);
  });

  it('a finished turn is quiet, and development builds go to the sandbox', async () => {
    const auth = await installWithPhone('ios', 'development');
    await call('POST', '/v1/send', { auth, body: { device: 'dev_phone', kind: 'finished' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.sandbox.push.apple.com');
    expect(JSON.parse(init.body as string).aps).toEqual({
      alert: { title: 'An agent finished' },
      'interruption-level': 'active',
    });
  });

  it('forgets a token Apple says is gone', async () => {
    const auth = await installWithPhone();
    fetchMock.mockResolvedValueOnce(Response.json({ reason: 'Unregistered' }, { status: 410 }));
    expect(
      (await call('POST', '/v1/send', { auth, body: { device: 'dev_phone', kind: 'finished' } }))
        .status
    ).toBe(410);
    expect(
      (await call('POST', '/v1/send', { auth, body: { device: 'dev_phone', kind: 'finished' } }))
        .body
    ).toEqual({
      error: 'unknown_device',
    });
  });

  it('says so when the key is missing, rather than pretending', async () => {
    const auth = await installWithPhone();
    const r = await call('POST', '/v1/send', {
      auth,
      body: { device: 'dev_phone', kind: 'finished' },
      env: relay({ APNS_KEY: undefined }),
    });
    expect(r).toEqual({ status: 503, body: { error: 'unconfigured', platform: 'ios' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a provider failure is a 502, not a success', async () => {
    const auth = await installWithPhone();
    fetchMock.mockResolvedValueOnce(Response.json({ reason: 'TooManyRequests' }, { status: 429 }));
    const r = await call('POST', '/v1/send', {
      auth,
      body: { device: 'dev_phone', kind: 'finished' },
    });
    expect(r).toEqual({ status: 502, body: { error: 'provider', status: 429 } });
  });
});

describe('limits', () => {
  it('caps sends per phone per hour', async () => {
    const auth = await installWithPhone();
    for (let i = 0; i < SEND_PER_DEVICE; i++) {
      expect(
        (await call('POST', '/v1/send', { auth, body: { device: 'dev_phone', kind: 'message' } }))
          .status
      ).toBe(200);
    }
    const over = await call('POST', '/v1/send', {
      auth,
      body: { device: 'dev_phone', kind: 'message' },
    });
    expect(over.status).toBe(429);
  });

  it('caps phones per installation', async () => {
    const auth = await install();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await call('PUT', `/v1/devices/dev_${i}`, {
            auth,
            body: { platform: 'ios', token: IOS_TOKEN },
          })
        ).status
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 204)).toBe(true);
    expect(statuses[10]).toBe(409);
  });

  it('revoking a phone stops its sends', async () => {
    const auth = await installWithPhone();
    expect((await call('DELETE', '/v1/devices/dev_phone', { auth })).status).toBe(204);
    expect(
      (await call('POST', '/v1/send', { auth, body: { device: 'dev_phone', kind: 'finished' } }))
        .status
    ).toBe(404);
  });
});

describe('FCM', () => {
  it('is off without its secret', async () => {
    const auth = await installWithPhone('android');
    const r = await call('POST', '/v1/send', {
      auth,
      body: { device: 'dev_phone', kind: 'finished' },
    });
    expect(r).toEqual({ status: 503, body: { error: 'unconfigured', platform: 'android' } });
  });

  it('sends the same generic alert through HTTP v1', async () => {
    const auth = await installWithPhone('android');
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('https://oauth2.googleapis.com')
        ? Response.json({ access_token: 'ya29.test', expires_in: 3600 })
        : new Response('{}', { status: 200 })
    );
    const r = await call('POST', '/v1/send', {
      auth,
      body: { device: 'dev_phone', kind: 'message', agent: AGENT, badge: 2 },
      env: relay({ FCM_SERVICE_ACCOUNT: fcmAccount }),
    });
    expect(r.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/shipstudio-test/messages:send');
    expect(JSON.parse(init.body as string)).toEqual({
      message: {
        token: FCM_TOKEN,
        notification: { title: 'New message from an agent' },
        data: { kind: 'message', agentId: AGENT },
        android: {
          priority: 'HIGH',
          collapse_key: `message.${AGENT}`,
          notification: { tag: `message.${AGENT}`, notification_count: 2 },
        },
      },
    });
  });
});
