/**
 * Check the hosting fixtures against the adapters they claim to come from.
 *
 * There are two ways a fixture goes wrong, and they need different defences.
 * One is *expiry*: a fixture that was true when written and drifted when the
 * code moved. Re-reading catches that, and so does the runner's `requires`
 * check, because an expired fixture usually stops rendering its subject.
 *
 * The other is *invention*: a fixture that was never true, not even on the day
 * it was written. Nothing catches that by looking at the fixture, because it is
 * internally consistent — it type-checks, it renders, it screenshots, and the
 * picture looks entirely plausible. The only way to catch it is to check the
 * fixture against the thing it is pretending to be.
 *
 * This file is that check for one specific pairing: which `DeploymentPhase`
 * each provider can actually emit. Two fixtures here got it wrong. The first
 * was a Vercel deployment in the `publishing` phase — Vercel has no state
 * between building and ready, and an earlier version of this feature invented
 * one for it; the fixture outlived the code that mistake came from. The second
 * was a Vercel deployment in the `skipped` phase, found by writing this test.
 *
 * ## Keeping this honest
 *
 * The table below is a hand-copy of Rust, which is exactly the kind of mirror
 * that drifts. It is written to drift *safely*: it lists what each provider can
 * emit, and the test asserts fixtures stay inside it. If an adapter gains a
 * phase and this table doesn't, a legitimate new fixture fails loudly and
 * someone updates both. The failure direction is a false alarm, never a false
 * pass — which is the only kind of staleness worth accepting in a mirror.
 */

import { describe, it, expect } from 'vitest';
import { hostingScenarios } from './hosting';
import type { DeploymentPhase, HostingProvider } from '../../lib/hosting';

/**
 * What each adapter's phase mapping can actually return.
 *
 * Sources, one per provider — update this table and that function together:
 * - `vercel.rs` → `phase_from_ready_state`: five readyStates, plus `Unknown`
 *   for anything else. Notably absent: `publishing`, `skipped` and `gated`,
 *   none of which Vercel's API expresses.
 * - `netlify.rs` → `phase_from_state` (fifteen states) and the `skipped`
 *   boolean in `to_deployment`, which wins over the state.
 * - `cloudflare.rs` → `phase_from_stage` (stage name × status) and the
 *   `is_skipped` flag in `to_deployment`.
 */
const PHASES_BY_PROVIDER: Record<HostingProvider, ReadonlySet<DeploymentPhase['phase']>> = {
  vercel: new Set(['queued', 'building', 'ready', 'failed', 'canceled', 'unknown']),
  netlify: new Set([
    'queued',
    'gated',
    'building',
    'publishing',
    'ready',
    'failed',
    'skipped',
    'unknown',
  ]),
  cloudflare: new Set([
    'queued',
    'building',
    'publishing',
    'ready',
    'failed',
    'canceled',
    'skipped',
    'unknown',
  ]),
};

/** Every deployment a scenario puts in front of a reviewer, with its provider. */
function deploymentsUnderReview() {
  const found: Array<{ id: string; provider: HostingProvider; phase: string; where: string }> = [];

  for (const scenario of hostingScenarios) {
    const status = scenario.commands?.get_hosting_status as
      | { providers?: Array<Record<string, unknown>> }
      | undefined;

    for (const p of status?.providers ?? []) {
      const provider = (p.link as { provider: HostingProvider } | undefined)?.provider;
      const lookup = p.lookup as
        | { kind: string; deployment?: unknown; latest_on_branch?: unknown }
        | null
        | undefined;
      if (!provider || !lookup) continue;

      // Both shapes a deployment reaches the UI through. `latest_on_branch` is
      // shown as context on a not-found, and it is a real deployment from the
      // same provider — an impossible phase there is just as wrong.
      const candidates: Array<[unknown, string]> = [
        [lookup.deployment, 'deployment'],
        [lookup.latest_on_branch, 'latest_on_branch'],
      ];

      for (const [candidate, where] of candidates) {
        const phase = (candidate as { phase?: { phase?: string } } | undefined)?.phase?.phase;
        if (phase) found.push({ id: scenario.id, provider, phase, where });
      }
    }
  }

  return found;
}

describe('hosting scenarios', () => {
  it('only shows phases the named provider can actually emit', () => {
    const offenders = deploymentsUnderReview().filter(
      (d) => !PHASES_BY_PROVIDER[d.provider].has(d.phase as DeploymentPhase['phase'])
    );

    expect(
      offenders,
      offenders
        .map(
          (d) =>
            `${d.id}: ${d.provider} cannot emit phase "${d.phase}" (${d.where}). ` +
            `A screenshot of it reviews a screen no user can reach.`
        )
        .join('\n')
    ).toEqual([]);
  });

  it('finds deployments to check, so the check above cannot pass vacuously', () => {
    // Without this, renaming a fixture field would make the assertion above
    // green by finding nothing — a check agreeing with itself about the wrong
    // thing, which is the failure this whole file exists to prevent.
    const found = deploymentsUnderReview();
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(new Set(found.map((d) => d.provider)).size).toBeGreaterThanOrEqual(2);
  });

  it('names a status_label on every deployment, since the row prints it verbatim', () => {
    for (const scenario of hostingScenarios) {
      const status = scenario.commands?.get_hosting_status as
        | { providers?: Array<{ lookup?: { deployment?: { status_label?: string } } | null }> }
        | undefined;

      for (const p of status?.providers ?? []) {
        const deployment = p.lookup?.deployment;
        if (!deployment) continue;
        expect(deployment.status_label, `${scenario.id} has no status_label`).toBeTruthy();
      }
    }
  });
});
