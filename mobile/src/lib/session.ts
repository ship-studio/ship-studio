/**
 * The live session with the paired Mac: owns the transport, feeds its events
 * into the store, and exposes the actions screens call. One Mac, one session.
 */

import type {
  Alert,
  AgentMessage,
  MethodName,
  Params,
  Result,
} from '@shipstudio/companion-protocol';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import { AppState } from 'react-native';
import {
  appInfo,
  forgetCredentials,
  loadCredentials,
  saveCredentials,
  usableRoutes,
  type Credentials,
} from './pairing';
import { getApp, setApp, update } from './store';
import {
  addPending,
  applyEvent,
  confirmSend,
  emptySync,
  mergePage,
  setPendingFailed,
} from './sync';
import { DirectTransport, WireFailure } from './transport';

const PAGE = 50;
let transport: DirectTransport | null = null;

export const currentTransport = () => transport;

/** Read the keychain and connect if a Mac is paired. Called once at launch. */
export async function boot() {
  const credentials = await loadCredentials().catch(() => null);
  setApp({ credentials });
  if (credentials) connect(credentials);
}

export async function adopt(credentials: Credentials) {
  await saveCredentials(credentials);
  setApp({ ...emptySync(), credentials, refusal: null, welcome: null });
  connect(credentials);
}

function connect(c: Credentials) {
  transport?.close();
  const t = new DirectTransport({
    routes: usableRoutes(c.routes),
    token: c.token,
    app: {
      version: appInfo().version,
      ...(Updates.updateId ? { updateId: Updates.updateId } : {}),
      runtimeVersion: Updates.runtimeVersion ?? 'development',
    },
    // The store is in memory, so a cold start has no cursor and gets a
    // snapshot; within a run, every reconnect resumes where it left off.
    getResume: () => getApp().cursor ?? undefined,
    foreground: AppState.currentState === 'active',
  });
  t.onState((link) => setApp({ link }));
  t.onRefused((refusal) => setApp({ refusal }));
  t.onWelcome((welcome) => {
    setApp({ welcome, refusal: null });
    // Focus is per connection: the Mac forgot it when the last one dropped.
    const open = getApp().openChat;
    if (open) void call('agents.focus', { agentId: open });
  });
  t.onEvent((event, cursor) => {
    update((s) => applyEvent(s, event, cursor));
    if (event.type === 'alert') void notify(event.alert);
    if (event.type === 'system.status') learnRoutes(event.status.routes);
    if (event.type === 'sync.snapshot') learnRoutes(event.status.routes);
    // After a snapshot every chat is stale; re-fetch the one on screen now,
    // the others when they're opened.
    if (event.type === 'sync.caughtUp') {
      const open = getApp().openChat;
      if (open && !getApp().chats[open]?.loaded) void loadLatest(open);
    }
  });
  transport = t;
}

/** The Mac's routes change (a new DHCP address, Tailscale turned on); keep the latest. */
function learnRoutes(routes: Credentials['routes']) {
  const c = getApp().credentials;
  if (!c || !routes.length || JSON.stringify(routes) === JSON.stringify(c.routes)) return;
  const next = { ...c, routes };
  setApp({ credentials: next });
  void saveCredentials(next);
}

function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return transport.request(method, params);
}

// ---- Lifecycle ----------------------------------------------------------------

/** Foreground/background and network changes. Returns a cleanup. */
export function watchLifecycle(): () => void {
  const app = AppState.addEventListener('change', (state) => {
    const fg = state === 'active';
    transport?.setForeground(fg);
    // Focus is per socket and only counts in the foreground: say so both ways.
    const open = getApp().openChat;
    if (open && transport?.state.kind === 'connected') {
      void call('agents.focus', { agentId: fg ? open : null }).catch(() => {});
    }
  });
  const net = NetInfo.addEventListener((s) => {
    const online = s.isConnected === null ? null : Boolean(s.isConnected);
    const was = getApp().phoneOnline;
    setApp({ phoneOnline: online });
    // A new network is the best moment to try again, not the end of a backoff.
    if (online && was !== true) transport?.retryNow();
  });
  return () => {
    app.remove();
    net();
  };
}

// ---- Chats --------------------------------------------------------------------

const loading = new Map<string, Promise<void>>();

/** The newest page. Concurrent calls for one chat share the request. */
export function loadLatest(agentId: string): Promise<void> {
  const running = loading.get(agentId);
  if (running) return running;
  const run = call('agents.messages', { agentId, limit: PAGE })
    .then((page) => update((s) => mergePage(s, agentId, page, false)))
    .finally(() => loading.delete(agentId));
  loading.set(agentId, run);
  return run;
}

export async function loadOlder(agentId: string) {
  const oldest = getApp().chats[agentId]?.messages[0];
  if (!oldest) return loadLatest(agentId);
  const page = await call('agents.messages', { agentId, limit: PAGE, before: oldest.id });
  update((s) => mergePage(s, agentId, page, true));
}

/** On screen (or `null` on leaving): the Mac clears its unread and holds alerts for it. */
export function setOpenChat(agentId: string | null) {
  setApp((s) => ({
    openChat: agentId,
    overview:
      agentId && s.overview
        ? {
            ...s.overview,
            agents: s.overview.agents.map((a) => (a.id === agentId ? { ...a, unread: 0 } : a)),
          }
        : s.overview,
  }));
  if (transport?.state.kind === 'connected') void call('agents.focus', { agentId }).catch(() => {});
}

/**
 * Send with an optimistic bubble. The `clientId` makes a retry after a lost
 * connection safe: the Mac returns the original message instead of sending
 * it twice. `now`: interrupt the turn in progress once the Mac has it.
 */
export async function send(agentId: string, text: string, now = false, clientId?: string) {
  const id = clientId ?? Crypto.randomUUID();
  if (clientId) update((s) => setPendingFailed(s, agentId, id, false));
  else update((s) => addPending(s, { clientId: id, agentId, text, ts: Date.now(), failed: false }));
  let message: AgentMessage;
  try {
    message = await call('agents.send', { agentId, text, clientId: id });
  } catch (error) {
    update((s) => setPendingFailed(s, agentId, id, true));
    throw error;
  }
  update((s) => confirmSend(s, id, message));
  if (now) await call('agents.interrupt', { agentId });
}

export function discardPending(agentId: string, clientId: string) {
  setApp((s) => ({
    pending: {
      ...s.pending,
      [agentId]: (s.pending[agentId] ?? []).filter((p) => p.clientId !== clientId),
    },
  }));
}

export const stop = (agentId: string) => call('agents.stop', { agentId });

export const answerApproval = (
  agentId: string,
  requestId: string,
  allow: boolean,
  always?: boolean,
  note?: string
) =>
  call('agents.answerApproval', {
    agentId,
    requestId,
    allow,
    ...(always ? { always } : {}),
    ...(note ? { note } : {}),
  });

export const deviceSelf = () => call('devices.self', {});

/** Forget this Mac: revoke our token on it when we can, then wipe everything here. */
export async function unpair() {
  if (transport?.state.kind === 'connected') {
    await call('devices.unpairSelf', {}).catch(() => {});
  }
  transport?.close();
  transport = null;
  await forgetCredentials();
  setApp({
    ...emptySync(),
    credentials: null,
    welcome: null,
    refusal: null,
    openChat: null,
    link: { kind: 'connecting', attempt: 0 },
  });
}

// ---- Notifications --------------------------------------------------------------

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

/** The Mac only sends an alert when this phone isn't showing that agent. */
async function notify(alert: Alert) {
  if (getApp().openChat === alert.agentId && AppState.currentState === 'active') return;
  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: alert.title,
      body: alert.body,
      data: { agentId: alert.agentId, messageId: alert.messageId ?? null },
    },
    trigger: null,
  });
}

// ---- Errors ---------------------------------------------------------------------

/** One sentence for a failed action, in the desktop's voice. */
export function describeError(error: unknown): string {
  if (!(error instanceof WireFailure)) {
    return error instanceof Error ? error.message : 'Something went wrong.';
  }
  const e = error.error;
  switch (e.type) {
    case 'Protocol':
      return e.message;
    case 'Timeout':
      return 'Your Mac didn’t answer in time.';
    case 'Validation':
      return e.reason;
    case 'NotAuthenticated':
      return `${e.service} is signed out on your Mac.`;
    case 'Process':
    case 'MergeConflict':
      return 'A command on your Mac failed.';
    case 'Io':
    case 'Other':
      return e.message;
  }
}
