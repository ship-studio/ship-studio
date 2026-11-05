/**
 * The connection's voice on the screens: nothing while all is well, a pill
 * or a slim banner when something isn't, and always a tap away from the full
 * picture on the Connection screen.
 */

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';
import { pill } from '../lib/connection';
import { useApp } from '../lib/store';
import { chromeScale, colors, radius, space } from '../lib/theme';
import { Dot, T, toneColor } from './ui';

/** Re-render every `ms` while mounted, for "last seen 2 min ago". */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Everything `pill` and `layers` read, from the store. */
export function useLinkState() {
  return useApp(
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
}

function ConnectionPill() {
  const router = useRouter();
  const p = pill(useLinkState(), useNow());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${p.label}. Connection details`}
      hitSlop={8}
      onPress={() => router.push('/connection')}
    >
      <Animated.View layout={LinearTransition.duration(200)} style={styles.pill}>
        <Dot color={toneColor[p.tone]} size={7} glow={p.tone === 'ok'} />
        <Animated.View
          key={p.label}
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(120)}
        >
          <T
            variant="small"
            color={colors.textPrimary}
            numberOfLines={1}
            maxFontSizeMultiplier={chromeScale}
          >
            {p.label}
          </T>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

/** Only when something is wrong: the state, and a tap to the reasons. */
export function ConnectionNotice() {
  const state = useLinkState();
  const p = pill(state, useNow());
  if (p.tone === 'ok' || state.link.kind === 'refused') return null;
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={styles.notice}
    >
      <ConnectionPill />
    </Animated.View>
  );
}

/** In a chat, only when something is wrong: a slim line under the header. */
export function LinkBanner() {
  const router = useRouter();
  const state = useLinkState();
  const now = useNow(10_000);
  if (state.link.kind === 'connected') return null;
  const p = pill(state, now);
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)}>
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Connection details"
        onPress={() => router.push('/connection')}
        style={styles.banner}
      >
        <T
          variant="caption"
          color={p.tone === 'problem' ? colors.accentErrorLight : colors.accentWarning}
          maxFontSizeMultiplier={chromeScale}
        >
          {p.label} · saved messages shown
        </T>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  notice: { paddingHorizontal: space.lg, paddingBottom: space.sm, alignItems: 'flex-start' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    paddingHorizontal: space.md,
    paddingVertical: space.tight,
    minHeight: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    maxWidth: 320,
  },
  banner: {
    paddingHorizontal: space.lg,
    paddingVertical: space.tight,
    backgroundColor: colors.surfacePanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
});
