import { useCallback, useEffect, useState } from 'react';

import {
  COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT,
  getCompactWorkspaceToolbarEnabled,
  setCompactWorkspaceToolbarEnabled,
} from '../lib/settings';

/**
 * Mirrors the persisted "compact workspace toolbar" setting into React state.
 *
 * The setting can also be flipped from outside this tree (settings modal,
 * command palette), which broadcasts COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT —
 * hence the window listener alongside the initial load.
 */
export function useCompactWorkspaceToolbar(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getCompactWorkspaceToolbarEnabled().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    const handleChanged = (event: Event) => {
      setEnabled((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT, handleChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT, handleChanged);
    };
  }, []);

  const update = useCallback((value: boolean) => {
    setEnabled(value);
    void setCompactWorkspaceToolbarEnabled(value);
  }, []);

  return [enabled, update];
}
