/**
 * Hosting status: did the commit I just pushed actually deploy?
 *
 * TS mirror of `src-tauri/src/commands/hosting/model.rs`, the invoke wrappers,
 * and the reducer that turns a backend answer into the single state the section
 * renders.
 *
 * The reducer is the interesting part. The backend reports what a provider
 * said; it deliberately does not decide how long to keep hoping a missing
 * deployment will appear, because only the frontend knows when the user pushed.
 * `deriveSectionState` folds auth, link, transport, and timing into exactly one
 * `SectionState`, and every state maps to one fixed-height row — which is what
 * keeps the popover from resizing as answers arrive.
 *
 * @module lib/hosting
 */

import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// Mirrors of the Rust types
// ---------------------------------------------------------------------------

export type HostingProvider = 'vercel' | 'cloudflare' | 'netlify';

export const PROVIDER_LABELS: Record<HostingProvider, string> = {
  vercel: 'Vercel',
  cloudflare: 'Cloudflare',
  netlify: 'Netlify',
};

export type LinkSource = 'vercel_cli_file' | 'netlify_cli_file' | 'user_picked';

export interface HostingLink {
  provider: HostingProvider;
  project_id: string;
  scope_id?: string | null;
  project_name?: string | null;
  source: LinkSource;
  linked_at: number;
}

export interface DetectedLink {
  provider: HostingProvider;
  project_id: string;
  scope_id?: string | null;
  project_name?: string | null;
  source: LinkSource;
}

export interface CommitRef {
  sha: string;
  short_sha: string;
  subject?: string | null;
  committed_at?: number | null;
  branch: string;
  has_upstream: boolean;
}

export type Environment = 'production' | 'preview';

export type DeploymentPhase =
  | { phase: 'queued' }
  | { phase: 'building' }
  | { phase: 'publishing' }
  | { phase: 'ready' }
  | { phase: 'failed' }
  | { phase: 'canceled' }
  | { phase: 'skipped' }
  | { phase: 'gated' }
  | { phase: 'unknown'; raw: string };

export type DeploymentDetail =
  | { detail: 'not_yet_promoted' }
  | { detail: 'rolling_out' }
  | { detail: 'skipped_because'; reason?: string | null }
  | { detail: 'awaiting_review'; reason?: string | null }
  | { detail: 'review_rejected' }
  | { detail: 'superseded_by_newer' };

export interface DeploymentUrls {
  /** The address people visit — the project's production domain. */
  site?: string | null;
  /** This build's immutable permalink. Always this commit, never "current". */
  deployment?: string | null;
  aliases: string[];
  /** Site if known, else this build. */
  primary?: string | null;
}

export interface Deployment {
  id: string;
  /** The provider's own status word, shown verbatim ("Ready", not a synonym). */
  status_label: string;
  phase: DeploymentPhase;
  detail?: DeploymentDetail | null;
  environment: Environment;
  branch?: string | null;
  commit_sha: string;
  commit_message?: string | null;
  urls: DeploymentUrls;
  dashboard_url?: string | null;
  error_message?: string | null;
  created_at: number;
  ready_at?: number | null;
}

export type LogStream = 'stdout' | 'stderr';

export interface LogLine {
  at: number;
  stream: LogStream;
  text: string;
}

export interface BuildLog {
  deployment_id: string;
  lines: LogLine[];
  /** The provider capped what it returned, so this isn't the whole log. */
  truncated: boolean;
}

export type Lookup =
  | { kind: 'found'; deployment: Deployment }
  | { kind: 'not_found'; latest_on_branch?: Deployment | null };

export type Auth = { kind: 'ok' } | { kind: 'no_token' } | { kind: 'rejected' };

export type TokenSource = 'keychain' | 'cli_file';

export interface ProviderStatus {
  link: HostingLink;
  auth: Auth;
  token_source?: TokenSource | null;
  lookup?: Lookup | null;
  transport_error?: string | null;
  retry_after_secs?: number | null;
  fetched_at: number;
  from_cache: boolean;
}

export interface HostingStatus {
  commit: CommitRef;
  providers: ProviderStatus[];
  detected: DetectedLink[];
}

export interface HostingProjectChoice {
  id: string;
  name: string;
  scope_id?: string | null;
  scope_name?: string | null;
}

export interface TokenCheck {
  auth: Auth;
  token_source?: TokenSource | null;
  account_label?: string | null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function getHostingStatus(projectPath: string): Promise<HostingStatus> {
  return invoke<HostingStatus>('get_hosting_status', { projectPath });
}

export function detectHostingLinks(projectPath: string): Promise<DetectedLink[]> {
  return invoke<DetectedLink[]>('detect_hosting_links', { projectPath });
}

export function listHostingProjects(
  projectPath: string,
  provider: HostingProvider,
  scopeId?: string
): Promise<HostingProjectChoice[]> {
  return invoke<HostingProjectChoice[]>('list_hosting_projects', {
    projectPath,
    provider,
    scopeId,
  });
}

export function setHostingLink(projectPath: string, link: HostingLink): Promise<void> {
  return invoke('set_hosting_link', { projectPath, link });
}

export function clearHostingLink(projectPath: string, provider: HostingProvider): Promise<void> {
  return invoke('clear_hosting_link', { projectPath, provider });
}

/** Recent deployments for a project, newest first. */
export function listRecentDeployments(
  projectPath: string,
  provider: HostingProvider,
  limit?: number
): Promise<Deployment[]> {
  return invoke<Deployment[]>('list_recent_deployments', { projectPath, provider, limit });
}

/**
 * A deployment's build output — the reason a failure happened, which the
 * deployments endpoints themselves don't carry.
 */
export function getDeploymentLog(
  projectPath: string,
  provider: HostingProvider,
  deploymentId: string
): Promise<BuildLog> {
  return invoke<BuildLog>('get_deployment_log', { projectPath, provider, deploymentId });
}

export function verifyHostingToken(
  projectPath: string,
  provider: HostingProvider
): Promise<TokenCheck> {
  return invoke<TokenCheck>('verify_hosting_token', { projectPath, provider });
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * How long a pushed commit may be missing from a provider before we stop
 * showing hope and switch to a neutral "nothing reported" state.
 *
 * No provider documents how long it takes a pushed commit to appear in their
 * API, so this is a product choice, not a guarantee. It is deliberately never
 * used to claim the deploy *failed* — only to stop implying one is coming.
 */
export const NOT_FOUND_GRACE_MS = 90_000;

/** Every state the hosting section can render. One row shape, one height. */
export type SectionStateKind =
  | 'checking'
  | 'not_pushed'
  | 'queued'
  | 'building'
  | 'publishing'
  | 'ready'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'gated'
  | 'unknown'
  | 'not_found_yet'
  | 'not_found'
  | 'no_token'
  | 'token_rejected'
  | 'no_link'
  | 'offline'
  | 'rate_limited';

export interface SectionState {
  kind: SectionStateKind;
  provider?: HostingProvider;
  /** The deployment being described, when there is one. */
  deployment?: Deployment;
  /** Offered as context in `not_found`, never as the answer. */
  latestOnBranch?: Deployment;
  detail?: DeploymentDetail | null;
  /** Set on `offline` when we have something to show from last time. */
  staleFrom?: number;
  transportError?: string;
  retryAfterSecs?: number;
  tokenSource?: TokenSource;
  /**
   * The answer hasn't been rechecked recently.
   *
   * Not shown next to a settled deployment: whether a twelve-day-old build was
   * re-confirmed eight seconds ago is not information anyone wants, and saying
   * so truncated to "· not ju…" in a 320px row is worse than saying nothing.
   * Staleness only earns space where it changes what you'd believe — the
   * `offline` state, whose copy already names when it last succeeded.
   */
  isStale?: boolean;
}

export interface DeriveContext {
  /** When the user's push completed, if it happened in this session. */
  pushedAt?: number;
  /** Injected for tests. */
  now?: number;
  /** How long an answer may sit before the UI admits it hasn't rechecked. */
  stalenessMs?: number;
}

function phaseToKind(phase: DeploymentPhase): SectionStateKind {
  switch (phase.phase) {
    case 'queued':
      return 'queued';
    case 'building':
      return 'building';
    case 'publishing':
      return 'publishing';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'skipped':
      return 'skipped';
    case 'gated':
      return 'gated';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * Collapse a backend status into the one state to render.
 *
 * Order matters and encodes the honesty rules:
 *
 * 1. Nothing pushed beats everything — a provider cannot have deployed a commit
 *    it never received.
 * 2. Auth problems beat data. A rejected token means whatever we last saw is
 *    unverifiable, so it is not shown as current.
 * 3. Transport failures fall back to the last known deployment *labelled as
 *    old*, rather than to silence or to a confident-looking blank.
 * 4. A missing deployment is only ever "not found" — it never becomes "failed".
 */
export function deriveSectionState(
  status: HostingStatus | null,
  ctx: DeriveContext = {}
): SectionState {
  const now = ctx.now ?? Date.now();

  if (!status) return { kind: 'checking' };
  if (status.providers.length === 0) return { kind: 'no_link' };

  // One provider for now; a second row repeats this reducer verbatim.
  const p = status.providers[0];
  const provider = p.link.provider;
  const tokenSource = p.token_source ?? undefined;

  if (!status.commit.has_upstream) return { kind: 'not_pushed', provider };

  if (p.auth.kind === 'no_token') return { kind: 'no_token', provider };
  if (p.auth.kind === 'rejected') return { kind: 'token_rejected', provider, tokenSource };

  if (p.retry_after_secs != null || p.transport_error?.includes('rate limiting')) {
    return {
      kind: 'rate_limited',
      provider,
      retryAfterSecs: p.retry_after_secs ?? undefined,
    };
  }

  if (p.transport_error) {
    return {
      kind: 'offline',
      provider,
      transportError: p.transport_error,
      staleFrom: p.fetched_at || undefined,
    };
  }

  const stalenessMs = ctx.stalenessMs ?? 0;
  const isStale = stalenessMs > 0 && now - p.fetched_at > stalenessMs;

  if (!p.lookup) return { kind: 'checking', provider };

  if (p.lookup.kind === 'found') {
    const deployment = p.lookup.deployment;
    return {
      kind: phaseToKind(deployment.phase),
      provider,
      deployment,
      detail: deployment.detail,
      tokenSource,
      isStale,
    };
  }

  // Not found. Only timing decides whether we still expect one — never a claim
  // that the deploy failed, which no provider's API can actually tell us.
  const since = ctx.pushedAt ?? status.commit.committed_at ?? 0;
  const waiting = since > 0 && now - since < NOT_FOUND_GRACE_MS;

  return {
    kind: waiting ? 'not_found_yet' : 'not_found',
    provider,
    latestOnBranch: p.lookup.latest_on_branch ?? undefined,
    tokenSource,
    isStale,
  };
}

/** States where a deployment is still moving, so polling should stay fast. */
const ACTIVE_KINDS = new Set<SectionStateKind>([
  'checking',
  'queued',
  'building',
  'publishing',
  'not_found_yet',
]);

export function isActive(kind: SectionStateKind): boolean {
  return ACTIVE_KINDS.has(kind);
}

/** States where polling buys nothing until the user does something. */
const IDLE_KINDS = new Set<SectionStateKind>([
  'no_token',
  'token_rejected',
  'no_link',
  'not_pushed',
]);

export function shouldPoll(kind: SectionStateKind): boolean {
  return !IDLE_KINDS.has(kind);
}
