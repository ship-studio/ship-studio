/**
 * Home: every agent, in the desktop's order (pinned, then most recently
 * active), with what needs you pulled to the top. Rows slide when the order
 * changes rather than jumping.
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { memo, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { AgentAvatar, Spinner, StatusMark } from '../components/agent';
import { ConnectionPill } from '../components/ConnectionPill';
import { Button, Icon, IconButton, T, tap } from '../components/ui';
import { formatAgo, lineState, needsAttention, sortAgents, subtitle } from '../lib/agents';
import { pill } from '../lib/connection';
import { unpair } from '../lib/session';
import { useApp } from '../lib/store';
import { colors, space } from '../lib/theme';

type Row =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'agent'; key: string; agent: Agent }
  | { kind: 'hidden'; key: string; count: number };

const lineColor = {
  waiting: colors.accentWarning,
  failed: colors.accentErrorLight,
  working: colors.textSecondary,
  limited: colors.textMuted,
} as const;

export default function Agents() {
  const router = useRouter();
  const overview = useApp((s) => s.overview);
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const [showHidden, setShowHidden] = useState(false);

  const rows = useMemo<Row[]>(() => {
    if (!overview) return [];
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
    }
    rest.forEach(add);
    if (hidden.length) {
      out.push({ kind: 'hidden', key: 'hidden', count: hidden.length });
      if (showHidden) hidden.forEach(add);
    }
    return out;
  }, [overview, showHidden]);

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => <ConnectionPill />,
          headerTitleAlign: 'center',
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
      <Animated.FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        itemLayoutAnimation={LinearTransition.springify().damping(20).mass(0.6)}
        contentContainerStyle={{ paddingBottom: space['2xl'] }}
        ListHeaderComponent={
          <>
            <T variant="display" color={colors.textWhite} style={styles.title}>
              Agents
            </T>
            <Refused />
          </>
        }
        ListEmptyComponent={<Empty hasOverview={!!overview} macName={macName} />}
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <T variant="caption" color={colors.textMuted} style={styles.section}>
              {item.title.toUpperCase()}
            </T>
          ) : item.kind === 'hidden' ? (
            <Pressable
              onPress={() => {
                tap();
                setShowHidden((v) => !v);
              }}
              style={styles.hiddenToggle}
            >
              <Icon
                name={showHidden ? 'chevron.down' : 'chevron.right'}
                size={11}
                color={colors.textMuted}
              />
              <T variant="small" color={colors.textMuted}>
                Hidden ({item.count})
              </T>
            </Pressable>
          ) : (
            <AgentRow
              agent={item.agent}
              onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.agent.id } })}
            />
          )
        }
      />
    </>
  );
}

const AgentRow = memo(function AgentRow({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  const state = lineState(agent);
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfacePanel }]}
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}. ${subtitle(agent)}${agent.unread ? '. Unread' : ''}`}
    >
      <AgentAvatar name={agent.name} color={agent.color} size={40} />
      <View style={styles.text}>
        <View style={styles.nameLine}>
          <T variant="subhead" color={colors.textWhite} numberOfLines={1} style={{ flexShrink: 1 }}>
            {agent.name}
          </T>
          {agent.pinned && <Icon name="pin.fill" size={10} color={colors.textMuted} />}
          {agent.muted && <Icon name="bell.slash.fill" size={10} color={colors.textMuted} />}
          <View style={{ flex: 1 }} />
          <T variant="caption" color={colors.textMuted}>
            {formatAgo(agent.lastActivityAt)}
          </T>
        </View>
        <View style={styles.nameLine}>
          <T
            variant="small"
            numberOfLines={1}
            color={state ? lineColor[state] : colors.textMuted}
            style={{ flex: 1 }}
          >
            {subtitle(agent)}
          </T>
          <View style={styles.mark}>
            <StatusMark agent={agent} />
          </View>
        </View>
      </View>
    </Pressable>
  );
});

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
  const state = useApp((s) => s);
  const p = pill(state);
  if (hasOverview) {
    return (
      <View style={styles.empty}>
        <T color={colors.textSecondary}>No agents yet. Create one in Ship Studio on your Mac.</T>
      </View>
    );
  }
  return (
    <Animated.View entering={FadeIn.delay(300)} style={styles.empty}>
      {p.tone === 'problem' ? (
        <>
          <T variant="subhead" color={colors.textWhite}>
            {p.label}
          </T>
          <T color={colors.textSecondary}>
            Your agents are on {macName}. Once it answers, they’ll be here.
          </T>
          <Button
            title="What’s wrong?"
            onPress={() => router.push('/connection')}
            style={{ alignSelf: 'flex-start' }}
          />
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
  title: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  section: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.tight,
    letterSpacing: 0.4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  text: { flex: 1, gap: space['2xs'] },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  mark: { width: 14, alignItems: 'flex-end' },
  hiddenToggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg },
  refused: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.lg,
    gap: space.sm,
    borderRadius: 12,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  empty: { padding: space.xl, gap: space.md },
  connecting: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
