/**
 * Behavior test for the HMR reload-suppress script (`RELOAD_SUPPRESS`).
 *
 * The script's canonical source lives in `src-tauri/src/proxy/reload_suppress.html`
 * (Rust injects it via `include_str!`). It wraps `window.WebSocket` and swallows
 * at most one Vite `full-reload` inside the editor's suppress window
 * (`window.__ssSuppressUntil`), while leaving every other socket and message
 * untouched. Here we evaluate that exact source against a fake WebSocket and
 * exercise the contracts the preview depends on: swallow-once, css-updates pass,
 * working removeEventListener, non-stacking onmessage, non-Vite sockets ignored.
 */

import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
// Import the exact script Rust injects (via `include_str!`) as a raw string so
// both consumers share one source of truth.
import scriptHtml from '../../../src-tauri/src/proxy/reload_suppress.html?raw';

const scriptJs = scriptHtml.replace(/^<script[^>]*>/, '').replace(/<\/script>\s*$/, '');

type Listener = (ev: unknown) => void;

/** Minimal stand-in for the native WebSocket the script wraps. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** The most recently constructed underlying socket, for dispatching events. */
  static last: FakeWebSocket | null = null;

  url: string;
  protocols?: string | string[];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.last = this;
  }

  addEventListener(type: string, handler: Listener) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: Listener) {
    this.listeners.get(type)?.delete(handler);
  }

  /** Simulate a server->client message reaching this socket. */
  dispatch(type: string, ev: Record<string, unknown>) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(ev);
  }
}

const FULL_RELOAD = JSON.stringify({ type: 'full-reload' });
const CSS_UPDATE = JSON.stringify({ type: 'update', updates: [] });

type TestWindow = Window & { __ssSuppressUntil?: number; WebSocket: unknown };
const win = window as unknown as TestWindow;

/** Construct a socket through the (possibly wrapped) global WebSocket. */
function connect(protocols?: string, url = 'ws://localhost:5173') {
  const Ctor = win.WebSocket as new (
    url: string,
    protocols?: string
  ) => {
    addEventListener: (type: string, handler: Listener) => void;
    removeEventListener: (type: string, handler: Listener) => void;
    onmessage: Listener | null;
  };
  const ws = protocols !== undefined ? new Ctor(url, protocols) : new Ctor(url);
  return { ws, native: FakeWebSocket.last! };
}

beforeAll(() => {
  win.WebSocket = FakeWebSocket;
  window.eval(scriptJs);
});

beforeEach(() => {
  win.__ssSuppressUntil = 0;
  FakeWebSocket.last = null;
});

it('wraps the global WebSocket', () => {
  expect(win.WebSocket).not.toBe(FakeWebSocket);
});

it('passes full-reload through outside the suppress window', () => {
  const { ws, native } = connect('vite-hmr');
  const seen: unknown[] = [];
  ws.addEventListener('message', (ev) => seen.push((ev as { data: string }).data));
  native.dispatch('message', { data: FULL_RELOAD });
  expect(seen).toEqual([FULL_RELOAD]);
});

it('drops exactly one full-reload inside the suppress window', () => {
  const { ws, native } = connect('vite-hmr');
  const seen: unknown[] = [];
  ws.addEventListener('message', (ev) => seen.push((ev as { data: string }).data));

  win.__ssSuppressUntil = Date.now() + 5000;
  native.dispatch('message', { data: FULL_RELOAD });
  expect(seen).toEqual([]);
  // Swallowing closed the window — a second reload (e.g. an agent editing
  // files right after an editor commit) must land, not leave the preview stale.
  expect(win.__ssSuppressUntil).toBe(0);
  native.dispatch('message', { data: FULL_RELOAD });
  expect(seen).toEqual([FULL_RELOAD]);
});

it('lets css updates through during the suppress window without consuming it', () => {
  const { ws, native } = connect('vite-hmr');
  const seen: unknown[] = [];
  ws.addEventListener('message', (ev) => seen.push((ev as { data: string }).data));

  win.__ssSuppressUntil = Date.now() + 5000;
  native.dispatch('message', { data: CSS_UPDATE });
  expect(seen).toEqual([CSS_UPDATE]);
  expect(win.__ssSuppressUntil).toBeGreaterThan(0);
});

it('gives every listener the same verdict on a dropped event', () => {
  const { ws, native } = connect('vite-hmr');
  const a: unknown[] = [];
  const b: unknown[] = [];
  ws.addEventListener('message', (ev) => a.push((ev as { data: string }).data));
  ws.addEventListener('message', (ev) => b.push((ev as { data: string }).data));

  win.__ssSuppressUntil = Date.now() + 5000;
  // The first listener's drop consumes the window; the second must not see the
  // same event slip through because the window is now closed.
  native.dispatch('message', { data: FULL_RELOAD });
  expect(a).toEqual([]);
  expect(b).toEqual([]);
});

it('removeEventListener detaches a filtered handler', () => {
  const { ws, native } = connect('vite-hmr');
  const seen: unknown[] = [];
  const handler = (ev: unknown) => seen.push((ev as { data: string }).data);
  ws.addEventListener('message', handler);
  ws.removeEventListener('message', handler);
  native.dispatch('message', { data: CSS_UPDATE });
  expect(seen).toEqual([]);
});

it('onmessage reassignment replaces the handler instead of stacking', () => {
  const { ws, native } = connect('vite-hmr');
  const first: unknown[] = [];
  const second: unknown[] = [];
  ws.onmessage = (ev) => first.push((ev as { data: string }).data);
  ws.onmessage = (ev) => second.push((ev as { data: string }).data);
  native.dispatch('message', { data: CSS_UPDATE });
  expect(first).toEqual([]);
  expect(second).toEqual([CSS_UPDATE]);
});

it('leaves non-Vite sockets completely alone', () => {
  const { ws, native } = connect();
  const seen: unknown[] = [];
  ws.addEventListener('message', (ev) => seen.push((ev as { data: string }).data));

  win.__ssSuppressUntil = Date.now() + 5000;
  native.dispatch('message', { data: FULL_RELOAD });
  expect(seen).toEqual([FULL_RELOAD]);
});

// ---- HMR watchdog ----------------------------------------------------------

/** Capture messages the script posts to the parent (window.parent === window in jsdom). */
function capturePosts() {
  const posted: unknown[] = [];
  const spy = vi.spyOn(window, 'postMessage').mockImplementation(((msg: unknown) => {
    posted.push(msg);
  }) as typeof window.postMessage);
  return { posted, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('posts hmr-down when the HMR socket closes and stays closed', () => {
  vi.useFakeTimers();
  const { posted } = capturePosts();
  const { native } = connect('vite-hmr');
  native.dispatch('open', {});
  native.dispatch('close', {});
  vi.advanceTimersByTime(4999);
  expect(posted).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(posted).toContainEqual({ type: 'shipstudio:hmr-down' });
});

it('stays quiet when a replacement HMR socket reconnects in time', () => {
  vi.useFakeTimers();
  const { posted } = capturePosts();
  const { native } = connect('vite-hmr');
  native.dispatch('open', {});
  native.dispatch('close', {});
  vi.advanceTimersByTime(2000);
  const { native: reconnected } = connect('vite-hmr');
  reconnected.dispatch('open', {});
  vi.advanceTimersByTime(10000);
  expect(posted).toEqual([]);
  // Keep watchdog state clean for later tests.
  reconnected.dispatch('close', {});
  vi.advanceTimersByTime(10000);
});

it('watches Next.js webpack-hmr sockets without filtering their messages', () => {
  vi.useFakeTimers();
  const { posted } = capturePosts();
  const { ws, native } = connect(undefined, 'ws://localhost:3000/_next/webpack-hmr');

  // No message filtering on non-Vite sockets, even during a suppress window.
  const seen: unknown[] = [];
  ws.addEventListener('message', (ev) => seen.push((ev as { data: string }).data));
  win.__ssSuppressUntil = Date.now() + 5000;
  native.dispatch('message', { data: FULL_RELOAD });
  expect(seen).toEqual([FULL_RELOAD]);

  // But the watchdog still covers them.
  native.dispatch('open', {});
  native.dispatch('close', {});
  vi.advanceTimersByTime(5000);
  expect(posted).toContainEqual({ type: 'shipstudio:hmr-down' });
});
