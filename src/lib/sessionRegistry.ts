/**
 * # Session Registry — Frontend
 *
 * Module-level (outside React) registry of live project sessions. The
 * single source of truth in the frontend for "which projects have a live
 * session in this window." Pairs with the Rust `pty_session` registry,
 * which owns the actual PTY processes.
 *
 * **Core invariant:** one project path → at most one session, ever.
 *
 * `getOrCreate` is the only path that creates a session. If a session
 * already exists for the path, it's returned unchanged. No other code
 * path can bypass this guard. React components remount during HMR,
 * project switches, and state changes — keeping the registry outside
 * React guarantees a remount cannot accidentally spawn a second session
 * for the same project.
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
 * Runtime status of a single agent/terminal tab. Derived from explicit
 * lifecycle events — spawn, exit, title-based activity — never from
 * "whether it's the selected tab". A non-selected-but-running tab is
 * `running`, not `idle`. Crash vs. clean exit is kept distinct because
 * the UX differs.
 */
export type TabStatus = 'starting' | 'running' | 'thinking' | 'waiting' | 'exited' | 'crashed';

/**
 * A single terminal tab belonging to a project's session. This is the
 * registry's view of the tab — enough to rehydrate the tab bar and sidebar
 * when we switch back to the project. The live PTY is owned by the Rust
 * registry (`pty_session.rs`); this struct carries the metadata that drives
 * the sidebar's rendering.
 */
export interface SessionTerminalTab {
  readonly id: number;
  readonly agentId: string;
  readonly sessionId: string;
  /** Last-seen PTY title (for sidebar display when the xterm is unmounted). */
  title?: string;
  /** User-supplied title from the sidebar's rename UI. Takes precedence
   *  over `title` when present so a manual rename is not clobbered by
   *  the next PTY title-change event. */
  customTitle?: string;
  /** Whether this tab has an attention indicator on the sidebar. */
  attention?: boolean;
  /** Authoritative lifecycle status. Undefined = we haven't heard from
   *  Terminal yet (treat as `starting`). Updated by Terminal's spawn/exit
   *  callbacks and by agent-activity status parsing. */
  status?: TabStatus;
  /** OS process id of the backing PTY. Null before spawn and after exit. */
  pid?: number | null;
  /** Exit code captured by `onExit`. Present iff status is `exited` or
   *  `crashed`. Non-zero typically means `crashed`. */
  exitCode?: number | null;
  /** Unix millis of the most recent status update for this tab. */
  lastActivityAt?: number;
  /** True when this tab's PTY captured a now-outdated workspace login env at
   *  spawn (a credential changed after it started). Non-destructive UI hint:
   *  the terminal area shows a "restart to apply" banner. Cleared when the tab
   *  is restarted (its sessionId changes) or the banner is dismissed. */
  staleEnv?: boolean;
}

/**
 * In-memory state for a single project session.
 *
 * Ownership split:
 *
 * - `status` / `activatedAt` / `lastFocusedAt` / `unreadCount` /
 *   `lastAgentStatus` / `terminalTabs`: owned by this registry.
 * - Live PTY handles: owned by the Rust `pty_session` registry, keyed
 *   by `tab.sessionId`.
 * - xterm instances + dev server handles: owned by React components
 *   (Terminal.tsx, useDevServer) while mounted.
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
  /**
   * Last-known terminal tabs for this project. Populated from the backend's
   * persisted `set_terminal_state` when the project is registered, and kept
   * in sync as the user spawns/closes tabs. Read by the sidebar so non-
   * current projects can show their tab list without having to switch.
   */
  terminalTabs: SessionTerminalTab[];
  /** Index into `terminalTabs` that should be active on next mount. */
  activeTabIndex: number;
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
  readonly terminalTabs: ReadonlyArray<SessionTerminalTab>;
  readonly activeTabIndex: number;
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
  /** Monotonic version bumped on every notify — lets React's
   *  `useSyncExternalStore` detect changes without snapshot equality. */
  private version = 0;

  /** Current store version (stable until the next `notify`). */
  getVersion(): number {
    return this.version;
  }

  /** `useSyncExternalStore`-compatible subscribe adapter. */
  subscribeSimple = (callback: () => void): (() => void) => {
    return this.subscribe(() => callback());
  };

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
      terminalTabs: [],
      activeTabIndex: 0,
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
   * Remove a session entirely. Called when the project is explicitly
   * closed from the sidebar. Idempotent.
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
   * Call on terminal input, focus, etc.
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

  /**
   * Replace the cached terminal-tab list for a project. Called when:
   * - A project is first loaded and its persisted tabs are hydrated.
   * - The user spawns, closes, or swaps the agent on a tab.
   * - The user switches to another project (outgoing snapshot).
   *
   * Auto-creates the session entry if missing — safer than requiring
   * consumers to chain `getOrCreate` first, which they often forget.
   */
  setTerminalTabs(
    projectPath: string,
    tabs: ReadonlyArray<SessionTerminalTab>,
    activeTabIndex: number
  ): void {
    const session = this.sessions.get(projectPath) ?? this.getOrCreate(projectPath);
    // Preserve `title` and `attention` from the existing snapshot when the
    // caller (useTerminalManagement) doesn't include them. Otherwise every
    // tab mutation — add, close, switch agent — would wipe the PTY-reported
    // title mid-session.
    const byId = new Map<number, SessionTerminalTab>();
    for (const t of session.terminalTabs) byId.set(t.id, t);
    session.terminalTabs = tabs.map((t) => {
      const prev = byId.get(t.id);
      if (!prev) return { ...t };
      // sessionId changes when the tab's agent is switched. Drop the
      // title/attention/status carried over from the previous agent so the
      // new Terminal starts with a clean slate and re-emits its own state.
      const agentChanged = prev.sessionId !== t.sessionId;
      return {
        ...t,
        title: t.title ?? (agentChanged ? undefined : prev.title),
        // `customTitle` is the user's manual rename — preserve it across
        // every other tab mutation (switch, close-sibling, etc.). Drop it
        // when the agent itself changes, since "Backend" probably meant
        // something specific to the previous agent.
        customTitle: t.customTitle ?? (agentChanged ? undefined : prev.customTitle),
        attention: t.attention ?? (agentChanged ? undefined : prev.attention),
        status: t.status ?? (agentChanged ? 'starting' : prev.status),
        pid: t.pid ?? (agentChanged ? null : prev.pid),
        exitCode: t.exitCode ?? (agentChanged ? null : prev.exitCode),
        lastActivityAt: t.lastActivityAt ?? (agentChanged ? Date.now() : prev.lastActivityAt),
        // A new sessionId means a fresh PTY that captured the *current* env, so
        // staleness clears on restart / agent switch. Otherwise it carries over.
        staleEnv: t.staleEnv ?? (agentChanged ? undefined : prev.staleEnv),
      };
    });
    session.activeTabIndex = Math.max(0, Math.min(activeTabIndex, tabs.length - 1));
    this.notify(projectPath);
  }

  /** Update a single tab's title (e.g. after a PTY title-change event). */
  setTerminalTabTitle(projectPath: string, tabId: number, title: string): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    let changed = false;
    session.terminalTabs = session.terminalTabs.map((tab) => {
      if (tab.id === tabId && tab.title !== title) {
        changed = true;
        return { ...tab, title };
      }
      return tab;
    });
    if (changed) this.notify(projectPath);
  }

  /** Snapshot of `tabId → customTitle` for a project. Empty when the
   *  project has no registry entry yet or no manual renames. Used by the
   *  set_terminal_state save call sites to forward custom titles to disk. */
  getCustomTitles(projectPath: string): Map<number, string> {
    const session = this.sessions.get(projectPath);
    const map = new Map<number, string>();
    if (!session) return map;
    for (const t of session.terminalTabs) {
      if (t.customTitle) map.set(t.id, t.customTitle);
    }
    return map;
  }

  /** Set or clear a user-supplied custom title. Pass an empty string or
   *  null to clear (revert to PTY-emitted title). */
  setTerminalTabCustomTitle(projectPath: string, tabId: number, customTitle: string | null): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    const next = customTitle && customTitle.trim().length > 0 ? customTitle.trim() : undefined;
    let changed = false;
    session.terminalTabs = session.terminalTabs.map((tab) => {
      if (tab.id === tabId && tab.customTitle !== next) {
        changed = true;
        return { ...tab, customTitle: next };
      }
      return tab;
    });
    if (changed) this.notify(projectPath);
  }

  /** Mark/clear the attention indicator on a specific tab. */
  setTerminalTabAttention(projectPath: string, tabId: number, attention: boolean): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    let changed = false;
    session.terminalTabs = session.terminalTabs.map((tab) => {
      if (tab.id === tabId && (tab.attention ?? false) !== attention) {
        changed = true;
        return { ...tab, attention };
      }
      return tab;
    });
    if (changed) this.notify(projectPath);
  }

  /**
   * Record a lifecycle update for a tab. Any subset of fields can be
   * patched in a single call; whatever isn't provided is left unchanged.
   * Bumps `lastActivityAt` to now on every call. Single entry point for
   * every runtime source (Terminal spawn/exit, title-based activity
   * parsing) — keeps the sidebar's derived state consistent.
   */
  patchTerminalTab(
    projectPath: string,
    tabId: number,
    patch: {
      status?: TabStatus;
      pid?: number | null;
      exitCode?: number | null;
      bumpActivity?: boolean;
    }
  ): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    let changed = false;
    const now = Date.now();
    session.terminalTabs = session.terminalTabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      const next: SessionTerminalTab = { ...tab };
      if (patch.status !== undefined && tab.status !== patch.status) {
        next.status = patch.status;
        changed = true;
      }
      if (patch.pid !== undefined && tab.pid !== patch.pid) {
        next.pid = patch.pid;
        changed = true;
      }
      if (patch.exitCode !== undefined && tab.exitCode !== patch.exitCode) {
        next.exitCode = patch.exitCode;
        changed = true;
      }
      if (patch.bumpActivity !== false) {
        next.lastActivityAt = now;
        changed = true;
      }
      return next;
    });
    if (changed) this.notify(projectPath);
  }

  /**
   * Flag a project's currently-running terminal tabs as having a stale login
   * env — their PTY captured the workspace's credentials at spawn and can't
   * pick up a change without a restart. Only running tabs are flagged: an
   * exited tab re-reads fresh env on its next (Enter-to-)restart anyway.
   * Non-destructive — it only drives a "restart to apply" banner.
   */
  markProjectTabsStale(projectPath: string): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    let changed = false;
    session.terminalTabs = session.terminalTabs.map((tab) => {
      const isRunning =
        tab.status === undefined ||
        tab.status === 'starting' ||
        tab.status === 'running' ||
        tab.status === 'thinking' ||
        tab.status === 'waiting';
      if (isRunning && !tab.staleEnv) {
        changed = true;
        return { ...tab, staleEnv: true };
      }
      return tab;
    });
    if (changed) this.notify(projectPath);
  }

  /** True when the project has at least one tab flagged with a stale env. */
  hasStaleTabs(projectPath: string): boolean {
    const session = this.sessions.get(projectPath);
    if (!session) return false;
    return session.terminalTabs.some((t) => t.staleEnv);
  }

  /** Clear the stale-env flag on every tab of a project (e.g. on banner
   *  dismiss). Restarting a tab clears its own flag via {@link setTerminalTabs}. */
  clearProjectStaleEnv(projectPath: string): void {
    const session = this.sessions.get(projectPath);
    if (!session) return;
    let changed = false;
    session.terminalTabs = session.terminalTabs.map((tab) => {
      if (tab.staleEnv) {
        changed = true;
        return { ...tab, staleEnv: false };
      }
      return tab;
    });
    if (changed) this.notify(projectPath);
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
    this.version += 1;
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
    terminalTabs: session.terminalTabs.slice(),
    activeTabIndex: session.activeTabIndex,
  };
}

/**
 * The one and only registry instance for this JS context.
 * Always import this — never instantiate `SessionRegistry` directly.
 */
export const sessionRegistry = new SessionRegistry();
