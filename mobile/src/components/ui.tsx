/**
 * The few primitives every screen shares: text in the type scale, the
 * semantic button family (primary / secondary / ghost / danger, as on the
 * desktop), an icon (SF Symbol on iOS, Material Symbol on Android), and the
 * status dot. Every control is at least 44pt to touch, whatever it draws.
 */

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
import { alpha, chromeScale, colors, fonts, lineHeight, radius, space, type } from '../lib/theme';
import type { Tone } from '../lib/connection';
import { haptic } from '../lib/haptics';
import { useApp } from '../lib/store';

/** Ripple for Android presses; iOS uses its pressed tints. */
export const ripple = { color: alpha(colors.textWhite, 0.08) };

/** Increase Contrast: each step of grey reads one step brighter. */
const brighter: Record<string, string> = {
  [colors.textMuted]: colors.textSecondary,
  [colors.textSecondary]: colors.textPrimary,
  [colors.textPrimary]: colors.textWhite,
};

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
  const high = useApp((s) => s.highContrast);
  return (
    <Text
      {...rest}
      style={[variants[variant], { color: (high && brighter[color]) || color }, style]}
    />
  );
}

/** A toggle flipped: the one tap that earns a haptic by itself. */
export const tap = haptic.select;

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
  lines = 1,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  title: string;
  variant?: ButtonVariant;
  size?: 'default' | 'large' | 'compact';
  busy?: boolean;
  icon?: SFName;
  style?: StyleProp<ViewStyle>;
  /** A choice someone must read in full (a session's options) wraps instead of truncating. */
  lines?: number;
}) {
  const c = buttonColors[variant];
  const height = size === 'large' ? 50 : size === 'compact' ? 32 : 44;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || busy), busy }}
      disabled={disabled || busy}
      onPress={onPress}
      android_ripple={ripple}
      hitSlop={size === 'compact' ? 6 : undefined}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: height,
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
          <T
            variant={size === 'compact' ? 'small' : 'subhead'}
            color={c.fg}
            numberOfLines={lines}
            maxFontSizeMultiplier={lines > 1 ? 2 : chromeScale}
            style={lines > 1 ? { flexShrink: 1, paddingVertical: space.sm } : undefined}
          >
            {title}
          </T>
        </>
      )}
    </Pressable>
  );
}

type SFName = Extract<SymbolViewProps['name'], string>;

/**
 * Each SF Symbol the app draws, as the Material Symbol Android draws in its
 * place. One map, so no icon quietly vanishes on Android.
 */
const MATERIAL: Partial<Record<SFName, string>> = {
  'arrow.up': 'arrow_upward',
  'arrow.down': 'arrow_downward',
  'arrow.clockwise': 'refresh',
  'arrow.trianglehead.2.clockwise': 'sync',
  'arrow.uturn.left': 'undo',
  bell: 'notifications',
  'bell.slash': 'notifications_off',
  'bell.slash.fill': 'notifications_off',
  'chevron.right': 'chevron_right',
  'chevron.down': 'expand_more',
  clock: 'schedule',
  'doc.on.doc': 'content_copy',
  'doc.on.clipboard': 'content_paste',
  'doc.text': 'description',
  ellipsis: 'more_horiz',
  'exclamationmark.circle': 'error',
  'exclamationmark.triangle.fill': 'warning',
  eye: 'visibility',
  'eye.slash': 'visibility_off',
  'folder.fill': 'folder',
  gearshape: 'settings',
  'info.circle': 'info',
  iphone: 'smartphone',
  'message.badge': 'mark_chat_unread',
  pin: 'keep',
  'pin.fill': 'keep',
  'pin.slash': 'keep_off',
  plus: 'add',
  'qrcode.viewfinder': 'qr_code_scanner',
  'selection.pin.in.out': 'select_all',
  'stop.fill': 'stop',
  terminal: 'terminal',
  'text.alignleft': 'notes',
  camera: 'photo_camera',
  play: 'play_arrow',
  'text.badge.checkmark': 'markdown',
  'text.quote': 'format_quote',
  'tray.and.arrow.up': 'outbox',
  xmark: 'close',
};

/** An SF Symbol on iOS, its Material Symbol on Android; `fallback` if neither exists. */
export function Icon({
  name,
  size = 18,
  color = colors.textSecondary,
  fallback,
}: {
  name: SFName;
  size?: number;
  color?: string;
  fallback?: ReactNode;
}) {
  if (Platform.OS === 'ios') {
    return <SymbolView name={name} size={size} tintColor={color} weight="medium" />;
  }
  const material = MATERIAL[name];
  if (!material) return <>{fallback ?? null}</>;
  return (
    <SymbolView
      name={{ android: material as never }}
      size={size}
      tintColor={color}
      fallback={fallback}
    />
  );
}

export function IconButton({
  name,
  label,
  onPress,
  color = colors.textSecondary,
  size = 18,
  fallback,
}: {
  name: SFName;
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
      hitSlop={4}
      onPress={onPress}
      android_ripple={{ ...ripple, borderless: true, radius: 22 }}
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
        <T
          variant="caption"
          color={colors.textMuted}
          style={styles.sectionTitle}
          maxFontSizeMultiplier={chromeScale}
          accessibilityRole="header"
        >
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
  trailing,
}: {
  label: string;
  value?: string;
  leading?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  destructive?: boolean;
  /** A control in place of the chevron, such as a Switch. */
  trailing?: ReactNode;
}) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      android_ripple={onPress ? ripple : undefined}
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
        <T color={colors.textSecondary} numberOfLines={1} style={styles.rowValue}>
          {value}
        </T>
      )}
      {trailing}
      {onPress && !destructive && !trailing && (
        <Icon name="chevron.right" size={12} color={colors.textMuted} />
      )}
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
    minHeight: 32,
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
    paddingVertical: space.xs,
    overflow: 'hidden',
  },
  iconButton: {
    width: 44,
    height: 44,
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
