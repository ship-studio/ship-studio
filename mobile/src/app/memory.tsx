/**
 * An agent's memory, from its sheet: every entry by group, as the desk's
 * Edit agent → Memory lists them. Tap one to edit or forget it (with Undo),
 * add another at the bottom. Each change is the desk's own `agents_memory_change`,
 * named by position and words, so an entry that moved meanwhile is refused
 * rather than the wrong one changed.
 */

import {
  groupMemory,
  undoDelete,
  type MemoryChange,
  type MemoryEntry,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Spinner } from '../components/agent';
import { Button, choose, Icon, T } from '../components/ui';
import { haptic } from '../lib/haptics';
import { changeMemory, describeError, readMemory } from '../lib/session';
import { useApp } from '../lib/store';
import { colors, fonts, radius, space, type } from '../lib/theme';

const MAX = 2_000;
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

export default function Memory() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const name = useApp((s) => s.overview?.agents.find((a) => a.id === id)?.name ?? 'This agent');
  const connected = useApp((s) => s.link.kind === 'connected');
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ label: string; change: MemoryChange } | null>(null);

  const reload = useCallback(
    () =>
      readMemory(id).then(
        (v) => setEntries(v.entries),
        (e: unknown) => setError(describeError(e))
      ),
    [id]
  );
  useEffect(() => {
    if (connected && entries === null) void reload();
  }, [connected, entries, reload]);

  /** Apply a change; on a refusal, say why and show the memory as it is now. */
  const apply = async (change: MemoryChange) => {
    setBusy(true);
    setError(null);
    try {
      const view = await changeMemory(id, change);
      setEntries(view.entries);
      return view;
    } catch (e) {
      haptic.error();
      setError(describeError(e));
      await reload();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const forget = async (index: number) => {
    if (!entries) return;
    const before = entries;
    const view = await apply({ op: 'delete', index, original: before[index].text });
    if (!view) return;
    haptic.warning();
    setUndo({
      label: `Forgot “${clip(before[index].text)}”`,
      change: undoDelete(before, index, view.removed),
    });
  };

  const saveEdit = async (index: number) => {
    if (!entries) return;
    const original = entries[index].text;
    const text = draft.trim();
    if (!text || text === original) return setEditing(null);
    const view = await apply({ op: 'edit', index, original, text });
    if (!view) return;
    haptic.success();
    setEditing(null);
    const now = view.entries[index]?.text ?? text;
    setUndo({
      label: 'Memory updated',
      change: { op: 'edit', index, original: now, text: original },
    });
  };

  const add = async () => {
    const text = adding.trim();
    if (!text) return;
    if (await apply({ op: 'add', text })) {
      haptic.success();
      setAdding('');
      setUndo(null);
    }
  };

  const menu = (entry: MemoryEntry, index: number) =>
    choose(clip(entry.text), [
      {
        label: 'Edit',
        run: () => {
          setDraft(entry.text);
          setEditing(index);
        },
      },
      { label: 'Forget', destructive: true, run: () => void forget(index) },
    ]);

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <T variant="title" color={colors.textWhite}>
        Memory
      </T>
      <T variant="small" color={colors.textSecondary}>
        What {name} remembers between conversations. It reads this at the start of every one, and
        keeps it up to date itself.
      </T>
      {error && (
        <T variant="small" color={colors.accentErrorLight}>
          {error}
        </T>
      )}
      {undo && (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut} style={styles.undo}>
          <T variant="small" color={colors.textPrimary} style={{ flex: 1 }} numberOfLines={1}>
            {undo.label}
          </T>
          <Button
            title="Undo"
            size="compact"
            variant="ghost"
            disabled={busy || !connected}
            onPress={() => {
              const change = undo.change;
              setUndo(null);
              void apply(change);
            }}
          />
        </Animated.View>
      )}
      {entries === null
        ? !error && (
            <View style={styles.center}>
              {connected ? (
                <Spinner />
              ) : (
                <T color={colors.textSecondary}>Reading it needs your Mac.</T>
              )}
            </View>
          )
        : groupMemory(entries).map((group) => (
            <Animated.View
              key={group.title ?? ''}
              layout={LinearTransition.duration(200)}
              style={{ gap: space.xs }}
            >
              {group.title && (
                <T variant="caption" color={colors.textMuted} style={styles.heading}>
                  {group.title.toUpperCase()}
                </T>
              )}
              <View style={styles.list}>
                {group.items.length === 0 ? (
                  <T variant="small" color={colors.textMuted} style={styles.row}>
                    Nothing yet. Add something below, or use “Remember this” on a message.
                  </T>
                ) : (
                  group.items.map(({ entry, index }, i) =>
                    editing === index ? (
                      <View
                        key={index}
                        style={[styles.row, i > 0 && styles.divider, styles.editing]}
                      >
                        <TextInput
                          autoFocus
                          multiline
                          value={draft}
                          onChangeText={setDraft}
                          maxLength={MAX}
                          editable={!busy}
                          keyboardAppearance="dark"
                          selectionColor={colors.accentActive}
                          accessibilityLabel="Edit memory"
                          style={styles.input}
                        />
                        <View style={styles.editActions}>
                          <Button
                            title="Cancel"
                            size="compact"
                            variant="ghost"
                            onPress={() => setEditing(null)}
                          />
                          <Button
                            title="Save"
                            size="compact"
                            variant="primary"
                            busy={busy}
                            disabled={!connected || !draft.trim()}
                            onPress={() => void saveEdit(index)}
                          />
                        </View>
                      </View>
                    ) : (
                      <Pressable
                        key={index}
                        disabled={!connected || busy}
                        onPress={() => menu(entry, index)}
                        accessibilityRole="button"
                        accessibilityHint="Edit or forget"
                        style={({ pressed }) => [
                          styles.row,
                          styles.entry,
                          i > 0 && styles.divider,
                          pressed && { backgroundColor: colors.surfaceControl },
                        ]}
                      >
                        <T color={colors.textPrimary} style={{ flex: 1 }} selectable>
                          {entry.text}
                        </T>
                        <Icon name="ellipsis" size={14} color={colors.textMuted} />
                      </Pressable>
                    )
                  )
                )}
              </View>
            </Animated.View>
          ))}
      {entries !== null && (
        <View style={styles.add}>
          <TextInput
            value={adding}
            onChangeText={setAdding}
            maxLength={MAX}
            placeholder={`Something ${name} should remember`}
            placeholderTextColor={colors.textMuted}
            editable={connected && !busy}
            keyboardAppearance="dark"
            selectionColor={colors.accentActive}
            returnKeyType="done"
            onSubmitEditing={() => void add()}
            style={[styles.input, { flex: 1 }]}
          />
          <Button
            title="Add"
            size="compact"
            variant="primary"
            disabled={!connected || busy || !adding.trim()}
            onPress={() => void add()}
          />
        </View>
      )}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  center: { paddingVertical: space.xl, alignItems: 'center' },
  heading: { marginLeft: space.lg, letterSpacing: 0.4 },
  list: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  row: { paddingHorizontal: space.lg, paddingVertical: space.md },
  entry: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  editing: { gap: space.sm },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  undo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSelected,
  },
  add: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceControl,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
});
