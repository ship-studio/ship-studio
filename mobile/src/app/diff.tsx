/**
 * A change card, opened: each file it touched, and that turn's diff of the
 * one you tap (`agents.changeDiff`, the desktop's diff modal). The project
 * and snapshots come from the stored card on the Mac, never from here.
 */

import type { FileDiff } from '@shipstudio/companion-protocol';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Spinner } from '../components/agent';
import { DiffLines } from '../components/diff';
import { Icon, T } from '../components/ui';
import { folderName } from '../lib/agents';
import { changeDiff, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { colors, radius, space } from '../lib/theme';

type Loaded = { diff: FileDiff } | { error: string } | 'loading';

const STATUS = { added: 'New', modified: 'Changed', deleted: 'Deleted' } as const;

export default function Diff() {
  const { agentId, messageId } = useLocalSearchParams<{ agentId: string; messageId: string }>();
  const changes = useApp(
    (s) => s.chats[agentId]?.messages.find((m) => m.id === messageId)?.changes
  );
  const connected = useApp((s) => s.link.kind === 'connected');
  const [open, setOpen] = useState<Record<string, Loaded>>({});

  if (!changes) {
    return (
      <T color={colors.textSecondary} style={styles.note}>
        This change isn’t in the saved chat any more.
      </T>
    );
  }

  const toggle = (path: string) => {
    if (open[path]) {
      const rest = { ...open };
      delete rest[path];
      return setOpen(rest);
    }
    setOpen((o) => ({ ...o, [path]: 'loading' }));
    changeDiff(agentId, messageId, path).then(
      (diff) => setOpen((o) => ({ ...o, [path]: { diff } })),
      (e: unknown) => setOpen((o) => ({ ...o, [path]: { error: describeError(e) } }))
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={{ gap: space['2xs'] }}>
        <T variant="title" color={colors.textWhite}>
          {changes.fileCount} file{changes.fileCount === 1 ? '' : 's'} changed
        </T>
        <T variant="small" color={colors.textSecondary}>
          {[folderName(changes.project), changes.branch, `+${changes.added} −${changes.removed}`]
            .filter(Boolean)
            .join(' · ')}
        </T>
      </View>
      {changes.files.map((f) => {
        const state = open[f.path];
        return (
          <View key={f.path} style={styles.file}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !!state, disabled: !connected && !state }}
              disabled={!connected && !state}
              onPress={() => toggle(f.path)}
              style={({ pressed }) => [styles.fileHead, pressed && { opacity: 0.6 }]}
            >
              <Icon
                name={state ? 'chevron.down' : 'chevron.right'}
                size={11}
                color={colors.textSecondary}
              />
              <T variant="small" color={colors.textWhite} numberOfLines={1} style={{ flex: 1 }}>
                {f.path}
              </T>
              <T variant="caption" color={colors.textSecondary}>
                {STATUS[f.status]}
                {f.added != null && ` +${f.added}`}
                {f.removed != null && ` −${f.removed}`}
              </T>
            </Pressable>
            {state === 'loading' ? (
              <View style={styles.pad}>
                <Spinner size={14} />
              </View>
            ) : state && 'error' in state ? (
              <T variant="small" color={colors.accentErrorLight} style={styles.pad}>
                {state.error}
              </T>
            ) : state ? (
              <Animated.View entering={FadeIn.duration(180)} style={styles.pad}>
                {state.diff.isBinary ? (
                  <T variant="small" color={colors.textSecondary}>
                    A binary file: there’s no text to compare.
                  </T>
                ) : (
                  <DiffLines
                    lines={state.diff.content.replace(/\n$/, '').split('\n')}
                    label={`Diff of ${f.path}`}
                  />
                )}
              </Animated.View>
            ) : null}
          </View>
        );
      })}
      {!connected && (
        <T variant="small" color={colors.textSecondary}>
          Opening a file’s diff needs your Mac.
        </T>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  note: { padding: space.xl, textAlign: 'center' },
  file: {
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceApp,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  fileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 44,
  },
  pad: { paddingHorizontal: space.md, paddingBottom: space.md },
});
