/**
 * Search every conversation on the Mac, grouped by agent, newest first, with
 * the matched words picked out. A hit opens its chat scrolled to that
 * message, paging back through history to reach it if it has to.
 */

import type { SearchHit } from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { AgentAvatar, Spinner } from '../../../components/agent';
import { T, tap } from '../../../components/ui';
import { formatAgo } from '../../../lib/agents';
import { canCall, describeError, search } from '../../../lib/session';
import { useApp } from '../../../lib/store';
import { colors, fonts, space } from '../../../lib/theme';

interface Group {
  agentId: string;
  name: string;
  color: string;
  data: SearchHit[];
}

/** Hits arrive newest first; groups keep that order by their newest hit. */
function groupHits(hits: SearchHit[]): Group[] {
  const groups = new Map<string, Group>();
  for (const h of hits) {
    const g = groups.get(h.agentId) ?? {
      agentId: h.agentId,
      name: h.agentName,
      color: h.agentColor,
      data: [],
    };
    g.data.push(h);
    groups.set(h.agentId, g);
  }
  return [...groups.values()];
}

const WHO: Partial<Record<SearchHit['kind'], string>> = {
  user: 'You',
  agent: 'Reply',
  check_in: 'Check-in',
  session: 'Session',
  note: 'Note',
};

/** Snippets are raw message text: drop the markdown marks a reader never sees. */
const plain = (snippet: string) => snippet.replace(/\*\*|__|`+|^#+\s*/gm, '');

export default function Search() {
  const router = useRouter();
  const served = useApp((s) => canCall('agents.search', s.welcome));
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<{ q: string; hits?: SearchHit[]; error?: string } | null>(
    null
  );
  const q = query.trim();
  const active = served && q.length >= 2;

  useEffect(() => {
    if (!active) return;
    let live = true;
    const timer = setTimeout(() => {
      search(q).then(
        (hits) => live && setAnswer({ q, hits }),
        (e: unknown) => live && setAnswer({ q, error: describeError(e) })
      );
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, active]);

  // While the next answer is on its way, the last one stays on screen.
  const busy = active && answer?.q !== q;
  const hits = active ? (answer?.hits ?? null) : null;
  const error = active && !busy ? (answer?.error ?? null) : null;

  const sections = useMemo(() => groupHits(hits ?? []), [hits]);
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Search',
          headerLargeTitle: true,
          headerLargeTitleStyle: { fontFamily: fonts.semibold, color: colors.textWhite },
          headerSearchBarOptions: {
            placeholder: 'Every conversation',
            autoCapitalize: 'none',
            hideWhenScrolling: false,
            textColor: colors.textWhite,
            onChangeText: (e) => setQuery(e.nativeEvent.text),
          },
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(h) => `${h.agentId}:${h.messageId}`}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: space['2xl'] }}
        renderSectionHeader={({ section }) => (
          <View style={styles.group}>
            <AgentAvatar name={section.name} color={section.color} size={22} />
            <T variant="small" color={colors.textWhite} style={{ flex: 1 }}>
              {section.name}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {section.data.length}
            </T>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              tap();
              router.push({
                pathname: '/chat/[id]',
                params: { id: item.agentId, at: item.messageId },
              });
            }}
            style={({ pressed }) => [
              styles.hit,
              pressed && { backgroundColor: colors.surfacePanel },
            ]}
          >
            <View style={styles.hitTop}>
              <T variant="caption" color={colors.textMuted}>
                {item.peerName ?? WHO[item.kind] ?? item.agentName}
              </T>
              <T variant="caption" color={colors.textFaint}>
                {formatAgo(item.ts)}
              </T>
            </View>
            <Highlighted text={plain(item.snippet)} words={words} />
          </Pressable>
        )}
        ListEmptyComponent={
          <Animated.View entering={FadeIn.delay(150)} style={styles.empty}>
            {!served ? (
              <T color={colors.textSecondary}>
                Update Ship Studio on your Mac to search from here.
              </T>
            ) : busy && !hits ? (
              <Spinner />
            ) : error ? (
              <T color={colors.accentErrorLight}>{error}</T>
            ) : hits ? (
              <T color={colors.textSecondary}>Nothing matches “{q}”.</T>
            ) : (
              <T color={colors.textMuted}>
                Every word has to match. Search covers every agent’s conversation on your Mac.
              </T>
            )}
          </Animated.View>
        }
      />
    </>
  );
}

/** The snippet with each searched word in white. */
function Highlighted({ text, words }: { text: string; words: string[] }) {
  const parts = useMemo(() => {
    if (!words.length) return [{ text, on: false }];
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return text
      .split(new RegExp(`(${escaped.join('|')})`, 'gi'))
      .filter(Boolean)
      .map((t) => ({ text: t, on: words.includes(t.toLowerCase()) }));
  }, [text, words]);
  return (
    <T variant="small" color={colors.textSecondary} numberOfLines={3}>
      {parts.map((p, i) =>
        p.on ? (
          <T key={i} variant="small" color={colors.textWhite} style={{ fontFamily: fonts.medium }}>
            {p.text}
          </T>
        ) : (
          p.text
        )
      )}
    </T>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.tight,
  },
  hit: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space['2xs'] },
  hitTop: { flexDirection: 'row', justifyContent: 'space-between' },
  empty: { padding: space.xl, alignItems: 'center' },
});
