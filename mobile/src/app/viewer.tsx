/**
 * One image, full screen, on black: pinch to zoom, swipe down or Done to
 * close, Share to send it on. An attachment shows the Mac's thumbnail at
 * once and swaps in the full file when that has loaded; a file already on
 * the phone (`uri`, such as a preview screenshot) shows as it is.
 */

import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { T } from '../components/ui';
import { share } from '../lib/files';
import { attachmentSource, describeError, download } from '../lib/session';
import { colors, radius, space } from '../lib/theme';

export default function Viewer() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { agentId, path, name, mime, uri } = useLocalSearchParams<{
    agentId?: string;
    path?: string;
    name: string;
    mime: string;
    uri?: string;
  }>();
  const remote = agentId && path ? { agentId, path } : null;
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doShare = async () => {
    setSharing(true);
    try {
      await share(uri ?? (await download(remote!)), mime);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{ width, height }}
        maximumZoomScale={4}
        minimumZoomScale={1}
        centerContent
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        bouncesZoom
        onScrollEndDrag={(e) => {
          // Pulled down past the top at normal zoom: close, as Photos does.
          if ((e.nativeEvent.zoomScale ?? 1) <= 1 && e.nativeEvent.contentOffset.y < -90)
            router.back();
        }}
      >
        <Image
          source={uri ? { uri } : remote && attachmentSource(remote.agentId, remote.path)}
          placeholder={remote ? attachmentSource(remote.agentId, remote.path, 232) : undefined}
          placeholderContentFit="contain"
          style={{ width, height }}
          contentFit="contain"
          transition={150}
          accessibilityLabel={name}
        />
      </ScrollView>
      <View style={[styles.bar, { paddingTop: insets.top + space.xs }]} pointerEvents="box-none">
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          style={styles.pill}
        >
          <T variant="subhead" color={colors.textWhite}>
            Done
          </T>
        </Pressable>
        <View style={styles.nameWrap}>
          <T variant="small" color={colors.textWhite} numberOfLines={1} style={styles.name}>
            {name}
          </T>
        </View>
        <Pressable
          onPress={() => void doShare()}
          disabled={sharing}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Share"
          style={styles.pill}
        >
          {sharing ? (
            <Spinner size={14} />
          ) : (
            <T variant="subhead" color={colors.textWhite}>
              Share
            </T>
          )}
        </Pressable>
      </View>
      {error && (
        <Pressable
          onPress={() => setError(null)}
          style={[styles.error, { bottom: insets.bottom + space.lg }]}
        >
          <T variant="small" color={colors.textWhite}>
            {error}
          </T>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.black },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  nameWrap: { flex: 1, alignItems: 'center' },
  name: {
    maxWidth: '100%',
    paddingHorizontal: space.md,
    paddingVertical: space.tight,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.scrim,
  },
  pill: {
    minWidth: 64,
    height: 34,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.scrim,
  },
  error: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSelected,
  },
});
