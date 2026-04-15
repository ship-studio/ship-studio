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

import type { Terminal as XTerm } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { IPty } from 'tauri-pty';
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
 * Per-tab terminal slot owned by the registry — survives the React
 * Terminal component unmounting/remounting (which happens on project
 * switch and HMR). Without registry-owned slots, switching projects
 * disposes xterm and kills the PTY, losing the agent session.
 *
 * Phase 2d: this is the heart of the background-sessions feature.
 *
 * The Terminal.tsx component checks the registry on mount and reuses
 * an existing slot if present (reattaching xterm DOM); on unmount, if
 * the project is pinned, the slot is parked here instead of destroyed.
 */
export interface TerminalSlot {
  /** xterm.js terminal instance. Survives DOM detach. */
  term: XTerm;
  /** Active PTY handle. `null` if the session is suspended. */
  pty: IPty | null;
  /** xterm fit addon (kept so resize works after reattach). */
  fitAddon: FitAddon;
  /** Disposables for `pty.onData` / `pty.onExit` listeners. */
  ptyDisposables: Array<{ dispose(): void }>;
  /** Buffered output captured while the slot has no DOM container. */
  hiddenBuffer: string[];
  /** Total bytes in `hiddenBuffer` (for cap enforcement). */
  hiddenBufferSize: number;
  /** Last-known agent activity status from terminal title detection. */
  lastAgentStatus: AgentActivityStatus;
}

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
  /** Per-project terminal slots, keyed by `projectPath` then `tabId`. */
  private readonly terminals = new Map<string, Map<number, TerminalSlot>>();
  /**
   * Project paths the rail considers "pinned." Drives whether terminal
   * slots are parked on Terminal-component unmount or fully destroyed.
   * Synced from `usePinnedProjects` via `setPinnedPaths`.
   */
  private pinnedPaths = new Set<string>();
  /**
   * The project the user is currently looking at, or `null` if none
   * (projects view, etc.). Synced from `App.tsx` via `setActiveProject`.
   * The only reason this lives in the registry is so that listeners
   * inside parked terminal slots — whose `isFocused` closure capture is
   * frozen at park time — can compute the CURRENT focus state when
   * forwarding status updates. Otherwise unread badges wouldn't increment
   * for a backgrounded project's `thinking → waiting` transition.
   */
  private activeProjectPath: string | null = null;

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
    if (session.status === 'active') return;
    session.status = 'active';
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
   *
   * `isFocusedHint` is optional — if omitted, the registry uses its own
   * `activeProjectPath` to decide. This matters for parked terminal
   * listeners whose closure-captured isFocused is frozen at park time:
   * we want the LIVE focus state to drive unread, not the stale capture.
   */
  setAgentStatus(projectPath: string, status: AgentActivityStatus, isFocusedHint?: boolean): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    const previous = session.lastAgentStatus;
    if (previous === status) return;
    session.lastAgentStatus = status;
    const isFocused = isFocusedHint ?? this.activeProjectPath === projectPath;
    if (status === 'waiting' && !isFocused) {
      session.unreadCount += 1;
    }
    this.notify(projectPath);
  }

  /**
   * Tell the registry which project is currently focused (visible to the
   * user). Drives unread-badge logic for status updates from parked
   * listeners. Pass `null` when no project is open.
   */
  setActiveProject(projectPath: string | null): void {
    if (this.activeProjectPath === projectPath) return;
    this.activeProjectPath = projectPath;
    if (projectPath) {
      // Coming into focus → clear any pending unread for this project.
      this.clearUnread(projectPath);
    }
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

  // ============ Terminal slot lifecycle (Phase 2d) ============

  /**
   * Look up the terminal slot for a (project, tab). Returns `undefined`
   * if no slot exists — caller should create one. Used by Terminal.tsx
   * to decide between reattach (slot exists) and create (slot missing).
   */
  getTerminalSlot(projectPath: string, tabId: number): TerminalSlot | undefined {
    return this.terminals.get(projectPath)?.get(tabId);
  }

  /**
   * Park a terminal slot in the registry. Safe to call repeatedly with
   * the same slot; later calls overwrite. Fires no subscriber notifications
   * because the slot is implementation detail of the rail's status, not
   * UI state.
   */
  setTerminalSlot(projectPath: string, tabId: number, slot: TerminalSlot): void {
    let perProject = this.terminals.get(projectPath);
    if (!perProject) {
      perProject = new Map();
      this.terminals.set(projectPath, perProject);
    }
    perProject.set(tabId, slot);
    logger.debug('[SessionRegistry] Parked terminal slot', { projectPath, tabId });
  }

  /**
   * Remove (but DO NOT dispose) a terminal slot. Caller is responsible
   * for disposing xterm and killing PTY if appropriate. Used internally
   * by `disposeTerminalSlot` and by tests.
   */
  forgetTerminalSlot(projectPath: string, tabId: number): TerminalSlot | undefined {
    const perProject = this.terminals.get(projectPath);
    if (!perProject) return undefined;
    const slot = perProject.get(tabId);
    perProject.delete(tabId);
    if (perProject.size === 0) this.terminals.delete(projectPath);
    return slot;
  }

  /**
   * Fully dispose a terminal slot — removes from registry, disposes the
   * xterm instance, and kills the PTY. Used when a project is unpinned
   * or the user explicitly closes a session.
   */
  disposeTerminalSlot(projectPath: string, tabId: number): void {
    const slot = this.forgetTerminalSlot(projectPath, tabId);
    if (!slot) return;
    for (const d of slot.ptyDisposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    if (slot.pty) {
      try {
        // tauri-pty's read loop polls indefinitely; clearing pid breaks it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (slot.pty as any).pid = undefined;
        slot.pty.kill();
      } catch {
        /* ignore — PTY may already be dead */
      }
    }
    try {
      slot.term.dispose();
    } catch {
      /* ignore */
    }
    logger.info('[SessionRegistry] Disposed terminal slot', { projectPath, tabId });
  }

  /** Dispose every terminal slot for a project. Used on unpin. */
  disposeAllTerminalsForProject(projectPath: string): void {
    const perProject = this.terminals.get(projectPath);
    if (!perProject) return;
    const tabIds = Array.from(perProject.keys());
    for (const tabId of tabIds) {
      this.disposeTerminalSlot(projectPath, tabId);
    }
  }

  /**
   * Sync the rail's pinned-project list into the registry so it can decide
   * whether to park or destroy on Terminal unmount. Also disposes terminal
   * slots for projects that just got unpinned (so their PTYs don't leak).
   */
  setPinnedPaths(paths: ReadonlyArray<string>): void {
    const next = new Set(paths);
    // Find paths that just became unpinned and tear down their terminals.
    for (const path of this.pinnedPaths) {
      if (!next.has(path)) {
        this.disposeAllTerminalsForProject(path);
      }
    }
    this.pinnedPaths = next;
  }

  /**
   * Whether a project's terminal slot should be PARKED instead of
   * destroyed when the React Terminal component unmounts. True iff the
   * project is currently pinned.
   */
  isPinned(projectPath: string): boolean {
    return this.pinnedPaths.has(projectPath);
  }

  /** TEST ONLY — reset the registry. Not exported through the singleton. */
  _resetForTests(): void {
    this.sessions.clear();
    this.subscribers.clear();
    // Can't safely dispose xterm/PTY in tests — just forget the slots.
    this.terminals.clear();
    this.pinnedPaths.clear();
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
