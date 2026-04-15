/**
 * # Session Registry — Frontend
 *
 * Module-level (outside React) registry of live project sessions. The single
 * source of truth for "which projects have a live session in this window."
 *
 * **Core invariant:** one project path → at most one session, ever.
 *
 * `getOrCreate` is the only path that creates a session. If a session for
 * the path already exists, it returns the existing one. No other code path
 * can bypass this guard. React components remount during HMR, project
 * switches, and state changes — putting the registry outside React means
 * a remount cannot accidentally spawn a second session for the same project
 * (which is how the previous memory leak happened).
 *
 * ## Phased migration
 *
 * Phase 2a (this file, initial version) ships only the data structure and
 * invariant. xterm/PTY ownership migration to the registry happens in
 * Phase 2d-2f, where Terminal.tsx is refactored to attach its xterm to a
 * registry-owned instance instead of owning it itself.
 *
 * Until then, the registry holds metadata only — `status`, `activatedAt`,
 * `unreadCount`, etc. The xterm instances still live in the React tree.
 *
 * @module lib/sessionRegistry
 */

import { logger } from './logger';

/**
 * Lifecycle status of a session. Mirrors the backend's `SessionStatus` enum
 * in `src-tauri/src/state.rs`.
 */
export type SessionStatus = 'active' | 'suspended' | 'error';

/** Agent activity status, derived from terminal title detection. */
export type AgentActivityStatus = 'thinking' | 'waiting' | 'idle';

/**
 * In-memory state for a single project session.
 *
 * Notes on ownership (subject to expansion in Phase 2d-2f):
 *
 * - `status` / `activatedAt` / `lastFocusedAt` / `unreadCount` /
 *   `lastAgentStatus`: owned by the registry from day one.
 * - xterm instances, PTY refs, hidden buffers, dev server handle:
 *   currently still owned by React components (Terminal.tsx, useDevServer).
 *   The registry keeps the slot reserved so when ownership migrates, the
 *   data has a home.
 */
export interface ProjectSession {
  /** Canonical absolute path to the project directory. */
  readonly projectPath: string;
  /** Lifecycle status. */
  status: SessionStatus;
  /** Latest agent activity status from terminal title parsing. */
  lastAgentStatus: AgentActivityStatus;
  /** Unread count on the rail (incremented when status hits `waiting`
   *  while the session is in the background). Cleared on focus. */
  unreadCount: number;
  /** Unix millis when the session was created in this app run. */
  readonly activatedAt: number;
  /** Unix millis bumped on user activity (input, focus). Drives LRU. */
  lastFocusedAt: number;
  /** Last known memory usage in bytes (polled from backend). */
  memoryBytes: number;
}

/** Diff-friendly snapshot used by the rail UI subscription. */
export interface SessionSnapshot {
  readonly projectPath: string;
  readonly status: SessionStatus;
  readonly lastAgentStatus: AgentActivityStatus;
  readonly unreadCount: number;
  readonly activatedAt: number;
  readonly lastFocusedAt: number;
  readonly memoryBytes: number;
}

/**
 * Subscriber callback signature.
 * Receives the affected projectPath (or `null` for "any change") and the
 * full snapshot list. Subscribers should re-render only what they depend on.
 */
export type SessionSubscriber = (
  changedPath: string | null,
  snapshots: ReadonlyArray<SessionSnapshot>
) => void;

/**
 * SessionRegistry — module-level singleton.
 *
 * Not exported as a class; consumers use the exported `sessionRegistry`
 * singleton. This guarantees there's exactly one registry per JS context,
 * which is the foundation of the invariant.
 */
class SessionRegistry {
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly subscribers = new Set<SessionSubscriber>();

  /**
   * Look up a session by path.
   * @returns the session if present, otherwise `undefined`.
   */
  get(projectPath: string): ProjectSession | undefined {
    return this.sessions.get(projectPath);
  }

  /**
   * Get or create a session for the given path. **The invariant guard.**
   *
   * If a session already exists for this path, it is returned unchanged
   * (its `lastFocusedAt` is *not* bumped — call `touch` for that).
   * If no session exists, a fresh one is created with `status='active'`.
   *
   * Repeated calls with the same path during the same project switch are
   * safe and idempotent — the registry will never hold two entries for
   * the same path.
   */
  getOrCreate(projectPath: string): ProjectSession {
    const existing = this.sessions.get(projectPath);
    if (existing) {
      logger.debug('[SessionRegistry] getOrCreate hit existing', {
        projectPath,
        status: existing.status,
      });
      return existing;
    }

    const now = Date.now();
    const session: ProjectSession = {
      projectPath,
      status: 'active',
      lastAgentStatus: 'idle',
      unreadCount: 0,
      activatedAt: now,
      lastFocusedAt: now,
      memoryBytes: 0,
    };
    this.sessions.set(projectPath, session);
    logger.info('[SessionRegistry] Created session', { projectPath });
    this.notify(projectPath);
    return session;
  }

  /**
   * Mark a session as suspended. Does not remove the entry — pinned-but-
   * suspended sessions still appear on the rail (grayed out). Idempotent.
   */
  suspend(projectPath: string): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    if (session.status === 'suspended') return;
    session.status = 'suspended';
    session.lastFocusedAt = Date.now();
    logger.info('[SessionRegistry] Suspended session', { projectPath });
    this.notify(projectPath);
  }

  /**
   * Move a suspended session back to active. Used when the user clicks a
   * suspended pin and the cold-start completes. Idempotent.
   */
  resume(projectPath: string): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    if (session.status === 'active' && session.lastAgentStatus === 'idle') return;
    session.status = 'active';
    // Cold-start wipes the terminal, so the stale thinking/waiting from
    // the previous run doesn't carry over. Without this, the rail dot
    // flickers the old color until the new agent emits its first title.
    session.lastAgentStatus = 'idle';
    session.lastFocusedAt = Date.now();
    logger.info('[SessionRegistry] Resumed session', { projectPath });
    this.notify(projectPath);
  }

  /**
   * Remove a session entirely. Used when the project is unpinned.
   * In Phase 2d+, this will also be the place that disposes xterm/PTY.
   * Idempotent.
   */
  destroy(projectPath: string): void {
    const removed = this.sessions.delete(projectPath);
    if (removed) {
      logger.info('[SessionRegistry] Destroyed session', { projectPath });
      this.notify(projectPath);
    }
  }

  /**
   * Bump `lastFocusedAt`. Cheap, idempotent within the same millisecond.
   * Call on terminal input, focus, etc. Drives LRU eviction in Phase 5.
   */
  touch(projectPath: string): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    session.lastFocusedAt = Date.now();
  }

  /**
   * Update the agent activity status (idle/thinking/waiting). If the new
   * status is `waiting` and the session is not the focused one, increment
   * `unreadCount` so the rail shows a badge.
   */
  setAgentStatus(projectPath: string, status: AgentActivityStatus, isFocused: boolean): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    const previous = session.lastAgentStatus;
    if (previous === status) return;
    session.lastAgentStatus = status;
    if (status === 'waiting' && !isFocused) {
      session.unreadCount += 1;
    }
    this.notify(projectPath);
  }

  /** Clear the unread badge for a session. Called when it becomes focused. */
  clearUnread(projectPath: string): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    if (session.unreadCount === 0) return;
    session.unreadCount = 0;
    this.notify(projectPath);
  }

  /** Update the cached memory reading. */
  setMemoryBytes(projectPath: string, bytes: number): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    if (session.memoryBytes === bytes) return;
    session.memoryBytes = bytes;
    this.notify(projectPath);
  }

  /** Snapshot of a single session for subscribers / equality checks. */
  snapshot(projectPath: string): SessionSnapshot | undefined {
    const session = this.sessions.get(projectPath);
    if (!session) return undefined;
    return toSnapshot(session);
  }

  /** Snapshot of all sessions, sorted by `activatedAt` ascending. */
  snapshotAll(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => a.activatedAt - b.activatedAt)
      .map(toSnapshot);
  }

  /** Number of sessions in `active` status. Used for soft-cap enforcement. */
  countActive(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'active') count += 1;
    }
    return count;
  }

  /**
   * Subscribe to registry changes. Returns an unsubscribe function.
   * Subscribers are called with the changedPath (or `null` for bulk
   * changes, e.g. memory polling) and a fresh snapshot list.
   */
  subscribe(callback: SessionSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** TEST ONLY — reset the registry. Not exported through the singleton. */
  _resetForTests(): void {
    this.sessions.clear();
    this.subscribers.clear();
  }

  private notify(changedPath: string | null): void {
    if (this.subscribers.size === 0) return;
    const snapshots = this.snapshotAll();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(changedPath, snapshots);
      } catch (err) {
        logger.error('[SessionRegistry] Subscriber threw', { error: String(err) });
      }
    }
  }
}

function toSnapshot(session: ProjectSession): SessionSnapshot {
  return {
    projectPath: session.projectPath,
    status: session.status,
    lastAgentStatus: session.lastAgentStatus,
    unreadCount: session.unreadCount,
    activatedAt: session.activatedAt,
    lastFocusedAt: session.lastFocusedAt,
    memoryBytes: session.memoryBytes,
  };
}

/**
 * The one and only registry instance for this JS context.
 * Always import this — never instantiate `SessionRegistry` directly.
 */
export const sessionRegistry = new SessionRegistry();
