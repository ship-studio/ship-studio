/**
 * The app's haptic grammar, in one place, and optional (Settings → Haptics),
 * as the HIG asks. Reserved for what matters: sending, interrupting,
 * approvals, failures and toggles. Plain navigation is silent.
 */

import * as Haptics from 'expo-haptics';
import { getApp } from './store';

const on = () => getApp().prefs.haptics;

export const haptic = {
  /** A toggle flipped, a swipe crossing its threshold. */
  select: () => void (on() && Haptics.selectionAsync()),
  /** Sent, or queued for the next turn. */
  light: () => void (on() && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** Interrupted the turn in progress, stopped it. */
  medium: () => void (on() && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** The Mac confirmed it (an approval allowed, a copy made). */
  success: () => void (on() && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** The Mac confirmed a no (an approval denied). */
  warning: () => void (on() && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  /** It didn't happen. */
  error: () => void (on() && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
