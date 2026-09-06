/**
 * Every user-facing string in the hosting section.
 *
 * Centralised for two reasons. First, so the vocabulary can be tested: the
 * section it replaces surfaced Vercel's own words — "Prod", "READY", "Queued",
 * "scope", "Deploy" as a noun — which describe a build pipeline rather than
 * anything the user did. Second, so the two lines of every row are written
 * together and stay the right length for a 320px popover.
 *
 * The rule the copy follows: **line 1 names what the user shipped, line 2 says
 * what happened to it.** "Ready" answers "is Vercel's pipeline done". It does
 * not answer "did my change go live", which is the actual question.
 *
 * @module lib/hostingCopy
 */

import { formatRelativeTime } from './branches';
import {
  PROVIDER_LABELS,
  type Deployment,
  type DeploymentDetail,
  type HostingProvider,
  type SectionState,
} from './hosting';

/** What the two-line row should say for a given state. */
export interface RowCopy {
  /** Line 1 — normally the commit subject. */
  title: string;
  /** Line 2 — what happened to it. */
  status: string;
  /** The optional third line of links/hints. */
  hint?: string;
  /** Label for the trailing action button, when there is one. */
  action?: string;
}

function providerName(state: SectionState): string {
  return state.provider ? PROVIDER_LABELS[state.provider] : 'your host';
}

/** When the deployment happened, phrased for a sentence. */
function when(deployment?: Deployment): string {
  const at = deployment?.ready_at || deployment?.created_at;
  return at ? ` · ${formatRelativeTime(at)}` : '';
}

/**
 * Where each environment is serving. "Production" and "Preview" are the two
 * words users actually see in every provider's own dashboard, so they are kept
 * — unlike "prod", which is nobody's word.
 */
function environmentLabel(deployment?: Deployment): string {
  if (!deployment) return '';
  return deployment.environment === 'production' ? ' · Production' : ' · Preview';
}

function detailSuffix(detail?: DeploymentDetail | null): string {
  if (!detail) return '';
  switch (detail.detail) {
    case 'not_yet_promoted':
      return ' — built, but not serving visitors yet';
    case 'rolling_out':
      return ' — rolling out to visitors';
    case 'skipped_because':
      return detail.reason ? ` — ${detail.reason}` : '';
    case 'awaiting_review':
      return detail.reason ? ` — ${detail.reason}` : '';
    case 'review_rejected':
      return '';
    case 'superseded_by_newer':
      return ' — a newer push replaced it';
  }
}

/**
 * The commit subject, preferring what git told us locally. The provider's own
 * commit message is a fallback because it is frequently null — a real Netlify
 * production deploy returned `commit_message: null` and `title: null`.
 */
export function titleFor(
  commitSubject: string | null | undefined,
  deployment?: Deployment
): string {
  return commitSubject?.trim() || deployment?.commit_message?.trim() || 'Your latest push';
}

/** Build both lines for a state. */
export function copyFor(
  state: SectionState,
  commitSubject?: string | null,
  shortSha?: string
): RowCopy {
  const host = providerName(state);
  const title = titleFor(commitSubject, state.deployment);
  const sha = shortSha ? ` · ${shortSha}` : '';

  switch (state.kind) {
    case 'checking':
      return { title, status: `Checking ${host}…` };

    case 'not_pushed':
      return {
        title,
        status: 'Not pushed yet',
        hint: 'Deployments appear here after your first push.',
      };

    case 'queued':
      return {
        title,
        status: `Waiting to build on ${host}${when(state.deployment)}${sha}`,
        hint: 'Links appear when the build finishes.',
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'building':
      return {
        title,
        status: `Building on ${host}${when(state.deployment)}`,
        hint: 'Links appear when the build finishes.',
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'publishing':
      return {
        title,
        status: `Almost live on ${host} — finishing up`,
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'ready':
      return {
        title,
        status: `Live on ${host}${when(state.deployment)}${environmentLabel(
          state.deployment
        )}${detailSuffix(state.detail)}`,
        action: state.deployment?.urls.primary ? 'Open' : undefined,
      };

    case 'failed':
      return {
        title,
        status: `Build failed on ${host}${when(state.deployment)}`,
        hint: state.deployment?.error_message?.split('\n')[0],
        action: state.deployment?.dashboard_url ? 'Details' : undefined,
      };

    case 'canceled':
      return {
        title,
        status: `Canceled on ${host}${detailSuffix(state.detail)}`,
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'skipped':
      return {
        title,
        status: `${host} skipped this push${detailSuffix(state.detail)}`,
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'gated':
      return {
        title,
        status:
          state.detail?.detail === 'review_rejected'
            ? `${host} declined to build this push`
            : `Waiting for approval on ${host}${detailSuffix(state.detail)}`,
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'unknown':
      return {
        title,
        // Deliberately not translated into success or failure — we genuinely
        // do not know which it is.
        status: `${host} reported a status Ship Studio doesn't recognize`,
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'not_found_yet':
      return {
        title,
        status: `Waiting for ${host} to pick up this push…`,
        hint: 'This usually takes under a minute.',
      };

    case 'not_found':
      return {
        title,
        // Never "failed to trigger": no provider's API can distinguish a push
        // that was ignored from one that simply hasn't arrived.
        status: `${host} hasn't reported a deploy for this push`,
        hint: state.latestOnBranch
          ? `Most recent on this branch: ${titleFor(null, state.latestOnBranch)}`
          : undefined,
      };

    case 'no_token':
      return {
        title: `Connect ${host} to see your deployments`,
        status: 'Your token is stored in the system keychain.',
        hint: `Deploys still run — this only affects what Ship Studio can show you.`,
        action: 'Connect',
      };

    case 'token_rejected':
      return {
        title: `${host} didn't accept the saved sign-in`,
        status:
          state.tokenSource === 'cli_file'
            ? `The ${host} CLI's login has expired.`
            : 'The saved token may have expired or been revoked.',
        hint: 'Connect again to keep seeing deployment status.',
        action: 'Connect',
      };

    case 'no_link':
      return {
        title: 'See whether each push went live',
        status: 'Connect Vercel, Cloudflare Pages, or Netlify.',
        action: 'Set up',
      };

    case 'offline':
      return {
        title,
        status: state.staleFrom
          ? `Couldn't reach ${host} · last checked ${formatRelativeTime(state.staleFrom)}`
          : `Couldn't reach ${host}`,
        hint: state.transportError,
        action: 'Retry',
      };

    case 'rate_limited':
      return {
        title,
        status: state.retryAfterSecs
          ? `${host} asked us to slow down — retrying in ${state.retryAfterSecs}s`
          : `${host} asked us to slow down`,
      };
  }
}

/**
 * Words that mean something inside a provider's own product and nothing to the
 * person who pushed a commit. Asserted against every string this module can
 * produce; provider names and "Production"/"Preview" are deliberately allowed.
 */
export const BANNED_JARGON =
  /\b(prod|READY|BUILDING|QUEUED|CANCELED|INITIALIZING|scope|alias|uid|teamId|substate|readyState|deployment_trigger)\b/;

/** Which provider each state's copy is about, for the icon. */
export function providerFor(state: SectionState): HostingProvider | undefined {
  return state.provider;
}
