/**
 * Events the Mac pushes. Each journaled one mirrors a desktop Tauri event,
 * which the server subscribes to (`app.listen_any`) rather than re-deriving:
 *
 * | Companion event   | Desktop event       | Replay rule                    |
 * | ----------------- | ------------------- | ------------------------------ |
 * | `agents.message`  | `agents://message`  | every one (upsert by id)       |
 * | `agents.status`   | `agents://status`   | latest per agent               |
 * | `agents.registry` | `agents://registry` | latest only                    |
 * | `agents.draft`    | `agents://draft`    | never (ephemeral)              |
 * | `projects.changed`| (polled session state) | latest per project          |
 * | `system.status`   | (power, Claude, routes) | latest only                |
 *
 * The desktop's `agents://registry` carries no payload; here it carries the
 * whole overview, so the phone needn't make a request per change.
 */

import type { Cursor } from './frames';
import type {
  AgentMessage,
  AgentStatus,
  AgentsOverview,
  Alert,
  MacStatus,
  ProjectSummary,
} from './model';

/** Journaled: carries a `seq` and is replayed on resume. */
export type JournaledEvent =
  /**
   * A message was added or changed (an approval answered or expired). Upsert
   * by `message.id`: the same id arriving again replaces, never duplicates.
   */
  | { type: 'agents.message'; message: AgentMessage }
  | { type: 'agents.status'; agentId: string; status: AgentStatus }
  | { type: 'agents.registry'; overview: AgentsOverview }
  | { type: 'projects.changed'; project: ProjectSummary }
  | { type: 'projects.removed'; path: string }
  | { type: 'system.status'; status: MacStatus };

/** Ephemeral: no `seq`, never replayed. */
export type EphemeralEvent =
  /**
   * A reply being written. `text` is appended at UTF-16 offset `from` of the
   * draft the phone holds for `id`. When `from` doesn't equal the phone's
   * length, drop the draft and wait: the Mac restarts the draft with
   * `from: 0` on every new connection, and the finished message replaces it
   * by the same `id`.
   */
  | { type: 'agents.draft'; agentId: string; id: string; from: number; text: string }
  /** Show a local notification (only sent when this device isn't showing that agent). */
  | { type: 'alert'; alert: Alert }
  /**
   * After `welcome.resume = 'snapshot'`: the state as of `cursor`. Replace the
   * overview and Mac status, drop drafts, and re-fetch open chats.
   */
  | {
      type: 'sync.snapshot';
      cursor: Cursor;
      overview: AgentsOverview;
      status: MacStatus;
      projects: ProjectSummary[];
    }
  /** Replay or snapshot is done; what follows is live. */
  | { type: 'sync.caughtUp'; cursor: Cursor };

export type CompanionEvent = JournaledEvent | EphemeralEvent;
export type EventType = CompanionEvent['type'];
