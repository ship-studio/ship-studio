/**
 * Lines of a diff in mono, additions and removals tinted, never re-wrapped:
 * long lines scroll sideways, so what's shown is exactly what changes.
 */

import { ScrollView, StyleSheet, View } from 'react-native';
import { diffLineKind, type DiffLineKind } from '../lib/diff';
import { alpha, colors, radius, space } from '../lib/theme';
import { T } from './ui';

const tint: Record<DiffLineKind, { fg: string; bg?: string }> = {
  add: { fg: colors.accentSuccess, bg: alpha(colors.accentSuccess, 0.1) },
  del: { fg: colors.accentErrorLight, bg: alpha(colors.accentError, 0.1) },
  hunk: { fg: colors.textMuted },
  context: { fg: colors.textPrimary },
};

export function DiffLines({ lines, label }: { lines: string[]; label?: string }) {
  return (
    <View style={styles.box} accessibilityLabel={label}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.inner}>
          {lines.map((line, i) => {
            const t = tint[diffLineKind(line)];
            return (
              <T
                key={i}
                variant="mono"
                color={t.fg}
                selectable
                maxFontSizeMultiplier={2}
                style={[styles.line, t.bg ? { backgroundColor: t.bg } : null]}
              >
                {line || ' '}
              </T>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.surfaceApp, borderRadius: radius.card, overflow: 'hidden' },
  inner: { paddingVertical: space.sm, minWidth: '100%' },
  line: { paddingHorizontal: space.md },
});
