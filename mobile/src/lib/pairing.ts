/**
 * Pairing with a Mac, and keeping what it gives us (docs/mobile.md, "Pairing").
 * The QR code holds a one-time code; the device token comes back over TLS and
 * lives only in the keychain.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import {
  HTTP,
  SUPPORTED,
  toBase64Url,
  type PairRequest,
  type PairResponse,
  type PairingLink,
  type Route,
} from '@shipstudio/companion-protocol';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';

/** One paired Mac. Multiple Macs are P3. */
export interface Credentials {
  serverId: string;
  name: string;
  routes: Route[];
  deviceId: string;
  token: string;
  /** X25519, base64url: unused by direct routes, kept for the future relay. */
  secretKey: string;
  pairedAt: number;
}

const KEY = 'shipstudio.mac';
// Excluded from backups and other devices: the token is this phone's alone.
const STORE_OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadCredentials(): Promise<Credentials | null> {
  const raw = await SecureStore.getItemAsync(KEY, STORE_OPTS);
  return raw ? (JSON.parse(raw) as Credentials) : null;
}

export const saveCredentials = (c: Credentials) =>
  SecureStore.setItemAsync(KEY, JSON.stringify(c), STORE_OPTS);

export const forgetCredentials = () => SecureStore.deleteItemAsync(KEY, STORE_OPTS);

/**
 * P1 connects over Tailscale only. A LAN route needs the pinned-transport
 * native module (P2), and plain fetch can't pin a self-signed certificate.
 */
export const usableRoutes = (routes: Route[]) => routes.filter((r) => r.kind === 'tailscale');

export type PairFailure =
  | { kind: 'lan_only' }
  | { kind: 'tailscale_off' }
  | { kind: 'mac_unreachable' }
  | { kind: 'refused'; reason: Extract<PairResponse, { ok: false }>['reason']; message: string }
  | { kind: 'expired' }
  | { kind: 'other'; message: string };

export class PairError extends Error {
  constructor(readonly failure: PairFailure) {
    super(failure.kind);
  }
}

export const appInfo = () => ({
  version: Application.nativeApplicationVersion ?? '0.0.0',
  build: Application.nativeBuildVersion ?? '0',
});

/**
 * Ask the Mac to pair. The request stays open while someone at the desk
 * decides (up to 120 s), so the caller shows "Allow on your Mac…" meanwhile.
 */
export async function pair(link: PairingLink, signal?: AbortSignal): Promise<Credentials> {
  const routes = usableRoutes(link.routes);
  if (!routes.length) throw new PairError({ kind: 'lan_only' });
  const secret = Crypto.getRandomBytes(32);
  const body: PairRequest = {
    code: link.code,
    device: {
      name: Device.deviceName ?? Device.modelName ?? 'Phone',
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      ...(Device.modelName ? { model: Device.modelName } : {}),
      appVersion: appInfo().version,
      build: Constants.expoConfig?.extra?.official ? 'official' : 'self',
    },
    protocol: SUPPORTED,
    publicKey: toBase64Url(x25519.getPublicKey(secret)),
  };

  let lastNetworkFailure: PairFailure = { kind: 'mac_unreachable' };
  for (const route of routes) {
    let res: Response;
    try {
      res = await fetch(route.url.replace(/\/$/, '') + HTTP.pair, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastNetworkFailure = await diagnose(route.url);
      continue;
    }
    // A wrong, used or expired code is a bare 404 (the Mac says nothing more).
    if (res.status === 404) throw new PairError({ kind: 'expired' });
    if (!res.ok) throw new PairError({ kind: 'other', message: `The Mac answered ${res.status}.` });
    const answer = (await res.json()) as PairResponse;
    if (!answer.ok) {
      throw new PairError({ kind: 'refused', reason: answer.reason, message: answer.message });
    }
    return {
      serverId: answer.serverId,
      name: link.name,
      routes,
      deviceId: answer.deviceId,
      token: answer.token,
      secretKey: toBase64Url(secret),
      pairedAt: Date.now(),
    };
  }
  throw new PairError(lastNetworkFailure);
}

/**
 * Why a route didn't answer, as far as the phone can tell. A `*.ts.net` name
 * resolves only through Tailscale's own DNS, so "host not found" means this
 * phone isn't on the tailnet; a name that resolves but never answers means
 * the Mac (or Ship Studio on it) isn't there. React Native's fetch hides the
 * difference, so this asks with XMLHttpRequest, which keeps the OS's reason.
 */
export function diagnose(
  url: string,
  timeoutMs = 6000
): Promise<{ kind: 'tailscale_off' } | { kind: 'mac_unreachable' }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = timeoutMs;
    xhr.onload = () => resolve({ kind: 'mac_unreachable' }); // answered after all: blame the socket
    xhr.ontimeout = () => resolve({ kind: 'mac_unreachable' });
    xhr.onerror = () => {
      const reason = String(xhr.responseText ?? '');
      resolve(
        /hostname could not be found|resolve host|UnknownHost|No address associated|nodename nor servname/i.test(
          reason
        ) && /\.ts\.net/i.test(url)
          ? { kind: 'tailscale_off' }
          : { kind: 'mac_unreachable' }
      );
    };
    xhr.open('GET', url.replace(/\/$/, '') + HTTP.pair);
    xhr.send();
  });
}

const TAILSCALE_STORE =
  Platform.OS === 'android'
    ? 'https://play.google.com/store/apps/details?id=com.tailscale.ipn'
    : 'https://apps.apple.com/app/tailscale/id1470499037';

/** The Tailscale app if it's installed, otherwise its store page. */
export async function openTailscale() {
  try {
    if (await Linking.canOpenURL('tailscale://')) return await Linking.openURL('tailscale://');
  } catch {
    // fall through to the store
  }
  await Linking.openURL(TAILSCALE_STORE);
}
