/**
 * Real push, through the Mac and Ship Studio's content-free relay
 * (docs/push-relay.md). The phone's only part: hand the Mac its push token
 * once it may show notifications, and say honestly where that leaves it.
 *
 * - Permission is asked at first need (the "Turn on alerts" card after
 *   pairing, or Settings), never at launch. Without it there is no token.
 * - Only the official build can receive push; a self-built app has no APNs
 *   entitlement, and says so instead of asking.
 * - The token goes to the Mac on every connect (`devices.setPush`); an
 *   unchanged one costs the Mac nothing.
 */

import type { PushEnvironment, PushStatus } from '@shipstudio/companion-protocol';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getApp, setApp } from './store';

/** Built by Ship Studio's EAS project (TestFlight, the App Store). */
export const isOfficialBuild = () => Boolean(Constants.expoConfig?.extra?.official);

/** What Settings says about push, from what is known. Null: say nothing yet. */
export function pushLine(
  status: PushStatus | null,
  official: boolean
): { value: string; footer: string } | null {
  if (!official || status === 'self_build') {
    return {
      value: 'Needs the official build',
      footer:
        'Push needs the official app from TestFlight or the App Store. This app was built on your Mac, and Apple doesn’t let it receive push.',
    };
  }
  switch (status) {
    case 'on':
      return {
        value: 'On',
        footer:
          'Your Mac can wake this phone through Ship Studio’s push service. Alerts say only that an agent needs you or finished, never what it said.',
      };
    case 'pending':
      return {
        value: 'Connecting',
        footer: 'Your Mac couldn’t reach the push service yet. It tries again with the next alert.',
      };
    case 'off':
      return {
        value: 'Off on your Mac',
        footer:
          'Turn on “Phone notifications via Ship Studio’s push service” in Ship Studio → Phone on your Mac.',
      };
    case 'unavailable':
      return {
        value: 'Not on this Mac',
        footer:
          'The Ship Studio on your Mac has no push service. Alerts arrive while the app is open.',
      };
    default:
      return null;
  }
}

/** The agent a tapped notification is about: local (`data`), APNs (`body`) or FCM. */
export function agentFromResponse(
  response: Notifications.NotificationResponse | null
): string | null {
  if (!response) return null;
  const request = response.notification.request;
  const trigger = request.trigger as {
    payload?: { body?: { agentId?: unknown } };
    remoteMessage?: { data?: { agentId?: unknown } };
  } | null;
  const candidates = [
    request.content.data?.agentId,
    trigger?.payload?.body?.agentId,
    trigger?.remoteMessage?.data?.agentId,
  ];
  const id = candidates.find((c) => typeof c === 'string' && c.length > 0);
  return typeof id === 'string' ? id : null;
}

async function environment(): Promise<PushEnvironment | null> {
  if (Platform.OS !== 'ios') return 'production';
  const env = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null);
  return env === 'development' || env === 'production' ? env : null;
}

/**
 * Tell the Mac this phone's token, if it may have one. Never asks for
 * permission. `call` is the session's request function.
 */
export async function registerPush(
  call: (token: string | null, environment: PushEnvironment) => Promise<{ status: PushStatus }>
): Promise<void> {
  if (!isOfficialBuild()) return setApp({ push: 'self_build' });
  // Simulators have no APNs token.
  if (!Device.isDevice) return;
  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return;
  const env = await environment();
  if (!env) return;
  const token: unknown = (await Notifications.getDevicePushTokenAsync()).data;
  if (typeof token !== 'string') return;
  const { status } = await call(token, env);
  if (getApp().push !== status) setApp({ push: status });
}
