/**
 * The few primitives every screen shares: text in the type scale, the
 * semantic button family (primary / secondary / ghost / danger, as on the
 * desktop), an SF Symbol, and the status dot.
 */

import * as Haptics from 'expo-haptics';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { alpha, colors, fonts, lineHeight, radius, space, type } from '../lib/theme';
import type { Tone } from '../lib/connection';

type Variant = 'body' | 'small' | 'caption' | 'subhead' | 'title' | 'display' | 'mono';

const variants = StyleSheet.create({
  body: { fontFamily: fonts.regular, fontSize: type.body, lineHeight: lineHeight(type.body, 1.5) },
  small: { fontFamily: fonts.regular, fontSize: type.small, lineHeight: lineHeight(type.small) },
  caption: {
    fontFamily: fonts.regular,
    fontSize: type.caption,
    lineHeight: lineHeight(type.caption),
  },
  subhead: {
    fontFamily: fonts.medium,
    fontSize: type.subhead,
    lineHeight: lineHeight(type.subhead, 1.3),
  },
  title: {
    fontFamily: fonts.semibold,
    fontSize: type.title,
    lineHeight: lineHeight(type.title, 1.3),
  },
  display: {
    fontFamily: fonts.semibold,
    fontSize: type.display,
    lineHeight: lineHeight(type.display, 1.2),
    letterSpacing: -0.4,
  },
  mono: { fontFamily: fonts.mono, fontSize: type.small, lineHeight: lineHeight(type.small, 1.5) },
});

export function T({
  variant = 'body',
  color = colors.textPrimary,
  style,
  ...rest
}: TextProps & { variant?: Variant; color?: string }) {
  return <Text {...rest} style={[variants[variant], { color }, style]} />;
}

export const tap = () => void Haptics.selectionAsync();

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonColors: Record<
  ButtonVariant,
  { bg: string; pressed: string; fg: string; border?: string }
> = {
  primary: { bg: colors.accentActive, pressed: colors.accentSuccess, fg: colors.textOnAccent },
  secondary: {
    bg: 'transparent',
    pressed: colors.surfaceControl,
    fg: colors.textPrimary,
    border: colors.borderStrong,
  },
  ghost: { bg: 'transparent', pressed: colors.surfaceControl, fg: colors.textSecondary },
  danger: {
    bg: alpha(colors.accentError, 0.12),
    pressed: alpha(colors.accentError, 0.2),
    fg: colors.accentErrorLight,
  },
};

export function Button({
  title,
  variant = 'secondary',
  size = 'default',
  busy = false,
  icon,
  style,
  disabled,
  onPress,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  title: string;
  variant?: ButtonVariant;
  size?: 'default' | 'large' | 'compact';
  busy?: boolean;
  icon?: SymbolViewProps['name'];
  style?: StyleProp<ViewStyle>;
}) {
  const c = buttonColors[variant];
  const height = size === 'large' ? 50 : size === 'compact' ? 32 : 40;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled || busy}
      onPress={(e) => {
        tap();
        onPress?.(e);
      }}
      style={({ pressed }) => [
        styles.button,
        {
          height,
          paddingHorizontal: size === 'compact' ? space.md : space.lg,
          backgroundColor: pressed ? c.pressed : c.bg,
          borderColor: c.border ?? 'transparent',
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
      {...rest}
    >
      {busy ? (
        <ActivityIndicator size="small" color={c.fg} />
      ) : (
        <>
          {icon && <Icon name={icon} size={16} color={c.fg} />}
          <T variant={size === 'compact' ? 'small' : 'subhead'} color={c.fg} numberOfLines={1}>
            {title}
          </T>
        </>
      )}
    </Pressable>
  );
}

/** An SF Symbol on iOS; on Android, the fallback (or nothing). */
export function Icon({
  name,
  size = 18,
  color = colors.textSecondary,
  fallback,
}: {
  name: SymbolViewProps['name'];
  size?: number;
  color?: string;
  fallback?: ReactNode;
}) {
  if (Platform.OS !== 'ios') return <>{fallback ?? null}</>;
  return <SymbolView name={name} size={size} tintColor={color} weight="medium" />;
}

export function IconButton({
  name,
  label,
  onPress,
  color = colors.textSecondary,
  size = 18,
  fallback,
}: {
  name: SymbolViewProps['name'];
  label: string;
  onPress: () => void;
  color?: string;
  size?: number;
  fallback?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && { backgroundColor: colors.surfaceControl },
      ]}
    >
      <Icon name={name} size={size} color={color} fallback={<T color={color}>{fallback}</T>} />
    </Pressable>
  );
}

export const toneColor: Record<Tone, string> = {
  ok: colors.accentSuccess,
  problem: colors.accentError,
  unknown: colors.textMuted,
  busy: colors.accentWarning,
};

export function Dot({
  color,
  size = 8,
  glow = false,
}: {
  color: string;
  size?: number;
  glow?: boolean;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        ...(glow
          ? {
              shadowColor: color,
              shadowOpacity: 0.7,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 0 },
            }
          : null),
      }}
    />
  );
}

/** A grouped section on a settings-style screen. */
export function Section({
  title,
  children,
  footer,
}: {
  title?: string;
  children: ReactNode;
  footer?: string;
}) {
  return (
    <View style={styles.section}>
      {title && (
        <T variant="caption" color={colors.textMuted} style={styles.sectionTitle}>
          {title.toUpperCase()}
        </T>
      )}
      <View style={styles.sectionBody}>{children}</View>
      {footer && (
        <T variant="small" color={colors.textMuted} style={styles.sectionFooter}>
          {footer}
        </T>
      )}
    </View>
  );
}

export function Row({
  label,
  value,
  leading,
  onPress,
  last,
  destructive,
}: {
  label: string;
  value?: string;
  leading?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.row,
        !last && styles.rowDivider,
        pressed && { backgroundColor: colors.surfaceControl },
      ]}
    >
      {leading}
      <T color={destructive ? colors.accentErrorLight : colors.textPrimary} style={{ flex: 1 }}>
        {label}
      </T>
      {value != null && (
        <T color={colors.textMuted} numberOfLines={1} style={styles.rowValue}>
          {value}
        </T>
      )}
      {onPress && !destructive && <Icon name="chevron.right" size={12} color={colors.textFaint} />}
    </Pressable>
  );
}

export interface Choice {
  label: string;
  destructive?: boolean;
  run: () => void;
}

/** The system's action sheet (an alert with buttons on Android). Cancel is added. */
export function choose(title: string | undefined, choices: Choice[], message?: string) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        message,
        options: [...choices.map((c) => c.label), 'Cancel'],
        cancelButtonIndex: choices.length,
        destructiveButtonIndex: choices.flatMap((c, i) => (c.destructive ? [i] : [])),
        userInterfaceStyle: 'dark',
      },
      (i) => choices[i]?.run()
    );
    return;
  }
  Alert.alert(title ?? '', message, [
    ...choices.map((c) => ({
      text: c.label,
      style: c.destructive ? ('destructive' as const) : ('default' as const),
      onPress: c.run,
    })),
    { text: 'Cancel', style: 'cancel' as const },
  ]);
}

/** Mutually exclusive filters, as the desktop's SegmentedControl. */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) tap();
              onChange(o.value);
            }}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <T variant="small" color={on ? colors.textWhite : colors.textSecondary}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: 'row',
    padding: space['2xs'],
    gap: space['2xs'],
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  segment: {
    flex: 1,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg - 2,
  },
  segmentOn: { backgroundColor: colors.surfaceSelected },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { marginBottom: space.xl },
  sectionTitle: { marginLeft: space.lg, marginBottom: space.tight, letterSpacing: 0.4 },
  sectionBody: {
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  sectionFooter: { marginHorizontal: space.lg, marginTop: space.sm },
  row: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  rowValue: { maxWidth: '55%', textAlign: 'right' },
});
