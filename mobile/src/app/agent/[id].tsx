/**
 * The agent sheet: who it is; its instructions, Files and usage; Pin, Mute
 * and Hide without a gesture; what it may do without asking (each "Always
 * allow" revocable); and its check-ins and routines, each one a tap from
 * Run now, Pause, Edit or Cancel, the same four the desktop offers. The
 * lists are the Mac's, live: whatever changes them, here or at the desk,
 * arrives with the next registry event.
 */

import {
  describeCheckInTime,
  sortCheckIns,
  type Agent,
  type CheckIn,
  type PermissionRule,
  type UsageSummary,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { AgentAvatar } from '../../components/agent';
import { useNow } from '../../components/ConnectionPill';
import { Button, choose, Icon, Row, T } from '../../components/ui';
import {
  describeScope,
  engineLine,
  engineName,
  folderName,
  modelName,
  usageLine,
} from '../../lib/agents';
import { haptic } from '../../lib/haptics';
import {
  canCall,
  describeError,
  readUsage,
  revokePermission,
  schedule,
  setAgentToggles,
} from '../../lib/session';
import { useApp } from '../../lib/store';
import { colors, radius, space } from '../../lib/theme';

export default function AgentSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const welcome = useApp((s) => s.welcome);
  const engines = useApp((s) => s.overview?.engines);
  const live = useApp((s) => s.link.kind === 'connected');
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const servesUsage = canCall('agents.usage', welcome);
  useEffect(() => {
    if (!servesUsage || !live) return;
    let on = true;
    readUsage(id).then(
      (u) => on && setUsage(u),
      () => {}
    );
    return () => {
      on = false;
    };
  }, [id, servesUsage, live]);
  if (!agent) return null;
  const canSchedule = canCall('agents.schedule.create', welcome);
  const checkIns = sortCheckIns(agent.checkIns ?? []);
  const where = [engineLine(agent, engines), agent.project && folderName(agent.project)]
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

      <View style={styles.list}>
        {canCall('agents.instructions', welcome) && (
          <Row
            label="Instructions"
            leading={<Icon name="text.alignleft" size={15} color={colors.textSecondary} />}
            onPress={() => router.push({ pathname: '/instructions', params: { id } })}
          />
        )}
        {canCall('agents.memory', welcome) && (
          <Row
            label="Memory"
            leading={<Icon name="brain" size={15} color={colors.textSecondary} />}
            onPress={() => router.push({ pathname: '/memory', params: { id } })}
          />
        )}
        {canCall('agents.files', welcome) && (
          <Row
            label="Files"
            leading={<Icon name="doc.on.doc" size={15} color={colors.textSecondary} />}
            onPress={() => router.push({ pathname: '/files/[id]', params: { id } })}
          />
        )}
        <Toggle agent={agent} field="pinned" label="Pinned" enabled={live} onError={setError} />
        <Toggle
          agent={agent}
          field="muted"
          label="Muted"
          enabled={live}
          onError={setError}
          last={agent.isMain}
        />
        {!agent.isMain && (
          <Toggle
            agent={agent}
            field="hidden"
            label="Hidden"
            enabled={live}
            onError={setError}
            last
          />
        )}
      </View>

      {!!agent.engine && (
        // Read-only here: switching engines starts a new session, a choice for the desk.
        <View style={styles.list}>
          <Row label="Runs on" value={engineName(agent)} />
          <Row label="Model" value={modelName(agent, engines)} last />
        </View>
      )}

      {usage && <Usage usage={usage} />}

      {!!agent.permissions?.length && (
        <>
          <T variant="caption" color={colors.textMuted} style={styles.sectionTitle}>
            ALLOWED WITHOUT ASKING
          </T>
          <View style={styles.list}>
            {agent.permissions.map((rule, i) => (
              <Animated.View
                key={rule.id}
                exiting={FadeOut.duration(150)}
                layout={LinearTransition.springify().damping(20)}
              >
                <PermissionRow
                  agent={agent}
                  rule={rule}
                  first={i === 0}
                  enabled={live && canCall('agents.revokePermission', welcome)}
                  onError={setError}
                />
              </Animated.View>
            ))}
          </View>
        </>
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

/** Pin, Mute or Hide as a switch: the path that needs no gesture. */
function Toggle({
  agent,
  field,
  label,
  enabled,
  onError,
  last,
}: {
  agent: Agent;
  field: 'pinned' | 'muted' | 'hidden';
  label: string;
  enabled: boolean;
  onError: (text: string | null) => void;
  last?: boolean;
}) {
  return (
    <Row
      label={label}
      last={last}
      trailing={
        <Switch
          value={agent[field]}
          disabled={!enabled}
          accessibilityLabel={label}
          onValueChange={(on) => {
            haptic.select();
            onError(null);
            setAgentToggles(agent.id, { [field]: on }).catch((e: unknown) =>
              onError(describeError(e))
            );
          }}
        />
      }
    />
  );
}

/** What a rule lets it do without asking, and Revoke. */
function PermissionRow({
  agent,
  rule,
  first,
  enabled,
  onError,
}: {
  agent: Agent;
  rule: PermissionRule;
  first: boolean;
  enabled: boolean;
  onError: (text: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const revoke = () =>
    Alert.alert(`Revoke “${rule.label}”?`, `${agent.name} asks again before it does this.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          onError(null);
          revokePermission(agent.id, rule.id)
            .then(() => haptic.warning())
            .catch((e: unknown) => {
              haptic.error();
              onError(describeError(e));
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <View style={{ flex: 1, gap: space['2xs'] }}>
        <T variant="mono" color={colors.textWhite} numberOfLines={2}>
          {rule.label}
        </T>
        <T variant="caption" color={colors.textSecondary}>
          {describeScope(rule, agent.name, false)}
        </T>
      </View>
      <Button
        title="Revoke"
        size="compact"
        variant="ghost"
        busy={busy}
        disabled={!enabled}
        onPress={revoke}
      />
    </View>
  );
}

function Usage({ usage }: { usage: UsageSummary }) {
  return (
    <>
      <T variant="caption" color={colors.textMuted} style={styles.sectionTitle}>
        USAGE
      </T>
      <View style={styles.list}>
        {(
          [
            ['This week', usage.week],
            ['All time', usage.allTime],
          ] as const
        ).map(([label, totals], i) => (
          <View key={label} style={[styles.row, i > 0 && styles.divider]}>
            <View style={{ flex: 1, gap: space['2xs'] }}>
              <T color={colors.textPrimary}>{label}</T>
              <T variant="small" color={colors.textSecondary}>
                {usageLine(totals)}
              </T>
            </View>
          </View>
        ))}
      </View>
    </>
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
