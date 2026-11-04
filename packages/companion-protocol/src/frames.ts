/**
 * What goes over the WebSocket (`GET /v1/ws`): JSON text frames, one object each.
 *
 * Order on connect: the phone sends `hello`; the Mac answers `welcome` (or
 * `refused` and closes); then replayed or snapshot events, `sync.caughtUp`,
 * and live traffic. Responses and events share the socket, so an event caused
 * by a request is never overtaken by that request's response.
 */

import type { CompanionEvent } from './events';
import type { MethodName, Params, Result } from './methods';
import type { ProtocolRange } from './version';

/**
 * A position in the Mac's event journal. `epoch` changes whenever the journal
 * starts over (the app restarted), so a cursor from before can't be mistaken
 * for one from now.
 */
export interface Cursor {
  epoch: string;
  seq: number;
}

// ---- Errors -----------------------------------------------------------------

/** `src-tauri/src/errors.rs::CommandError`, as src/lib/errors.ts mirrors it. */
export type CommandError =
  | { type: 'Timeout'; cmd: string; secs: number }
  | { type: 'Process'; cmd: string; exit_code: number; stderr: string }
  | { type: 'Validation'; field: string; reason: string }
  | { type: 'NotAuthenticated'; service: string }
  | { type: 'Io'; message: string }
  | { type: 'MergeConflict'; pr_number: number; stderr: string }
  | { type: 'Other'; message: string; expected?: boolean };

/** Failures of the companion itself, before or around a command. */
export interface ProtocolError {
  type: 'Protocol';
  code:
    | 'unknown_method'
    | 'bad_params'
    | 'rate_limited'
    | 'too_large'
    /** Remote Access's text rules said no; `message` says why, for the user. */
    | 'refused'
    | 'not_connected';
  message: string;
}

export type WireError = CommandError | ProtocolError;

// ---- Phone → Mac ------------------------------------------------------------

export interface HelloFrame {
  t: 'hello';
  protocol: ProtocolRange;
  /** The device token from pairing. Sent here, never in the URL, so no log ever holds it. */
  token: string;
  app: {
    version: string;
    /** expo-updates update id, when running an OTA update. */
    updateId?: string;
    /** The native binary's `runtimeVersion`: which OTA updates it can take. */
    runtimeVersion: string;
  };
  /** The last cursor the phone fully applied. Absent on a first connect. */
  resume?: Cursor;
  /** The phone is in the foreground (only then does it count as "showing" an agent). */
  foreground: boolean;
}

export interface RequestFrame<M extends MethodName = MethodName> {
  t: 'req';
  /** Unique per connection; echoed on the response. */
  id: number;
  method: M;
  params: Params<M>;
}

/** The app moved between foreground and background. */
export interface PresenceFrame {
  t: 'presence';
  foreground: boolean;
}

export interface PingFrame {
  t: 'ping';
}

export type ClientFrame = HelloFrame | RequestFrame | PresenceFrame | PingFrame;

// ---- Mac → phone ------------------------------------------------------------

export interface WelcomeFrame {
  t: 'welcome';
  /** The version both sides speak, from `negotiate`. */
  protocol: number;
  server: { id: string; name: string; appVersion: string };
  deviceId: string;
  /**
   * `replay`: the events after `hello.resume` follow, then `sync.caughtUp`.
   * `snapshot`: the cursor was unknown or too old; a `sync.snapshot` event
   * follows, then `sync.caughtUp`. Cached messages must be re-fetched.
   */
  resume: 'replay' | 'snapshot';
  /** Methods this Mac supports, so a newer app can hide what an older Mac lacks. */
  methods: MethodName[];
}

export interface RefusedFrame {
  t: 'refused';
  reason:
    | 'unauthorized'
    | 'revoked'
    /** The phone is older than the Mac supports: update the app. */
    | 'update_app'
    /** The Mac is older than the phone supports: update Ship Studio. */
    | 'update_mac'
    | 'too_many_connections';
  message: string;
}

export type ResponseFrame<M extends MethodName = MethodName> =
  | { t: 'res'; id: number; ok: true; result: Result<M> }
  | { t: 'res'; id: number; ok: false; error: WireError };

/**
 * One event. `seq` is present on journaled events: the phone stores
 * `{epoch, seq}` as its cursor once the event is applied. Ephemeral events
 * (drafts, alerts) have none and are never replayed.
 */
export interface EventFrame {
  t: 'evt';
  seq?: number;
  event: CompanionEvent;
}

export interface PongFrame {
  t: 'pong';
}

export type ServerFrame = WelcomeFrame | RefusedFrame | ResponseFrame | EventFrame | PongFrame;

/** The Mac sends a ping every 15 s; no frame for this long means the link is dead. */
export const HEARTBEAT_MS = 15_000;
export const DEAD_AFTER_MS = 40_000;
