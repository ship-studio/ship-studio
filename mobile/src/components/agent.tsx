/**
 * An agent's badge and its status mark, drawn as the desktop sidebar draws
 * them: initials on a tile tinted with the agent's colour; one mark for
 * needs-you (amber), working (a spinner), didn't finish (red), usage limit
 * (amber) or unread (green).
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { distinctInitials, failedTurn, needsYou, teamNames, waitingForSlot } from '../lib/agents';
import { useApp } from '../lib/store';
import { agentTints, colors, fonts, mix, radius } from '../lib/theme';
import { Dot, T } from './ui';

/** A string snapshot, so a streaming reply never re-renders a badge. */
const useTeamNames = () =>
  useApp((s) => (s.overview ? teamNames(s.overview.agents).join('\n') : ''));

export function AgentAvatar({
  name,
  color,
  size = 36,
}: {
  name: string;
  color: string;
  size?: number;
}) {
  const names = useTeamNames();
  const tint = agentTints[color] ?? colors.textMuted;
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size > 40 ? radius.lg : radius.card,
          // color-mix(tint 24%, --surface-control) / color-mix(tint 70%, --text-primary)
          backgroundColor: mix(tint, colors.surfaceControl, 0.24),
        },
      ]}
      accessible={false}
    >
      <T
        // Sized to the tile, not to Dynamic Type: the tile doesn't grow, so the
        // letters can't either (they were clipped out of it at AX sizes).
        allowFontScaling={false}
        style={{
          fontFamily: fonts.semibold,
          fontSize: Math.round(size * 0.36),
          lineHeight: Math.round(size * 0.48),
          textAlign: 'center',
          includeFontPadding: false,
        }}
        color={mix(tint, colors.textPrimary, 0.7)}
      >
        {distinctInitials(name, names ? names.split('\n') : [])}
      </T>
    </View>
  );
}

/**
 * `live` false: the Mac isn't answering, so this is only the last thing it
 * said. Marks go grey and nothing turns: a spinner would claim work we can't
 * see.
 */
export function StatusMark({ agent, live = true }: { agent: Agent; live?: boolean }) {
  const failure = failedTurn(agent);
  if (!live) {
    if (agent.status.state === 'working') return <View style={styles.wasWorking} />;
    if (needsYou(agent) || failure || agent.unread > 0) return <Dot color={colors.textMuted} />;
    return null;
  }
  if (needsYou(agent)) return <Dot color={colors.accentWarning} glow />;
  // Queued for a slot: a still ring, since nothing is running yet.
  if (waitingForSlot(agent)) {
    return (
      <View
        accessibilityLabel="Waiting for a free slot"
        style={[styles.wasWorking, styles.queued]}
      />
    );
  }
  if (agent.status.state === 'working') return <Spinner />;
  if (failure) {
    return (
      <Dot color={failure.kind === 'usage_limit' ? colors.accentWarning : colors.accentError} />
    );
  }
  if (agent.unread > 0) return <Dot color={colors.accentActive} />;
  return null;
}

/** A small arc that turns: the working state, quiet enough to sit in a list. */
export function Spinner({
  size = 12,
  color = colors.textSecondary,
}: {
  size?: number;
  color?: string;
}) {
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.set(withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1));
    return () => cancelAnimation(turn);
  }, [turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <Animated.View
      accessibilityLabel="Working"
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: colors.surfaceSelected,
          borderTopColor: color,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  // A still ring: "it was working when we last heard".
  wasWorking: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
  },
  queued: { borderColor: colors.textSecondary, borderStyle: 'dashed' },
});
