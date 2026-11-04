/**
 * The message field. While the agent works, an empty field offers Stop; with
 * text, Send queues it for the next turn and holding Send interrupts and
 * sends now (the desktop's ↵ and ⌘↵). Offline, what you typed stays here
 * until you send it yourself: a message arriving hours later is worse than
 * one that waits.
 */

import type { Agent } from '@shipstudio/companion-protocol';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { describeError, send, stop } from '../lib/session';
import { colors, fonts, lineHeight, radius, space, type } from '../lib/theme';
import { Icon, T } from './ui';

export function Composer({
  agent,
  connected,
  onError,
  onSent,
}: {
  agent: Agent;
  connected: boolean;
  onError: (text: string) => void;
  onSent: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const working = agent.status.state !== 'idle';
  const canSend = text.trim().length > 0 && connected;

  const submit = (now: boolean) => {
    const body = text.trim();
    if (!body || !connected) return;
    void Haptics.impactAsync(
      now ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light
    );
    setText('');
    onSent();
    send(agent.id, body, now).catch((error: unknown) => onError(describeError(error)));
  };

  const hint = !connected
    ? 'Not connected · what you type stays here'
    : working && text.trim()
      ? `Sends when ${agent.name} finishes · hold to interrupt and send now`
      : null;

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      {hint && (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(100)}>
          <T variant="caption" color={colors.textMuted} style={styles.hint}>
            {hint}
          </T>
        </Animated.View>
      )}
      <View style={styles.field}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={`Message ${agent.name}`}
          placeholderTextColor={colors.textMuted}
          multiline
          style={styles.input}
          selectionColor={colors.accentActive}
          keyboardAppearance="dark"
          accessibilityLabel={`Message ${agent.name}`}
        />
        {working && !text.trim() ? (
          <Animated.View entering={ZoomIn.duration(160)} key="stop">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Stop ${agent.name}`}
              disabled={!connected}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                stop(agent.id).catch((error: unknown) => onError(describeError(error)));
              }}
              style={({ pressed }) => [styles.round, styles.stop, pressed && { opacity: 0.7 }]}
            >
              <View style={styles.stopSquare} />
            </Pressable>
          </Animated.View>
        ) : (
          <Animated.View entering={ZoomIn.duration(160)} key="send">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                working ? 'Send after this turn. Hold to interrupt and send now' : 'Send'
              }
              disabled={!canSend}
              onPress={() => submit(false)}
              onLongPress={working ? () => submit(true) : undefined}
              delayLongPress={350}
              style={({ pressed }) => [
                styles.round,
                { backgroundColor: canSend ? colors.accentActive : colors.surfaceSelected },
                pressed && { transform: [{ scale: 0.92 }] },
              ]}
            >
              <Icon
                name="arrow.up"
                size={16}
                color={canSend ? colors.textOnAccent : colors.textMuted}
                fallback={<T color={canSend ? colors.textOnAccent : colors.textMuted}>↑</T>}
              />
            </Pressable>
          </Animated.View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: colors.surfaceApp,
    gap: space.tight,
  },
  hint: { marginLeft: space.md },
  field: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.lg + 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingLeft: space.lg,
    paddingRight: space.tight,
    paddingVertical: space.tight,
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textPrimary,
    maxHeight: lineHeight(type.body, 1.35) * 6 + space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  round: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stop: { backgroundColor: colors.surfaceSelected },
  stopSquare: { width: 11, height: 11, borderRadius: 2, backgroundColor: colors.textPrimary },
});
