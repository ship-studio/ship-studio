/**
 * StaleEnvBanner — a non-destructive notice shown above a project's terminal
 * when its workspace login changed *after* the terminal started.
 *
 * A PTY captures the workspace's login env once, at spawn (see `pty/spawn.rs`);
 * there's no way to re-inject `CLAUDE_CODE_OAUTH_TOKEN` / `VERCEL_TOKEN` /
 * `GH_CONFIG_DIR` into a live process. So when a connect/disconnect fires
 * {@link ACCOUNT_CREDENTIALS_CHANGED_EVENT} for the workspace this project
 * belongs to, we flag its running tabs (see {@link sessionRegistry.markProjectTabsStale})
 * and surface this banner. Restarting a tab re-reads the fresh env and clears
 * the flag automatically; "Dismiss" just hides the notice.
 *
 * @module components/terminal/StaleEnvBanner
 */

import { useEffect, useSyncExternalStore } from 'react';
import { WarningIcon } from '../icons';
import { Button } from '../primitives/Button';
import { sessionRegistry } from '../../lib/sessionRegistry';
import {
  ACCOUNT_CREDENTIALS_CHANGED_EVENT,
  getProjectAccountId,
  type AccountCredentialsChangedDetail,
} from '../../lib/accounts';
import '../../styles/features/stale-env-banner.css';

export function StaleEnvBanner({ projectPath }: { projectPath: string }) {
  // Re-render whenever the registry changes; staleness is derived live.
  useSyncExternalStore(sessionRegistry.subscribeSimple, () => sessionRegistry.getVersion());
  const isStale = sessionRegistry.hasStaleTabs(projectPath);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const changedAccountId = (event as CustomEvent<AccountCredentialsChangedDetail>).detail
        ?.accountId;
      // Only flag this project if it actually belongs to the workspace whose
      // login changed — otherwise editing one client's token would needlessly
      // pester every open project. Best-effort: if we can't resolve the mapping,
      // err toward showing the banner (non-destructive).
      void (async () => {
        try {
          const projectAccountId = await getProjectAccountId(projectPath);
          if (!changedAccountId || projectAccountId === changedAccountId) {
            sessionRegistry.markProjectTabsStale(projectPath);
          }
        } catch {
          sessionRegistry.markProjectTabsStale(projectPath);
        }
      })();
    };
    window.addEventListener(ACCOUNT_CREDENTIALS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ACCOUNT_CREDENTIALS_CHANGED_EVENT, onChanged);
  }, [projectPath]);

  if (!isStale) return null;

  return (
    <div className="stale-env-banner" role="status">
      <WarningIcon size={14} className="stale-env-banner-icon" />
      <span className="stale-env-banner-text">
        This workspace’s login changed. Open agent terminals keep the previous login until you
        restart them.
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => sessionRegistry.clearProjectStaleEnv(projectPath)}
      >
        Dismiss
      </Button>
    </div>
  );
}
