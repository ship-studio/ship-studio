/**
 * Remote access — control Ship Studio from any MCP-capable AI assistant on
 * your phone while your Mac keeps doing the work.
 *
 * TypeScript mirror of `src-tauri/src/commands/remote_access.rs`, the invoke
 * wrappers, and the logic the modal and sidebar render: the "before you
 * leave" checklist, the setup steps, and the live summary. All pure functions
 * of the backend's status, so every state is testable without a Mac in it.
 *
 * Two rules the copy follows:
 * - The computer must be on for any of this to work, and the user learns that
 *   first, while still sitting at it — not from their phone when nothing
 *   answers.
 * - Setup is finished when an assistant has actually connected, not when a link
 *   exists. A link nobody has used proves nothing.
 *
 * The link's secret never reaches this code: the backend returns a masked
 * link and copies the real one itself. See docs/remote-access.md.
 *
 * @module lib/remoteAccess
 */

import { invoke } from '@tauri-apps/api/core';

export type TailscaleState =
  | { state: 'notInstalled' }
  | { state: 'needsLogin' }
  | { state: 'connected'; dnsName: string }
  | { state: 'unknown'; detail: string };

export interface PowerStatus {
  hasBattery: boolean;
  onAc: boolean | null;
  batteryPercent: number | null;
  charging: boolean | null;
}

export interface RemoteActivity {
  lastRequestMs: number | null;
  lastClient: string | null;
  rejectedRequests: number;
}

export type PushPinState = 'notSet' | 'set' | 'locked';

export interface PublishProgress {
  sinceMs: number | null;
  /** Ship Studio already asked Tailscale again by itself. */
  autoRetried: boolean;
  /** The background check stopped waiting; it's over to the user. */
  gaveUp: boolean;
}

export type Reachability =
  | { state: 'reachable' }
  | { state: 'noPublicDns' }
  | { state: 'unreachable'; detail: string };

export interface RemoteAccessStatus {
  supported: boolean;
  enabled: boolean;
  serverRunning: boolean;
  tailscale: TailscaleState;
  funnelOn: boolean;
  funnelApprovalUrl: string | null;
  funnelError: string | null;
  /** The link with its secret masked; present once Tailscale confirms the Funnel. */
  linkMasked: string | null;
  /**
   * Whether a request through the public internet actually reached this
   * computer. Null until the Funnel is on. Only `reachable` counts as live —
   * the Funnel being configured isn't enough (see Reachability in tailscale.rs).
   */
  reachability: Reachability | null;
  /** The wait for the address to go public, and what's been tried. */
  publish: PublishProgress;
  power: PowerStatus;
  keepAwake: boolean;
  lidClosedMode: boolean | null;
  openAtLogin: boolean;
  openAtLoginAvailable: boolean;
  pushPin: PushPinState;
  projects: string[];
  /** An assistant has reached this computer with the current link at least once. */
  everConnected: boolean;
  activity: RemoteActivity;
}

/** The cheap status the sidebar polls (no Tailscale calls). */
export interface RemoteAccessBrief {
  enabled: boolean;
  serverRunning: boolean;
  keepAwake: boolean;
  power: PowerStatus;
  lidClosedMode: boolean | null;
  activity: RemoteActivity;
}

export interface AuditEntry {
  atMs: number;
  tool: string;
  project: string | null;
  detail: string;
  ok: boolean;
}

export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/mac';
export const TAILSCALE_MACHINES_URL = 'https://login.tailscale.com/admin/machines';

export const getRemoteAccessStatus = () => invoke<RemoteAccessStatus>('get_remote_access_status');
export const getRemoteAccessBrief = () => invoke<RemoteAccessBrief>('get_remote_access_brief');
export const setRemoteAccessEnabled = (enabled: boolean) =>
  invoke<RemoteAccessStatus>('set_remote_access_enabled', { enabled });
export const setRemoteProject = (projectPath: string, shared: boolean) =>
  invoke<string[]>('set_remote_project', { projectPath, shared });
export const resetRemoteLink = () => invoke<RemoteAccessStatus>('reset_remote_link');
export const republishRemoteLink = () => invoke<RemoteAccessStatus>('republish_remote_link');
export const copyRemoteLink = () => invoke<void>('copy_remote_link');
export const setLidClosedMode = (enabled: boolean) =>
  invoke<RemoteAccessStatus>('set_lid_closed_mode', { enabled });
export const setOpenAtLogin = (enabled: boolean) =>
  invoke<RemoteAccessStatus>('set_open_at_login', { enabled });
export const setRemotePushPin = (pin: string) =>
  invoke<RemoteAccessStatus>('set_remote_push_pin', { pin });
export const clearRemotePushPin = () => invoke<RemoteAccessStatus>('clear_remote_push_pin');
export const getRemoteAudit = (limit = 50) => invoke<AuditEntry[]>('get_remote_audit', { limit });

// ============================================================================
// "Before you leave" — will the computer still be there?
// ============================================================================

export type CheckState = 'ok' | 'warn';

export interface ReadinessItem {
  id: 'power' | 'awake' | 'lid' | 'restart' | 'app';
  state: CheckState;
  title: string;
  detail: string;
}

type ReadinessInput = Pick<
  RemoteAccessStatus,
  'power' | 'keepAwake' | 'lidClosedMode' | 'openAtLogin'
>;

export function readinessItems(s: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const { power } = s;

  if (power.onAc === true) {
    items.push({
      id: 'power',
      state: 'ok',
      title: 'Plugged in',
      detail: 'Keep it plugged in while you’re away.',
    });
  } else if (power.onAc === false) {
    items.push({
      id: 'power',
      state: 'warn',
      title: power.batteryPercent !== null ? `On battery (${power.batteryPercent}%)` : 'On battery',
      detail: 'Plug it in. On battery it stops when the battery runs out.',
    });
  } else {
    items.push({
      id: 'power',
      state: 'warn',
      title: 'Power unknown',
      detail: 'Couldn’t tell whether this computer is plugged in. Make sure it is.',
    });
  }

  items.push(
    s.keepAwake
      ? {
          id: 'awake',
          state: 'ok',
          title: 'Kept awake',
          detail: 'It won’t sleep while remote access is on. The screen can still turn off.',
        }
      : {
          id: 'awake',
          state: 'warn',
          title: 'May fall asleep',
          detail: 'Turning on remote access keeps it awake.',
        }
  );

  if (power.hasBattery) {
    items.push(
      s.lidClosedMode === true
        ? {
            id: 'lid',
            state: 'ok',
            title: 'Runs with the lid closed',
            detail:
              'Keep it plugged in — it keeps working and using battery with the lid shut. Don’t put it in a bag.',
          }
        : {
            id: 'lid',
            state: 'warn',
            title: 'Closing the lid puts it to sleep',
            detail: 'Leave the lid open, or let it run with the lid closed.',
          }
    );
  }

  items.push(
    s.openAtLogin
      ? {
          id: 'restart',
          state: 'ok',
          title: 'Comes back after a restart',
          detail:
            'After a restart (like an overnight macOS update) someone still has to log in once.',
        }
      : {
          id: 'restart',
          state: 'warn',
          title: 'Won’t come back after a restart',
          detail: 'If macOS restarts, remote access stays off until you’re back.',
        }
  );

  items.push({
    id: 'app',
    state: 'ok',
    title: 'Leave Ship Studio open',
    detail: 'Quitting it ends remote access. You’ll be asked first.',
  });

  return items;
}

export function warningCount(s: ReadinessInput): number {
  return readinessItems(s).filter((i) => i.state === 'warn').length;
}

export function isReadyToLeave(s: ReadinessInput): boolean {
  return warningCount(s) === 0;
}

// ============================================================================
// Connection
// ============================================================================

export type ConnectionStep =
  | { kind: 'unsupported' }
  | { kind: 'installTailscale' }
  | { kind: 'signInTailscale' }
  | { kind: 'tailscaleProblem'; detail: string }
  | { kind: 'off' }
  | { kind: 'approveFunnel'; url: string }
  | { kind: 'funnelFailed'; detail: string }
  | { kind: 'starting' }
  /** Funnel is on, but the internet can't find this computer yet. */
  | { kind: 'publishing'; linkMasked: string; stage: PublishStage; minutes: number }
  /** Funnel is on and the name resolves, but requests don't get through. */
  | { kind: 'unreachable'; linkMasked: string; detail: string }
  | { kind: 'ready'; linkMasked: string };

/**
 * One state, in the order the blockers have to be cleared: you can't turn on
 * a Funnel you can't sign in to, and "ready" means a request from the public
 * internet actually reached this computer — not just that Tailscale is
 * configured. Until then the link is shown (so it can be added in advance)
 * with what's still missing.
 */
export type PublishStage = 'waiting' | 'retried' | 'stuck';

/** Where the wait for a public address has got to. */
export function publishStage(p: PublishProgress, minutes: number): PublishStage {
  if (p.gaveUp || minutes >= 10) return 'stuck';
  if (p.autoRetried) return 'retried';
  return 'waiting';
}

export function connectionStep(s: RemoteAccessStatus, now: number = 0): ConnectionStep {
  if (!s.supported) return { kind: 'unsupported' };
  switch (s.tailscale.state) {
    case 'notInstalled':
      return { kind: 'installTailscale' };
    case 'needsLogin':
      return { kind: 'signInTailscale' };
    case 'unknown':
      return { kind: 'tailscaleProblem', detail: s.tailscale.detail };
    case 'connected':
      break;
  }
  if (!s.enabled) return { kind: 'off' };
  if (s.linkMasked) {
    const r = s.reachability;
    if (r?.state === 'reachable') return { kind: 'ready', linkMasked: s.linkMasked };
    if (r?.state === 'unreachable') {
      return { kind: 'unreachable', linkMasked: s.linkMasked, detail: r.detail };
    }
    const minutes =
      s.publish.sinceMs !== null ? Math.max(0, Math.floor((now - s.publish.sinceMs) / 60_000)) : 0;
    return {
      kind: 'publishing',
      linkMasked: s.linkMasked,
      stage: publishStage(s.publish, minutes),
      minutes,
    };
  }
  if (s.funnelApprovalUrl) return { kind: 'approveFunnel', url: s.funnelApprovalUrl };
  if (s.funnelError) return { kind: 'funnelFailed', detail: s.funnelError };
  return { kind: 'starting' };
}

// ============================================================================
// Setup steps
// ============================================================================

export type SetupStepId = 'stayOn' | 'connect' | 'projects' | 'pushing' | 'assistant';
export type SetupStepState = 'done' | 'current' | 'upcoming';

/** Choices the user made in this modal that the backend doesn't record. */
export interface SetupChoices {
  /** Read and accepted "this computer has to stay on". */
  understood: boolean;
  /** Pressed Continue after ticking projects. */
  projectsConfirmed: boolean;
  /** Chose not to allow pushing from the phone. */
  pushingSkipped: boolean;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  state: SetupStepState;
}

const STEP_TITLES: Record<SetupStepId, string> = {
  stayOn: 'This computer has to stay on',
  connect: 'Give this computer a private link',
  projects: 'Choose what your assistant can reach',
  pushing: 'Pushing from your phone',
  assistant: 'Connect your AI assistant',
};

function stepDone(id: SetupStepId, s: RemoteAccessStatus, c: SetupChoices): boolean {
  switch (id) {
    case 'stayOn':
      return c.understood || s.everConnected;
    case 'connect':
      return s.linkMasked !== null;
    case 'projects':
      return s.projects.length > 0 && (c.projectsConfirmed || s.everConnected);
    case 'pushing':
      return s.pushPin !== 'notSet' || c.pushingSkipped || s.everConnected;
    case 'assistant':
      return s.everConnected;
  }
}

/**
 * The setup steps in order, each done, current (the first not done) or
 * upcoming. Steps are done by what's true, not by what was clicked, except
 * where only the user can say (having read a warning, choosing to skip).
 */
export function setupSteps(s: RemoteAccessStatus, c: SetupChoices): SetupStep[] {
  const ids: SetupStepId[] = ['stayOn', 'connect', 'projects', 'pushing', 'assistant'];
  let foundCurrent = false;
  return ids.map((id) => {
    let state: SetupStepState = 'upcoming';
    if (!foundCurrent) {
      if (stepDone(id, s, c)) state = 'done';
      else {
        state = 'current';
        foundCurrent = true;
      }
    }
    return { id, title: STEP_TITLES[id], state };
  });
}

/**
 * Setup is finished once an assistant has connected with the current link —
 * and stays finished if the link later drops, so a problem shows up in the
 * live view (as "Not reachable") instead of throwing the user back into a
 * wizard they already completed. Replacing the link starts setup over.
 */
export function isSetupComplete(s: RemoteAccessStatus, c: SetupChoices): boolean {
  return s.everConnected || setupSteps(s, c).every((step) => step.state === 'done');
}

// ============================================================================
// Live summary
// ============================================================================

export type LiveState = 'live' | 'down' | 'off';

/** "Live" only when the internet can actually reach it; anything less is "down". */
export function liveState(s: RemoteAccessStatus): LiveState {
  if (!s.enabled) return 'off';
  return s.reachability?.state === 'reachable' ? 'live' : 'down';
}

export function agoText(ms: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86_400)} d ago`;
}

/** "grok connected 3 min ago", or null when nothing has connected this run. */
export function describeLastRequest(activity: RemoteActivity, now: number): string | null {
  if (activity.lastRequestMs === null) return null;
  const when = agoText(activity.lastRequestMs, now);
  return activity.lastClient ? `${activity.lastClient} connected ${when}` : `Last used ${when}`;
}

/** A remote action as one readable line. */
export function describeAudit(entry: AuditEntry): string {
  const project = entry.project ? ` in ${entry.project.split('/').pop()}` : '';
  const quote = entry.detail ? `: “${entry.detail}”` : '';
  switch (entry.tool) {
    case 'connected':
      return `${entry.detail} connected`;
    case 'message_agent':
    case 'send_to_agent': // the tool's name before message_agent; older log lines
      return `Sent a message${project}${quote}`;
    case 'start_agent':
      return `Started a new agent${project}${quote}`;
    case 'close_agent':
      return `Closed an agent${project}${entry.detail ? ` (${entry.detail})` : ''}`;
    case 'republish':
      return entry.ok ? 'Asked Tailscale to publish the address again' : 'Republishing failed';
    case 'press_key':
      return `Pressed ${entry.detail.replace('key ', '') || 'a key'}${project}`;
    case 'read_agent':
      return `Read an agent tab${project}`;
    case 'prepare_push':
      return `Asked to push${project}`;
    case 'confirm_push':
      return entry.ok ? `Pushed${project}` : `Push refused${project}`;
    case 'preview_screenshot':
      return `Took a preview screenshot${project}`;
    case 'create_project':
      return entry.ok ? `Created a new project${quote}` : `Couldn’t create a project${quote}`;
    case 'open_project':
      return `Switched to${project.replace(' in', '')}`;
    case 'push_pin':
    case 'new_link':
      return entry.detail.charAt(0).toUpperCase() + entry.detail.slice(1);
    default:
      return `${entry.tool.replace(/_/g, ' ')}${project}`;
  }
}

/** PIN rules, mirrored from the backend so the field can say why before submitting. */
export function pinProblem(pin: string): string | null {
  if (!/^\d*$/.test(pin)) return 'Digits only.';
  if (pin.length < 6) return 'At least 6 digits.';
  if (pin.length > 12) return 'At most 12 digits.';
  const d = pin.split('').map(Number);
  const same = d.every((n) => n === d[0]);
  const up = d.every((n, i) => i === 0 || n === d[i - 1] + 1);
  const down = d.every((n, i) => i === 0 || n === d[i - 1] - 1);
  if (same || up || down) return 'Too easy to guess.';
  return null;
}
