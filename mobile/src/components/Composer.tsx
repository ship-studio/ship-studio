/**
 * The message field. What it will do is always on the button, never hidden
 * behind a gesture:
 *
 * - idle: **Send**;
 * - working, nothing typed: **Stop**;
 * - working, with text: **Queue** (it reads it when this turn ends), with
 *   **Send now** (interrupt, then send) and Stop beside it;
 * - waiting on your OK: **Queue**, and no Stop: the card above is the control;
 * - offline: **Send** waits for the Mac (outbox.ts), and says so.
 *
 * What's typed, quoted and @mentioned is the chat's draft (drafts.ts): it
 * survives leaving the chat and restarting the app. Files attach from the
 * camera, Photos or Files and upload at once, so Send has nothing to wait on.
 */

import {
  MAX_ATTACHMENTS,
  withQuotes,
  type Agent,
  type AgentRef,
} from '@shipstudio/companion-protocol';
import { Image } from 'expo-image';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { needsYou } from '../lib/agents';
import { mentionQuery, sendMode } from '../lib/composer';
import { clearComposer, liveMentions, setComposer, useComposerDraft } from '../lib/drafts';
import {
  admit,
  extensionOf,
  isPreviewableImage,
  pickDocuments,
  pickPhotos,
  takePhoto,
  type PickedFile,
} from '../lib/files';
import { haptic } from '../lib/haptics';
import { OUTBOX_WAIT_MS } from '../lib/outbox';
import { canCall, describeError, send, stop, upload } from '../lib/session';
import { useApp } from '../lib/store';
import type { PendingAttachment } from '../lib/sync';
import { alpha, chromeScale, colors, fonts, lineHeight, radius, space, type } from '../lib/theme';
import { AgentAvatar } from './agent';
import { choose, Icon, ripple, T } from './ui';

interface Staged {
  key: string;
  file: PickedFile;
  progress: number;
  blob?: PendingAttachment;
  error?: string;
}

const NONE: Agent[] = [];

export function Composer({
  agent,
  connected,
  macName,
  onError,
  onSent,
  onHeight,
}: {
  agent: Agent;
  connected: boolean;
  macName: string;
  onError: (text: string) => void;
  onSent: () => void;
  onHeight?: (h: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const draft = useComposerDraft(agent.id);
  const [staged, setStaged] = useState<Staged[]>([]);
  const canAttach = useApp((s) => canCall('agents.files', s.welcome));
  const team = useApp((s) => s.overview?.agents ?? NONE);
  const seq = useRef(0);

  const uploading = staged.some((f) => !f.blob && !f.error);
  const ready = staged.filter((f) => f.blob);
  const hasContent = draft.text.trim().length > 0 || draft.quotes.length > 0 || ready.length > 0;
  const blocked = uploading || staged.some((f) => f.error);
  const mode = sendMode(agent, hasContent);
  const waitingOnYou = needsYou(agent);
  // Offline, Send still works: it waits for the Mac in the outbox.
  const canSend = hasContent && !blocked;
  const offerNow = mode === 'queue' && connected && !waitingOnYou;

  const query = mentionQuery(draft.text);
  const suggestions = useMemo(() => {
    if (query == null) return NONE;
    const q = query.toLowerCase();
    return team
      .filter((a) => a.id !== agent.id && !a.hidden && a.name.toLowerCase().startsWith(q))
      .slice(0, 5);
  }, [query, team, agent.id]);

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

  const setText = (text: string) =>
    setComposer(agent.id, { text, mentions: liveMentions(text, draft.mentions) });

  const pickMention = (peer: AgentRef) => {
    const text = draft.text.replace(/@[\w.-]*$/, `@${peer.name} `);
    const mentions = draft.mentions.some((m) => m.id === peer.id)
      ? draft.mentions
      : [...draft.mentions, { id: peer.id, name: peer.name }];
    setComposer(agent.id, { text, mentions });
    haptic.select();
  };

  const submit = (now: boolean) => {
    if (!canSend) return;
    if (now) haptic.medium();
    else haptic.light();
    const body = withQuotes(draft.quotes, draft.text.trim());
    const mentions = liveMentions(draft.text, draft.mentions).map((m) => m.id);
    const files = ready.map((f) => f.blob!);
    clearComposer(agent.id);
    setStaged([]);
    onSent();
    send(agent.id, body, now && connected, undefined, files, mentions).catch((error: unknown) => {
      haptic.error();
      onError(describeError(error));
    });
  };

  const stopTurn = () => {
    haptic.medium();
    stop(agent.id).catch((error: unknown) => {
      haptic.error();
      onError(describeError(error));
    });
  };

  const hint = !connected
    ? hasContent
      ? `Not connected · Send waits up to ${OUTBOX_WAIT_MS / 60_000} min for ${macName}`
      : 'Not connected · what you type stays here'
    : uploading
      ? `Uploading ${staged.filter((f) => !f.blob && !f.error).length} of ${staged.length}…`
      : mode === 'queue'
        ? waitingOnYou
          ? `${agent.name} reads it after you answer above`
          : `${agent.name} reads it when this turn ends`
        : null;

  return (
    <View
      style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space.sm) }]}
      onLayout={(e: LayoutChangeEvent) => onHeight?.(e.nativeEvent.layout.height)}
    >
      {suggestions.length > 0 && (
        <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)}>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.suggestions}
          >
            {suggestions.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${a.name}`}
                android_ripple={ripple}
                onPress={() => pickMention(a)}
                style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
              >
                <AgentAvatar name={a.name} color={a.color} size={22} />
                <T variant="small" color={colors.textPrimary} maxFontSizeMultiplier={chromeScale}>
                  {a.name}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      )}
      {(hint || offerNow) && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(100)}
          layout={LinearTransition.duration(150)}
          style={styles.hintRow}
        >
          <T variant="caption" color={colors.textSecondary} style={styles.hint}>
            {hint}
          </T>
          {offerNow && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Send now: interrupt ${agent.name} and send`}
              disabled={!canSend}
              onPress={() => submit(true)}
              android_ripple={ripple}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={({ pressed }) => [styles.nowChip, pressed && styles.pressed]}
            >
              <T variant="caption" color={colors.textWhite} maxFontSizeMultiplier={chromeScale}>
                Send now
              </T>
            </Pressable>
          )}
        </Animated.View>
      )}
      {draft.quotes.length > 0 && (
        <View style={styles.quotes}>
          {draft.quotes.map((q, i) => (
            <Animated.View
              key={q}
              entering={FadeIn.duration(150)}
              exiting={FadeOut.duration(100)}
              layout={LinearTransition.duration(150)}
              style={styles.quote}
            >
              <T variant="small" color={colors.textSecondary} numberOfLines={2} style={{ flex: 1 }}>
                {q}
              </T>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove quote"
                hitSlop={14}
                onPress={() =>
                  setComposer(agent.id, { quotes: draft.quotes.filter((_, j) => j !== i) })
                }
              >
                <Icon name="xmark" size={11} color={colors.textMuted} fallback={<T>×</T>} />
              </Pressable>
            </Animated.View>
          ))}
        </View>
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
            onPress={attach}
            style={styles.hit}
          >
            {({ pressed }) => (
              <View
                style={[
                  styles.round,
                  styles.attach,
                  (!connected || staged.length >= MAX_ATTACHMENTS) && styles.off,
                  pressed && { backgroundColor: colors.surfaceControlHover },
                ]}
              >
                <Icon name="plus" size={17} color={colors.textPrimary} fallback={<T>+</T>} />
              </View>
            )}
          </Pressable>
        )}
        <View style={styles.field}>
          <TextInput
            // A new text size remounts the field, so it never keeps a stale height.
            key={`input-${fontScale}`}
            value={draft.text}
            onChangeText={setText}
            placeholder={`Message ${agent.name}`}
            placeholderTextColor={colors.textMuted}
            multiline
            style={styles.input}
            selectionColor={colors.accentActive}
            keyboardAppearance="dark"
            accessibilityLabel={`Message ${agent.name}`}
          />
          {mode === 'queue' && !waitingOnYou && (
            <RoundButton
              label={`Stop ${agent.name}`}
              disabled={!connected}
              onPress={stopTurn}
              tone="quiet"
            >
              <View style={styles.stopSquare} />
            </RoundButton>
          )}
          {mode === 'stop' ? (
            <RoundButton
              key="stop"
              label={`Stop ${agent.name}`}
              disabled={!connected}
              onPress={stopTurn}
              tone="quiet"
            >
              <View style={styles.stopSquare} />
            </RoundButton>
          ) : mode === 'queue' ? (
            <Animated.View key="queue" entering={ZoomIn.duration(160)}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Queue: ${agent.name} reads it when this turn ends`}
                disabled={!canSend}
                onPress={() => submit(false)}
                style={styles.hit}
              >
                {({ pressed }) => (
                  <View
                    style={[
                      styles.queue,
                      !canSend && styles.off,
                      pressed && { transform: [{ scale: 0.95 }] },
                    ]}
                  >
                    <T
                      variant="small"
                      color={colors.textOnAccent}
                      style={{ fontFamily: fonts.semibold }}
                      maxFontSizeMultiplier={chromeScale}
                    >
                      Queue
                    </T>
                    <Icon name="arrow.up" size={13} color={colors.textOnAccent} />
                  </View>
                )}
              </Pressable>
            </Animated.View>
          ) : (
            <RoundButton
              key="send"
              label={connected ? 'Send' : `Send when ${macName} answers`}
              disabled={!canSend}
              onPress={() => submit(false)}
              tone={canSend ? 'accent' : 'off'}
            >
              <Icon
                name="arrow.up"
                size={16}
                color={canSend ? colors.textOnAccent : colors.textMuted}
                fallback={<T color={canSend ? colors.textOnAccent : colors.textMuted}>↑</T>}
              />
            </RoundButton>
          )}
        </View>
      </View>
    </View>
  );
}

/** A 34pt circle inside a 44pt target. */
function RoundButton({
  label,
  disabled,
  onPress,
  tone,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  tone: 'accent' | 'quiet' | 'off';
  children: ReactNode;
}) {
  return (
    <Animated.View entering={ZoomIn.duration(160)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        style={styles.hit}
      >
        {({ pressed }) => (
          <View
            style={[
              styles.round,
              {
                backgroundColor: tone === 'accent' ? colors.accentActive : colors.surfaceSelected,
              },
              disabled && tone !== 'off' && styles.off,
              pressed && { transform: [{ scale: 0.92 }] },
            ]}
          >
            {children}
          </View>
        )}
      </Pressable>
    </Animated.View>
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
            <T
              variant="caption"
              color={colors.textSecondary}
              numberOfLines={2}
              style={styles.tileName}
            >
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
        hitSlop={12}
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
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginLeft: space.md,
    marginRight: space.xs,
  },
  hint: { flex: 1 },
  nowChip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSelected,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: colors.surfaceControlHover },
  suggestions: { gap: space.sm, paddingHorizontal: space.xs },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  quotes: { gap: space.xs },
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginLeft: space['2xl'] + space.md,
    marginRight: space.md,
    paddingLeft: space.md,
    paddingVertical: space.xs,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.xs },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  attach: {
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  off: { opacity: 0.4 },
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
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.lg + 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingLeft: space.lg,
    paddingRight: space['2xs'],
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textPrimary,
    maxHeight: lineHeight(type.body, 1.35) * 6 + space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  round: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    height: 34,
    paddingHorizontal: space.md,
    borderRadius: 17,
    backgroundColor: colors.accentActive,
  },
  stopSquare: { width: 11, height: 11, borderRadius: 2, backgroundColor: colors.textPrimary },
});
