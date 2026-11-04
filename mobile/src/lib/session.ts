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
import { AccessibilityInfo, AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import {
  appInfo,
  forgetCredentials,
  loadCredentials,
  saveCredentials,
  usableRoutes,
  type Credentials,
} from './pairing';
import { flushCache, forgetCache, loadCache, watchCache } from './cache';
import { flushDrafts, forgetDrafts, loadDrafts } from './drafts';
import { outboxPlan, unreached } from './outbox';
import { loadPrefs } from './prefs';
import { getApp, setApp, update } from './store';
import {
  addPending,
  applyEvent,
  type PendingAttachment,
  confirmSend,
  emptySync,
  mergePage,
  setPendingFailed,
} from './sync';
import { clearCache, http, type PickedFile } from './files';
import { DirectTransport, WireFailure } from './transport';

const PAGE = 50;
let transport: DirectTransport | null = null;

export const currentTransport = () => transport;

/**
 * Read the keychain and, if a Mac is paired, its offline copy and drafts,
 * then connect: the cached chats show at once, and the Mac replays from the
 * copy's cursor. Called once at launch.
 */
export async function boot() {
  const [credentials] = await Promise.all([
    loadCredentials().catch(() => null),
    loadPrefs().catch(() => {}),
  ]);
  if (credentials) {
    await Promise.all([
      loadCache(credentials.serverId).catch(() => false),
      loadDrafts(credentials.serverId).catch(() => {}),
    ]);
  }
  setApp({ credentials });
  watchCache();
  if (credentials) connect(credentials);
}

export async function adopt(credentials: Credentials) {
  await saveCredentials(credentials);
  setApp({ ...emptySync(), credentials, refusal: null, welcome: null, composer: {} });
  await loadDrafts(credentials.serverId).catch(() => {});
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
    http,
  });
  t.onState((link) => {
    // "As of" for everything shown while it's away: the moment it stopped being live.
    const was = getApp().link.kind;
    setApp(
      was === 'connected' && link.kind !== 'connected' ? { link, syncedAt: Date.now() } : { link }
    );
  });
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
    // the others when they're opened. Then send what waited for the Mac.
    if (event.type === 'sync.caughtUp') {
      const open = getApp().openChat;
      if (open && !getApp().chats[open]?.loaded) void loadLatest(open);
      void flushOutbox();
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

/** Whether this Mac serves `method` (older Macs list fewer; the phone hides the rest). */
export const canCall = (method: MethodName, welcome = getApp().welcome) =>
  !!welcome?.methods.includes(method);

export function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return transport.request(method, params);
}

// ---- Lifecycle ----------------------------------------------------------------

/** Foreground/background and network changes. Returns a cleanup. */
export function watchLifecycle(): () => void {
  const app = AppState.addEventListener('change', (state) => {
    const fg = state === 'active';
    transport?.setForeground(fg);
    // The app may be killed from the background: put the copy on disk now.
    if (!fg) {
      void flushCache();
      void flushDrafts();
    }
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
  // Increase Contrast (iOS) / high-contrast text (Android): words get one step brighter.
  if (Platform.OS === 'ios') {
    void AccessibilityInfo.isDarkerSystemColorsEnabled().then((on) => setApp({ highContrast: on }));
  }
  const contrast =
    Platform.OS === 'ios'
      ? AccessibilityInfo.addEventListener('darkerSystemColorsChanged', (on) =>
          setApp({ highContrast: on })
        )
      : null;
  return () => {
    app.remove();
    net();
    contrast?.remove();
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
 *
 * With no link the send waits in the outbox (outbox.ts) and goes when the
 * Mac answers; a send the Mac may not have heard waits the same way.
 */
export async function send(
  agentId: string,
  text: string,
  now = false,
  clientId?: string,
  attachments: PendingAttachment[] = [],
  mentions: string[] = []
) {
  const id = clientId ?? Crypto.randomUUID();
  const offline = getApp().link.kind !== 'connected';
  if (clientId) update((s) => setPendingFailed(s, agentId, id, false, offline));
  else
    update((s) =>
      addPending(s, {
        clientId: id,
        agentId,
        text,
        ts: Date.now(),
        failed: false,
        ...(offline ? { waiting: true } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(mentions.length ? { mentions } : {}),
      })
    );
  if (offline) return;
  let message: AgentMessage;
  try {
    message = await call('agents.send', {
      agentId,
      text,
      clientId: id,
      ...(attachments.length
        ? { attachments: attachments.map((a) => ({ blobId: a.blobId })) }
        : {}),
      ...(mentions.length ? { mentions } : {}),
    });
  } catch (error) {
    const retry = unreached(error);
    update((s) => setPendingFailed(s, agentId, id, !retry, retry));
    if (retry) return;
    throw error;
  }
  update((s) => confirmSend(s, id, message));
  if (now) await call('agents.interrupt', { agentId });
}

let flushing = false;

/** Send what waited for the Mac, oldest first; give up on what waited too long. */
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const { flush, expire } = outboxPlan(getApp().pending, Date.now());
    for (const p of expire) update((s) => setPendingFailed(s, p.agentId, p.clientId, true));
    for (const p of flush) {
      if (getApp().link.kind !== 'connected') break;
      await send(p.agentId, p.text, false, p.clientId, p.attachments, p.mentions).catch(() => {});
    }
  } finally {
    flushing = false;
  }
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

/** Pin, mute or hide: shown at once, put back if the Mac says no. */
export async function setAgentToggles(
  agentId: string,
  input: Partial<Record<'pinned' | 'muted' | 'hidden', boolean>>
) {
  const before = getApp().overview;
  const patch = (on: typeof before) =>
    on && {
      ...on,
      agents: on.agents.map((a) => (a.id === agentId ? { ...a, ...input } : a)),
    };
  setApp({ overview: patch(before) });
  try {
    await call('agents.update', { agentId, input });
  } catch (error) {
    setApp((s) => ({
      overview:
        s.overview && before
          ? {
              ...s.overview,
              agents: s.overview.agents.map((a) => {
                const was = before.agents.find((b) => b.id === a.id);
                return a.id === agentId && was
                  ? { ...a, pinned: was.pinned, muted: was.muted, hidden: was.hidden }
                  : a;
              }),
            }
          : s.overview,
    }));
    throw error;
  }
}

export async function markUnread(agentId: string) {
  setApp((s) => ({
    overview: s.overview && {
      ...s.overview,
      agents: s.overview.agents.map((a) =>
        a.id === agentId ? { ...a, unread: Math.max(1, a.unread) } : a
      ),
    },
  }));
  await call('agents.markUnread', { agentId });
}

// ---- Files ------------------------------------------------------------------------

/** Upload a picked file to the Mac's staging area (kept there an hour). */
export function upload(file: PickedFile, onProgress?: (fraction: number) => void) {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return transport.upload(file, onProgress);
}

/** A local copy of an attachment (cached) or of a blob the Mac produced. */
export function download(source: { blobId: string } | { agentId: string; path: string }) {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return transport.download(source);
}

/** An image source for an attachment: the Mac's thumbnail at `width` points (2x for the screen). */
export function attachmentSource(agentId: string, path: string, width?: number) {
  if (!transport) return null;
  return {
    uri: transport.attachmentUrl(agentId, path, width ? width * 2 : undefined),
    headers: transport.authHeaders,
    cacheKey: `${agentId}/${path}@${width ?? 'full'}`,
  };
}

export const listFiles = (agentId: string) => call('agents.files', { agentId });

/** A path written in an agent's reply, fetched from the Mac and saved here. */
export async function fetchPath(agentId: string, path: string) {
  const blob = await call('agents.fetchPath', { agentId, path });
  const local = await download({ blobId: blob.blobId });
  return { ...blob, uri: local };
}

// ---- Search -------------------------------------------------------------------------

export const search = (query: string) => call('agents.search', { query });

/**
 * Page a chat back until `messageId` is loaded, for a search hit. Gives up
 * after `maxPages` pages; resolves whether it was found.
 */
export async function loadUntil(agentId: string, messageId: string, maxPages = 40) {
  const has = () => getApp().chats[agentId]?.messages.some((m) => m.id === messageId) ?? false;
  if (!getApp().chats[agentId]?.loaded) await loadLatest(agentId);
  for (let i = 0; i < maxPages && !has(); i++) {
    if (!getApp().chats[agentId]?.more) break;
    await loadOlder(agentId);
  }
  return has();
}

// ---- Check-ins and routines ---------------------------------------------------------

export const schedule = {
  preview: (when: string) => call('agents.schedule.preview', { when }),
  create: (agentId: string, when: string, note: string) =>
    call('agents.schedule.create', { agentId, when, note }),
  update: (agentId: string, id: string, when: string, note: string) =>
    call('agents.schedule.update', { agentId, id, when, note }),
  pause: (agentId: string, id: string, paused: boolean) =>
    call('agents.schedule.pause', { agentId, id, paused }),
  cancel: (agentId: string, id: string) => call('agents.schedule.cancel', { agentId, id }),
  runNow: (agentId: string, id: string) => call('agents.schedule.runNow', { agentId, id }),
};

// ---- Projects and sessions -----------------------------------------------------------

export async function refreshProjects() {
  const projects = await call('projects.list', {});
  setApp({ projects });
}

export const readSession = (sessionId: string) => call('sessions.read', { sessionId });

/** Type into a project's agent tab. Remote Access's refusals apply on the Mac. */
export const sendToSession = (project: string, sessionId: string, text: string) =>
  call('sessions.send', { project, sessionId, text, clientId: Crypto.randomUUID() });

/** Answer a question a tab is showing: an option's key, or Escape. */
export const pressSessionKey = (sessionId: string, key: string) =>
  call('sessions.key', { sessionId, key });

/** Forget this Mac: revoke our token on it when we can, then wipe everything here. */
export async function unpair() {
  if (transport?.state.kind === 'connected') {
    await call('devices.unpairSelf', {}).catch(() => {});
  }
  transport?.close();
  transport = null;
  const serverId = getApp().credentials?.serverId;
  await forgetCredentials();
  await clearCache().catch(() => {});
  if (serverId) {
    await forgetCache(serverId).catch(() => {});
    await forgetDrafts(serverId).catch(() => {});
  }
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
