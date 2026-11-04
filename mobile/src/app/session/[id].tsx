/**
 * A project session, read-only: what Remote Access reads off its screen
 * (the state, a question waiting with its options) and the transcript
 * itself, refreshed while you watch. Answering and typing stay at the Mac.
 */

import type { SessionScreen } from '@shipstudio/companion-protocol';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Spinner } from '../../components/agent';
import { useNow } from '../../components/ConnectionPill';
import { SessionState, tabName } from '../../components/session';
import { T } from '../../components/ui';
import { formatAgo } from '../../lib/agents';
import { describeError, readSession } from '../../lib/session';
import { usePolling } from '../../lib/usePolling';
import { alpha, colors, fonts, radius, space } from '../../lib/theme';

export default function Session() {
  const { id, project, tab, reply } = useLocalSearchParams<{
    id: string;
    project?: string;
    tab?: string;
    reply?: string;
  }>();
  const now = useNow(10_000);
  const [data, setData] = useState<SessionScreen | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const pinned = useRef(true);

  const load = useCallback(
    () =>
      readSession(id).then(
        (s) => {
          setData(s);
          setGone(null);
        },
        (e: unknown) => setGone(describeError(e))
      ),
    [id]
  );
  usePolling(load, 2500);

  const title = [project, data ? tabName(data.session) : tab].filter(Boolean).join(' · ');
  const question = data?.session.question;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.header}>
              <T variant="subhead" color={colors.textWhite} numberOfLines={1}>
                {title || 'Session'}
              </T>
              <T variant="caption" color={colors.textMuted}>
                Read-only ·{' '}
                {data ? `output ${formatAgo(data.session.lastOutputAt, now)}` : 'loading'}
              </T>
            </View>
          ),
        }}
      />
      {!data && !gone ? (
        <View style={styles.center}>
          <Spinner size={16} />
        </View>
      ) : (
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.content}
          onContentSizeChange={() =>
            pinned.current && scroll.current?.scrollToEnd({ animated: false })
          }
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            pinned.current = contentOffset.y + layoutMeasurement.height > contentSize.height - 40;
          }}
          scrollEventThrottle={100}
        >
          {gone && (
            <Animated.View entering={FadeIn} style={styles.card}>
              <T variant="subhead" color={colors.textWhite}>
                This session isn’t open on your Mac any more
              </T>
              <T variant="small" color={colors.textSecondary}>
                {gone}
              </T>
              {!!reply && (
                <T color={colors.textPrimary} selectable style={{ marginTop: space.sm }}>
                  {reply}
                </T>
              )}
            </Animated.View>
          )}
          {data && (
            <>
              {!question && (
                <View style={styles.state}>
                  <SessionState session={data.session} />
                </View>
              )}
              {question && (
                <Animated.View entering={FadeIn} style={[styles.card, styles.asking]}>
                  <T variant="subhead" color={colors.textWhite}>
                    {question.question}
                  </T>
                  {!!question.action && (
                    <T variant="mono" color={colors.textPrimary}>
                      {question.action}
                    </T>
                  )}
                  <View style={{ gap: space.xs }}>
                    {question.options.map((o) => (
                      <T
                        key={o.key}
                        variant="small"
                        color={o.highlighted ? colors.textWhite : colors.textSecondary}
                      >
                        {o.highlighted ? '❯ ' : '   '}
                        {o.key}. {o.label}
                      </T>
                    ))}
                  </View>
                  <T variant="caption" color={colors.textMuted}>
                    Answer it in Ship Studio on your Mac.
                  </T>
                </Animated.View>
              )}
              <T selectable style={styles.screen} color={colors.textPrimary}>
                {textGlyphs(data.screen.replace(/\s+$/, ''))}
              </T>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

/** Claude Code's ⏺ and friends, as text: iOS would otherwise draw them as emoji. */
const textGlyphs = (screen: string) => screen.replace(/([⏺⏸⏹✻✳])(?!\uFE0E)/g, '$1\uFE0E');

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', maxWidth: 260 },
  content: { padding: space.lg, gap: space.md, paddingBottom: space['2xl'] },
  state: { paddingVertical: space.xs },
  card: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  asking: { borderColor: alpha(colors.accentWarning, 0.45) },
  screen: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    overflow: 'hidden',
  },
});
