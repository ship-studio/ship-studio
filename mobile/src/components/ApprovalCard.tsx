/**
 * An approval in the chat: the exact command, then Deny / Allow (and Always
 * allow, when the desktop offers a scope), inert for a beat after it lands.
 * Once answered, the outcome in a line.
 */

import type { Agent, AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { describeScope } from '../lib/agents';
import { haptic } from '../lib/haptics';
import { answerApproval, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { alpha, chromeScale, colors, fonts, radius, space, type } from '../lib/theme';
import { Button, Icon, T } from './ui';

const OUTCOME = {
  allowed: 'Allowed',
  denied: 'Declined',
  expired: 'Not answered in time',
} as const;

/**
 * How long a new card's answers stay inert: the desktop's anti-misclick
 * delay. A card can land under a thumb that was tapping Send or Stop, and
 * Allow is the one tap this app must never take by accident.
 */
const ARM_MS = 400;

/** At this text size the explanation folds away, so the answers stay in reach. */
const LARGE_TEXT = 1.6;

export function ApprovalCard({
  message,
  approval,
  agent,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  agent: Agent;
  onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'always'>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [armed, setArmed] = useState(false);
  const [explained, setExplained] = useState(false);
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= LARGE_TEXT;
  const connected = useApp((s) => s.link.kind === 'connected');
  const pending = approval.status === 'pending';
  const paused = pending && agent.status.state === 'idle';

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  // The haptic says what the Mac did, so it waits for the Mac.
  const answer = async (allow: boolean, always = false, why?: string) => {
    if (!armed) return;
    setBusy(always ? 'always' : allow ? 'allow' : 'deny');
    try {
      await answerApproval(message.agentId, approval.requestId, allow, always, why);
      if (allow) haptic.success();
      else haptic.warning();
      setNoting(false);
    } catch (error) {
      haptic.error();
      onError(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const outcome =
    approval.alwaysAllowed && approval.always
      ? `Always allowed · ${approval.always.label}`
      : approval.status === 'denied' && approval.note
        ? `Declined · “${approval.note}”`
        : OUTCOME[approval.status as keyof typeof OUTCOME];
  const scope = approval.always ? describeScope(approval.always, agent.name) : null;
  const off = !!busy || !connected;

  return (
    <Animated.View
      layout={LinearTransition.duration(220)}
      style={[styles.card, pending && styles.cardPending]}
    >
      {pending && (
        <View style={styles.eyebrow}>
          <Icon name="exclamationmark.triangle.fill" size={12} color={colors.accentWarning} />
          <T
            variant="caption"
            color={colors.accentWarning}
            style={styles.eyebrowText}
            maxFontSizeMultiplier={chromeScale}
          >
            NEEDS YOUR OK
          </T>
        </View>
      )}
      <T variant="subhead" color={colors.textWhite} maxFontSizeMultiplier={2}>
        {approval.title}
      </T>
      {!!approval.detail && <Command text={approval.detail} lines={large ? 6 : 12} />}
      {paused && (
        <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
          It paused here for you. Allow it and it picks up where it left off.
        </T>
      )}
      {pending && !connected && (
        <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
          Answer it once your Mac is back. It stays open until then.
        </T>
      )}
      {pending && noting ? (
        <Animated.View entering={FadeIn.duration(150)} style={{ gap: space.sm }}>
          <TextInput
            autoFocus
            value={note}
            onChangeText={setNote}
            maxLength={500}
            placeholder={`Tell ${agent.name} what to do instead`}
            placeholderTextColor={colors.textMuted}
            style={styles.noteInput}
            returnKeyType="send"
            keyboardAppearance="dark"
            // Return denies with the note, and only once there is one.
            onSubmitEditing={() => note.trim() && void answer(false, false, note)}
          />
          <View style={styles.actions}>
            <Button
              title="Cancel"
              variant="ghost"
              onPress={() => setNoting(false)}
              style={{ flex: 1 }}
            />
            <Button
              title="Deny"
              busy={busy === 'deny'}
              disabled={!connected}
              onPress={() => void answer(false, false, note)}
              style={{ flex: 1 }}
            />
          </View>
        </Animated.View>
      ) : pending ? (
        <Animated.View
          // Inert, and fading in, until armed: a tap meant for something else lands on nothing.
          entering={FadeIn.duration(ARM_MS)}
          exiting={FadeOut.duration(120)}
          pointerEvents={armed ? 'auto' : 'none'}
          accessibilityElementsHidden={!armed}
          importantForAccessibility={armed ? 'auto' : 'no-hide-descendants'}
          style={{ gap: space.sm }}
        >
          <View style={styles.actions}>
            <Button
              title="Deny"
              busy={busy === 'deny'}
              disabled={off}
              focusable={armed}
              onPress={() => void answer(false)}
              style={{ flex: 1 }}
            />
            <Button
              title="Allow"
              variant="primary"
              busy={busy === 'allow'}
              disabled={off}
              focusable={armed}
              onPress={() => void answer(true)}
              accessibilityHint={approval.detail || undefined}
              style={{ flex: 1 }}
            />
          </View>
          {approval.always && (
            <View style={{ gap: space.xs }}>
              <Button
                title={`Always allow ${approval.always.label}`}
                busy={busy === 'always'}
                disabled={off}
                focusable={armed}
                onPress={() => void answer(true, true)}
                accessibilityHint={scope ?? undefined}
              />
              {large && !explained ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="What does always allow cover?"
                  hitSlop={{ top: 10, bottom: 10 }}
                  onPress={() => setExplained(true)}
                  style={styles.disclosure}
                >
                  <Icon name="info.circle" size={12} color={colors.textSecondary} />
                  <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={2}>
                    What does this cover?
                  </T>
                </Pressable>
              ) : (
                <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={2}>
                  {scope}
                </T>
              )}
            </View>
          )}
          <Button
            title="Deny with note…"
            variant="ghost"
            disabled={off}
            focusable={armed}
            onPress={() => setNoting(true)}
          />
        </Animated.View>
      ) : (
        <Animated.View entering={FadeIn.duration(200).delay(100)}>
          <T
            variant="small"
            color={approval.status === 'allowed' ? colors.accentSuccess : colors.textSecondary}
          >
            {outcome}
          </T>
        </Animated.View>
      )}
    </Animated.View>
  );
}

/**
 * The exact command, never re-wrapped: a line break inside `acme-site`
 * reads as a different path. Long lines scroll sideways instead, and what
 * is selected and copied is the command itself, character for character.
 */
function Command({ text, lines }: { text: string; lines: number }) {
  return (
    <View style={styles.cardDetail}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cardDetailInner}
      >
        <T
          variant="mono"
          color={colors.textPrimary}
          selectable
          numberOfLines={lines}
          maxFontSizeMultiplier={2}
        >
          {text}
        </T>
      </ScrollView>
    </View>
  );
}

/** Yours, before the Mac has it: shown at once, and retryable in place. */

const styles = StyleSheet.create({
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg + 8,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  cardPending: { borderColor: alpha(colors.accentWarning, 0.45) },
  eyebrow: { flexDirection: 'row', gap: space.tight, alignItems: 'center' },
  eyebrowText: { fontFamily: fonts.semibold, letterSpacing: 0.6 },
  cardDetail: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  cardDetailInner: { padding: space.md },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
  },
  actions: { flexDirection: 'row', gap: space.sm },
  noteInput: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceControl,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
});
