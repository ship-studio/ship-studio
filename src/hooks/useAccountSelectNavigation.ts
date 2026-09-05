/**
 * Opening the workspace switcher is a detour, not a destination: remember
 * which screen it was opened from so Back / Esc can return there without
 * switching anything.
 *
 * @module hooks/useAccountSelectNavigation
 */

import { useCallback, useMemo, useRef } from 'react';
import type { AppView } from '../lib/types';

/** Screens the switcher can return to; anything else falls back to Home. */
const RETURNABLE: ReadonlySet<AppView> = new Set<AppView>(['workspace', 'workflows', 'inbox']);

interface AccountSelectNavigation {
  /** Show the switcher, remembering `view` as the place to come back to. */
  openAccountSelect: () => void;
  /** Props for `<AccountSelectScreen>`: continue to Home after a switch, or go back. */
  accountSelectProps: { onContinue: () => void; onBack: () => void };
}

export function useAccountSelectNavigation(
  view: AppView,
  setView: (view: AppView) => void
): AccountSelectNavigation {
  const returnViewRef = useRef<AppView>('projects');

  const openAccountSelect = useCallback(() => {
    returnViewRef.current = RETURNABLE.has(view) ? view : 'projects';
    setView('account-select');
  }, [view, setView]);

  const accountSelectProps = useMemo(
    () => ({
      onContinue: () => setView('projects'),
      onBack: () => setView(returnViewRef.current),
    }),
    [setView]
  );

  return { openAccountSelect, accountSelectProps };
}
