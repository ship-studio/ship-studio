/**
 * A long-press menu. iOS gets the system action sheet; Android gets a
 * Material bottom sheet with icons and ripples (an Alert there holds three
 * buttons at most). Rows on iOS use the native context menu instead (see
 * the Agents list); this is for everything that isn't a link.
 */

import { useSyncExternalStore } from 'react';
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Action } from '../lib/actions';
import { colors, radius, space } from '../lib/theme';
import { Icon, ripple, T } from './ui';

interface Open {
  title?: string;
  actions: Action<string>[];
  run: (id: string) => void;
}

let open: Open | null = null;
const listeners = new Set<() => void>();
const set = (next: Open | null) => {
  open = next;
  listeners.forEach((l) => l());
};

export function showActions<Id extends string>(
  title: string | undefined,
  actions: Action<Id>[],
  run: (id: Id) => void
) {
  if (!actions.length) return;
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...actions.map((a) => a.title), 'Cancel'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.flatMap((a, i) => (a.destructive ? [i] : [])),
        userInterfaceStyle: 'dark',
      },
      (i) => {
        const a = actions[i];
        if (a) run(a.id);
      }
    );
    return;
  }
  set({ title, actions, run: run as (id: string) => void });
}

/** Mounted once at the root; draws the Android sheet when one is open. */
export function MenuHost() {
  const insets = useSafeAreaInsets();
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open
  );
  if (Platform.OS === 'ios') return null;
  return (
    <Modal transparent visible={!!current} onRequestClose={() => set(null)} animationType="none">
      {current && (
        <View style={StyleSheet.absoluteFill}>
          <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(150)}>
            <Pressable
              style={[StyleSheet.absoluteFill, styles.scrim]}
              onPress={() => set(null)}
              accessibilityLabel="Close menu"
            />
          </Animated.View>
          <Animated.View
            entering={SlideInDown.duration(220)}
            exiting={SlideOutDown.duration(160)}
            style={[styles.sheet, { paddingBottom: insets.bottom + space.sm }]}
          >
            {!!current.title && (
              <T
                variant="small"
                color={colors.textSecondary}
                style={styles.title}
                numberOfLines={2}
              >
                {current.title}
              </T>
            )}
            {current.actions.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="menuitem"
                android_ripple={ripple}
                onPress={() => {
                  set(null);
                  current.run(a.id);
                }}
                style={styles.item}
              >
                <Icon
                  name={a.icon}
                  size={20}
                  color={a.destructive ? colors.accentErrorLight : colors.textSecondary}
                />
                <T color={a.destructive ? colors.accentErrorLight : colors.textPrimary}>
                  {a.title}
                </T>
              </Pressable>
            ))}
          </Animated.View>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: colors.scrim },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surfacePanel,
    borderTopLeftRadius: radius.lg + 8,
    borderTopRightRadius: radius.lg + 8,
    paddingTop: space.sm,
  },
  title: { paddingHorizontal: space.xl, paddingVertical: space.md },
  item: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.xl,
  },
});
