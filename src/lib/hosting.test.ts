/**
 * The reducer decides what the user is told, so it is tested exhaustively.
 *
 * Two invariants matter more than the rest and have their own tests below:
 * a missing deployment never becomes a failure, and a rejected credential is
 * never rendered as healthy — that second one is the exact defect that made
 * the old hosting card show a connected state over an expired login.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveSectionState,
  isActive,
  shouldPoll,
  NOT_FOUND_GRACE_MS,
  type Deployment,
  type DeploymentPhase,
  type HostingStatus,
  type Lookup,
  type ProviderStatus,
} from './hosting';

const NOW = 1_700_000_000_000;

function deployment(phase: DeploymentPhase, overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 'dpl_1',
    status_label: 'Ready',
    phase,
    environment: 'production',
    branch: 'main',
    commit_sha: 'abc123',
    urls: { aliases: [], primary: 'https://example.vercel.app' },
    created_at: NOW - 60_000,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    link: {
      provider: 'vercel',
      project_id: 'prj_1',
      source: 'vercel_cli_file',
      linked_at: 0,
    },
    auth: { kind: 'ok' },
    fetched_at: NOW,
    from_cache: false,
    ...overrides,
  };
}

function status(
  providers: ProviderStatus[],
  commit: Partial<HostingStatus['commit']> = {}
): HostingStatus {
  return {
    commit: {
      sha: 'abc123',
      short_sha: 'abc123a',
      subject: 'Update from Ship Studio',
      committed_at: NOW - 30_000,
      branch: 'main',
      has_upstream: true,
      ...commit,
    },
    providers,
    detected: [],
  };
}

const found = (phase: DeploymentPhase): Lookup => ({
  kind: 'found',
  deployment: deployment(phase),
});

describe('deriveSectionState', () => {
  it('is checking before anything has loaded', () => {
    expect(deriveSectionState(null, { now: NOW }).kind).toBe('checking');
  });

  it('invites setup when the project deploys nowhere', () => {
    expect(deriveSectionState(status([]), { now: NOW }).kind).toBe('no_link');
  });

  it('says nothing has been pushed before there is an upstream', () => {
    // A provider cannot have deployed a commit it never received.
    const s = status([provider({ lookup: found({ phase: 'ready' }) })], { has_upstream: false });
    expect(deriveSectionState(s, { now: NOW }).kind).toBe('not_pushed');
  });

  it.each([
    ['queued', 'queued'],
    ['building', 'building'],
    ['publishing', 'publishing'],
    ['ready', 'ready'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['skipped', 'skipped'],
    ['gated', 'gated'],
  ] as const)('maps the %s phase straight through', (phase, expected) => {
    const s = status([provider({ lookup: found({ phase }) })]);
    expect(deriveSectionState(s, { now: NOW }).kind).toBe(expected);
  });

  it('surfaces an unrecognized provider status instead of guessing', () => {
    const s = status([provider({ lookup: found({ phase: 'unknown', raw: 'SOMETHING_NEW' }) })]);
    expect(deriveSectionState(s, { now: NOW }).kind).toBe('unknown');
  });

  describe('a missing deployment', () => {
    const notFound: Lookup = { kind: 'not_found' };

    it('still hopes inside the grace period', () => {
      const s = status([provider({ lookup: notFound })]);
      const state = deriveSectionState(s, { now: NOW, pushedAt: NOW - 5_000 });
      expect(state.kind).toBe('not_found_yet');
    });

    it('goes neutral once the grace period lapses', () => {
      const s = status([provider({ lookup: notFound })]);
      const state = deriveSectionState(s, {
        now: NOW,
        pushedAt: NOW - NOT_FOUND_GRACE_MS - 1,
      });
      expect(state.kind).toBe('not_found');
    });

    it('never becomes a failure, however long it has been', () => {
      // No provider API can distinguish "ignored this push" from "hasn't got
      // to it yet", so claiming a failure would be inventing information.
      const s = status([provider({ lookup: notFound })]);
      const state = deriveSectionState(s, { now: NOW, pushedAt: NOW - 86_400_000 });
      expect(state.kind).toBe('not_found');
      expect(state.kind).not.toBe('failed');
    });

    it('falls back to the commit time when the push was in an earlier session', () => {
      const s = status([provider({ lookup: notFound })], { committed_at: NOW - 3_600_000 });
      expect(deriveSectionState(s, { now: NOW }).kind).toBe('not_found');
    });

    it('offers the latest deploy on the branch as context, not as the answer', () => {
      const latest = deployment({ phase: 'ready' });
      const s = status([provider({ lookup: { kind: 'not_found', latest_on_branch: latest } })]);
      const state = deriveSectionState(s, { now: NOW, pushedAt: NOW - 200_000 });

      expect(state.kind).toBe('not_found');
      expect(state.latestOnBranch).toBe(latest);
      // Crucially, the branch's deployment is NOT reported as this commit's.
      expect(state.deployment).toBeUndefined();
    });
  });

  describe('credentials', () => {
    it('asks for a connection when there is no token', () => {
      const s = status([provider({ auth: { kind: 'no_token' } })]);
      expect(deriveSectionState(s, { now: NOW }).kind).toBe('no_token');
    });

    it('never renders a rejected credential as healthy', () => {
      // The defect this replaces: a 403 from an expired token was mapped to
      // "unknown" and then coerced to "connected", so a dead login showed a
      // connected card with a spinner and no URL.
      const s = status([
        provider({
          auth: { kind: 'rejected' },
          token_source: 'cli_file',
          lookup: found({ phase: 'ready' }),
        }),
      ]);
      const state = deriveSectionState(s, { now: NOW });

      expect(state.kind).toBe('token_rejected');
      expect(state.kind).not.toBe('ready');
    });

    it('remembers a rejection came from the CLI so the copy can explain it', () => {
      const s = status([provider({ auth: { kind: 'rejected' }, token_source: 'cli_file' })]);
      expect(deriveSectionState(s, { now: NOW }).tokenSource).toBe('cli_file');
    });
  });

  describe('when the provider cannot be reached', () => {
    it('says so rather than showing nothing', () => {
      const s = status([provider({ transport_error: 'dns error' })]);
      const state = deriveSectionState(s, { now: NOW });
      expect(state.kind).toBe('offline');
      expect(state.transportError).toBe('dns error');
    });

    it('reports rate limiting separately, with the retry hint', () => {
      const s = status([provider({ retry_after_secs: 30 })]);
      const state = deriveSectionState(s, { now: NOW });
      expect(state.kind).toBe('rate_limited');
      expect(state.retryAfterSecs).toBe(30);
    });

    it('prefers an auth problem over a transport one', () => {
      // A rejected token is actionable; a network blip on top of it is noise.
      const s = status([provider({ auth: { kind: 'rejected' }, transport_error: 'timeout' })]);
      expect(deriveSectionState(s, { now: NOW }).kind).toBe('token_rejected');
    });
  });

  it('admits when an answer has not been rechecked recently', () => {
    const s = status([provider({ lookup: found({ phase: 'ready' }), fetched_at: NOW - 60_000 })]);
    const state = deriveSectionState(s, { now: NOW, stalenessMs: 8_000 });
    expect(state.isStale).toBe(true);
  });

  it('produces exactly one state for every input combination', () => {
    const lookups: (Lookup | null)[] = [null, found({ phase: 'ready' }), { kind: 'not_found' }];
    const auths = [
      { kind: 'ok' as const },
      { kind: 'no_token' as const },
      { kind: 'rejected' as const },
    ];

    for (const lookup of lookups) {
      for (const auth of auths) {
        for (const transport of [undefined, 'boom']) {
          for (const upstream of [true, false]) {
            const s = status([provider({ auth, lookup, transport_error: transport })], {
              has_upstream: upstream,
            });
            const state = deriveSectionState(s, { now: NOW });
            expect(typeof state.kind).toBe('string');
          }
        }
      }
    }
  });
});

describe('polling policy', () => {
  it('polls fast only while something is moving', () => {
    expect(isActive('building')).toBe(true);
    expect(isActive('queued')).toBe(true);
    expect(isActive('not_found_yet')).toBe(true);
    expect(isActive('ready')).toBe(false);
    expect(isActive('failed')).toBe(false);
  });

  it('stops entirely when only the user can change the outcome', () => {
    expect(shouldPoll('no_token')).toBe(false);
    expect(shouldPoll('token_rejected')).toBe(false);
    expect(shouldPoll('no_link')).toBe(false);
    expect(shouldPoll('not_pushed')).toBe(false);

    expect(shouldPoll('building')).toBe(true);
    expect(shouldPoll('offline')).toBe(true);
  });
});
