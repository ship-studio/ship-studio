/**
 * Hook for reading the Workspace (Account) to display in the UI.
 *
 * When a `projectPath` is given, it resolves the workspace that project is
 * tagged with (`account_id` in `.shipstudio/project.json`) so the indicator
 * follows the open project as you switch between projects in the sidebar.
 * Without a path (e.g. on Home), it falls back to the globally active account.
 *
 * @module hooks/useActiveAccount
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listAccounts,
  getActiveAccountId,
  getProjectAccountId,
  ACCOUNTS_CHANGED_EVENT,
  type Account,
} from '../lib/accounts';

// Module-level cache of the last successful fetch. The sidebar remounts on
// every view change (e.g. switching workspaces routes through the picker view
// and back), which would otherwise reset the hook's state to empty and hide the
// footer switcher for a frame until the async fetch resolves — a visible
// flicker. Seeding initial state from this cache keeps the indicator stable
// across remounts; the fetch then refreshes it.
let cachedAccounts: Account[] = [];
let cachedActiveAccount: Account | null = null;

export function useActiveAccount(projectPath?: string | null) {
  const [activeAccount, setActiveAccount] = useState<Account | null>(cachedActiveAccount);
  const [accounts, setAccounts] = useState<Account[]>(cachedAccounts);

  // Monotonic request id. `refresh()` has several awaits, so when the user
  // switches projects quickly an earlier call can resolve AFTER a later one and
  // overwrite the indicator with a stale workspace. Only the most recent call is
  // allowed to apply its result.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    const isStale = () => seq !== requestSeq.current;
    try {
      const all = await listAccounts();
      if (isStale()) return;
      cachedAccounts = all;
      setAccounts(all);
      // Prefer the open project's workspace; fall back to the active account.
      let accountId: string | null = null;
      if (projectPath) {
        accountId = await getProjectAccountId(projectPath).catch(() => null);
      }
      if (!accountId) {
        accountId = await getActiveAccountId();
      }
      if (isStale()) return;
      const resolved = all.find((a) => a.id === accountId) ?? all[0] ?? null;
      cachedActiveAccount = resolved;
      setActiveAccount(resolved);
    } catch {
      if (isStale()) return;
      // Keep the last-known values rather than blanking the indicator on a
      // transient fetch error.
      setAccounts(cachedAccounts);
      setActiveAccount(cachedActiveAccount);
    }
  }, [projectPath]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: fetch the workspace on mount / when projectPath changes
    void refresh();
    // Re-fetch whenever a workspace is created/renamed/deleted/switched so the
    // indicator never goes stale (e.g. the footer switcher appearing the moment
    // a second workspace exists). Also re-fetch when the window regains focus
    // or visibility, as a safety net for any change made out of band (another
    // window, a prior session) that didn't fire the in-app event.
    const onAccountsChanged = () => void refresh();
    window.addEventListener(ACCOUNTS_CHANGED_EVENT, onAccountsChanged);
    window.addEventListener('focus', onAccountsChanged);
    document.addEventListener('visibilitychange', onAccountsChanged);
    return () => {
      window.removeEventListener(ACCOUNTS_CHANGED_EVENT, onAccountsChanged);
      window.removeEventListener('focus', onAccountsChanged);
      document.removeEventListener('visibilitychange', onAccountsChanged);
    };
  }, [refresh]);

  return { activeAccount, accounts, refresh };
}
