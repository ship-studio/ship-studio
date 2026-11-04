/**
 * One conversation. An inverted list, so the newest line sits on the
 * composer and a growing draft pushes upward like the desktop's; scrolling
 * to the top pages in older messages; a button brings you back down.
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View, type ScrollViewProps } from 'react-native';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  ZoomIn,
  ZoomOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { AgentAvatar, Spinner } from '../../components/agent';
import { DraftRow, MessageRow, PendingRow, WorkingRow } from '../../components/chat';
import { Composer } from '../../components/Composer';
import { useNow } from '../../components/ConnectionPill';
import { Icon, IconButton, T, tap } from '../../components/ui';
import { isQueued, needsYou } from '../../lib/agents';
import { pill } from '../../lib/connection';
import { describeError, loadLatest, loadOlder, loadUntil, setOpenChat } from '../../lib/session';
import { useApp } from '../../lib/store';
import type { PendingSend } from '../../lib/sync';
import { alpha, colors, radius, space } from '../../lib/theme';
import { useShallow } from 'zustand/react/shallow';

type Item =
  | { kind: 'message'; key: string; message: AgentMessage }
  | { kind: 'pending'; key: string; pending: PendingSend }
  | { kind: 'draft'; key: string; text: string }
  | { kind: 'working'; key: string; label: string };

const NONE: never[] = [];

export default function Chat() {
  const { id, at } = useLocalSearchParams<{ id: string; at?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const chat = useApp((s) => s.chats[id]);
  const draft = useApp((s) => s.drafts[id]);
  const pending = useApp((s) => s.pending[id] ?? NONE);
  const connected = useApp((s) => s.link.kind === 'connected');
  const list = useRef<FlatList<Item>>(null);
  const [away, setAway] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // A search hit to land on: paged in, scrolled to, and lit up once.
  const [target, setTarget] = useState<string | null>(null);

  // On screen: the Mac clears its unread and holds this agent's alerts.
  useFocusEffect(
    useCallback(() => {
      setOpenChat(id);
      return () => setOpenChat(null);
    }, [id])
  );

  const showError = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 4000);
  }, []);

  // First open, or after a snapshot made the cached copy stale.
  useEffect(() => {
    if (connected && !chat?.loaded)
      loadLatest(id).catch((e: unknown) => showError(describeError(e)));
  }, [connected, chat?.loaded, id, showError]);

  const items = useMemo<Item[]>(() => {
    if (!agent) return [];
    const out: Item[] = [];
    // Inverted: newest first.
    const working = agent.status.state === 'working';
    if (draft) out.push({ kind: 'draft', key: draft.id, text: draft.text });
    else if (working)
      out.push({ kind: 'working', key: 'working', label: agent.status.activity ?? 'Working…' });
    for (let i = pending.length - 1; i >= 0; i--) {
      out.push({ kind: 'pending', key: `pending:${pending[i].clientId}`, pending: pending[i] });
    }
    const messages = chat?.messages ?? NONE;
    for (let i = messages.length - 1; i >= 0; i--) {
      // A draft that became its message keeps its key, so the row never remounts.
      if (draft && messages[i].id === draft.id) continue;
      out.push({ kind: 'message', key: messages[i].id, message: messages[i] });
    }
    return out;
  }, [agent, chat?.messages, draft, pending]);

  useEffect(() => {
    if (!at || !connected) return;
    let live = true;
    loadUntil(id, at).then(
      (found) => {
        if (!live) return;
        if (found) setTarget(at);
        else showError('That message is too far back to open here.');
      },
      (e: unknown) => live && showError(describeError(e))
    );
    return () => {
      live = false;
    };
  }, [at, id, connected, showError]);

  const targetIndex = target ? items.findIndex((i) => i.key === target) : -1;
  useEffect(() => {
    if (targetIndex < 0) return;
    const timer = setTimeout(
      () => list.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.5, animated: true }),
      60
    );
    return () => clearTimeout(timer);
  }, [targetIndex]);

  const older = useCallback(() => {
    if (!chat?.loaded || !chat.more || loadingOlder || !connected) return;
    setLoadingOlder(true);
    loadOlder(id)
      .catch((e: unknown) => showError(describeError(e)))
      .finally(() => setLoadingOlder(false));
  }, [chat, loadingOlder, connected, id, showError]);

  const renderScroll = useCallback(
    (props: ScrollViewProps) => (
      <KeyboardChatScrollView {...props} inverted offset={insets.bottom} />
    ),
    [insets.bottom]
  );

  if (!agent) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: '' }} />
        <Spinner />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Files, check-ins and routines"
              onPress={() => router.push({ pathname: '/agent/[id]', params: { id } })}
            >
              <Header agent={agent} />
            </Pressable>
          ),
          headerRight: () => (
            <IconButton
              name="info.circle"
              label={`About ${agent.name}`}
              fallback="ⓘ"
              onPress={() => router.push({ pathname: '/agent/[id]', params: { id } })}
            />
          ),
        }}
      />
      <LinkBanner />
      <FlatList
        ref={list}
        inverted
        data={items}
        keyExtractor={(i) => i.key}
        renderItem={({ item }) => (
          <ItemView item={item} agent={agent} onError={showError} lit={item.key === target} />
        )}
        onScrollToIndexFailed={(info) => {
          // Not measured yet: get near it, then try again once it's laid out.
          list.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          setTimeout(
            () =>
              list.current?.scrollToIndex({
                index: info.index,
                viewPosition: 0.5,
                animated: true,
              }),
            120
          );
        }}
        renderScrollComponent={renderScroll}
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReached={older}
        onEndReachedThreshold={0.6}
        onScroll={(e) => setAway(e.nativeEvent.contentOffset.y > 360)}
        scrollEventThrottle={64}
        initialNumToRender={16}
        maxToRenderPerBatch={12}
        windowSize={13}
        ListFooterComponent={
          chat?.loaded && !chat.more ? (
            <T variant="caption" color={colors.textFaint} style={styles.start}>
              Start of your conversation with {agent.name}
            </T>
          ) : chat?.loaded ? (
            <View style={styles.start}>{loadingOlder && <Spinner />}</View>
          ) : undefined
        }
        ListEmptyComponent={
          chat?.loaded ? undefined : (
            <View style={[styles.start, { transform: [{ scaleY: -1 }] }]}>
              <Spinner />
            </View>
          )
        }
      />
      {away && (
        <Animated.View
          entering={ZoomIn.duration(160)}
          exiting={ZoomOut.duration(120)}
          style={styles.jumpWrap}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to latest"
            onPress={() => {
              tap();
              list.current?.scrollToOffset({ offset: 0, animated: true });
            }}
            style={styles.jump}
          >
            <Icon name="arrow.down" size={15} color={colors.textPrimary} fallback={<T>↓</T>} />
          </Pressable>
        </Animated.View>
      )}
      {toast && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(150)}
          style={styles.toast}
        >
          <T variant="small" color={colors.textWhite}>
            {toast}
          </T>
        </Animated.View>
      )}
      <KeyboardStickyView offset={{ opened: insets.bottom }}>
        <Composer
          agent={agent}
          connected={connected}
          onError={showError}
          onSent={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
        />
      </KeyboardStickyView>
    </View>
  );
}

function ItemView({
  item,
  agent,
  onError,
  lit,
}: {
  item: Item;
  agent: Agent;
  onError: (t: string) => void;
  lit?: boolean;
}) {
  const body =
    item.kind === 'message' ? (
      <MessageRow
        message={item.message}
        agent={agent}
        queued={isQueued(item.message, agent)}
        onError={onError}
      />
    ) : item.kind === 'pending' ? (
      <PendingRow pending={item.pending} />
    ) : item.kind === 'draft' ? (
      <DraftRow text={item.text} />
    ) : (
      <WorkingRow label={item.label} />
    );
  return (
    <View style={styles.item}>
      {lit && <Glow />}
      {body}
    </View>
  );
}

/** The row a search hit opened on: lit, then fading back. */
function Glow() {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(withDelay(900, withTiming(0, { duration: 900 })));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View pointerEvents="none" style={[styles.glow, style]} />;
}

function Header({ agent }: { agent: Agent }) {
  const line = needsYou(agent)
    ? { text: 'Needs your OK', color: colors.accentWarning }
    : agent.status.state === 'working'
      ? { text: agent.status.activity ?? 'Working…', color: colors.textSecondary }
      : { text: agent.role || 'Idle', color: colors.textMuted };
  return (
    <View style={styles.header}>
      <AgentAvatar name={agent.name} color={agent.color} size={28} />
      <View style={{ flexShrink: 1 }}>
        <T variant="subhead" color={colors.textWhite} numberOfLines={1}>
          {agent.name}
        </T>
        <Animated.View key={line.text} entering={FadeIn.duration(180)}>
          <T variant="caption" color={line.color} numberOfLines={1}>
            {line.text}
          </T>
        </Animated.View>
      </View>
    </View>
  );
}

/** Only when something is wrong: a slim line under the header, tappable for details. */
function LinkBanner() {
  const router = useRouter();
  const now = useNow(10_000);
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
  if (state.link.kind === 'connected') return null;
  const p = pill(state, now);
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)}>
      <Pressable onPress={() => router.push('/connection')} style={styles.banner}>
        <T
          variant="caption"
          color={p.tone === 'problem' ? colors.accentErrorLight : colors.accentWarning}
        >
          {p.label} · cached messages shown
        </T>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.lg, paddingVertical: space.md },
  item: { paddingVertical: space.sm },
  glow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: -space.lg,
    right: -space.lg,
    backgroundColor: alpha(colors.accentFocus, 0.14),
  },
  start: { alignItems: 'center', paddingVertical: space.xl, textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 260 },
  jumpWrap: { position: 'absolute', right: space.lg, bottom: 110 },
  jump: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    top: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSelected,
  },
  banner: {
    paddingHorizontal: space.lg,
    paddingVertical: space.tight,
    backgroundColor: colors.surfacePanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
});
