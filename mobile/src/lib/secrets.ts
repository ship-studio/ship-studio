/**
 * A secure input card's values on their way to the Mac's Keychain. The one
 * rule: they go now, over Tailscale (TLS from this phone to the Mac), as one
 * request, or not at all. Nothing here keeps them: not the store, the cache,
 * drafts, the outbox, a notification or a log. A failed save is the card's
 * to retry while it's on screen.
 *
 * Pure apart from the transport it's handed, so the test drives it against
 * the mock Mac and reads back everything the app would persist.
 */

import type { AgentSecret, LinkState, Route } from '@shipstudio/companion-protocol';
import type { DirectTransport } from './transport';

/**
 * Why a secret can't go over this route, or null when it can. The token
 * rides every route, but a secret outlives the pairing, so anything but
 * HTTPS over Tailscale is refused outright.
 */
export function secretRouteProblem(route: Pick<Route, 'kind' | 'url'> | null): string | null {
  if (!route) return 'Saving a secret needs your Mac. It stays here until then.';
  if (route.kind !== 'tailscale' || !/^https:\/\//i.test(route.url)) {
    return 'Secrets only go over Tailscale, which encrypts them all the way to your Mac. Connect over Tailscale, or save it at your desk.';
  }
  return null;
}

type Link = Pick<DirectTransport, 'request' | 'route'> & { state: LinkState };

export async function sendSecret(
  t: Link,
  agentId: string,
  requestId: string,
  values: string[]
): Promise<AgentSecret> {
  const problem = secretRouteProblem(t.state.kind === 'connected' ? t.route : null);
  if (problem) throw new Error(problem);
  return t.request('agents.saveSecret', { agentId, requestId, values: [...values] });
}
