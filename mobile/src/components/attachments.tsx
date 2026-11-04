/**
 * Files in a conversation. Images show inline as the Mac's thumbnails (one
 * at its own shape, several as a grid) and open in the photo viewer; any
 * other file is a chip that opens in Quick Look, and long-press shares it.
 * Everything is fetched with this phone's token, and cached once fetched.
 */

import type { Attachment } from '@shipstudio/companion-protocol';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { extensionOf, formatSize, isPreviewableImage, preview, share } from '../lib/files';
import { attachmentSource, describeError, download } from '../lib/session';
import { colors, radius, space } from '../lib/theme';
import { Spinner } from './agent';
import { choose, T, tap } from './ui';

/** Either a file on the Mac, or (before the Mac has it) the phone's own copy. */
export type Shown = Attachment & { localUri?: string };

const ONE_WIDE = 232;
const TILE = 112;

export function Attachments({
  agentId,
  attachments,
  align = 'left',
  width = ONE_WIDE,
  onError,
}: {
  agentId: string;
  attachments: Shown[];
  align?: 'left' | 'right';
  /** A lone image's width; a phone screenshot reads fine smaller. */
  width?: number;
  onError?: (text: string) => void;
}) {
  const images = attachments.filter((a) => isPreviewableImage(a.mime));
  const others = attachments.filter((a) => !isPreviewableImage(a.mime));
  const end = align === 'right' ? 'flex-end' : 'flex-start';
  return (
    <View style={{ gap: space.tight, alignItems: end }}>
      {images.length === 1 ? (
        <Thumb agentId={agentId} file={images[0]} width={width} />
      ) : images.length > 1 ? (
        <View style={[styles.grid, { justifyContent: end }]}>
          {images.map((a) => (
            <Thumb key={a.path || a.localUri} agentId={agentId} file={a} width={TILE} square />
          ))}
        </View>
      ) : null}
      {others.map((a) => (
        <FileChip key={a.path || a.localUri} agentId={agentId} file={a} onError={onError} />
      ))}
    </View>
  );
}

function Thumb({
  agentId,
  file,
  width,
  square,
}: {
  agentId: string;
  file: Shown;
  width: number;
  square?: boolean;
}) {
  const router = useRouter();
  // Until it loads its shape is unknown; then it keeps its own, within reason.
  const [ratio, setRatio] = useState(square ? 1 : 4 / 3);
  const source = file.localUri
    ? { uri: file.localUri }
    : attachmentSource(agentId, file.path, width);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`${file.name}, image`}
      disabled={!!file.localUri}
      onPress={() => {
        tap();
        router.push({
          pathname: '/viewer',
          params: { agentId, path: file.path, name: file.name, mime: file.mime },
        });
      }}
      style={({ pressed }) => [
        styles.thumb,
        { width, aspectRatio: ratio },
        pressed && styles.pressed,
      ]}
    >
      <Image
        source={source}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={180}
        recyclingKey={file.path || file.localUri}
        onLoad={(e) => {
          if (square) return;
          const { width: w, height: h } = e.source;
          if (w && h) setRatio(Math.min(1.8, Math.max(0.62, w / h)));
        }}
      />
    </Pressable>
  );
}

/** Open a file the way the phone opens files: Quick Look for documents. */
export async function openFile(agentId: string, file: Attachment) {
  const uri = await download({ agentId, path: file.path });
  await preview(uri, file.mime);
}

export function FileChip({
  agentId,
  file,
  onError,
}: {
  agentId: string;
  file: Shown;
  onError?: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (action: 'open' | 'share') => {
    if (file.localUri || busy) return;
    setBusy(true);
    try {
      if (action === 'open') await openFile(agentId, file);
      else await share(await download({ agentId, path: file.path }), file.mime);
    } catch (error) {
      onError?.(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${formatSize(file.size)}. Opens in Quick Look`}
      onPress={() => {
        tap();
        void run('open');
      }}
      onLongPress={() =>
        choose(file.name, [
          { label: 'Open', run: () => void run('open') },
          { label: 'Share…', run: () => void run('share') },
        ])
      }
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      <View style={styles.badge}>
        {busy ? (
          <Spinner size={12} />
        ) : (
          <T variant="caption" color={colors.textSecondary} style={styles.badgeText}>
            {extensionOf(file.name)}
          </T>
        )}
      </View>
      <View style={{ flexShrink: 1 }}>
        <T variant="small" color={colors.textWhite} numberOfLines={1}>
          {file.name}
        </T>
        <T variant="caption" color={colors.textMuted}>
          {formatSize(file.size)}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.tight,
    maxWidth: TILE * 2 + space.tight,
  },
  thumb: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    maxWidth: 280,
    paddingVertical: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  badge: {
    width: 38,
    height: 38,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  badgeText: { letterSpacing: 0.4, fontSize: 10 },
});
