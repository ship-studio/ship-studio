/**
 * A secure input card's value goes to the Mac over TLS on Tailscale and
 * nowhere else: not the cache, the outbox, drafts or the store, and never
 * over any other route. Against the mock Mac on HTTPS, through the app's
 * real transport and sync rules.
 */

import type { CompanionEvent, Cursor } from '@shipstudio/companion-protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { until } from './helpers';

// What would reach the disk: every write captured instead.
const written: string[] = [];
jest.mock('../src/lib/persist', () => ({
  readJson: () => Promise.resolve(null),
  writeJson: (_name: string, value: unknown) => {
    written.push(JSON.stringify(value));
    return Promise.resolve();
  },
  removeJson: () => Promise.resolve(),
  debounced: (run: () => Promise<void>) => ({
    schedule: () => void run(),
    flush: run,
    cancel: () => {},
  }),
}));

// jest.mock is hoisted above these, so they load with it in place.
import { toCache } from '../src/lib/cache';
import { flushDrafts } from '../src/lib/drafts';
import { secretRouteProblem, sendSecret } from '../src/lib/secrets';
import { getApp } from '../src/lib/store';
import { applyEvent, emptySync } from '../src/lib/sync';
import { DirectTransport } from '../src/lib/transport';

jest.setTimeout(20_000);

const VALUE = 'sk_live_51NeverWriteMeDown';
const certs = join(__dirname, '../dev/.certs');

/** The mock's certificate is self-signed; the app trusts the real `*.ts.net` one. */
class SelfSignedOk extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { rejectUnauthorized: false });
  }
}

describe('secrets', () => {
  const mock = createMockServer({
    quiet: true,
    allowAfterMs: 0,
    tls: { key: readFileSync(join(certs, 'key.pem')), cert: readFileSync(join(certs, 'cert.pem')) },
  });
  let t: DirectTransport;
  let state = emptySync();
  const frames: string[] = [];

  beforeAll(async () => {
    const url = await mock.listen();
    expect(url).toMatch(/^https:/);
    t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token: mock.issueToken().token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => state.cursor ?? undefined,
      foreground: true,
      WebSocketImpl: SelfSignedOk as unknown as typeof globalThis.WebSocket,
    });
    t.onEvent((e: CompanionEvent, c?: Cursor) => {
      frames.push(JSON.stringify(e));
      state = applyEvent(state, e, c);
    });
    await until(() => state.syncedAt != null);
  });

  afterAll(async () => {
    t.close();
    await mock.close();
  });

  it('only goes over HTTPS on Tailscale', () => {
    expect(secretRouteProblem({ kind: 'tailscale', url: 'https://mac.tail1.ts.net:47443' })).toBe(
      null
    );
    expect(secretRouteProblem({ kind: 'tailscale', url: 'http://mac.tail1.ts.net:47443' })).toMatch(
      /only go over Tailscale/
    );
    expect(secretRouteProblem({ kind: 'lan', url: 'https://192.168.1.20:47444' })).toMatch(
      /only go over Tailscale/
    );
    expect(secretRouteProblem(null)).toMatch(/needs your Mac/);
  });

  it('is refused before it leaves the phone on any other route', async () => {
    const request = jest.fn();
    const plain = { state: t.state, route: { kind: 'tailscale', url: 'http://x' }, request };
    await expect(sendSecret(plain as never, 'fin', 'req_secret', [VALUE])).rejects.toThrow(
      /only go over Tailscale/
    );
    const offline = { state: { kind: 'connecting', attempt: 1 }, route: t.route, request };
    await expect(sendSecret(offline as never, 'fin', 'req_secret', [VALUE])).rejects.toThrow(
      /needs your Mac/
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('reaches the Mac once and lands nowhere on the phone', async () => {
    const saved = await sendSecret(t, 'fin', 'req_secret', [VALUE]);
    expect(saved.name).toBe('Stripe key');
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    const card = () =>
      state.chats.fin?.messages.find((m) => m.approval?.requestId === 'req_secret') ??
      frames.find((f) => f.includes('req_secret'));
    await until(() =>
      frames.some((f) => f.includes('req_secret') && f.includes('"status":"allowed"'))
    );
    expect(card()).toBeTruthy();
    // The agent now lists it by name, and only by name.
    const fin = state.overview?.agents.find((a) => a.id === 'fin');
    expect(fin?.secrets?.map((s) => s.name)).toEqual(['Stripe key']);

    // Everything the app would keep: the cache, its outbox, drafts, the store.
    await flushDrafts();
    const kept = [
      JSON.stringify(toCache(state)),
      JSON.stringify(state.pending),
      JSON.stringify(getApp()),
      ...written,
      ...frames,
    ];
    for (const k of kept) expect(k).not.toContain(VALUE);
    // A second save of the same card is the Mac's to refuse.
    await expect(sendSecret(t, 'fin', 'req_secret', [VALUE])).rejects.toThrow();
  });
});
