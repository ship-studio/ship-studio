/**
 * Run `fn` now and every `intervalMs` while the screen is focused, the app
 * is in front and the Mac is connected; never two at once. Live views (a
 * session's screen, the project list) refresh this way rather than by event.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useApp } from './store';

export function usePolling(fn: () => Promise<unknown>, intervalMs: number) {
  const connected = useApp((s) => s.link.kind === 'connected');
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  }, [fn]);
  useFocusEffect(
    useCallback(() => {
      if (!connected) return;
      let running = false;
      const tick = () => {
        if (running || AppState.currentState !== 'active') return;
        running = true;
        void latest.current().finally(() => (running = false));
      };
      tick();
      const id = setInterval(tick, intervalMs);
      return () => clearInterval(id);
    }, [connected, intervalMs])
  );
}
