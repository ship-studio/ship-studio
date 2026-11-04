/**
 * The message field. Files attach from the camera, Photos or Files and
 * upload at once, with progress, so Send has nothing left to wait for.
 * While the agent works, an empty field offers Stop; with
 * text, Send queues it for the next turn and holding Send interrupts and
 * sends now (the desktop's ↵ and ⌘↵). Offline, what you typed stays here
 * until you send it yourself: a message arriving hours later is worse than
 * one that waits.
 */

import { MAX_ATTACHMENTS, type Agent } from '@shipstudio/companion-protocol';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  admit,
  extensionOf,
  isPreviewableImage,
  pickDocuments,
  pickPhotos,
  takePhoto,
  type PickedFile,
} from '../lib/files';
import { canCall, describeError, send, stop, upload } from '../lib/session';
import { useApp } from '../lib/store';
import type { PendingAttachment } from '../lib/sync';
import { alpha, colors, fonts, lineHeight, radius, space, type } from '../lib/theme';
import { choose, Icon, T } from './ui';

interface Staged {
  key: string;
  file: PickedFile;
  progress: number;
  blob?: PendingAttachment;
  error?: string;
}

export function Composer({
  agent,
  connected,
  onError,
  onSent,
}: {
  agent: Agent;
  connected: boolean;
  onError: (text: string) => void;
  onSent: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const canAttach = useApp((s) => canCall('agents.files', s.welcome));
  const seq = useRef(0);
  const working = agent.status.state !== 'idle';
  const uploading = staged.some((f) => !f.blob && !f.error);
  const ready = staged.filter((f) => f.blob);
  const canSend =
    connected &&
    !uploading &&
    (text.trim().length > 0 || ready.length > 0) &&
    !staged.some((f) => f.error);

  const patch = (key: string, change: Partial<Staged>) =>
    setStaged((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)));

  const start = (item: Staged) =>
    upload(item.file, (progress) => patch(item.key, { progress }))
      .then((ref) =>
        patch(item.key, {
          progress: 1,
          error: undefined,
          blob: {
            blobId: ref.blobId,
            uri: item.file.uri,
            name: ref.name,
            mime: ref.mime,
            size: ref.size,
          },
        })
      )
      .catch((error: unknown) => patch(item.key, { error: describeError(error) }));

  const add = (files: PickedFile[]) => {
    const { kept, refused } = admit(files, MAX_ATTACHMENTS - staged.length);
    if (refused) onError(refused);
    const items = kept.map((file) => ({ key: `f${seq.current++}`, file, progress: 0 }));
    setStaged((list) => [...list, ...items]);
    items.forEach((item) => void start(item));
  };

  const attach = () =>
    choose(undefined, [
      {
        label: 'Take Photo',
        run: () => void takePhoto().then(add, (e: Error) => onError(e.message)),
      },
      {
        label: 'Photo Library',
        run: () =>
          void pickPhotos(MAX_ATTACHMENTS - staged.length).then(add, (e: Error) =>
            onError(e.message)
          ),
      },
      {
        label: 'Choose File',
        run: () => void pickDocuments().then(add, (e: Error) => onError(e.message)),
      },
    ]);

  const submit = (now: boolean) => {
    const body = text.trim();
    if (!canSend) return;
    void Haptics.impactAsync(
      now ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light
    );
    const files = ready.map((f) => f.blob!);
    setText('');
    setStaged([]);
    onSent();
    send(agent.id, body, now, undefined, files).catch((error: unknown) =>
      onError(describeError(error))
    );
  };

  const hint = !connected
    ? 'Not connected · what you type stays here'
    : uploading
      ? `Uploading ${staged.filter((f) => !f.blob && !f.error).length} of ${staged.length}…`
      : working && canSend
        ? `Sends when ${agent.name} finishes · hold to interrupt and send now`
        : null;

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      {hint && (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(100)}>
          <T variant="caption" color={colors.textMuted} style={styles.hint}>
            {hint}
          </T>
        </Animated.View>
      )}
      {staged.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tray}
          keyboardShouldPersistTaps="handled"
        >
          {staged.map((f) => (
            <Animated.View
              key={f.key}
              entering={ZoomIn.duration(160)}
              exiting={ZoomOut.duration(120)}
              layout={LinearTransition.duration(160)}
            >
              <StagedTile
                item={f}
                onRemove={() => setStaged((list) => list.filter((x) => x.key !== f.key))}
                onRetry={() => {
                  patch(f.key, { error: undefined, progress: 0 });
                  void start(f);
                }}
              />
            </Animated.View>
          ))}
        </ScrollView>
      )}
      <View style={styles.row}>
        {canAttach && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach files"
            disabled={!connected || staged.length >= MAX_ATTACHMENTS}
            onPress={() => {
              void Haptics.selectionAsync();
              attach();
            }}
            style={({ pressed }) => [
              styles.round,
              styles.attach,
              (!connected || staged.length >= MAX_ATTACHMENTS) && { opacity: 0.4 },
              pressed && { backgroundColor: colors.surfaceControlHover },
            ]}
          >
            <Icon name="plus" size={17} color={colors.textPrimary} fallback={<T>+</T>} />
          </Pressable>
        )}
        <View style={styles.field}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={`Message ${agent.name}`}
            placeholderTextColor={colors.textMuted}
            multiline
            style={styles.input}
            selectionColor={colors.accentActive}
            keyboardAppearance="dark"
            accessibilityLabel={`Message ${agent.name}`}
          />
          {working && !text.trim() ? (
            <Animated.View entering={ZoomIn.duration(160)} key="stop">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Stop ${agent.name}`}
                disabled={!connected}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  stop(agent.id).catch((error: unknown) => onError(describeError(error)));
                }}
                style={({ pressed }) => [styles.round, styles.stop, pressed && { opacity: 0.7 }]}
              >
                <View style={styles.stopSquare} />
              </Pressable>
            </Animated.View>
          ) : (
            <Animated.View entering={ZoomIn.duration(160)} key="send">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  working ? 'Send after this turn. Hold to interrupt and send now' : 'Send'
                }
                disabled={!canSend}
                onPress={() => submit(false)}
                onLongPress={working ? () => submit(true) : undefined}
                delayLongPress={350}
                style={({ pressed }) => [
                  styles.round,
                  { backgroundColor: canSend ? colors.accentActive : colors.surfaceSelected },
                  pressed && { transform: [{ scale: 0.92 }] },
                ]}
              >
                <Icon
                  name="arrow.up"
                  size={16}
                  color={canSend ? colors.textOnAccent : colors.textMuted}
                  fallback={<T color={canSend ? colors.textOnAccent : colors.textMuted}>↑</T>}
                />
              </Pressable>
            </Animated.View>
          )}
        </View>
      </View>
    </View>
  );
}

/** One file waiting to go: its picture or type, how far the upload is, and ×. */
function StagedTile({
  item,
  onRemove,
  onRetry,
}: {
  item: Staged;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { file, progress, blob, error } = item;
  return (
    <View style={styles.tile}>
      <Pressable
        disabled={!error}
        onPress={onRetry}
        accessibilityLabel={error ? `${file.name} didn’t upload. Tap to try again` : file.name}
        style={styles.tileBody}
      >
        {isPreviewableImage(file.mime) ? (
          <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={styles.tileFile}>
            <T variant="caption" color={colors.textSecondary} style={styles.tileExt}>
              {extensionOf(file.name)}
            </T>
            <T variant="caption" color={colors.textMuted} numberOfLines={2} style={styles.tileName}>
              {file.name}
            </T>
          </View>
        )}
        {!blob && (
          <View style={[StyleSheet.absoluteFill, styles.tileVeil]}>
            {error ? (
              <Icon name="arrow.clockwise" size={16} color={colors.textWhite} fallback={<T>↻</T>} />
            ) : (
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.max(6, progress * 100)}%` }]} />
              </View>
            )}
          </View>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${file.name}`}
        hitSlop={8}
        onPress={onRemove}
        style={styles.remove}
      >
        <Icon
          name="xmark"
          size={9}
          color={colors.textWhite}
          fallback={<T variant="caption">×</T>}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: colors.surfaceApp,
    gap: space.tight,
  },
  hint: { marginLeft: space.md },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  attach: {
    marginBottom: space.tight,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  tray: { gap: space.sm, paddingTop: space.tight, paddingHorizontal: space.xs },
  tile: { width: 64, height: 64, marginTop: space.tight, marginRight: space.tight },
  tileBody: {
    flex: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  tileFile: { flex: 1, padding: space.tight, justifyContent: 'space-between' },
  tileExt: { fontSize: 10, letterSpacing: 0.4 },
  tileName: { fontSize: 10, lineHeight: 12 },
  tileVeil: {
    backgroundColor: alpha(colors.surfaceApp, 0.55),
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    width: 40,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: alpha(colors.textWhite, 0.25),
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.textWhite },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSelected,
    borderWidth: 2,
    borderColor: colors.surfaceApp,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.lg + 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingLeft: space.lg,
    paddingRight: space.tight,
    paddingVertical: space.tight,
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textPrimary,
    maxHeight: lineHeight(type.body, 1.35) * 6 + space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  round: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stop: { backgroundColor: colors.surfaceSelected },
  stopSquare: { width: 11, height: 11, borderRadius: 2, backgroundColor: colors.textPrimary },
});
