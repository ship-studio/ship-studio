/**
 * Live verification checklist beside the guided agent terminal.
 *
 * The source of truth for "done" — rows tick green as the app's own
 * `get_full_setup_status` checks pass, never on the agent's say-so.
 */

import { SetupItem, SETUP_FRIENDLY_NAMES } from '../../../lib/setup';
import { AGENT_LED_REQUIRED_ITEM_IDS, HostChoice } from '../../../lib/agentOnboarding';
import { SuccessIcon } from '@/components/icons';

interface ChecklistRow {
  id: string;
  label: string;
  ready: boolean;
}

interface SetupChecklistProps {
  items: SetupItem[];
  /** Binary id of the agent chosen in Phase 0, or null for "Other" (no row). */
  agentBinaryId: string | null;
  /** Display name of the chosen agent. */
  agentDisplayName: string;
  /** Hosting provider chosen in the hosting step (null = skipped). */
  hostChoice: HostChoice | null;
}

export function SetupChecklist({
  items,
  agentBinaryId,
  agentDisplayName,
  hostChoice,
}: SetupChecklistProps) {
  const rows: ChecklistRow[] = [
    // "Other" agents aren't managed by Ship Studio, so there's no row to
    // verify for them — only the required tools below.
    ...(agentBinaryId !== null
      ? [
          {
            id: agentBinaryId,
            label: agentDisplayName,
            ready:
              items.find((i) => i.id === agentBinaryId)?.status === 'ready' &&
              items.find((i) => i.id === `${agentBinaryId}_auth`)?.status === 'ready',
          },
        ]
      : []),
    // Required items, in install order. Absent items (e.g. npm_fix once
    // permissions are fine) simply don't get a row.
    ...AGENT_LED_REQUIRED_ITEM_IDS.map((id) => items.find((i) => i.id === id))
      .filter((item): item is SetupItem => item !== undefined)
      .map((item) => ({
        id: item.id,
        label: SETUP_FRIENDLY_NAMES[item.id] ?? item.friendlyName,
        ready: item.status === 'ready',
      })),
    // Vercel has real backend detection, so its row is verifiable. Cloudflare
    // doesn't yet — it gets an honest footnote below instead of a fake row.
    ...(hostChoice === 'vercel'
      ? [
          {
            id: 'vercel-pair',
            label: 'Vercel hosting',
            ready:
              items.find((i) => i.id === 'vercel')?.status === 'ready' &&
              items.find((i) => i.id === 'vercel_auth')?.status === 'ready',
          },
        ]
      : []),
  ];

  return (
    <div className="agent-setup-checklist" aria-label="Setup progress">
      <h3 className="agent-setup-checklist-title">Setup checklist</h3>
      <p className="agent-setup-checklist-hint">
        Ship Studio verifies each item itself — they turn green as real checks pass.
      </p>
      <ul className="agent-setup-checklist-items">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`agent-setup-checklist-item ${row.ready ? 'ready' : ''}`}
            aria-label={`${row.label}: ${row.ready ? 'ready' : 'pending'}`}
          >
            {row.ready ? (
              <SuccessIcon
                size={16}
                className="agent-setup-checklist-success-icon"
                aria-hidden="true"
              />
            ) : (
              <span className="agent-setup-checklist-dot" />
            )}
            <span>{row.label}</span>
          </li>
        ))}
      </ul>
      {hostChoice === 'cloudflare' && (
        <p className="agent-setup-checklist-footnote">
          Cloudflare is set up by your agent in the terminal — Ship Studio can't verify it yet, so
          check the terminal output.
        </p>
      )}
    </div>
  );
}
