/**
 * Home: every agent, in the desktop's order (pinned, then most recently
 * active), with what needs you pulled to the top. Rows slide when the order
 * changes rather than jumping.
 *
 * The connection says nothing while it's fine; when it isn't, a notice sits
 * under the title and every row shows only what was last known. On a wide
 * screen (iPad, or a big phone in landscape) the chat opens beside the list.
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { AgentRow } from '../../../components/AgentRow';
import { Spinner } from '../../../components/agent';
import { ChatView } from '../../../components/ChatView';
import { ConnectionNotice, useNow } from '../../../components/ConnectionPill';
import { Button, Icon, IconButton, ripple, T, tap } from '../../../components/ui';
import { toggleFor, type AgentAction } from '../../../lib/actions';
import { formatAgo, needsAttention, sortAgents } from '../../../lib/agents';
import { pill } from '../../../lib/connection';
import { haptic } from '../../../lib/haptics';
import {
  call,
  canCall,
  describeError,
  markUnread,
  setAgentToggles,
  unpair,
} from '../../../lib/session';
import { setApp, useApp } from '../../../lib/store';
import { chromeScale, colors, radius, space } from '../../../lib/theme';

type Row =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'agent'; key: string; agent: Agent }
  | { kind: 'hidden'; key: string; count: number };

/** Wide enough for a list and a chat side by side. */
const SPLIT_AT = 700;

const UNDO: Partial<Record<AgentAction, [string, AgentAction]>> = {
  hide: ['Hid', 'unhide'],
  mute: ['Muted', 'unmute'],
};

export default function Agents() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const split = width >= SPLIT_AT;
  const overview = useApp((s) => s.overview);
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const live = useApp((s) => s.link.kind === 'connected');
  const removed = useApp(
    (s) =>
      s.link.kind === 'refused' && (s.link.reason === 'revoked' || s.link.reason === 'unauthorized')
  );
  const caps = useApp(
    useShallow((s) => ({
      update: canCall('agents.update', s.welcome),
      markUnread: canCall('agents.markUnread', s.welcome),
    }))
  );
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo<Row[]>(() => {
    // A Mac that removed this phone shows nothing of its agents: only the way back.
    if (!overview || removed) return [];
    const sorted = sortAgents(overview.agents);
    const visible = sorted.filter((a) => !a.hidden);
    const hidden = sorted.filter((a) => a.hidden);
    const urgent = visible.filter(needsAttention);
    const rest = visible.filter((a) => !needsAttention(a));
    const out: Row[] = [];
    const add = (a: Agent) => out.push({ kind: 'agent', key: a.id, agent: a });
    if (urgent.length) {
      out.push({ kind: 'header', key: 'h-urgent', title: 'Needs you' });
      urgent.forEach(add);
      if (rest.length) out.push({ kind: 'header', key: 'h-rest', title: 'Agents' });
    } else if (!live && rest.length) {
      out.push({ kind: 'header', key: 'h-rest', title: 'Agents' });
    }
    rest.forEach(add);
    if (hidden.length) {
      out.push({ kind: 'hidden', key: 'hidden', count: hidden.length });
      if (showHidden) hidden.forEach(add);
    }
    return out;
  }, [overview, showHidden, removed, live]);

  const flash = useCallback((text: string, run?: () => void) => {
    const entry = { text, run: run ?? (() => {}) };
    setUndo(entry);
    setTimeout(() => setUndo((u) => (u === entry ? null : u)), 4500);
  }, []);

  const onAction = useCallback(
    (agent: Agent, action: AgentAction) => {
      const fail = (e: unknown) => {
        haptic.error();
        setError(describeError(e));
        setTimeout(() => setError(null), 4000);
      };
      if (action === 'markUnread') {
        markUnread(agent.id).catch(fail);
        return;
      }
      const input = toggleFor(action);
      if (!input) return;
      haptic.select();
      setAgentToggles(agent.id, input).then(() => {
        const undoable = UNDO[action];
        if (undoable) {
          const [verb, back] = undoable;
          flash(`${verb} ${agent.name}`, () => {
            const reverse = toggleFor(back);
            if (reverse) setAgentToggles(agent.id, reverse).catch(fail);
          });
        }
      }, fail);
    },
    [flash]
  );

  const refresh = useCallback(async () => {
    if (!live) return;
    setRefreshing(true);
    try {
      setApp({ overview: await call('agents.overview', {}) });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRefreshing(false);
    }
  }, [live]);

  // In the split, something is always open: what needs you, else the top agent.
  const firstAgent = rows.find((r): r is Extract<Row, { kind: 'agent' }> => r.kind === 'agent');
  const shown =
    split && overview && !removed
      ? ((selected && overview.agents.some((a) => a.id === selected) ? selected : null) ??
        firstAgent?.agent.id ??
        null)
      : null;

  const list = (
    <Animated.FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      contentInsetAdjustmentBehavior="automatic"
      itemLayoutAnimation={LinearTransition.springify().damping(20).mass(0.6)}
      contentContainerStyle={{ paddingBottom: space['2xl'], flexGrow: 1 }}
      refreshControl={
        live ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textSecondary}
          />
        ) : undefined
      }
      ListHeaderComponent={
        <>
          <ConnectionNotice />
          <Refused />
        </>
      }
      ListEmptyComponent={
        removed ? undefined : <Empty hasOverview={!!overview} macName={macName} />
      }
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <SectionHeader title={item.title} live={live} />
        ) : item.kind === 'hidden' ? (
          <Pressable
            onPress={() => {
              tap();
              setShowHidden((v) => !v);
            }}
            android_ripple={ripple}
            accessibilityRole="button"
            accessibilityState={{ expanded: showHidden }}
            style={styles.hiddenToggle}
          >
            <Icon
              name={showHidden ? 'chevron.down' : 'chevron.right'}
              size={11}
              color={colors.textSecondary}
            />
            <T variant="small" color={colors.textSecondary}>
              Hidden ({item.count})
            </T>
          </Pressable>
        ) : (
          <AgentRow
            agent={item.agent}
            caps={caps}
            live={live}
            selected={item.agent.id === shown}
            onPress={split ? () => setSelected(item.agent.id) : undefined}
            onAction={onAction}
          />
        )
      }
    />
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Agents',
          // Always on: changing it (or the header) at runtime loses the title
          // when the phone rotates back. In landscape iOS shows it small anyway.
          headerLargeTitle: true,
          headerLargeTitleShadowVisible: false,
          headerLargeStyle: { backgroundColor: colors.surfaceApp },
          headerLargeTitleStyle: { color: colors.textWhite },
          headerRight: () => (
            <IconButton
              name="gearshape"
              label="Settings"
              fallback="⚙"
              onPress={() => router.push('/settings')}
            />
          ),
        }}
      />
      {split ? (
        <View style={styles.split}>
          <View style={[styles.splitList, { paddingLeft: insets.left, width: 360 + insets.left }]}>
            {list}
          </View>
          <View style={[styles.splitChat, { paddingRight: insets.right }]}>
            {shown ? (
              <ChatView key={shown} id={shown} embedded />
            ) : (
              <View style={styles.center}>
                <T color={colors.textSecondary}>Pick an agent to see its chat.</T>
              </View>
            )}
          </View>
        </View>
      ) : (
        list
      )}
      {(undo || error) && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(150)}
          style={styles.toast}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textWhite} style={{ flex: 1 }}>
            {error ?? undo?.text}
          </T>
          {!error && undo && (
            <Button
              title="Undo"
              size="compact"
              variant="ghost"
              onPress={() => {
                undo.run();
                setUndo(null);
              }}
            />
          )}
        </Animated.View>
      )}
    </>
  );
}

/** "NEEDS YOU", or "AGENTS · AS OF 4 MIN AGO" when the Mac isn't answering. */
function SectionHeader({ title, live }: { title: string; live: boolean }) {
  useNow(30_000); // re-render to keep "as of" current
  const asOf = useApp((s) => (s.link.kind === 'reconnecting' ? s.link.lastSeenAt : s.syncedAt));
  const label = live || !asOf ? title : `${title} · as of ${formatAgo(asOf)}`;
  return (
    <T
      variant="caption"
      color={colors.textSecondary}
      style={styles.section}
      maxFontSizeMultiplier={chromeScale}
      accessibilityRole="header"
    >
      {label.toUpperCase()}
    </T>
  );
}

/** The Mac said no for good: removed, or one side needs updating. */
function Refused() {
  const router = useRouter();
  const link = useApp((s) => s.link);
  const refusal = useApp((s) => s.refusal);
  const name = useApp((s) => s.credentials?.name ?? 'Your Mac');
  if (link.kind !== 'refused') return null;
  const removed = link.reason === 'revoked' || link.reason === 'unauthorized';
  return (
    <Animated.View entering={FadeIn.duration(200)} style={styles.refused}>
      <T variant="subhead" color={colors.textWhite}>
        {removed
          ? `${name} removed this phone`
          : link.reason === 'update_app'
            ? 'Update this app'
            : `Update Ship Studio on ${name}`}
      </T>
      {refusal?.message ? <T color={colors.textSecondary}>{refusal.message}</T> : null}
      {removed && (
        <Button
          title="Pair again"
          variant="primary"
          style={{ alignSelf: 'flex-start' }}
          onPress={async () => {
            await unpair();
            router.replace('/pair');
          }}
        />
      )}
    </Animated.View>
  );
}

function Empty({ hasOverview, macName }: { hasOverview: boolean; macName: string }) {
  const router = useRouter();
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
  const p = pill(state);
  if (hasOverview) {
    return (
      <Animated.View entering={FadeIn.duration(200)} style={styles.emptyCentered}>
        <T variant="title" color={colors.textWhite} style={styles.centerText}>
          No agents yet
        </T>
        <T color={colors.textSecondary} style={styles.centerText}>
          In Ship Studio on {macName}, open Agents and create one. It shows up here as soon as it
          exists.
        </T>
        <Button title="Connection details" onPress={() => router.push('/connection')} />
      </Animated.View>
    );
  }
  return (
    <Animated.View entering={FadeIn.delay(300)} style={styles.emptyCentered}>
      {p.tone === 'problem' ? (
        <>
          <T variant="title" color={colors.textWhite} style={styles.centerText}>
            {p.label}
          </T>
          <T color={colors.textSecondary} style={styles.centerText}>
            Your agents are on {macName}. Once it answers, they’ll be here.
          </T>
          <Button title="What’s wrong?" onPress={() => router.push('/connection')} />
        </>
      ) : (
        <View style={styles.connecting}>
          <Spinner />
          <T color={colors.textSecondary}>Connecting to {macName}…</T>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.tight,
    letterSpacing: 0.4,
  },
  hiddenToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.lg,
    minHeight: 48,
  },
  refused: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.lg,
    gap: space.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  emptyCentered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
    minHeight: 320,
  },
  centerText: { textAlign: 'center', maxWidth: 340 },
  connecting: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  split: { flex: 1, flexDirection: 'row' },
  splitList: {
    width: 360,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.borderSubtle,
  },
  splitChat: { flex: 1 },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space['2xl'] + 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingVertical: space.xs,
    paddingRight: space.xs,
    minHeight: 48,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSelected,
  },
});
