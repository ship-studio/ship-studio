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
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { announce } from './a11y';
import { needsYou } from './agents';
import {
  badgeCount,
  clearAll,
  dismissApproval,
  dismissRead,
  post,
  setBadge,
  setupChannels,
} from './notify';
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
import { getApp, setApp, update, useApp } from './store';
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
import { registerPush } from './push';
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
  watchAttention();
  void setupChannels();
  void finishForgets();
  if (credentials) connect(credentials);
}

export async function adopt(credentials: Credentials) {
  await saveCredentials(credentials);
  setApp({ ...emptySync(), credentials, refusal: null, welcome: null, composer: {}, push: null });
  await loadDrafts(credentials.serverId).catch(() => {});
  connect(credentials);
}

const transportFor = (c: Credentials, getResume?: () => ReturnType<typeof getApp>['cursor']) =>
  new DirectTransport({
    routes: usableRoutes(c.routes),
    token: c.token,
    app: {
      version: appInfo().version,
      ...(Updates.updateId ? { updateId: Updates.updateId } : {}),
      runtimeVersion: Updates.runtimeVersion ?? 'development',
    },
    getResume: () => getResume?.() ?? undefined,
    foreground: AppState.currentState === 'active',
    http,
  });

/** Replayed events are history, not news: nothing is announced until caught up. */
let caughtUp = false;

function connect(c: Credentials) {
  transport?.close();
  // The store is in memory, so a cold start has no cursor and gets a
  // snapshot; within a run, every reconnect resumes where it left off.
  const t = transportFor(c, () => getApp().cursor);
  t.onState((link) => {
    // "As of" for everything shown while it's away: the moment it stopped being live.
    const was = getApp().link.kind;
    setApp(
      was === 'connected' && link.kind !== 'connected' ? { link, syncedAt: Date.now() } : { link }
    );
  });
  t.onRefused((refusal) => setApp({ refusal }));
  t.onWelcome((welcome) => {
    caughtUp = false;
    setApp({ welcome, refusal: null });
    // Focus is per connection: the Mac forgot it when the last one dropped.
    const open = getApp().openChat;
    if (open) void call('agents.focus', { agentId: open });
    if (canCall('devices.setPush', welcome)) void syncPush();
  });
  t.onEvent((event, cursor) => {
    if (event.type === 'agents.message') noticeMessage(event.message);
    update((s) => applyEvent(s, event, cursor));
    if (event.type === 'alert') void notify(event.alert);
    if (event.type === 'system.status') learnRoutes(event.status.routes);
    if (event.type === 'sync.snapshot') learnRoutes(event.status.routes);
    // After a snapshot every chat is stale; re-fetch the one on screen now,
    // the others when they're opened. Then send what waited for the Mac.
    if (event.type === 'sync.caughtUp') {
      caughtUp = true;
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

/** Hand the Mac this phone's push token, when it may have one. Never asks. */
const syncPush = () =>
  registerPush((token, environment) => call('devices.setPush', { token, environment })).catch(
    () => {}
  );

/**
 * The user chose alerts (after pairing, or in Settings): ask the OS once,
 * then register for push if this build can.
 */
export async function enableAlerts(): Promise<void> {
  await Notifications.requestPermissionsAsync().catch(() => null);
  if (canCall('devices.setPush')) await syncPush();
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
    if (online && was !== true) {
      transport?.retryNow();
      void finishForgets();
    }
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
  if (agentId) {
    const agent = getApp().overview?.agents.find((a) => a.id === agentId);
    void dismissRead(agentId, agent ? needsYou(agent) : true);
  }
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

// ---- The agent sheet ----------------------------------------------------------------

export const readInstructions = (agentId: string) => call('agents.instructions', { agentId });
export const setInstructions = (agentId: string, instructions: string) =>
  call('agents.update', { agentId, input: { instructions } });
export const readUsage = (agentId: string) => call('agents.usage', { agentId });
export const revokePermission = (agentId: string, ruleId: string) =>
  call('agents.revokePermission', { agentId, ruleId });
export const changeDiff = (agentId: string, messageId: string, path: string) =>
  call('agents.changeDiff', { agentId, messageId, path });

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

/** A new agent tab in `project` that opens on `prompt`; resolves once the tab exists. */
export const startSession = (project: string, prompt: string) =>
  call('sessions.start', { project, prompt, clientId: Crypto.randomUUID() });

/** The project's live preview as `device`, saved here to open. */
export async function previewScreenshot(project: string, device: 'desktop' | 'phone') {
  const blob = await call('preview.screenshot', { project, device });
  return { ...blob, uri: await download({ blobId: blob.blobId }) };
}

/** Answer a question a tab is showing: an option's key, or Escape. */
export const pressSessionKey = (sessionId: string, key: string) =>
  call('sessions.key', { sessionId, key });

/**
 * Forget this Mac: revoke our token on it, then wipe everything here.
 * Offline (or if the Mac doesn't answer), the revoke is queued with the
 * token, in the keychain, and finished the next time the Mac can be
 * reached (`finishForgets`). Says which happened, so Settings can tell the
 * user honestly.
 */
export async function unpair(): Promise<'removed' | 'queued'> {
  const credentials = getApp().credentials;
  let removed = false;
  if (transport?.state.kind === 'connected') {
    removed = await call('devices.unpairSelf', {}).then(
      () => true,
      () => false
    );
  }
  transport?.close();
  transport = null;
  if (credentials && !removed) await queueForget(credentials);
  const serverId = credentials?.serverId;
  await forgetCredentials();
  await clearCache().catch(() => {});
  await clearAll();
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
    push: null,
    link: { kind: 'connecting', attempt: 0 },
  });
  return removed || !credentials ? 'removed' : 'queued';
}

// ---- Forgets that couldn't reach the Mac -----------------------------------------

const FORGET_KEY = 'shipstudio.forget';
const FORGET_OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

async function queuedForgets(): Promise<Credentials[]> {
  const raw = await SecureStore.getItemAsync(FORGET_KEY, FORGET_OPTS).catch(() => null);
  return raw ? (JSON.parse(raw) as Credentials[]) : [];
}

const saveForgets = (list: Credentials[]) =>
  list.length
    ? SecureStore.setItemAsync(FORGET_KEY, JSON.stringify(list), FORGET_OPTS)
    : SecureStore.deleteItemAsync(FORGET_KEY, FORGET_OPTS);

async function queueForget(c: Credentials) {
  const list = (await queuedForgets()).filter((x) => x.serverId !== c.serverId);
  await saveForgets([...list, c]).catch(() => {});
}

/** Macs forgotten while unreachable, for Settings to name. */
export const pendingForgets = async () => (await queuedForgets()).map((c) => c.name);

let finishing = false;

/**
 * Tell each Mac forgotten offline to revoke this phone's token, over a
 * short-lived connection of its own. Done once the Mac confirms, or says
 * the token is already gone.
 */
export async function finishForgets() {
  if (finishing) return;
  finishing = true;
  try {
    for (const c of await queuedForgets()) {
      if (!usableRoutes(c.routes).length) continue;
      const done = await new Promise<boolean>((resolve) => {
        const t = transportFor(c);
        const end = (ok: boolean) => {
          clearTimeout(timer);
          t.close();
          resolve(ok);
        };
        const timer = setTimeout(() => end(false), 20_000);
        t.onRefused((r) => end(r.reason === 'revoked' || r.reason === 'unauthorized'));
        t.onWelcome(() => {
          t.request('devices.unpairSelf', {}).then(
            () => end(true),
            () => end(false)
          );
        });
      });
      if (done) {
        await saveForgets((await queuedForgets()).filter((x) => x.serverId !== c.serverId));
      }
    }
  } finally {
    finishing = false;
  }
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
  await post(alert);
}

/**
 * A message is about to be stored: take back the alert for an approval
 * that was just answered, and tell VoiceOver / TalkBack what's new.
 */
function noticeMessage(m: AgentMessage) {
  const known = getApp().chats[m.agentId]?.messages.find((x) => x.id === m.id);
  if (m.approval && m.approval.status !== 'pending' && known?.approval?.status === 'pending') {
    void dismissApproval(m.agentId, m.id);
  }
  if (!caughtUp || known) return;
  const name = getApp().overview?.agents.find((a) => a.id === m.agentId)?.name ?? 'An agent';
  if (m.kind === 'approval' && m.approval?.status === 'pending') {
    announce(`${name} needs your OK: ${m.approval.title}`, true);
  } else if (m.kind === 'agent') {
    announce(`${name} replied`);
  } else if (m.kind === 'error') {
    announce(`${name} didn’t finish`);
  }
}

let watchingAttention = false;

/**
 * The icon badge follows the overview, and a chat read anywhere (its unread
 * falling to 0, here or at the desk) takes back its reply alerts. A Mac
 * that removed this phone leaves nothing counted.
 */
function watchAttention() {
  if (watchingAttention) return;
  watchingAttention = true;
  useApp.subscribe((s, prev) => {
    if (s.overview === prev.overview && s.link === prev.link) return;
    const refused = s.link.kind === 'refused';
    void setBadge(refused || !s.overview ? 0 : badgeCount(s.overview.agents));
    if (!s.overview || !prev.overview) return;
    for (const a of s.overview.agents) {
      const was = prev.overview.agents.find((b) => b.id === a.id);
      if (was && was.unread > 0 && a.unread === 0) void dismissRead(a.id, needsYou(a));
    }
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
