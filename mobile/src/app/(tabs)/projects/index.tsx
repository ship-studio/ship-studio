/**
 * Projects on the Mac and their session tabs, each with its state as
 * Remote Access reads it: anything waiting on a decision first. The Mac
 * sends each change as it happens (`projects.changed`); pull to re-read.
 * Tap a tab to watch it, answer it, or type to it.
 */

import type { ProjectSummary, SessionSummary } from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { Spinner } from '../../../components/agent';
import { ConnectionNotice, useNow } from '../../../components/ConnectionPill';
import { SessionState, tabName } from '../../../components/session';
import { Icon, ripple, T } from '../../../components/ui';
import { formatAgo } from '../../../lib/agents';
import { canCall, describeError, refreshProjects } from '../../../lib/session';
import { useApp } from '../../../lib/store';
import { colors, radius, space } from '../../../lib/theme';

/** Waiting on you first, then the most recently active. */
function order(projects: ProjectSummary[]): ProjectSummary[] {
  const asking = (p: ProjectSummary) => p.sessions.some((s) => s.state === 'needs_decision');
  const last = (p: ProjectSummary) => Math.max(0, ...p.sessions.map((s) => s.lastOutputAt));
  return [...projects].sort(
    (a, b) =>
      Number(asking(b)) - Number(asking(a)) || last(b) - last(a) || a.name.localeCompare(b.name)
  );
}

export default function Projects() {
  const projects = useApp((s) => s.projects);
  const served = useApp((s) => canCall('projects.list', s.welcome));
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      refreshProjects().then(
        () => setError(null),
        (e: unknown) => setError(describeError(e))
      ),
    []
  );
  const sorted = useMemo(() => order(projects ?? []), [projects]);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Projects',
          headerLargeTitle: true,
          headerLargeTitleShadowVisible: false,
          headerLargeStyle: { backgroundColor: colors.surfaceApp },
          headerLargeTitleStyle: { color: colors.textWhite },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textSecondary}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <ConnectionNotice />
        {!served ? (
          <T color={colors.textSecondary} style={styles.note}>
            Update Ship Studio on {macName} to see its projects here.
          </T>
        ) : projects == null ? (
          <View style={styles.note}>
            <Spinner />
          </View>
        ) : sorted.length === 0 ? (
          <T color={colors.textSecondary} style={styles.note}>
            No projects on {macName} yet.
          </T>
        ) : (
          sorted.map((p) => <ProjectCard key={p.path} project={p} />)
        )}
        {error && (
          <T variant="small" color={colors.accentErrorLight} style={styles.note}>
            {error}
          </T>
        )}
      </ScrollView>
    </>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const meta = [
    project.branch,
    project.dirtyFiles ? `${project.dirtyFiles} uncommitted` : project.branch ? 'clean' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Animated.View layout={LinearTransition.springify().damping(20)} style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="folder.fill" size={14} color={colors.textSecondary} />
        <T variant="subhead" color={colors.textWhite} numberOfLines={1} style={{ flexShrink: 1 }}>
          {project.name}
        </T>
        <View style={{ flex: 1 }} />
        {!!meta && (
          <T variant="caption" color={colors.textSecondary} numberOfLines={1} style={styles.meta}>
            {meta}
          </T>
        )}
      </View>
      {project.sessions.length === 0 ? (
        <T variant="small" color={colors.textSecondary} style={styles.empty}>
          No sessions open
        </T>
      ) : (
        project.sessions.map((s, i) => (
          <SessionRow key={s.sessionId} session={s} project={project} first={i === 0} />
        ))
      )}
    </Animated.View>
  );
}

function SessionRow({
  session,
  project,
  first,
}: {
  session: SessionSummary;
  project: ProjectSummary;
  first: boolean;
}) {
  const router = useRouter();
  const now = useNow(15_000);
  return (
    <Animated.View entering={FadeIn.duration(200)}>
      <Pressable
        accessibilityRole="button"
        android_ripple={ripple}
        onPress={() =>
          router.push({
            pathname: '/session/[id]',
            params: {
              id: session.sessionId,
              project: project.name,
              path: project.path,
              tab: tabName(session),
            },
          })
        }
        style={({ pressed }) => [
          styles.session,
          !first && styles.divider,
          pressed && { backgroundColor: colors.surfaceControl },
        ]}
      >
        <View style={styles.sessionText}>
          <View style={styles.sessionTop}>
            <T variant="small" color={colors.textPrimary}>
              {tabName(session)}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {formatAgo(session.lastOutputAt, now)}
            </T>
          </View>
          <SessionState session={session} />
        </View>
        <Icon name="chevron.right" size={11} color={colors.textMuted} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space['2xl'], gap: space.md },
  note: { paddingHorizontal: space.lg, paddingVertical: space.md },
  card: {
    marginHorizontal: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  meta: { maxWidth: '55%' },
  empty: { paddingHorizontal: space.lg, paddingBottom: space.md },
  session: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  sessionText: { flex: 1, gap: space['2xs'] },
  sessionTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
});
