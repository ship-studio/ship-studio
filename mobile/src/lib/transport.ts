/**
 * `DirectTransport`: one WebSocket to the Mac over a route (docs/mobile.md,
 * "Transport"). Screens never see the socket; they see `Transport`.
 *
 * Pure TypeScript with the socket constructor injected, so the integration
 * test drives this exact class against the mock server under Node.
 */

import {
  DEAD_AFTER_MS,
  HEARTBEAT_MS,
  HTTP,
  SUPPORTED,
  type BlobRef,
  type ClientFrame,
  type CompanionEvent,
  type Cursor,
  type HelloFrame,
  type LinkState,
  type MethodName,
  type Params,
  type RefusedFrame,
  type Result,
  type Route,
  type ServerFrame,
  type Transport,
  type WelcomeFrame,
  type WireError,
} from '@shipstudio/companion-protocol';

/** A request that failed, carrying the Mac's (or our) structured error. */
export class WireFailure extends Error {
  constructor(readonly error: WireError) {
    super('message' in error ? error.message : error.type);
  }
}

const notConnected = () =>
  new WireFailure({
    type: 'Protocol',
    code: 'not_connected',
    message: 'Not connected to your Mac right now.',
  });

export interface DirectTransportOptions {
  /** Tried in order, starting from the one that last worked. */
  routes: Route[];
  token: string;
  app: HelloFrame['app'];
  /** The last cursor the store fully applied; sent as `hello.resume`. */
  getResume: () => Cursor | undefined;
  foreground: boolean;
  WebSocketImpl?: typeof WebSocket;
  requestTimeoutMs?: number;
}

type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const BACKOFF_MS = [400, 1000, 2000, 4000, 8000, 15000];

export class DirectTransport implements Transport {
  private ws: SocketLike | null = null;
  private routeIndex = 0;
  private attempt = 0;
  private everConnected = false;
  private closed = false;
  private refused = false;
  private ready = false;
  private epoch: string | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;
  private pingSentAt = 0;
  private eventListeners = new Set<(e: CompanionEvent, c?: Cursor) => void>();
  private stateListeners = new Set<(s: LinkState) => void>();
  private welcomeListeners = new Set<(w: WelcomeFrame) => void>();
  private refusedListeners = new Set<(r: RefusedFrame) => void>();
  private foreground: boolean;

  state: LinkState = { kind: 'connecting', attempt: 0 };
  /** The last frame from the Mac (epoch ms), 0 before the first. */
  lastSeenAt = 0;
  /** Round trip of the last ping, for the Connection screen. */
  latencyMs: number | null = null;
  welcome: WelcomeFrame | null = null;
  refusal: RefusedFrame | null = null;

  constructor(private readonly opts: DirectTransportOptions) {
    this.foreground = opts.foreground;
    if (!opts.routes.length) throw new Error('No route to the Mac');
    this.connect();
  }

  get route(): Route {
    return this.opts.routes[this.routeIndex];
  }

  // ---- Transport ------------------------------------------------------------

  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!this.ready || !this.ws) return Promise.reject(notConnected());
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      const secs = (this.opts.requestTimeoutMs ?? 30_000) / 1000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WireFailure({ type: 'Timeout', cmd: method, secs }));
      }, secs * 1000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: 'req', id, method, params });
    });
  }

  onEvent(listener: (event: CompanionEvent, cursor?: Cursor) => void) {
    this.eventListeners.add(listener);
    return () => void this.eventListeners.delete(listener);
  }

  onState(listener: (state: LinkState) => void) {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }

  onWelcome(listener: (welcome: WelcomeFrame) => void) {
    this.welcomeListeners.add(listener);
    return () => void this.welcomeListeners.delete(listener);
  }

  onRefused(listener: (refused: RefusedFrame) => void) {
    this.refusedListeners.add(listener);
    return () => void this.refusedListeners.delete(listener);
  }

  // Attachments are P2 (docs/mobile.md, "Build plan"); the HTTP routes exist
  // in the protocol, but nothing in the P1 app sends or shows files yet.
  upload(): Promise<BlobRef> {
    return Promise.reject(
      new WireFailure({ type: 'Protocol', code: 'unknown_method', message: 'Not in this version' })
    );
  }

  download(): Promise<string> {
    return this.upload() as unknown as Promise<string>;
  }

  setForeground(foreground: boolean) {
    this.foreground = foreground;
    if (this.ready) this.send({ t: 'presence', foreground });
    // Coming back to the app is the moment to stop waiting out a backoff.
    else if (foreground) this.retryNow();
  }

  /** Try again now (the network changed, or the app came forward). */
  retryNow() {
    if (this.closed || this.refused || this.ws) return;
    this.attempt = 0;
    this.connect();
  }

  close() {
    this.closed = true;
    this.teardown();
    this.eventListeners.clear();
    this.stateListeners.clear();
  }

  // ---- The socket -----------------------------------------------------------

  private connect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.everConnected) this.setState({ kind: 'connecting', attempt: this.attempt });
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const url = this.route.url.replace(/^http/, 'ws').replace(/\/$/, '') + HTTP.ws;
    const ws = new Impl(url) as unknown as SocketLike;
    this.ws = ws;
    ws.onopen = () => {
      this.armDeadTimer();
      const resume = this.opts.getResume();
      this.send({
        t: 'hello',
        protocol: SUPPORTED,
        token: this.opts.token,
        app: this.opts.app,
        ...(resume ? { resume } : {}),
        foreground: this.foreground,
      });
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.lastSeenAt = Date.now();
      this.armDeadTimer();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      this.handle(frame);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (ws === this.ws) this.lost();
    };
  }

  private handle(frame: ServerFrame) {
    switch (frame.t) {
      case 'welcome': {
        this.ready = true;
        this.everConnected = true;
        this.attempt = 0;
        this.welcome = frame;
        if (frame.resume === 'replay') this.epoch = this.opts.getResume()?.epoch ?? this.epoch;
        this.startPings();
        this.setState({ kind: 'connected', route: this.route.kind, since: Date.now() });
        this.welcomeListeners.forEach((l) => l(frame));
        return;
      }
      case 'refused': {
        this.refusal = frame;
        this.refusedListeners.forEach((l) => l(frame));
        if (frame.reason === 'too_many_connections') return; // close follows; retry with backoff
        this.refused = true;
        this.setState({ kind: 'refused', reason: frame.reason });
        this.teardown();
        return;
      }
      case 'res': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new WireFailure(frame.error));
        return;
      }
      case 'evt': {
        const { event } = frame;
        if (event.type === 'sync.snapshot' || event.type === 'sync.caughtUp') {
          this.epoch = event.cursor.epoch;
        }
        const cursor =
          frame.seq != null && this.epoch ? { epoch: this.epoch, seq: frame.seq } : undefined;
        this.eventListeners.forEach((l) => l(event, cursor));
        return;
      }
      case 'pong':
        // The Mac also sends pongs unprompted, as its heartbeat; only an
        // answer to our own ping says anything about latency.
        if (this.pingSentAt) this.latencyMs = Date.now() - this.pingSentAt;
        this.pingSentAt = 0;
        return;
    }
  }

  /** The socket closed or went silent: fail what's in flight and retry with backoff. */
  private lost() {
    this.teardown();
    if (this.closed || this.refused) return;
    // A route that failed before ever answering hands over to the next one.
    if (!this.ready) this.routeIndex = (this.routeIndex + 1) % this.opts.routes.length;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt++;
    this.setState(
      this.everConnected
        ? { kind: 'reconnecting', lastSeenAt: this.lastSeenAt, nextTryAt: Date.now() + delay }
        : { kind: 'connecting', attempt: this.attempt }
    );
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private teardown() {
    this.ready = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = this.deadTimer = this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(notConnected());
    }
    this.pending.clear();
  }

  /**
   * The Mac sends a heartbeat pong every HEARTBEAT_MS; the phone pings too,
   * to measure the round trip. Any frame proves the link, and silence for
   * DEAD_AFTER_MS means sleep or a Wi-Fi handoff, which TCP would take
   * minutes to notice: reconnect and resume from the cursor.
   */
  private startPings() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.pingSentAt = Date.now();
      this.send({ t: 'ping' });
    }, HEARTBEAT_MS);
  }

  private armDeadTimer() {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => this.lost(), DEAD_AFTER_MS);
  }

  private send(frame: ClientFrame) {
    // OPEN is 1 for every WebSocket implementation.
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private setState(state: LinkState) {
    this.state = state;
    this.stateListeners.forEach((l) => l(state));
  }
}
