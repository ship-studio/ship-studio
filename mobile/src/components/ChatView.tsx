/**
 * One conversation. An inverted list, so the newest line sits on the
 * composer and a growing draft pushes upward like the desktop's; scrolling
 * to the top pages in older messages; a button brings you back down, and
 * says so when an approval is waiting below.
 *
 * Used full-screen (chat/[id]) and as the right column of the iPad split
 * (`embedded`), where it draws its own header instead of the stack's.
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type FlatList,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  View,
  type ScrollViewProps,
} from 'react-native';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { isQueued, needsYou } from '../lib/agents';
import { messageActions, plainText, type MessageAction } from '../lib/actions';
import { pill } from '../lib/connection';
import { announce } from '../lib/a11y';
import { addQuote } from '../lib/drafts';
import { preview } from '../lib/files';
import { haptic } from '../lib/haptics';
import {
  describeError,
  fetchPath,
  loadLatest,
  loadOlder,
  loadUntil,
  setOpenChat,
} from '../lib/session';
import { useApp } from '../lib/store';
import { chatItems, type Item } from '../lib/timeline';
import { alpha, chromeScale, colors, radius, space } from '../lib/theme';
import { AgentAvatar, Spinner } from './agent';
import { DaySeparator, DraftRow, MessageRow, PendingRow, WorkingRow } from './chat';
import { Composer } from './Composer';
import { useNow } from './ConnectionPill';
import { PathContext } from './Markdown';
import { showActions } from './menu';
import { SelectSheet } from './SelectSheet';
import { Button, Icon, IconButton, ripple, T } from './ui';

const NONE: never[] = [];

/** Rows glide to where a growing or collapsing neighbour puts them: nothing jumps. */
const glide = LinearTransition.duration(220);

/**
 * A reply taller than this share of the screen stops pushing its own first
 * line away: its start stays put and it grows down, as ChatGPT and Claude do.
 */
const TALL_REPLY = 0.7;

export function ChatView({
  id,
  at,
  compose = false,
  embedded = false,
}: {
  id: string;
  at?: string;
  /** Opened to write (the "New message" quick action): the field has the keyboard. */
  compose?: boolean;
  embedded?: boolean;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const hasOverview = useApp((s) => !!s.overview);
  const chat = useApp((s) => s.chats[id]);
  const draft = useApp((s) => s.drafts[id]);
  const pending = useApp((s) => s.pending[id] ?? NONE);
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const list = useRef<FlatList<Item>>(null);
  const [away, setAway] = useState(false);
  // Scrolled off the bottom at all: what's on screen holds still while the newest grows.
  const [scrolled, setScrolled] = useState(false);
  const [listHeight, setListHeight] = useState(0);
  const [draftHeight, setDraftHeight] = useState(0);
  // The newest row when you scrolled away: anything newer is "New reply".
  const [awayFrom, setAwayFrom] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(90);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<AgentMessage | null>(null);
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
    announce(text, true);
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 4000);
  }, []);

  // First open, or after a snapshot made the cached copy stale.
  useEffect(() => {
    if (connected && agent && !chat?.loaded)
      loadLatest(id).catch((e: unknown) => showError(describeError(e)));
  }, [connected, chat?.loaded, id, showError, agent]);

  const messages = chat?.messages ?? NONE;
  const items = useMemo<Item[]>(
    () => (agent ? chatItems(agent, messages, pending, draft) : []),
    [agent, messages, draft, pending]
  );
  // The header must agree with the card: an approval in the chat is "needs you",
  // even in the beat before the status event says so.
  const asking = useMemo(
    () => messages.some((m) => m.kind === 'approval' && m.approval?.status === 'pending'),
    [messages]
  );
  const tall = !!draft && listHeight > 0 && draftHeight > listHeight * TALL_REPLY;
  const newest = items[0]?.key ?? null;
  const newReply =
    away &&
    awayFrom !== null &&
    newest !== awayFrom &&
    items[0]?.kind === 'message' &&
    items[0].message.kind === 'agent';

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
      <KeyboardChatScrollView {...props} inverted offset={embedded ? 0 : insets.bottom} />
    ),
    [insets.bottom, embedded]
  );

  const onMessageAction = useCallback(
    (m: AgentMessage) => {
      haptic.select();
      showActions(undefined, messageActions(m), (action: MessageAction) => {
        switch (action) {
          case 'copy':
            void Clipboard.setStringAsync(m.kind === 'agent' ? plainText(m.text) : m.text);
            haptic.success();
            break;
          case 'copyMarkdown':
            void Clipboard.setStringAsync(m.text);
            haptic.success();
            break;
          case 'quote':
            addQuote(id, m.kind === 'agent' ? plainText(m.text) : m.text);
            break;
          case 'select':
            setSelecting(m);
            break;
        }
      });
    },
    [id]
  );

  const openPath = useCallback(
    (path: string) => {
      if (!connected) return showError(`Opening files needs ${macName}.`);
      setToast(`Getting ${path.split('/').pop()} from ${macName}…`);
      fetchPath(id, path).then(
        (file) => {
          setToast(null);
          return preview(file.uri, file.mime);
        },
        (e: unknown) => {
          haptic.error();
          showError(describeError(e));
        }
      );
    },
    [connected, id, macName, showError]
  );

  if (!agent) {
    return hasOverview ? (
      <Gone embedded={embedded} macName={macName} onBack={() => router.back()} />
    ) : (
      <View style={styles.center}>
        {!embedded && <Stack.Screen options={{ title: '' }} />}
        <Spinner />
      </View>
    );
  }

  const header = <Header agent={agent} asking={asking} writing={!!draft?.text} />;
  const openSheet = () => router.push({ pathname: '/agent/[id]', params: { id } });
  const urgentBelow = away && (needsYou(agent) || asking);

  return (
    <View style={{ flex: 1 }}>
      {embedded ? (
        <View style={styles.embeddedHeader}>
          <Pressable accessibilityRole="button" onPress={openSheet} style={{ flex: 1 }}>
            {header}
          </Pressable>
          <IconButton name="info.circle" label={`About ${agent.name}`} onPress={openSheet} />
        </View>
      ) : (
        <Stack.Screen
          options={{
            headerTitle: () => (
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Files, check-ins and routines"
                onPress={openSheet}
              >
                {header}
              </Pressable>
            ),
            headerRight: () => (
              <IconButton
                name="info.circle"
                label={`About ${agent.name}`}
                fallback="ⓘ"
                onPress={openSheet}
              />
            ),
          }}
        />
      )}
      <LinkBanner />
      <PathContext.Provider value={openPath}>
        <Animated.FlatList
          ref={list}
          inverted
          data={items}
          keyExtractor={(i) => i.key}
          itemLayoutAnimation={glide}
          onLayout={(e: LayoutChangeEvent) => setListHeight(e.nativeEvent.layout.height)}
          // Scrolled up, or reading a reply taller than the screen: the rows
          // above the newest stay where they are while it grows below them.
          maintainVisibleContentPosition={scrolled || tall ? { minIndexForVisible: 1 } : undefined}
          renderItem={({ item }) => (
            <ItemView
              item={item}
              agent={agent}
              onError={showError}
              onLongPress={onMessageAction}
              onDraftHeight={setDraftHeight}
              lit={item.key === target}
            />
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
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            const isAway = y > 360;
            setScrolled(y > 8);
            if (isAway !== away) {
              setAway(isAway);
              setAwayFrom(isAway ? newest : null);
            }
          }}
          scrollEventThrottle={64}
          initialNumToRender={16}
          maxToRenderPerBatch={12}
          windowSize={13}
          ListFooterComponent={
            chat?.loaded && !chat.more ? (
              <T variant="caption" color={colors.textSecondary} style={styles.start}>
                Start of your conversation with {agent.name}
              </T>
            ) : chat?.loaded ? (
              <View style={styles.start}>{loadingOlder && <Spinner />}</View>
            ) : undefined
          }
          ListEmptyComponent={
            chat?.loaded || !connected ? undefined : (
              <View style={[styles.start, { transform: [{ scaleY: -1 }] }]}>
                <Spinner />
              </View>
            )
          }
        />
      </PathContext.Provider>
      {away && (
        <Animated.View
          entering={ZoomIn.duration(160)}
          exiting={ZoomOut.duration(120)}
          style={[styles.jumpWrap, { bottom: composerHeight + space.md }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              urgentBelow
                ? 'Needs your OK. Jump to it'
                : newReply
                  ? 'New reply. Jump to it'
                  : 'Jump to latest'
            }
            android_ripple={ripple}
            onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
            style={[styles.jump, urgentBelow && styles.jumpUrgent]}
          >
            {(urgentBelow || newReply) && (
              <T
                variant="small"
                color={urgentBelow ? colors.textOnAccent : colors.textPrimary}
                maxFontSizeMultiplier={chromeScale}
                style={{ marginLeft: space.xs }}
              >
                {urgentBelow ? 'Needs your OK' : 'New reply'}
              </T>
            )}
            <Icon
              name="arrow.down"
              size={15}
              color={urgentBelow ? colors.textOnAccent : colors.textPrimary}
              fallback={<T>↓</T>}
            />
          </Pressable>
        </Animated.View>
      )}
      {toast && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(150)}
          style={[styles.toast, { bottom: composerHeight + space.md + (away ? 52 : 0) }]}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textWhite}>
            {toast}
          </T>
        </Animated.View>
      )}
      <KeyboardStickyView offset={{ opened: embedded ? 0 : insets.bottom }}>
        <Composer
          agent={agent}
          autoFocus={compose}
          connected={connected}
          macName={macName}
          onError={showError}
          onHeight={setComposerHeight}
          onSent={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
        />
      </KeyboardStickyView>
      <SelectSheet
        message={selecting}
        onClose={() => setSelecting(null)}
        onQuote={(text) => {
          addQuote(id, text);
          setSelecting(null);
        }}
      />
    </View>
  );
}

function ItemView({
  item,
  agent,
  onError,
  onLongPress,
  onDraftHeight,
  lit,
}: {
  item: Item;
  agent: Agent;
  onError: (t: string) => void;
  onLongPress: (m: AgentMessage) => void;
  onDraftHeight: (height: number) => void;
  lit?: boolean;
}) {
  const body =
    item.kind === 'message' ? (
      <MessageRow
        message={item.message}
        agent={agent}
        queued={isQueued(item.message, agent)}
        time={item.time}
        onError={onError}
        onLongPress={onLongPress}
      />
    ) : item.kind === 'day' ? (
      <DaySeparator label={item.label} />
    ) : item.kind === 'pending' ? (
      <PendingRow pending={item.pending} />
    ) : item.kind === 'draft' ? (
      <DraftRow id={item.key} text={item.text} onHeight={onDraftHeight} />
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

function Header({
  agent,
  asking,
  writing,
}: {
  agent: Agent;
  asking: boolean;
  /** Its reply is streaming in: the header says so, not the step before it. */
  writing: boolean;
}) {
  const connected = useApp((s) => s.link.kind === 'connected');
  const line =
    needsYou(agent) || asking
      ? { text: 'Needs your OK', color: colors.accentWarning }
      : writing
        ? { text: 'Writing…', color: colors.textSecondary }
        : agent.status.state === 'working'
          ? { text: agent.status.activity ?? 'Working…', color: colors.textSecondary }
          : { text: agent.role || 'Idle', color: colors.textSecondary };
  return (
    <View style={styles.header}>
      <AgentAvatar name={agent.name} color={agent.color} size={28} />
      <View style={{ flexShrink: 1 }}>
        <T
          variant="subhead"
          color={colors.textWhite}
          numberOfLines={1}
          maxFontSizeMultiplier={chromeScale}
        >
          {agent.name}
        </T>
        <Animated.View key={line.text} entering={FadeIn.duration(180)}>
          <T
            variant="caption"
            color={connected ? line.color : colors.textMuted}
            numberOfLines={1}
            maxFontSizeMultiplier={chromeScale}
          >
            {line.text}
          </T>
        </Animated.View>
      </View>
    </View>
  );
}

/** A chat for an agent the Mac no longer has (deleted, or a stale alert). */
function Gone({
  embedded,
  macName,
  onBack,
}: {
  embedded: boolean;
  macName: string;
  onBack: () => void;
}) {
  return (
    <Animated.View entering={FadeIn.duration(200)} style={styles.gone}>
      {!embedded && <Stack.Screen options={{ title: '' }} />}
      <T variant="title" color={colors.textWhite} style={{ textAlign: 'center' }}>
        This agent was removed
      </T>
      <T color={colors.textSecondary} style={{ textAlign: 'center' }}>
        It isn’t on {macName} any more, so there’s nothing to show or send here.
      </T>
      {!embedded && <Button title="Back to Agents" onPress={onBack} />}
    </Animated.View>
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
  embeddedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  jumpWrap: { position: 'absolute', right: space.lg },
  jump: {
    minWidth: 40,
    height: 40,
    paddingHorizontal: space.md,
    borderRadius: 20,
    flexDirection: 'row',
    gap: space.tight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  jumpUrgent: { backgroundColor: colors.accentWarning, borderColor: colors.accentWarning },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
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
  gone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
});
