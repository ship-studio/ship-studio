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

/**
 * A compact age, the way every provider's own deployment list writes it.
 *
 * The app's `formatRelativeTime` spells it out — "23 minutes ago" — which is
 * right in a list with room for it and wrong here: the status line gets 184px,
 * and spending 14 characters on the age is what pushed
 * "Ready · Production · 23 minutes ago" past the ellipsis in the single most
 * common state this section has. Vercel, Netlify and Cloudflare all write
 * "23m ago" in their own dashboards.
 */
export function compactAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** When the deployment happened, phrased for a sentence. */
function when(deployment?: Deployment): string {
  const at = deployment?.ready_at || deployment?.created_at;
  return at ? ` · ${compactAge(at)}` : '';
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
 * The row's button opens the deployment on the provider.
 *
 * It used to open the domain, which was already one click away on the address
 * rows right below it — so the button spent its space duplicating them. The
 * provider's own page is the thing the row cannot show: build logs, timings,
 * redeploy, rollback. Absent when the provider gives us no link to it, which
 * Cloudflare's API currently does not.
 */
function dashboardLabelFor(state: SectionState): string | undefined {
  if (!state.deployment?.dashboard_url) return undefined;
  return state.provider ? `Open in ${PROVIDER_LABELS[state.provider]}` : 'Open';
}

/**
 * The provider's qualifier on a status, written as a sentence for line 3.
 *
 * These used to be appended to the status line after an em dash. The status
 * line is 184px wide, so "Canceled · Production — a newer push replaced it"
 * arrived on screen as "Canceled · Production — a ne…" — the ellipsis landing
 * squarely on the only part the user didn't already know. The qualifier is the
 * informative half, so it gets the full-width line instead.
 */
function detailSentence(detail?: DeploymentDetail | null): string | undefined {
  if (!detail) return undefined;
  switch (detail.detail) {
    case 'not_yet_promoted':
      return 'Built, but not serving visitors yet.';
    case 'rolling_out':
      return 'Rolling out to visitors.';
    case 'skipped_because':
      return detail.reason?.trim() || undefined;
    case 'awaiting_review':
      return detail.reason?.trim() || undefined;
    case 'review_rejected':
      return undefined;
    case 'superseded_by_newer':
      return 'A newer push replaced it.';
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

/**
 * Build the row's lines for a state.
 *
 * The two upper lines live in a 184px column and are ellipsised, so they are
 * written to fit it: a status word, an environment, an age. Anything longer —
 * a build error, a skip reason, a provider's qualifier — goes to line 3, which
 * spans the section and may wrap. Every string here was measured in the UI
 * harness; `harness-capture.mjs` lists anything that still overflows.
 */
export function copyFor(
  state: SectionState,
  commitSubject?: string | null,
  shortSha?: string
): RowCopy {
  const host = providerName(state);
  const title = titleFor(commitSubject, state.deployment);
  const env = environmentLabel(state.deployment);
  const commit = shortSha ? `commit ${shortSha}` : 'this commit';

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
        status: `${statusWord(state.deployment, 'Queued')}${env}${when(state.deployment)}`,
        action: dashboardLabelFor(state),
      };

    case 'building':
    case 'publishing':
      return {
        title,
        status: `${statusWord(state.deployment, 'Building')}${env}${when(state.deployment)}`,
        hint: detailSentence(state.detail),
        action: dashboardLabelFor(state),
      };

    case 'ready':
      return {
        title,
        status: `${statusWord(state.deployment, 'Ready')}${env}${when(state.deployment)}`,
        // Usually no hint: the addresses get their own labelled rows below.
        hint: detailSentence(state.detail),
        action: dashboardLabelFor(state),
      };

    case 'failed':
      return {
        title,
        status: `${statusWord(state.deployment, 'Error')}${env}${when(state.deployment)}`,
        hint: state.deployment?.error_message?.split('\n')[0],
        action: dashboardLabelFor(state),
      };

    case 'canceled':
      return {
        title,
        status: `${statusWord(state.deployment, 'Canceled')}${env}${when(state.deployment)}`,
        hint: detailSentence(state.detail),
        action: dashboardLabelFor(state),
      };

    case 'skipped':
      return {
        title,
        status: `${statusWord(state.deployment, 'Skipped')}${env}${when(state.deployment)}`,
        hint: detailSentence(state.detail)
          ? `${host} skipped it: ${detailSentence(state.detail)}`
          : `${host} chose not to build this push.`,
        action: dashboardLabelFor(state),
      };

    case 'gated':
      return state.detail?.detail === 'review_rejected'
        ? {
            title,
            status: `Declined${env}`,
            hint: `${host} declined to build this push.`,
            action: dashboardLabelFor(state),
          }
        : {
            title,
            status: `Awaiting approval${env}`,
            hint: detailSentence(state.detail) ?? `Waiting for approval on ${host}.`,
            action: dashboardLabelFor(state),
          };

    case 'unknown':
      return {
        title,
        // The provider's own word, shown verbatim rather than translated into
        // success or failure — we genuinely do not know which it is.
        status: `${statusWord(state.deployment, 'Unknown')}${env}${when(state.deployment)}`,
        hint: `Ship Studio doesn't recognize this status yet.`,
        action: dashboardLabelFor(state),
      };

    case 'not_found_yet':
      return {
        title,
        status: `Waiting for ${host}…`,
        hint: 'This usually takes under a minute.',
      };

    case 'not_found':
      return {
        title,
        // Never "failed to trigger": no provider's API can distinguish a push
        // that was ignored from one that simply hasn't arrived.
        status: 'No deploy reported yet',
        hint: state.latestOnBranch
          ? `${host} has nothing for ${commit}. Latest on this branch: ${titleFor(
              null,
              state.latestOnBranch
            )}`
          : `${host} has nothing for ${commit}.`,
      };

    case 'no_token':
      return {
        title: `Connect ${host}`,
        status: 'See if each push went live',
        hint: 'Your deploys run either way — this only changes what you see here.',
        action: 'Connect',
      };

    case 'token_rejected':
      return {
        title: `Reconnect ${host}`,
        status:
          state.tokenSource === 'cli_file'
            ? 'Its CLI login has expired'
            : 'The saved token was rejected',
        hint: 'Deployment status is unavailable until you do.',
        action: 'Connect',
      };

    case 'no_link':
      return {
        title: 'See if each push went live',
        status: 'Vercel, Cloudflare, or Netlify',
        action: 'Set up',
      };

    case 'offline':
      return {
        title,
        status: `Couldn't reach ${host}`,
        hint: [
          state.staleFrom ? `Last checked ${compactAge(state.staleFrom)}.` : undefined,
          state.transportError,
        ]
          .filter(Boolean)
          .join(' '),
        action: 'Retry',
      };

    case 'rate_limited':
      return {
        title,
        status: state.retryAfterSecs
          ? `Rate limited · retrying in ${state.retryAfterSecs}s`
          : `Rate limited by ${host}`,
        hint: `${host} asked us to slow down.`,
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
