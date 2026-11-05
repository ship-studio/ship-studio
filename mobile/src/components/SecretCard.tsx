/**
 * A secure input card (`request_secret`): what the agent wants and why, a
 * masked field per part, Save or Deny. The value goes from these fields to
 * the Mac's Keychain over Tailscale and nowhere else: it lives in a ref (not
 * state, so nothing re-renders holding it), is wiped on Save, when the app
 * leaves the foreground and when the card goes, and never reaches the store,
 * the cache, drafts, the outbox, a notification or a log. The agent is woken
 * with the variable's name, never the value.
 */

import type { Agent, AgentMessage, Approval, SecretRequest } from '@shipstudio/companion-protocol';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { haptic } from '../lib/haptics';
import {
  answerApproval,
  currentTransport,
  describeError,
  saveSecret,
  secretRouteProblem,
} from '../lib/session';
import { useApp } from '../lib/store';
import { colors, fonts, radius, space, type } from '../lib/theme';
import { ARM_MS, cardStyles, useArmed } from './ApprovalCard';
import { Button, Icon, T } from './ui';

/** `$STRIPE_KEY`, or `$BANK_USERNAME, $BANK_PASSWORD`: what the agent gets. */
export const secretVars = (s: Pick<SecretRequest, 'fields'>) =>
  s.fields.map((f) => `$${f.env}`).join(', ');

export function SecretCard({
  message,
  approval,
  request,
  agent,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  request: SecretRequest;
  agent: Agent;
  onError: (text: string) => void;
}) {
  const pending = approval.status === 'pending';
  const armed = useArmed(pending);
  const link = useApp((s) => s.link);
  // Only that each field has something, never what.
  const [filled, setFilled] = useState<boolean[]>(() => request.fields.map(() => false));
  const [busy, setBusy] = useState<null | 'save' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);
  const values = useRef<string[]>(request.fields.map(() => ''));
  const inputs = useRef<(ComponentRef<typeof TextInput> | null)[]>([]);
  const route = link.kind === 'connected' ? (currentTransport()?.route ?? null) : null;
  const problem = secretRouteProblem(route);

  const wipe = () => {
    values.current = request.fields.map(() => '');
    inputs.current.forEach((i) => i?.clear());
    setFilled(request.fields.map(() => false));
  };
  // Gone from memory when the card goes, and when the app leaves the screen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s !== 'active' && wipe());
    return () => {
      sub.remove();
      values.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wipe only reads refs
  }, []);

  const save = async () => {
    if (!armed || problem || !filled.every(Boolean)) return;
    setBusy('save');
    setError(null);
    try {
      await saveSecret(message.agentId, approval.requestId, [...values.current]);
      wipe();
      haptic.success();
    } catch (e) {
      haptic.error();
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const deny = async () => {
    setBusy('deny');
    try {
      await answerApproval(message.agentId, approval.requestId, false);
      wipe();
      haptic.warning();
    } catch (e) {
      haptic.error();
      onError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const outcome =
    approval.status === 'allowed'
      ? `Saved to your Mac’s Keychain · ${agent.name} uses ${secretVars(request)}`
      : approval.status === 'denied'
        ? approval.note
          ? `Declined · “${approval.note}”`
          : `Declined · ${agent.name} was told`
        : 'Not answered';

  return (
    <Animated.View
      layout={LinearTransition.duration(220)}
      style={[cardStyles.card, pending && cardStyles.cardPending]}
    >
      <View style={styles.title}>
        <Icon name="lock.fill" size={13} color={colors.textSecondary} />
        <T
          variant="subhead"
          color={colors.textWhite}
          maxFontSizeMultiplier={2}
          style={{ flexShrink: 1 }}
        >
          {agent.name} asks for <T variant="mono">{request.name}</T>
        </T>
      </View>
      <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
        {request.purpose}
      </T>
      {pending ? (
        problem ? (
          <View style={{ gap: space.sm }}>
            <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
              {problem}
            </T>
            {link.kind === 'connected' && (
              <Button title="Deny" busy={busy === 'deny'} onPress={() => void deny()} />
            )}
          </View>
        ) : (
          <Animated.View
            entering={FadeIn.duration(ARM_MS)}
            exiting={FadeOut.duration(120)}
            pointerEvents={armed ? 'auto' : 'none'}
            accessibilityElementsHidden={!armed}
            importantForAccessibility={armed ? 'auto' : 'no-hide-descendants'}
            style={{ gap: space.sm }}
          >
            {request.fields.map((field, i) => (
              <View key={field.env} style={{ gap: space['2xs'] }}>
                <T variant="caption" color={colors.textSecondary}>
                  {field.label}
                </T>
                <TextInput
                  ref={(r) => {
                    inputs.current[i] = r;
                  }}
                  secureTextEntry
                  // Not offered to the system's password manager: it would keep a copy.
                  textContentType="none"
                  autoComplete="off"
                  importantForAutofill="no"
                  autoCorrect={false}
                  autoCapitalize="none"
                  spellCheck={false}
                  editable={!busy}
                  keyboardAppearance="dark"
                  accessibilityLabel={field.label}
                  onChangeText={(v) => {
                    values.current[i] = v;
                    const has = v.trim().length > 0;
                    setFilled((f) => (f[i] === has ? f : f.map((x, j) => (j === i ? has : x))));
                  }}
                  returnKeyType={i === request.fields.length - 1 ? 'done' : 'next'}
                  onSubmitEditing={() =>
                    i < request.fields.length - 1 ? inputs.current[i + 1]?.focus() : void save()
                  }
                  style={styles.input}
                />
              </View>
            ))}
            <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={2}>
              Kept in your Mac’s Keychain for {agent.name} only. It gets {secretVars(request)},
              never the value, and this phone keeps nothing.
            </T>
            {error && (
              <T variant="small" color={colors.accentErrorLight}>
                {error}
              </T>
            )}
            <View style={cardStyles.actions}>
              <Button
                title="Deny"
                busy={busy === 'deny'}
                disabled={!!busy || link.kind !== 'connected'}
                onPress={() => void deny()}
                style={{ flex: 1 }}
              />
              <Button
                title="Save"
                variant="primary"
                busy={busy === 'save'}
                disabled={!!busy || !filled.every(Boolean)}
                focusable={armed}
                onPress={() => void save()}
                style={{ flex: 1 }}
              />
            </View>
          </Animated.View>
        )
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

const styles = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  input: {
    fontFamily: fonts.mono,
    fontSize: type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceControl,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
});
