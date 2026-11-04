/**
 * Spoken announcements for VoiceOver and TalkBack. `accessibilityLiveRegion`
 * is Android-only, so on iOS a reply, an approval or a failure would
 * otherwise arrive in silence.
 */

import { AccessibilityInfo } from 'react-native';

let screenReader = false;
void AccessibilityInfo.isScreenReaderEnabled().then(
  (on) => (screenReader = on),
  () => {}
);
AccessibilityInfo.addEventListener('screenReaderChanged', (on) => (screenReader = on));

/**
 * Say `text` if a screen reader is on. `queue`: wait for what's being read
 * to finish instead of cutting it off (iOS; Android always queues).
 */
export function announce(text: string, queue = false) {
  if (!screenReader || !text) return;
  AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue });
}
