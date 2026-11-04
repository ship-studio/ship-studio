/**
 * Everything shared in one conversation, both ways, newest first: the
 * desktop's Files list. All / You / Agent; images as thumbnails, documents
 * open in Quick Look; long-press to share.
 */

import type { SharedFile } from '@shipstudio/companion-protocol';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Spinner } from '../../components/agent';
import { openFile } from '../../components/attachments';
import { choose, Segmented, T, tap } from '../../components/ui';
import { formatAgo } from '../../lib/agents';
import { extensionOf, formatSize, isPreviewableImage, share } from '../../lib/files';
import { attachmentSource, describeError, download, listFiles } from '../../lib/session';
import { useApp } from '../../lib/store';
import { colors, radius, space } from '../../lib/theme';

type Filter = 'all' | 'user' | 'agent';

export default function Files() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const agentName = useApp((s) => s.overview?.agents.find((a) => a.id === id)?.name ?? 'Agent');
  const [files, setFiles] = useState<SharedFile[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      listFiles(id).then(
        (f) => {
          setFiles(f);
          setError(null);
        },
        (e: unknown) => setError(describeError(e))
      ),
    [id]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (files ?? []).filter((f) => filter === 'all' || f.from === filter),
    [files, filter]
  );

  const open = async (f: SharedFile) => {
    tap();
    if (isPreviewableImage(f.mime)) {
      router.push({
        pathname: '/viewer',
        params: { agentId: id, path: f.path, name: f.name, mime: f.mime },
      });
      return;
    }
    setOpening(f.path);
    try {
      await openFile(id, f);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setOpening(null);
    }
  };

  const shareFile = async (f: SharedFile) => {
    setOpening(f.path);
    try {
      await share(await download({ agentId: id, path: f.path }), f.mime);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <FlatList
      data={shown}
      keyExtractor={(f) => f.path}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space['2xl'] }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textMuted}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
      ListHeaderComponent={
        <View style={styles.head}>
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'user', label: 'You' },
              { value: 'agent', label: agentName },
            ]}
          />
          {error && (
            <T variant="small" color={colors.accentErrorLight}>
              {error}
            </T>
          )}
        </View>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          {files == null ? (
            <Spinner />
          ) : (
            <T color={colors.textSecondary}>
              {filter === 'user'
                ? `You haven’t sent ${agentName} any files.`
                : filter === 'agent'
                  ? `${agentName} hasn’t shared any files.`
                  : 'No files in this conversation yet.'}
            </T>
          )}
        </View>
      }
      renderItem={({ item, index }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${formatSize(item.size)}`}
          onPress={() => void open(item)}
          onLongPress={() =>
            choose(item.name, [
              { label: 'Open', run: () => void open(item) },
              { label: 'Share…', run: () => void shareFile(item) },
            ])
          }
          style={({ pressed }) => [
            styles.row,
            index > 0 && styles.divider,
            pressed && { backgroundColor: colors.surfacePanel },
          ]}
        >
          <View style={styles.thumb}>
            {isPreviewableImage(item.mime) ? (
              <Image
                source={attachmentSource(id, item.path, 48)}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={150}
              />
            ) : opening === item.path ? (
              <Spinner size={14} />
            ) : (
              <T variant="caption" color={colors.textSecondary} style={styles.ext}>
                {extensionOf(item.name)}
              </T>
            )}
          </View>
          <View style={{ flex: 1, gap: space['2xs'] }}>
            <T color={colors.textWhite} numberOfLines={1}>
              {item.name}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {item.from === 'user' ? 'You' : agentName} · {formatSize(item.size)} ·{' '}
              {formatAgo(item.ts)}
            </T>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  head: { padding: space.lg, gap: space.md },
  empty: { padding: space.xl, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: radius.card,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  ext: { fontSize: 10, letterSpacing: 0.4 },
});
