/**
 * Push-popover hosting states.
 *
 * IMPORTANT — what these fixtures do and do not prove.
 *
 * These are `HostingStatus` values in *our own* vocabulary (`model.rs`), so
 * they exercise one thing honestly: that the UI renders every phase the model
 * can produce, including the awkward ones. They prove nothing about whether a
 * given provider actually emits the raw state that reduces to that phase —
 * that mapping is the adapter's job and is verified against provider fixtures
 * in the Rust unit tests, not here.
 *
 * Cloudflare and Netlify adapters have no live evidence behind them (see
 * `docs/internal/hosting-provider-matrix.md`). Any scenario below naming those
 * providers is therefore labelled `synthetic: true` and must not be cited as
 * evidence that the provider behaves this way.
 */

import type { Scenario } from '../types';
import { unlinkedHostingStatus } from './base';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

const commit = unlinkedHostingStatus.commit;

const vercelLink = {
  provider: 'vercel' as const,
  project_id: 'prj_harness0000000000000000000',
  scope_id: null,
  project_name: 'acme-marketing',
  source: 'vercel_cli_file' as const,
  linked_at: 1_757_000_000_000,
};

/** One provider row, with the lookup the scenario is about. */
const status = (lookup: unknown, over: Record<string, unknown> = {}) => ({
  commit,
  providers: [
    {
      link: vercelLink,
      auth: { kind: 'ok' },
      token_source: 'cli_file',
      lookup,
      fetched_at: Date.now(),
      from_cache: false,
      ...over,
    },
  ],
  detected: [],
});

const deployment = (phase: unknown, over: Record<string, unknown> = {}) => ({
  id: 'dpl_harness000000000000000000',
  phase,
  environment: 'production',
  branch: 'main',
  commit_sha: commit.sha,
  commit_message: commit.subject,
  urls: {},
  created_at: Date.now() - 45_000,
  ...over,
});

const found = (d: unknown) => ({ kind: 'found', deployment: d });

const liveUrls = {
  deployment: 'https://acme-marketing-9f3c1ab.vercel.app',
  aliases: ['https://acme-marketing.vercel.app'],
  primary: 'https://acme-marketing.vercel.app',
};

export const hostingScenarios: Scenario[] = [
  {
    id: 'hosting-building',
    title: 'Push popover — build in progress',
    looksRightWhen:
      'The row shows a build running for THIS commit (9f3c1ab), with no URL offered yet and no claim of success.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(found(deployment({ phase: 'building' }))),
    },
  },
  {
    id: 'hosting-ready',
    title: 'Push popover — deployed and openable',
    looksRightWhen:
      'The row is green, names the commit, and offers a clickable URL that came from the fixture (never assembled from the project name).',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(
        found(deployment({ phase: 'ready' }, { urls: liveUrls, ready_at: Date.now() - 5_000 }))
      ),
    },
  },
  {
    id: 'hosting-publishing',
    title: 'Push popover — built but not yet serving',
    looksRightWhen:
      'Distinct from "ready": the build finished but aliases are not attached, so no live URL is promised yet.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(found(deployment({ phase: 'publishing' }))),
    },
  },
  {
    id: 'hosting-failed',
    title: 'Push popover — build failed',
    looksRightWhen:
      'Clearly failed, tied to this commit, with a way through to the provider’s own log. No URL is offered.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(
        found(
          deployment(
            { phase: 'failed' },
            {
              error_message: 'Build exited with code 1',
              dashboard_url: 'https://vercel.com/harness/acme-marketing/dpl_harness',
            }
          )
        )
      ),
    },
  },
  {
    id: 'hosting-canceled',
    title: 'Push popover — superseded by a newer push',
    looksRightWhen:
      'Reads as "replaced", not "broken" — a canceled build is a normal consequence of pushing twice.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(
        found(deployment({ phase: 'canceled' }, { detail: { detail: 'superseded_by_newer' } }))
      ),
    },
  },
  {
    id: 'hosting-skipped',
    title: 'Push popover — commit deliberately not built',
    looksRightWhen:
      'Explains that the provider chose not to build, and shows the provider’s own reason rather than guessing one.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(
        found(
          deployment(
            { phase: 'skipped' },
            { detail: { detail: 'skipped_because', reason: '[skip ci] in commit message' } }
          )
        )
      ),
    },
  },
  {
    id: 'hosting-not-found',
    title: 'Push popover — provider has nothing for this commit',
    looksRightWhen:
      'Never says "failed". Shows waiting/nothing-reported, and any "latest on this branch" is clearly context, not this commit’s status.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status({
        kind: 'not_found',
        latest_on_branch: deployment({ phase: 'ready' }, { commit_sha: 'aaaa111', urls: liveUrls }),
      }),
    },
  },
  {
    id: 'hosting-token-rejected',
    title: 'Push popover — expired credential',
    looksRightWhen:
      'Reads as a broken connection needing reconnection. This is the exact bug the rewrite exists to fix: it must NOT render as a healthy card.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(null, { auth: { kind: 'rejected' }, lookup: null }),
    },
  },
  {
    id: 'hosting-unlinked',
    title: 'Push popover — project deploys nowhere',
    looksRightWhen: 'An invitation to connect hosting, not an error state and not an empty void.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: { ...workspaceCommands, get_hosting_status: unlinkedHostingStatus },
  },
  {
    id: 'hosting-offline',
    title: 'Push popover — provider unreachable',
    looksRightWhen:
      'Says we could not reach the provider. Does not imply the deploy failed and does not show a stale status as if it were current.',
    project: WORKSPACE_PROJECT,
    openSelector: '.source-control-push-button',
    clipSelector: '.publish-dropdown-menu',
    commands: {
      ...workspaceCommands,
      get_hosting_status: status(null, {
        lookup: null,
        transport_error: 'dns error: failed to lookup address information',
      }),
    },
  },
];
