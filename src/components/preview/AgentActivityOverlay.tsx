/**
 * Visual "the agent is driving" layer over the preview iframe.
 *
 * Renders while the workspace agent uses a preview MCP tool (agent bridge):
 * a pulsing glow around the preview edges, a chip naming the action, a big
 * cursor with a click ripple for spatial actions (navigate/reload), and a
 * camera flash for screenshots. Pointer-events pass straight through — this
 * layer informs, it never blocks the user.
 */

import { useSyncExternalStore } from 'react';
import { agentActivityStore } from '../../lib/agentActivityStore';

export function AgentActivityOverlay() {
  const state = useSyncExternalStore(agentActivityStore.subscribe, agentActivityStore.getState);

  // The store keeps `exiting` true for the exit-animation window so the chip
  // and glow shrink/fade away instead of vanishing.
  if (!state.visible && !state.exiting) return null;

  return (
    <div
      className={`agent-activity-overlay${state.exiting ? ' agent-activity-overlay--exiting' : ''}`}
      aria-hidden
    >
      <div className={`agent-activity-glow${state.busy ? ' agent-activity-glow--busy' : ''}`} />
      {state.label && (
        <div className="agent-activity-chip">
          <span className="agent-activity-chip-dot" />
          {state.label}
        </div>
      )}
      {state.effect?.kind === 'cursor' && (
        <div
          key={state.effect.seq}
          className="agent-activity-cursor"
          style={{ left: `${state.effect.x * 100}%`, top: `${state.effect.y * 100}%` }}
        >
          <span className="agent-activity-ripple" />
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path
              d="m4 4 7.07 17 2.51-7.39L21 11.07z"
              fill="var(--action)"
              stroke="var(--action-text)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
      {state.effect?.kind === 'flash' && (
        <div key={state.effect.seq} className="agent-activity-flash" />
      )}
    </div>
  );
}
