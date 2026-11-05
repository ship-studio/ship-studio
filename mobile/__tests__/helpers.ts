/** Shared by the tests: message and agent builders, and a wait for the mock Mac. */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const base = real.agentsOverview.agents[0] as Agent;

/** The Mac's real agent, idle and with nothing waiting, then `over`. */
export const agent = (over: Partial<Agent> = {}): Agent => ({
  ...base,
  pendingApprovals: 0,
  unread: 0,
  failure: undefined,
  status: { state: 'idle', activity: null, since: null },
  ...over,
});

export const msg = (id: string, ts: number, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id,
  agentId: 'a',
  ts,
  kind: 'agent',
  text: id,
  ...extra,
});

export async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
