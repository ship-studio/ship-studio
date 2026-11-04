/**
 * An agent on the home list. Tap opens the chat. Hold for the native
 * context menu on iOS (Pin, Mark as Unread, Mute, Hide), or a sheet on
 * Android and in the iPad split. Swipe left for Mute and Hide, with Undo;
 * swipe right to pin.
 *
 * While the Mac can't be reached the row says only what was last known:
 * status marks go grey and stop moving (`live` false).
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { Link, type Href } from 'expo-router';
import { memo, useRef } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { agentActions, type AgentAction, type AgentCaps } from '../lib/actions';
import { formatAgo, lineState, needsLine, needsYou, subtitle } from '../lib/agents';
import { useApp } from '../lib/store';
import { haptic } from '../lib/haptics';
import { chromeScale, colors, radius, space } from '../lib/theme';
import { AgentAvatar, StatusMark } from './agent';
import { showActions } from './menu';
import { Icon, ripple, T } from './ui';

const lineColor = {
  waiting: colors.accentWarning,
  failed: colors.accentErrorLight,
  working: colors.textSecondary,
  limited: colors.textSecondary,
} as const;

/** How far a row's words follow Dynamic Type: past this they'd outgrow the title above them. */
const NAME_SCALE = 2;

/** iOS 18+: the system's own context menu and preview (expo-router's Link.Menu). */
const NATIVE_MENU = Platform.OS === 'ios';
const ACTION_W = 76;

export const AgentRow = memo(function AgentRow({
  agent,
  caps,
  live,
  selected,
  onPress,
  onAction,
}: {
  agent: Agent;
  caps: AgentCaps;
  /** Connected: what the row shows is current. */
  live: boolean;
  /** The chat open beside the list (iPad). */
  selected?: boolean;
  /** Given in the iPad split: open beside the list instead of pushing. */
  onPress?: () => void;
  onAction: (agent: Agent, action: AgentAction) => void;
}) {
  const swipe = useRef<SwipeableMethods>(null);
  const actions = agentActions(agent, caps);
  const canToggle = live && caps.update;
  const href: Href = { pathname: '/chat/[id]', params: { id: agent.id } };

  const body = (
    <RowBody
      agent={agent}
      live={live}
      selected={selected}
      onPress={onPress}
      onLongPress={
        NATIVE_MENU && !onPress
          ? undefined
          : () => {
              haptic.select();
              showActions(agent.name, live ? actions : [], (id) => onAction(agent, id));
            }
      }
    />
  );

  const row =
    NATIVE_MENU && !onPress ? (
      <Link href={href} asChild>
        <Link.Trigger>{body}</Link.Trigger>
        {live && actions.length > 0 && (
          <Link.Menu>
            {actions.map((a) => (
              <Link.MenuAction
                key={a.id}
                icon={a.icon}
                destructive={a.destructive}
                onPress={() => onAction(agent, a.id)}
              >
                {a.title}
              </Link.MenuAction>
            ))}
          </Link.Menu>
        )}
      </Link>
    ) : (
      body
    );

  if (!canToggle) return row;
  const act = (id: AgentAction) => {
    swipe.current?.close();
    onAction(agent, id);
  };
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      overshootFriction={8}
      rightThreshold={ACTION_W / 2}
      leftThreshold={ACTION_W / 2}
      onSwipeableWillOpen={() => haptic.select()}
      renderLeftActions={(progress) => (
        <SwipeAction
          progress={progress}
          side="left"
          icon={agent.pinned ? 'pin.slash' : 'pin.fill'}
          label={agent.pinned ? 'Unpin' : 'Pin'}
          color={colors.surfaceSelected}
          onPress={() => act(agent.pinned ? 'unpin' : 'pin')}
        />
      )}
      renderRightActions={(progress) => (
        <View style={styles.actions}>
          <SwipeAction
            progress={progress}
            side="right"
            icon={agent.muted ? 'bell' : 'bell.slash'}
            label={agent.muted ? 'Unmute' : 'Mute'}
            color={colors.surfaceSelected}
            onPress={() => act(agent.muted ? 'unmute' : 'mute')}
          />
          {!agent.isMain && (
            <SwipeAction
              progress={progress}
              side="right"
              icon={agent.hidden ? 'eye' : 'eye.slash'}
              label={agent.hidden ? 'Unhide' : 'Hide'}
              color={colors.accentError}
              onPress={() => act(agent.hidden ? 'unhide' : 'hide')}
            />
          )}
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  );
});

function SwipeAction({
  progress,
  side,
  icon,
  label,
  color,
  onPress,
}: {
  progress: SharedValue<number>;
  side: 'left' | 'right';
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  color: string;
  onPress: () => void;
}) {
  // Nothing is drawn while closed: the row lifts out for its context menu,
  // and these mustn't show through the gap it leaves.
  const fill = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.05], [0, 1], 'clamp'),
  }));
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.6, 1], [0, 0.6, 1]),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.8, 1], 'clamp') }],
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.action}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: color },
          side === 'left' && styles.actionLeft,
          fill,
        ]}
      />
      <Animated.View style={[styles.actionInner, style]}>
        <Icon name={icon} size={18} color={colors.textWhite} />
        <T variant="caption" color={colors.textWhite} maxFontSizeMultiplier={chromeScale}>
          {label}
        </T>
      </Animated.View>
    </Pressable>
  );
}

function RowBody({
  agent,
  live,
  selected,
  onPress,
  onLongPress,
  ...trigger
}: {
  agent: Agent;
  live: boolean;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  // At the largest sizes the time moves under the subtitle so the name keeps its room.
  const stacked = fontScale >= 1.6;
  const state = lineState(agent);
  // Waiting on you: say what for, when the saved chat knows.
  const line = useApp((s) =>
    needsYou(agent) ? needsLine(agent, s.chats[agent.id]?.messages) : subtitle(agent)
  );
  const time = (
    <T
      variant="caption"
      color={colors.textSecondary}
      numberOfLines={1}
      maxFontSizeMultiplier={chromeScale}
      style={styles.time}
    >
      {formatAgo(agent.lastActivityAt)}
    </T>
  );
  return (
    <Pressable
      // Link.Trigger hands its own onPress in through these props.
      {...trigger}
      onPress={onPress ?? (trigger as { onPress?: () => void }).onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.row,
        selected && styles.selected,
        pressed && Platform.OS === 'ios' && { backgroundColor: colors.surfacePanel },
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={`${agent.name}. ${line}${agent.unread ? '. Unread' : ''}${
        live ? '' : '. Last known'
      }`}
      accessibilityHint="Hold for Pin, Mute and Hide"
    >
      <AgentAvatar name={agent.name} color={agent.color} size={44} />
      <View style={styles.text}>
        <View style={styles.nameLine}>
          <T
            variant="subhead"
            color={colors.textWhite}
            numberOfLines={1}
            // Names stop growing at twice the size, under Home's large title.
            maxFontSizeMultiplier={NAME_SCALE}
            style={styles.name}
          >
            {agent.name}
          </T>
          {agent.pinned && <Icon name="pin.fill" size={10} color={colors.textMuted} />}
          {agent.muted && <Icon name="bell.slash.fill" size={10} color={colors.textMuted} />}
          {!stacked && time}
        </View>
        <View style={styles.nameLine}>
          <T
            variant="small"
            numberOfLines={stacked ? 3 : 1}
            maxFontSizeMultiplier={NAME_SCALE}
            color={state && live ? lineColor[state] : colors.textSecondary}
            style={{ flex: 1 }}
          >
            {line}
          </T>
          <View style={styles.mark}>
            <StatusMark agent={agent} live={live} />
          </View>
        </View>
        {stacked && time}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 68,
    backgroundColor: colors.surfaceApp,
  },
  selected: { backgroundColor: colors.surfaceControl },
  text: { flex: 1, gap: space['2xs'] },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  // The name wins the line: it shrinks last, and the time never takes more than it needs.
  name: { flexShrink: 1, flexGrow: 1 },
  time: { flexShrink: 0, marginLeft: space.sm },
  mark: { width: 14, alignItems: 'flex-end' },
  actions: { flexDirection: 'row' },
  action: { width: ACTION_W, alignItems: 'center', justifyContent: 'center' },
  actionLeft: { borderTopRightRadius: radius.card, borderBottomRightRadius: radius.card },
  actionInner: { alignItems: 'center', gap: space.xs },
});
