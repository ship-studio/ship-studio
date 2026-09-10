/**
 * Whether this window is the one the user is actually looking at.
 *
 * The gate for background polling. Harbr is a multi-window app and
 * projects are commonly left open for days, so a poll that doesn't ask this
 * question keeps running in windows nobody can see — spawning processes and
 * reaching the network on a timer to produce pixels nobody is looking at.
 *
 * Both halves are needed. `document.hasFocus()` alone says nothing about a
 * window that is minimised or on another Space; `visibilityState` alone says
 * nothing about a visible window sitting behind another one.
 *
 * Pair it with `usePolling({ enabled })`. The poller fires immediately on
 * start, so a window that regains focus refreshes at once rather than showing
 * whatever it had when it lost focus.
 *
 * @module hooks/useWindowFocused
 */

import { useEffect, useState } from 'react';

export function isWindowFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(isWindowFocused);

  useEffect(() => {
    const update = () => setFocused(isWindowFocused());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    // The state can have moved between the initial render and this effect.
    update();
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  return focused;
}
