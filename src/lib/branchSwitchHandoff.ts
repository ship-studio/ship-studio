/**
 * Handing a branch switch from the header's Branches menu to the Branches view.
 *
 * The menu runs the checkout itself for the common case. Anything that needs a
 * conversation — uncommitted changes, a branch checked out in another worktree,
 * a paused merge — already has one in `BranchesTab`, so the menu queues the
 * branch here, opens that view, and the view finishes the switch through its
 * own flow rather than the menu re-implementing it (issue #1012).
 *
 * A one-slot queue rather than a prop chain for the same reason as
 * `workflowHandoff`: the two ends are far apart in the tree, and the view may
 * or may not be mounted yet when the request is made. Taking the request
 * clears it, so a later remount of the view never replays it.
 *
 * @module lib/branchSwitchHandoff
 */

interface PendingSwitch {
  projectPath: string;
  branch: string;
}

let pending: PendingSwitch | null = null;
const listeners = new Set<() => void>();

/** Ask the Branches view of `projectPath` to switch to `branch`. */
export function queueBranchSwitch(projectPath: string, branch: string): void {
  pending = { projectPath, branch };
  listeners.forEach((listener) => listener());
}

/** Take (and clear) the queued switch for `projectPath`, if there is one. */
export function takeQueuedBranchSwitch(projectPath: string): string | null {
  if (!pending || pending.projectPath !== projectPath) return null;
  const { branch } = pending;
  pending = null;
  return branch;
}

/** Be told when a switch is queued. Returns the unsubscribe. */
export function subscribeQueuedBranchSwitch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
