/**
 * The mobile companion, as the Phone panel sees it: turn phone access on,
 * show a one-time pairing code, Allow or Deny the phone that used it, and
 * see or remove paired phones. The server is `src-tauri/src/companion/`;
 * the wire protocol the phone speaks is `packages/companion-protocol`.
 *
 * @module lib/companion
 */

import { invoke } from '@tauri-apps/api/core';
import type { Device, DevicePlatform } from '../../packages/companion-protocol/src/model';

export type { Device };

/** Re-read `companion_status` when this fires (a pair request, a connect). */
export const COMPANION_CHANGED_EVENT = 'companion://changed';

/** `tailscale::TailscaleState`. */
export type TailscaleState =
  | { state: 'notInstalled' }
  | { state: 'needsLogin' }
  | { state: 'connected'; dnsName: string }
  | { state: 'unknown'; detail: string };

/** The tailnet route, as read back from Tailscale (`desktop::ServeState`). */
export type ServeState =
  | { state: 'off' }
  | { state: 'on'; url: string }
  | { state: 'needsApproval'; url: string }
  | { state: 'failed'; detail: string };

/** A phone that used the code, waiting for Allow or Deny. */
export interface PairRequestDevice {
  name: string;
  platform: DevicePlatform;
  model?: string;
  appVersion: string;
  build: 'official' | 'self';
}

export interface PairingView {
  active: boolean;
  expiresAt?: number;
  request?: PairRequestDevice;
}

export interface PhoneStatus {
  enabled: boolean;
  running: boolean;
  serve: ServeState;
  tailscale: TailscaleState;
  devices: Device[];
  pairing: PairingView;
}

export interface PairingCode {
  /** What the QR code says, for pasting into the phone instead. */
  link: string;
  /** Row by row, `1` for a dark module. */
  qr: { size: number; modules: string };
  expiresAt: number;
}

export const getPhoneStatus = () => invoke<PhoneStatus>('companion_status');

export const setPhoneAccess = (enabled: boolean) =>
  invoke<PhoneStatus>('companion_set_enabled', { enabled });

export const retryPhoneTailscale = () => invoke<PhoneStatus>('companion_retry_tailscale');

export const startPairing = () => invoke<PairingCode>('companion_pair_start');

export const cancelPairing = () => invoke<void>('companion_pair_cancel');

export const decidePairing = (allow: boolean) => invoke<void>('companion_pair_decide', { allow });

export const removePhone = (deviceId: string) =>
  invoke<PhoneStatus>('companion_revoke', { deviceId });

/**
 * Cmd+K "Pair a phone" opens the Phone panel and asks it to show a code
 * straight away. The modal takes the request once, when it opens.
 */
let pairOnOpen = false;

export function requestPairOnOpen() {
  pairOnOpen = true;
}

export function takePairOnOpen(): boolean {
  const wanted = pairOnOpen;
  pairOnOpen = false;
  return wanted;
}

// ---- Wording ----------------------------------------------------------------

/** Where phone access stands, in one state the panel renders. */
export type PhoneStep =
  | { kind: 'off' }
  | { kind: 'installTailscale' }
  | { kind: 'signInTailscale' }
  | { kind: 'approveHttps'; url: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'starting' }
  | { kind: 'ready'; url: string };

/** Off beats everything; then Tailscale itself; then our route. */
export function phoneStep(s: PhoneStatus): PhoneStep {
  if (!s.enabled) return { kind: 'off' };
  if (s.tailscale.state === 'notInstalled') return { kind: 'installTailscale' };
  if (s.tailscale.state === 'needsLogin') return { kind: 'signInTailscale' };
  switch (s.serve.state) {
    case 'on':
      return { kind: 'ready', url: s.serve.url };
    case 'needsApproval':
      return { kind: 'approveHttps', url: s.serve.url };
    case 'failed':
      return { kind: 'failed', detail: s.serve.detail };
    case 'off':
      return s.tailscale.state === 'unknown'
        ? { kind: 'failed', detail: s.tailscale.detail }
        : { kind: 'starting' };
  }
}

/**
 * "iPhone 16 Pro · app 1.0.0", plus "built on this Mac" for a self-build.
 * The model is left out when the phone is already called that.
 */
export function deviceLine(
  d: Pick<Device, 'name' | 'platform' | 'model' | 'appVersion' | 'build'>
) {
  const what = d.model ?? (d.platform === 'ios' ? 'iPhone' : 'Android phone');
  const parts = what === d.name ? [] : [what];
  parts.push(`app ${d.appVersion}`);
  if (d.build === 'self') parts.push('built on this Mac');
  return parts.join(' · ');
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Connected now, or when it was last seen, and over which route. */
export function presenceLine(d: Device, now: number): string {
  if (d.connected) return 'Connected now';
  if (d.lastSeenAt === undefined) return 'Hasn’t connected yet';
  const route = d.lastRoute === 'tailscale' ? ' over Tailscale' : '';
  return `Last seen ${ago(d.lastSeenAt, now)}${route}`;
}

/** "4:32" until a code expires; null once it has. */
export function expiresIn(expiresAt: number, now: number): string | null {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** The address without the scheme, for showing. */
export function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, '');
}
