/**
 * What the phone can honestly say about the link (docs/mobile.md,
 * "Connection status"). Each layer is ok, a problem, or unknown, and nothing
 * is claimed that wasn't observed: "Ship Studio running" is only ever yes
 * when the server answered, because silence looks the same either way.
 */

import type { Known } from '@shipstudio/companion-protocol';
import { formatAgo } from './agents';
import type { AppState } from './store';

export type Tone = 'ok' | 'problem' | 'unknown' | 'busy';

export interface Pill {
  tone: Tone;
  label: string;
}

type Inputs = Pick<
  AppState,
  'link' | 'refusal' | 'mac' | 'overview' | 'phoneOnline' | 'syncedAt' | 'credentials'
>;

const claudeSignedOut = (s: Inputs) =>
  s.mac?.claude.signedIn === 'no' ||
  Boolean(s.overview?.agents.some((a) => a.failure?.kind === 'signed_out'));

export function pill(s: Inputs, now = Date.now()): Pill {
  const { link } = s;
  if (link.kind === 'refused') {
    return link.reason === 'update_app' || link.reason === 'update_mac'
      ? { tone: 'problem', label: 'Update needed' }
      : { tone: 'problem', label: 'Removed from Mac' };
  }
  if (link.kind === 'connected') {
    return claudeSignedOut(s)
      ? { tone: 'problem', label: 'Claude Code signed out' }
      : { tone: 'ok', label: 'Connected' };
  }
  if (s.phoneOnline === false) return { tone: 'problem', label: 'Can’t reach Mac' };
  if (link.kind === 'reconnecting') {
    // A short blip reads as calm; a long one says plainly that it's not there.
    return now - link.lastSeenAt > 2 * 60_000
      ? { tone: 'problem', label: 'Can’t reach Mac' }
      : { tone: 'busy', label: `Reconnecting · last seen ${formatAgo(link.lastSeenAt, now)}` };
  }
  return link.attempt >= 3
    ? { tone: 'problem', label: 'Can’t reach Mac' }
    : { tone: 'busy', label: 'Connecting…' };
}

export interface Layer {
  title: string;
  tone: Tone;
  detail: string;
}

const known = (k: Known, yes: string, no: string, unknown: string) =>
  k === 'yes' ? yes : k === 'no' ? no : unknown;

export function layers(
  s: Inputs,
  extra: { latencyMs: number | null; lastSeenAt: number },
  now = Date.now()
): Layer[] {
  const connected = s.link.kind === 'connected';
  const name = s.credentials?.name ?? 'your Mac';
  const mac = s.mac;
  const out: Layer[] = [];

  out.push({
    title: 'This phone is online',
    tone: s.phoneOnline == null ? 'unknown' : s.phoneOnline ? 'ok' : 'problem',
    detail: s.phoneOnline == null ? 'Unknown' : s.phoneOnline ? 'Yes' : 'No network on this phone',
  });

  if (connected) {
    const via = s.link.kind === 'connected' && s.link.route === 'tailscale' ? 'Tailscale' : 'LAN';
    out.push({
      title: 'Mac reachable',
      tone: 'ok',
      detail: `Over ${via}${extra.latencyMs != null ? ` · ${extra.latencyMs} ms` : ''}`,
    });
  } else {
    const seen = extra.lastSeenAt
      ? `Last seen ${formatAgo(extra.lastSeenAt, now)}`
      : 'Not seen yet';
    // We can't know why from here; list the likely causes from the last status we had.
    const causes = ['Tailscale may be off on this phone or on the Mac'];
    if (mac && !mac.power.keepAwake && mac.power.onBattery === 'yes') {
      const pct = mac.power.batteryPercent != null ? ` at ${mac.power.batteryPercent}%` : '';
      causes.unshift(`It was on battery${pct} with keep-awake off: it may be asleep`);
    }
    out.push({
      title: 'Mac reachable',
      tone: s.link.kind === 'connecting' && s.link.attempt < 3 ? 'unknown' : 'problem',
      detail: `${seen}. ${causes.join('. ')}.`,
    });
  }

  out.push(
    mac && connected
      ? {
          title: 'Mac awake',
          tone: 'ok',
          detail: [
            mac.power.keepAwake ? 'Keep-awake on' : 'Keep-awake off',
            known(mac.power.lidClosedMode, 'lid-closed mode on', 'lid-closed mode off', ''),
            mac.power.onBattery === 'yes'
              ? `on battery${mac.power.batteryPercent != null ? ` (${mac.power.batteryPercent}%)` : ''}`
              : mac.power.onBattery === 'no'
                ? 'on power'
                : '',
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : { title: 'Mac awake', tone: 'unknown', detail: 'Unknown until it answers' }
  );

  out.push({
    title: 'Ship Studio running',
    tone: connected ? 'ok' : 'unknown',
    detail: connected
      ? `Yes${mac ? ` · ${mac.appVersion}` : ''}`
      : `Unknown: ${name} isn’t answering, which looks the same whether it’s asleep or closed`,
  });

  if (!mac) {
    out.push({ title: 'Claude Code', tone: 'unknown', detail: 'Unknown' });
  } else if (!mac.claude.installed) {
    out.push({ title: 'Claude Code', tone: 'problem', detail: 'Not installed on the Mac' });
  } else {
    const signedOut = claudeSignedOut(s);
    out.push({
      title: 'Claude Code',
      tone: signedOut ? 'problem' : mac.claude.signedIn === 'yes' ? 'ok' : 'unknown',
      detail: signedOut
        ? 'Signed out. Sign in on your Mac to keep your agents working'
        : known(mac.claude.signedIn, 'Signed in', 'Signed out', 'Sign-in unknown') +
          (mac.claude.version ? ` · ${mac.claude.version}` : ''),
    });
  }

  out.push({
    title: 'Last sync',
    tone: connected && s.syncedAt ? 'ok' : 'unknown',
    detail:
      connected && s.syncedAt
        ? 'Live: changes arrive as they happen'
        : extra.lastSeenAt
          ? `Last synced ${formatAgo(extra.lastSeenAt, now)}`
          : 'Not yet',
  });
  return out;
}
