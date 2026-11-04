/**
 * The phone's notifications, kept honest:
 *
 * - one per alert, stacked per agent (iOS `threadIdentifier`, the same
 *   thread id the push relay sets), on an Android channel per urgency;
 * - taken back once handled: an approval answered here or at the desk, or
 *   a chat read on either side, removes what it was about, local or pushed;
 * - the app icon's badge is the desk's own count (`notify::badge_count`:
 *   unread plus approvals waiting, hidden agents left out), so the icon and
 *   the Mac's Dock never disagree;
 * - Forget this Mac clears all of it.
 *
 * Notification Center calls fail quietly: a stale banner is a nuisance, a
 * crash on a background tick is worse.
 */

import type { Agent, Alert } from '@shipstudio/companion-protocol';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/** What a notification is about, from a local alert's data or a push's payload. */
export interface Target {
  agentId: string;
  messageId?: string;
  /** `approval` for a local one; `needs_you` for a push. */
  kind?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function targetOf(request: Notifications.NotificationRequest | undefined): Target | null {
  if (!request) return null;
  const trigger = request.trigger as {
    payload?: { body?: Record<string, unknown> };
    remoteMessage?: { data?: Record<string, unknown> };
  } | null;
  for (const source of [
    request.content.data,
    trigger?.payload?.body,
    trigger?.remoteMessage?.data,
  ]) {
    const agentId = str(source?.agentId);
    if (!agentId) continue;
    const messageId = str(source?.messageId);
    const kind = str(source?.kind);
    return { agentId, ...(messageId ? { messageId } : {}), ...(kind ? { kind } : {}) };
  }
  return null;
}

const isApproval = (t: Target) => t.kind === 'approval' || t.kind === 'needs_you';

/** The desk's badge rule: unread plus approvals waiting, for every agent not hidden. */
export const badgeCount = (agents: Agent[]) =>
  agents.filter((a) => !a.hidden).reduce((n, a) => n + a.unread + (a.pendingApprovals ?? 0), 0);

const CHANNEL = { needsYou: 'needs-you', replies: 'replies' } as const;

/** Android: approvals interrupt (heads-up), replies don't. Once per launch. */
export async function setupChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL.needsYou, {
    name: 'Needs you',
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => {});
  await Notifications.setNotificationChannelAsync(CHANNEL.replies, {
    name: 'Replies',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {});
}

/** The same alert again replaces the first rather than stacking a copy. */
export const notificationId = (alert: Alert) =>
  alert.messageId ? `${alert.kind}:${alert.messageId}` : undefined;

export async function post(alert: Alert) {
  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return;
  const identifier = notificationId(alert);
  await Notifications.scheduleNotificationAsync({
    ...(identifier ? { identifier } : {}),
    content: {
      title: alert.title,
      body: alert.body,
      threadIdentifier: alert.agentId,
      data: { agentId: alert.agentId, messageId: alert.messageId ?? null, kind: alert.kind },
    },
    trigger:
      Platform.OS === 'android'
        ? { channelId: alert.kind === 'approval' ? CHANNEL.needsYou : CHANNEL.replies }
        : null,
  }).catch(() => {});
}

async function dismissWhere(match: (t: Target) => boolean) {
  const shown = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  await Promise.all(
    shown
      .filter((n) => {
        const t = targetOf(n.request);
        return t && match(t);
      })
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {}))
  );
}

/** An approval was answered (here or at the desk): its alert is no longer true. */
export const dismissApproval = (agentId: string, messageId: string) =>
  dismissWhere(
    (t) =>
      t.agentId === agentId &&
      // A push carries no message id: once nothing of this agent's waits, it goes too.
      (t.messageId === messageId || (t.kind === 'needs_you' && !t.messageId))
  );

/**
 * A chat was read here or at the desk: its replies are seen. What still
 * waits on you stays until it's answered.
 */
export const dismissRead = (agentId: string, stillWaiting: boolean) =>
  dismissWhere((t) => t.agentId === agentId && !(stillWaiting && isApproval(t)));

let lastBadge: number | null = null;

/** Only with permission (iOS shows no badge without it) and only when it changed. */
export async function setBadge(count: number) {
  if (count === lastBadge) return;
  const { granted } = await Notifications.getPermissionsAsync().catch(() => ({ granted: false }));
  if (!granted) return;
  lastBadge = count;
  await Notifications.setBadgeCountAsync(count).catch(() => {});
}

/** Forget this Mac: nothing it said stays on the Lock Screen, and no count stays on the icon. */
export async function clearAll() {
  lastBadge = null;
  await Notifications.dismissAllNotificationsAsync().catch(() => {});
  await Notifications.setBadgeCountAsync(0).catch(() => {});
}
