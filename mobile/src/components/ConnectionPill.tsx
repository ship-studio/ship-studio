/**
 * The header's connection pill: always there, quiet when all is well, and a
 * tap away from the full picture on the Connection screen.
 */

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { pill } from '../lib/connection';
import { useApp } from '../lib/store';
import { colors, radius, space } from '../lib/theme';
import { Dot, T, tap, toneColor } from './ui';
import { useShallow } from 'zustand/react/shallow';

/** Re-render every `ms` while mounted, for "last seen 2 min ago". */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function ConnectionPill() {
  const router = useRouter();
  const now = useNow();
  const state = useApp(
    useShallow((s) => ({
      link: s.link,
      refusal: s.refusal,
      mac: s.mac,
      overview: s.overview,
      phoneOnline: s.phoneOnline,
      syncedAt: s.syncedAt,
      credentials: s.credentials,
    }))
  );
  const p = pill(state, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${p.label}. Connection details`}
      hitSlop={6}
      onPress={() => {
        tap();
        router.push('/connection');
      }}
    >
      <Animated.View layout={LinearTransition.duration(200)} style={styles.pill}>
        <Dot color={toneColor[p.tone]} size={7} glow={p.tone === 'ok'} />
        <Animated.View
          key={p.label}
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(120)}
        >
          <T variant="caption" color={colors.textSecondary} numberOfLines={1}>
            {p.label}
          </T>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    paddingHorizontal: space.md,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    maxWidth: 260,
  },
});
