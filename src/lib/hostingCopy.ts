/**
 * Every user-facing string in the hosting section.
 *
 * The rule the copy follows: **line 1 names what the user shipped, line 2 says
 * what the provider says happened to it** — in the provider's own words.
 *
 * An earlier version translated those words, on the theory that "Ready" is
 * pipeline jargon. That was a mistake. This is a UI over what Vercel returns,
 * and inventing synonyms only means a user comparing this against the Vercel
 * dashboard has two vocabularies to reconcile. Status words come from
 * `deployment.status_label`, which is the provider's; environments are
 * Production and Preview, which is what all three providers call them.
 *
 * What this module still owns is the sentence around those words — the
 * timestamp, which provider, and the states that have no provider status at
 * all because nothing was found or no credential exists.
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

/** Vercel's own two environments, capitalised as its dashboard capitalises them. */
function environmentLabel(deployment?: Deployment): string {
  if (!deployment) return '';
  return deployment.environment === 'production' ? ' · Production' : ' · Preview';
}

/**
 * The provider's status word. Falls back only when a deployment predates the
 * field or a provider sends nothing.
 */
function statusWord(deployment: Deployment | undefined, fallback: string): string {
  return deployment?.status_label?.trim() || fallback;
}

/**
 * What the row's own button opens, named for where the deployment went. A
 * preview never reached production, so "Open domain" would be wrong on a
 * feature branch.
 */
function openLabelFor(deployment?: Deployment): string | undefined {
  if (!deployment) return undefined;
  if (deployment.environment === 'preview') {
    return deployment.urls.deployment ? 'Open preview' : undefined;
  }
  return deployment.urls.site ? 'Open domain' : undefined;
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
        status: `${statusWord(state.deployment, 'Queued')}${environmentLabel(
          state.deployment
        )}${when(state.deployment)}${sha}`,
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'building':
    case 'publishing':
      return {
        title,
        status: `${statusWord(state.deployment, 'Building')}${environmentLabel(
          state.deployment
        )}${when(state.deployment)}`,
        action: state.deployment?.dashboard_url ? 'View' : undefined,
      };

    case 'ready':
      return {
        title,
        status: `${statusWord(state.deployment, 'Ready')}${environmentLabel(
          state.deployment
        )}${when(state.deployment)}${detailSuffix(state.detail)}`,
        // No hint: the addresses get their own labelled rows below.
        action: openLabelFor(state.deployment),
      };

    case 'failed':
      return {
        title,
        status: `${statusWord(state.deployment, 'Error')}${environmentLabel(
          state.deployment
        )}${when(state.deployment)}`,
        hint: state.deployment?.error_message?.split('\n')[0],
        action: state.deployment?.dashboard_url ? 'View logs' : undefined,
      };

    case 'canceled':
      return {
        title,
        status: `${statusWord(state.deployment, 'Canceled')}${environmentLabel(
          state.deployment
        )}${detailSuffix(state.detail)}`,
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
            ? `Its command-line login has expired.`
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
 * Not a ban on the provider's vocabulary — this app deliberately uses it, so
 * that "Ready" here and "Ready" on the dashboard are the same word.
 *
 * What stays banned is the shape nobody writes for a reader: SHOUTED enum
 * values straight off the wire, API field names, and internal abbreviations.
 * "Ready" is fine; `READY`, `readyState` and `prod` are not.
 */
export const BANNED_JARGON =
  /\b(prod|READY|BUILDING|QUEUED|CANCELED|INITIALIZING|ERROR|scope|alias|uid|teamId|substate|readyState|aliasAssigned|deployment_trigger)\b/;

/** Which provider each state's copy is about, for the icon. */
export function providerFor(state: SectionState): HostingProvider | undefined {
  return state.provider;
}
