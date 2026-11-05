/**
 * A conversation as the list draws it, newest first (the list is inverted):
 * the reply being written or the working line, your unconfirmed sends, then
 * the messages with a day line where the day changes and a clock under the
 * last message of each run. Pure, so it's tested.
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import { workingLine } from './agents';
import type { PendingSend } from './sync';

export type Item =
  | { kind: 'message'; key: string; message: AgentMessage; time: boolean }
  | { kind: 'day'; key: string; label: string }
  | { kind: 'pending'; key: string; pending: PendingSend }
  | { kind: 'draft'; key: string; text: string }
  | { kind: 'working'; key: string; label: string };

/** Messages closer than this, from the same side, are one run with one clock. */
const RUN_MS = 5 * 60_000;
const side = (m: AgentMessage) => (m.kind === 'user' ? 'you' : 'them');

/**
 * The list, newest first: the draft or working line, unconfirmed sends, then
 * messages with a day line where the day changes and a clock on the last
 * message of each run.
 */
export function chatItems(
  agent: Agent,
  messages: AgentMessage[],
  pending: PendingSend[],
  draft: { id: string; text: string } | undefined,
  now = Date.now()
): Item[] {
  const out: Item[] = [];
  if (draft) out.push({ kind: 'draft', key: draft.id, text: draft.text });
  else if (agent.status.state === 'working')
    out.push({ kind: 'working', key: 'working', label: workingLine(agent) });
  for (let i = pending.length - 1; i >= 0; i--) {
    out.push({ kind: 'pending', key: `pending:${pending[i].clientId}`, pending: pending[i] });
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // A draft that became its message keeps its key, so the row never remounts.
    if (draft && m.id === draft.id) continue;
    const next = messages[i + 1];
    const time = !next || side(next) !== side(m) || next.ts - m.ts > RUN_MS;
    out.push({ kind: 'message', key: m.id, message: m, time });
    const prev = messages[i - 1];
    const label = dayLabel(m.ts, now);
    if (!prev || dayLabel(prev.ts, now) !== label) {
      out.push({ kind: 'day', key: `day:${m.id}`, label });
    }
  }
  return out;
}

/** "Today", "Yesterday", "Tuesday", "Mon 3 Nov": a day separator. */
export function dayLabel(ts: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
}
