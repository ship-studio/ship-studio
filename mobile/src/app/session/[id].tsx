/**
 * A project session: what Remote Access reads off its screen (the state, a
 * question waiting with its options) and the transcript itself, refreshed
 * while you watch. Answer a question with its options, or type to the
 * agent; both go through Remote Access's own rules on the Mac (agent tabs
 * only, never typing into a tab that's showing a question).
 */

import type { SessionScreen } from '@shipstudio/companion-protocol';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../../components/agent';
import { DiffLines } from '../../components/diff';
import { useNow } from '../../components/ConnectionPill';
import { SessionState, tabName } from '../../components/session';
import { Button, Icon, ripple, T } from '../../components/ui';
import { formatAgo } from '../../lib/agents';
import { questionContext } from '../../lib/diff';
import { haptic } from '../../lib/haptics';
import {
  canCall,
  describeError,
  pressSessionKey,
  readSession,
  sendToSession,
} from '../../lib/session';
import { useApp } from '../../lib/store';
import { usePolling } from '../../lib/usePolling';
import {
  alpha,
  chromeScale,
  colors,
  fonts,
  lineHeight,
  radius,
  space,
  type,
} from '../../lib/theme';

export default function Session() {
  const { id, project, path, tab, reply } = useLocalSearchParams<{
    id: string;
    project?: string;
    path?: string;
    tab?: string;
    reply?: string;
  }>();
  const now = useNow(10_000);
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<SessionScreen | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = useApp((s) => s.link.kind === 'connected');
  const canAnswer = useApp((s) => canCall('sessions.key', s.welcome));
  // The project's path, from the list when we came from a chat's session card.
  const projectPath = useApp(
    (s) =>
      path ?? s.projects?.find((p) => p.sessions.some((x) => x.sessionId === id))?.path ?? undefined
  );
  const canType = useApp((s) => canCall('sessions.send', s.welcome)) && !!projectPath;
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

  const fail = (e: unknown) => {
    haptic.error();
    setError(describeError(e));
  };

  const answer = (key: string) => {
    setBusy(key);
    setError(null);
    pressSessionKey(id, key)
      .then(() => {
        haptic.success();
        return load();
      }, fail)
      .finally(() => setBusy(null));
  };

  const submit = () => {
    const body = text.trim();
    if (!body || !projectPath) return;
    setBusy('send');
    setError(null);
    haptic.light();
    sendToSession(projectPath, id, body)
      .then(() => {
        setText('');
        pinned.current = true;
        return load();
      }, fail)
      .finally(() => setBusy(null));
  };

  const title = [project, data ? tabName(data.session) : tab].filter(Boolean).join(' · ');
  const question = data?.session.question;
  // What it's asking about (an edit's diff, a command), read off its screen.
  const context = question && data ? questionContext(data.screen, question) : [];

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.header}>
              <T variant="subhead" color={colors.textWhite} numberOfLines={1}>
                {title || 'Session'}
              </T>
              <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={chromeScale}>
                {data ? `Output ${formatAgo(data.session.lastOutputAt, now)}` : 'Loading…'}
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
          contentContainerStyle={[styles.content, canType && { paddingBottom: 120 }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
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
                  {context.length > 0 && (
                    <DiffLines lines={context} label="What it’s asking to do" />
                  )}
                  {canAnswer ? (
                    <View style={{ gap: space.sm }}>
                      {question.options.map((o) => (
                        <Button
                          key={o.key}
                          title={o.key === 'enter' ? o.label : `${o.key}. ${o.label}`}
                          variant={o.highlighted ? 'primary' : 'secondary'}
                          lines={4}
                          busy={busy === o.key}
                          disabled={!connected || !!busy}
                          onPress={() => answer(o.key)}
                          style={styles.option}
                        />
                      ))}
                      <Button
                        title="Cancel (Esc)"
                        variant="ghost"
                        busy={busy === 'escape'}
                        disabled={!connected || !!busy}
                        onPress={() => answer('escape')}
                      />
                    </View>
                  ) : (
                    <>
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
                      <T variant="caption" color={colors.textSecondary}>
                        Answer it in Ship Studio on your Mac.
                      </T>
                    </>
                  )}
                </Animated.View>
              )}
              <T selectable style={styles.screen} color={colors.textPrimary}>
                {textGlyphs(data.screen.replace(/\s+$/, ''))}
              </T>
            </>
          )}
        </ScrollView>
      )}
      {error && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
          style={[styles.toast, { bottom: (canType ? 88 : space.lg) + insets.bottom }]}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textWhite} style={{ flex: 1 }}>
            {error}
          </T>
          <Pressable accessibilityLabel="Dismiss" hitSlop={14} onPress={() => setError(null)}>
            <Icon name="xmark" size={12} color={colors.textSecondary} fallback={<T>×</T>} />
          </Pressable>
        </Animated.View>
      )}
      {canType && data && !gone && (
        <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.composerWrap}>
          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
            <View style={styles.field}>
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                editable={!question}
                placeholder={
                  question ? 'Answer the question above first' : `Message ${tabName(data.session)}`
                }
                placeholderTextColor={colors.textMuted}
                keyboardAppearance="dark"
                selectionColor={colors.accentActive}
                style={styles.input}
                accessibilityLabel={`Message ${tabName(data.session)}`}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                disabled={!text.trim() || !!busy || !connected || !!question}
                onPress={submit}
                android_ripple={{ ...ripple, borderless: true }}
                style={styles.hit}
              >
                {({ pressed }) => (
                  <View
                    style={[
                      styles.send,
                      (!text.trim() || !connected || !!question) && styles.sendOff,
                      pressed && { transform: [{ scale: 0.92 }] },
                    ]}
                  >
                    {busy === 'send' ? (
                      <Spinner size={12} color={colors.textOnAccent} />
                    ) : (
                      <Icon
                        name="arrow.up"
                        size={16}
                        color={
                          text.trim() && connected && !question
                            ? colors.textOnAccent
                            : colors.textMuted
                        }
                      />
                    )}
                  </View>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardStickyView>
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
  option: { justifyContent: 'flex-start' },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSelected,
  },
  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  composer: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: colors.surfaceApp,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.lg + 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingLeft: space.lg,
    paddingRight: space['2xs'],
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textPrimary,
    maxHeight: lineHeight(type.body, 1.35) * 5 + space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentActive,
  },
  sendOff: { backgroundColor: colors.surfaceSelected },
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
