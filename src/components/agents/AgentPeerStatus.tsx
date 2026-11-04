/**
 * The live state of an agent beside its name on a delegation line
 * ("Messaged Finance · reading Gmail"), so handed-off work keeps its thread.
 * Status comes from the store; "didn't finish" only when that agent's newest
 * line is known to be an error (its chat, or one small read of its log).
 *
 * @module components/agents/AgentPeerStatus
 */

import { useEffect, useState } from 'react';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { useAgents } from '../../lib/agentsStore';
import {
  getAgentMessages,
  lastOutcome,
  peerState,
  type Agent,
  type AgentMessage,
} from '../../lib/agents';

/** Its newest outcome line: from the store when that chat is loaded, else read once per change. */
function useLastOutcome(agent: Agent): AgentMessage | null {
  const loaded = useAgents().messages[agent.id];
  const [fetched, setFetched] = useState<{ key: string; line: AgentMessage | null } | null>(null);
  const key = `${agent.id}:${agent.lastActivityAt}`;
  const idle = agent.status.state === 'idle';
  useEffect(() => {
    if (loaded || !idle) return;
    let live = true;
    getAgentMessages(agent.id, 4)
      .then((lines) => live && setFetched({ key, line: lastOutcome(lines) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agent.id, key, loaded, idle]);
  if (loaded) return lastOutcome(loaded);
  return fetched?.key === key ? fetched.line : null;
}

export function AgentPeerStatus({ agent }: { agent: Agent }) {
  const state = peerState(agent, useLastOutcome(agent));
  return (
    <span className="agent-peer__state" data-state={state.kind}>
      {state.kind === 'working' ? (
        <PixelLoaderRings size="sm" label={`${agent.name} is working`} />
      ) : state.kind !== 'idle' ? (
        <span
          className={`sidebar-row-dot ${state.kind === 'waiting' ? 'dot-attention' : 'dot-error'}`}
          aria-hidden="true"
        />
      ) : null}
      <span className="agent-peer__state-label">{state.label}</span>
    </span>
  );
}
