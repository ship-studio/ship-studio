/**
 * The harness's own chrome: which scenario is loaded, what it should look
 * like, and — loudly — any command the fixture set doesn't answer.
 *
 * Rendered outside the app tree and suppressible with `?chrome=off` so a
 * captured screenshot can show the product alone.
 */

import { useSyncExternalStore } from 'react';
import { subscribeUnhandled, unhandledCalls } from './unhandled';
import { scenarios } from './scenarios';
import type { Scenario } from './types';

const shell: React.CSSProperties = {
  position: 'fixed',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 2147483647,
  font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  background: '#111317',
  color: '#e5e7eb',
  borderTop: '1px solid #2a2f37',
  padding: '8px 12px',
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  flexWrap: 'wrap',
};

export function HarnessOverlay({ scenario }: { scenario: Scenario }) {
  const missing = useSyncExternalStore(subscribeUnhandled, unhandledCalls);

  return (
    <div style={shell} data-harness-chrome>
      <select
        value={scenario.id}
        onChange={(e) => {
          const url = new URL(window.location.href);
          url.searchParams.set('scenario', e.target.value);
          window.location.href = url.toString();
        }}
        style={{
          background: '#1b1f26',
          color: '#e5e7eb',
          border: '1px solid #2a2f37',
          borderRadius: 4,
          padding: '4px 6px',
          font: 'inherit',
        }}
      >
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id}
          </option>
        ))}
      </select>

      <span style={{ color: '#9ca3af' }}>
        <strong style={{ color: '#e5e7eb' }}>{scenario.title}</strong> — {scenario.looksRightWhen}
      </span>

      {missing.length > 0 && (
        <span
          data-harness-unhandled={missing.length}
          style={{
            marginLeft: 'auto',
            background: '#7f1d1d',
            color: '#fecaca',
            borderRadius: 4,
            padding: '3px 8px',
          }}
          title={missing.map((m) => `${m.cmd} ×${m.count}`).join('\n')}
        >
          {missing.length} command{missing.length === 1 ? '' : 's'} unmocked — this screen is
          incomplete
        </span>
      )}
    </div>
  );
}
