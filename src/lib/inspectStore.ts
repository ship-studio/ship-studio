/**
 * Module-level store for the in-app browser inspector.
 *
 * Holds console entries, network entries, and the latest DOM snapshot pushed
 * by the inspector shim (see `src-tauri/src/webview_scripts.rs`). The store
 * lives outside React so that frequent re-renders or unmounts of the
 * `<BrowserTools/>` component don't drop captured data.
 *
 * Subscribe via `useSyncExternalStore`; the store registers ONE global
 * `message` listener at module init.
 */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  args: string[];
  t: number;
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  status?: number;
  ok?: boolean;
  duration?: number;
  error?: string;
  pending: boolean;
  startedAt: number;
}

export type DomNode =
  | { kind: 'el'; tag: string; attrs: Record<string, string>; children: DomNode[] }
  | { kind: 'text'; text: string }
  | { kind: 'comment'; text: string };

export interface DomSnapshot {
  tree: DomNode;
  truncated: boolean;
  receivedAt: number;
}

const MAX_ENTRIES = 500;
const CHANNEL = 'shipstudio-inspect';
const HOST_CHANNEL = 'shipstudio-inspect-host';

interface ShimMessage {
  source?: string;
  type?: string;
  seq?: number;
  t?: number;
  level?: ConsoleLevel;
  args?: string[];
  id?: string;
  method?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  duration?: number;
  error?: string;
  tree?: DomNode;
  truncated?: boolean;
}

let consoleEntries: ConsoleEntry[] = [];
let networkEntries: NetworkEntry[] = [];
let domSnapshot: DomSnapshot | null = null;
let consoleId = 0;
// Whether the Elements view wants live DOM snapshots. The shim's mutation
// observer only runs while subscribed (serializing the tree on every mutation
// burst is too expensive to leave on invisibly); a freshly loaded document
// starts unsubscribed, so we re-arm it on the shim's 'ready' beacon.
let domSubscriptionActive = false;

const listeners = new Set<() => void>();
const notify = () => {
  // Iterate over a snapshot so a listener can unsubscribe itself safely.
  for (const l of Array.from(listeners)) l();
};

/** Preview content is always served from a localhost dev-server/proxy/static
 * port. Requiring that origin keeps the privileged app frame (origin
 * `tauri://…`) — and anything running in it, e.g. plugins — from spoofing
 * inspector telemetry. */
const isPreviewOrigin = (origin: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

/** When set, only this frame's telemetry is collected and only this frame is
 *  asked for DOM snapshots. The breakpoint canvas runs several preview frames
 *  at once; without this the inspector would interleave four copies of every
 *  console line and pay for four DOM serializations. Null (focus mode, where
 *  there is only one preview frame) accepts every preview-origin frame. */
let inspectSource: Window | null = null;

const handleMessage = (event: MessageEvent) => {
  if (!isPreviewOrigin(event.origin)) return;
  if (inspectSource && event.source !== inspectSource) return;
  const data = event.data as ShimMessage | null;
  if (!data || typeof data !== 'object' || data.source !== CHANNEL) return;

  switch (data.type) {
    case 'ready': {
      consoleEntries = [];
      networkEntries = [];
      domSnapshot = null;
      consoleId = 0;
      // A new document just installed the shim (reload/navigation); it starts
      // unsubscribed, so re-arm live DOM snapshots if Elements is watching.
      if (domSubscriptionActive) broadcastToPreviews('subscribe-dom-tree');
      notify();
      return;
    }
    case 'console': {
      const entry: ConsoleEntry = {
        id: ++consoleId,
        level: data.level ?? 'log',
        args: data.args ?? [],
        t: data.t ?? Date.now(),
      };
      const next = consoleEntries.concat(entry);
      consoleEntries = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      notify();
      return;
    }
    case 'net-start': {
      if (!data.id) return;
      const entry: NetworkEntry = {
        id: data.id,
        method: data.method ?? 'GET',
        url: data.url ?? '',
        pending: true,
        startedAt: data.t ?? Date.now(),
      };
      const next = networkEntries.concat(entry);
      networkEntries = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      notify();
      return;
    }
    case 'net-end': {
      if (!data.id) return;
      let changed = false;
      networkEntries = networkEntries.map((n) => {
        if (n.id !== data.id) return n;
        changed = true;
        return {
          ...n,
          pending: false,
          status: data.status,
          ok: data.ok,
          duration: data.duration,
          error: data.error,
        };
      });
      if (changed) notify();
      return;
    }
    case 'dom-tree': {
      if (!data.tree) return;
      domSnapshot = {
        tree: data.tree,
        truncated: !!data.truncated,
        receivedAt: data.t ?? Date.now(),
      };
      notify();
      return;
    }
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('message', handleMessage);
}

/** Broadcast a host command to any preview iframes. */
const broadcastToPreviews = (type: string) => {
  if (inspectSource) {
    try {
      inspectSource.postMessage({ source: HOST_CHANNEL, type }, '*');
    } catch {
      // ignore — the frame may have gone away between selection and broadcast
    }
    return;
  }
  if (typeof document === 'undefined') return;
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach((iframe) => {
    try {
      iframe.contentWindow?.postMessage({ source: HOST_CHANNEL, type }, '*');
    } catch {
      // ignore — cross-origin frames may not allow postMessage in some setups
    }
  });
};

/**
 * Ask any preview iframes to re-serialize and post their DOM tree.
 * Called when the Elements tab activates so the user always sees fresh state.
 */
const requestDomTree = () => broadcastToPreviews('request-dom-tree');

/* All store methods are arrow properties (not method shorthand) so
   that references like `inspectStore.subscribe` passed into
   useSyncExternalStore can't drift from `this`. The store has no
   instance state anyway — it closes over module-level vars. */
/**
 * Point the inspector at one preview frame (or `null` for "whichever preview
 * frame is talking"). Switching frames clears the captured entries — they
 * described a different document — and re-arms the DOM subscription on the new
 * frame if Elements is watching.
 */
export const setInspectSource = (win: Window | null): void => {
  if (inspectSource === win) return;
  inspectSource = win;
  consoleEntries = [];
  networkEntries = [];
  domSnapshot = null;
  consoleId = 0;
  if (domSubscriptionActive) broadcastToPreviews('subscribe-dom-tree');
  notify();
};

export const inspectStore = {
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getConsoleEntries: () => consoleEntries,
  getNetworkEntries: () => networkEntries,
  getDomSnapshot: () => domSnapshot,
  clearConsole: () => {
    if (consoleEntries.length === 0) return;
    consoleEntries = [];
    notify();
  },
  clearNetwork: () => {
    if (networkEntries.length === 0) return;
    networkEntries = [];
    notify();
  },
  refreshDom: requestDomTree,
  /** Turn live DOM snapshots on/off (Elements view visible/hidden). */
  setDomSubscription: (active: boolean) => {
    if (domSubscriptionActive === active) return;
    domSubscriptionActive = active;
    broadcastToPreviews(active ? 'subscribe-dom-tree' : 'unsubscribe-dom-tree');
  },
};
