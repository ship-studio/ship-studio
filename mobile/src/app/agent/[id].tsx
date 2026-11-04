/**
 * The agent sheet: who it is, its Files, and its check-ins and routines,
 * each one a tap from Run now, Pause, Edit or Cancel, the same four the
 * desktop offers. The list is the Mac's, live: whatever changes it, here or
 * at the desk, arrives with the next registry event.
 */

import {
  describeCheckInTime,
  sortCheckIns,
  type Agent,
  type CheckIn,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { AgentAvatar } from '../../components/agent';
import { useNow } from '../../components/ConnectionPill';
import { Button, choose, Icon, Row, T } from '../../components/ui';
import { folderName } from '../../lib/agents';
import { canCall, describeError, schedule } from '../../lib/session';
import { useApp } from '../../lib/store';
import { colors, radius, space } from '../../lib/theme';

export default function AgentSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const welcome = useApp((s) => s.welcome);
  const [error, setError] = useState<string | null>(null);
  if (!agent) return null;
  const canSchedule = canCall('agents.schedule.create', welcome);
  const checkIns = sortCheckIns(agent.checkIns ?? []);
  const where = [agent.model, agent.project && folderName(agent.project)]
    .filter(Boolean)
    .join(' · ');

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.who}>
        <AgentAvatar name={agent.name} color={agent.color} size={52} />
        <View style={{ flex: 1, gap: space['2xs'] }}>
          <T variant="title" color={colors.textWhite} numberOfLines={1}>
            {agent.name}
          </T>
          {!!agent.role && (
            <T variant="small" color={colors.textSecondary} numberOfLines={2}>
              {agent.role}
            </T>
          )}
          {!!where && (
            <T variant="caption" color={colors.textMuted}>
              {where}
            </T>
          )}
        </View>
      </View>

      {canCall('agents.files', welcome) && (
        <View style={styles.list}>
          <Row
            label="Files"
            leading={<Icon name="doc.on.doc" size={15} color={colors.textSecondary} />}
            onPress={() => router.push({ pathname: '/files/[id]', params: { id } })}
            last
          />
        </View>
      )}

      <View style={styles.sectionHead}>
        <T variant="caption" color={colors.textMuted} style={styles.sectionTitle}>
          CHECK-INS AND ROUTINES
        </T>
        {canSchedule && (
          <Button
            title="Add"
            size="compact"
            variant="ghost"
            icon="plus"
            onPress={() => router.push({ pathname: '/schedule', params: { agentId: id } })}
          />
        )}
      </View>
      <View style={styles.list}>
        {checkIns.length === 0 ? (
          <T variant="small" color={colors.textMuted} style={styles.none}>
            Nothing scheduled. Add one in a line, like “every weekday 9am: brief me on the launch”.
          </T>
        ) : (
          checkIns.map((c, i) => (
            <Animated.View
              key={c.id}
              entering={FadeIn.duration(180)}
              exiting={FadeOut.duration(150)}
              layout={LinearTransition.springify().damping(20)}
            >
              <CheckInRow
                agent={agent}
                checkIn={c}
                first={i === 0}
                enabled={canSchedule}
                onError={setError}
              />
            </Animated.View>
          ))
        )}
      </View>
      {error && (
        <T variant="small" color={colors.accentErrorLight} style={styles.none}>
          {error}
        </T>
      )}
    </ScrollView>
  );
}

function CheckInRow({
  agent,
  checkIn: c,
  first,
  enabled,
  onError,
}: {
  agent: Agent;
  checkIn: CheckIn;
  first: boolean;
  enabled: boolean;
  onError: (text: string | null) => void;
}) {
  const router = useRouter();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const act = (run: () => Promise<unknown>) => () => {
    setBusy(true);
    onError(null);
    run()
      .catch((e: unknown) => onError(describeError(e)))
      .finally(() => setBusy(false));
  };
  const menu = () =>
    choose(c.note, [
      { label: 'Run now', run: act(() => schedule.runNow(agent.id, c.id)) },
      {
        label: c.paused ? 'Resume' : 'Pause',
        run: act(() => schedule.pause(agent.id, c.id, !c.paused)),
      },
      {
        label: 'Edit',
        run: () => router.push({ pathname: '/schedule', params: { agentId: agent.id, id: c.id } }),
      },
      {
        label: c.repeat ? 'Cancel routine' : 'Cancel check-in',
        destructive: true,
        run: () =>
          Alert.alert(
            c.repeat ? 'Cancel this routine?' : 'Cancel this check-in?',
            `${agent.name} won’t be woken for it again.`,
            [
              { text: 'Keep', style: 'cancel' },
              {
                text: 'Cancel it',
                style: 'destructive',
                onPress: act(() => schedule.cancel(agent.id, c.id)),
              },
            ]
          ),
      },
    ]);
  return (
    <Pressable
      disabled={!enabled || busy}
      onPress={menu}
      accessibilityRole="button"
      accessibilityHint="Run now, pause, edit or cancel"
      style={({ pressed }) => [
        styles.row,
        !first && styles.divider,
        pressed && { backgroundColor: colors.surfaceControl },
      ]}
    >
      <Icon
        name={c.repeat ? 'arrow.trianglehead.2.clockwise' : 'clock'}
        size={14}
        color={c.paused ? colors.textMuted : colors.textSecondary}
      />
      <View style={{ flex: 1, gap: space['2xs'] }}>
        <T color={c.paused ? colors.textMuted : colors.textWhite} numberOfLines={2}>
          {c.note}
        </T>
        <T variant="caption" color={colors.textSecondary}>
          {describeCheckInTime(c, now)}
        </T>
      </View>
      {busy ? null : <Icon name="ellipsis" size={14} color={colors.textMuted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  sectionTitle: { marginLeft: space.lg, letterSpacing: 0.4 },
  list: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  none: { padding: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
});
