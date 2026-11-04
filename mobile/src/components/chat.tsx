/**
 * The rows of a conversation. Yours are neutral bubbles on the right; the
 * agent's replies are prose on the left with no bubble (as on the desktop);
 * everything else is a quiet line or a card.
 */

import {
  splitQuotes,
  type Agent,
  type AgentMessage,
  type Approval,
} from '@shipstudio/companion-protocol';
import { memo, useEffect, useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { describeScope, failureLine, folderName, formatClock, sessionLabel } from '../lib/agents';
import { haptic } from '../lib/haptics';
import { describeError, answerApproval, discardPending, send } from '../lib/session';
import type { PendingSend } from '../lib/sync';
import { alpha, chromeScale, colors, fonts, radius, space, type } from '../lib/theme';
import { Attachments } from './attachments';
import { useReveal } from '../lib/reveal';
import { Markdown } from './Markdown';
import { Button, Icon, ripple, T } from './ui';
import { Spinner } from './agent';
import { useApp } from '../lib/store';

const enter = FadeInDown.duration(220).springify().damping(18);

export const MessageRow = memo(function MessageRow({
  message,
  agent,
  queued,
  time,
  onError,
  onLongPress,
}: {
  message: AgentMessage;
  agent: Agent;
  queued: boolean;
  /** The clock under the last message of a run, iMessage-style. */
  time?: boolean;
  onError: (text: string) => void;
  /** Copy, Quote, Select Text: words only, so only user and agent messages. */
  onLongPress?: (message: AgentMessage) => void;
}) {
  const hold = onLongPress && message.text.trim() ? () => onLongPress(message) : undefined;
  switch (message.kind) {
    case 'user':
      return (
        <View style={styles.userRow}>
          {!!message.attachments?.length && (
            <Attachments
              agentId={message.agentId}
              attachments={message.attachments}
              align="right"
              onError={onError}
            />
          )}
          {!!message.text && (
            <Pressable
              onLongPress={hold}
              delayLongPress={300}
              accessibilityHint={hold ? 'Hold for Copy, Quote and Select Text' : undefined}
              style={({ pressed }) => [styles.userBubble, pressed && styles.held]}
            >
              <Bubble text={message.text} />
            </Pressable>
          )}
          {queued ? (
            <T variant="caption" color={colors.textSecondary} style={styles.meta}>
              Queued · {agent.name} reads it when this turn ends
            </T>
          ) : (
            time && <Clock ts={message.ts} align="right" />
          )}
        </View>
      );
    case 'agent':
      return (
        <Pressable
          onLongPress={hold}
          delayLongPress={300}
          accessibilityHint={hold ? 'Hold for Copy, Quote and Select Text' : undefined}
          style={({ pressed }) => [styles.agentRow, pressed && styles.heldProse]}
        >
          <Prose id={message.id} text={message.text} />
          {!!message.attachments?.length && (
            <Attachments
              agentId={message.agentId}
              attachments={message.attachments}
              onError={onError}
            />
          )}
          {(message.stopped || time) && (
            <T variant="caption" color={colors.textSecondary}>
              {[message.stopped && 'Stopped', time && formatClock(message.ts)]
                .filter(Boolean)
                .join(' · ')}
            </T>
          )}
        </Pressable>
      );
    case 'approval':
      return message.approval ? (
        <ApprovalCard
          message={message}
          approval={message.approval}
          agent={agent}
          onError={onError}
        />
      ) : null;
    case 'error':
      return (
        <View style={styles.errorRow}>
          <Icon name="exclamationmark.circle" size={14} color={colors.accentErrorLight} />
          <T variant="small" color={colors.accentErrorLight} style={{ flex: 1 }}>
            {message.failure ? failureLine(message.failure, message.text) : message.text}
          </T>
        </View>
      );
    case 'session':
      return message.session ? <SessionCard message={message} onError={onError} /> : null;
    default:
      return <SystemLine message={message} />;
  }
});

/** Your words, with any quoted passages set off above them. */
function Bubble({ text }: { text: string }) {
  const parts = splitQuotes(text);
  if (parts.length === 1 && parts[0].kind === 'text') return <T>{text}</T>;
  return (
    <View style={{ gap: space.xs }}>
      {parts.map((p, i) =>
        p.kind === 'quote' ? (
          <View key={i} style={styles.bubbleQuote}>
            <T variant="small" color={colors.textSecondary} numberOfLines={4}>
              {p.text}
            </T>
          </View>
        ) : (
          <T key={i}>{p.text}</T>
        )
      )}
    </View>
  );
}

function Clock({ ts, align }: { ts: number; align?: 'right' }) {
  return (
    <T
      variant="caption"
      color={colors.textSecondary}
      style={align === 'right' ? styles.meta : undefined}
      maxFontSizeMultiplier={chromeScale}
    >
      {formatClock(ts)}
    </T>
  );
}

export function DaySeparator({ label }: { label: string }) {
  return (
    <View style={styles.day} accessibilityRole="header">
      <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={chromeScale}>
        {label}
      </T>
    </View>
  );
}

/**
 * What an agent did in a project's session, as the desktop shows it: a line
 * for "started" and "sent", a card with the session's reply, and preview
 * screenshots inline. A session that still exists opens read-only.
 */
function SessionCard({
  message,
  onError,
}: {
  message: AgentMessage;
  onError: (text: string) => void;
}) {
  const router = useRouter();
  const mark = message.session!;
  const project = useApp(
    (s) => s.projects?.find((p) => p.path === mark.project)?.name ?? folderName(mark.project)
  );
  const tab = sessionLabel(mark);
  const open = mark.sessionId
    ? () => {
        router.push({
          pathname: '/session/[id]',
          params: {
            id: mark.sessionId!,
            project,
            tab,
            ...(mark.event === 'reply' ? { reply: message.text } : {}),
          },
        });
      }
    : undefined;

  if (mark.event === 'started' || mark.event === 'sent') {
    return (
      <Pressable
        disabled={!open}
        onPress={open}
        accessibilityRole={open ? 'button' : undefined}
        style={({ pressed }) => [styles.sessionLine, pressed && { opacity: 0.6 }]}
      >
        <Icon name="terminal" size={12} color={colors.textSecondary} />
        <T variant="small" color={colors.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
          {mark.event === 'started'
            ? `Started a session in ${project}`
            : `Sent to ${project} · ${tab}`}
        </T>
        {open && <Icon name="chevron.right" size={10} color={colors.textMuted} />}
      </Pressable>
    );
  }

  return (
    <View style={styles.sessionCard}>
      <View style={styles.sessionHead}>
        <Icon
          name={mark.event === 'reply' ? 'terminal' : 'iphone'}
          size={12}
          color={colors.textMuted}
        />
        <T variant="caption" color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
          {mark.event === 'reply'
            ? `${project} · ${tab}`
            : `${project} · ${message.text || 'Preview'}`}
        </T>
        <T variant="caption" color={colors.textMuted}>
          {formatClock(message.ts)}
        </T>
      </View>
      {mark.event === 'reply' ? (
        <T color={colors.textPrimary} numberOfLines={8}>
          {message.text}
        </T>
      ) : (
        message.attachments && (
          <Attachments
            agentId={message.agentId}
            attachments={message.attachments}
            width={176}
            onError={onError}
          />
        )
      )}
      {open && (
        <Pressable
          onPress={open}
          hitSlop={12}
          style={styles.sessionOpen}
          accessibilityRole="button"
        >
          <T variant="small" color={colors.textPrimary}>
            Open session
          </T>
          <Icon name="chevron.right" size={10} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

/** Notes, check-ins, delegation and session lines: one muted line each. A change opens its diff. */
function SystemLine({ message }: { message: AgentMessage }) {
  const router = useRouter();
  const canDiff = useApp((s) => !!s.welcome?.methods.includes('agents.changeDiff'));
  const text =
    message.kind === 'changes' && message.changes
      ? `Changed ${message.changes.fileCount} file${message.changes.fileCount === 1 ? '' : 's'} in ${message.changes.project
          .split('/')
          .pop()} · +${message.changes.added} −${message.changes.removed}`
      : message.kind === 'sent_to_agent' && message.peer
        ? `To ${message.peer.name}: ${message.text}`
        : message.kind === 'from_agent' && message.peer
          ? `From ${message.peer.name}: ${message.text}`
          : message.kind === 'check_in'
            ? `${message.checkIn?.manual ? 'Ran now' : 'Check-in'} · ${message.text}`
            : message.text;
  const line = (
    <View style={styles.systemRow}>
      <T variant="small" color={colors.textSecondary} numberOfLines={4} style={{ flexShrink: 1 }}>
        {text}
      </T>
      <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
        {formatClock(message.ts)}
      </T>
    </View>
  );
  if (message.kind !== 'changes' || !message.changes || !canDiff) return line;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Shows what changed in each file"
      onPress={() =>
        router.push({
          pathname: '/diff',
          params: { agentId: message.agentId, messageId: message.id },
        })
      }
      style={({ pressed }) => pressed && { opacity: 0.6 }}
    >
      {line}
    </Pressable>
  );
}

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
export const ARM_MS = 400;

/** At this text size the explanation folds away, so the answers stay in reach. */
const LARGE_TEXT = 1.6;

function ApprovalCard({
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
export function PendingRow({ pending }: { pending: PendingSend }) {
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const dim = pending.failed || pending.waiting;
  return (
    <Animated.View entering={enter} style={styles.userRow}>
      {!!pending.attachments?.length && (
        <View style={dim && { opacity: 0.6 }}>
          <Attachments
            agentId={pending.agentId}
            align="right"
            attachments={pending.attachments.map((a) => ({ ...a, path: '', localUri: a.uri }))}
          />
        </View>
      )}
      {!!pending.text && (
        <View style={[styles.userBubble, dim && { opacity: 0.6 }]}>
          <Bubble text={pending.text} />
        </View>
      )}
      {pending.failed || pending.waiting ? (
        <View style={styles.failedLine}>
          <T
            variant="caption"
            color={pending.failed ? colors.accentErrorLight : colors.textSecondary}
            style={{ flexShrink: 1 }}
          >
            {pending.failed ? 'Not sent' : `Waiting for ${macName}`}
          </T>
          {pending.failed && (
            <LineButton
              label="Send"
              onPress={() => {
                haptic.light();
                void send(
                  pending.agentId,
                  pending.text,
                  false,
                  pending.clientId,
                  pending.attachments,
                  pending.mentions
                ).catch(() => {});
              }}
            />
          )}
          <LineButton
            label="Discard"
            muted
            onPress={() => discardPending(pending.agentId, pending.clientId)}
          />
        </View>
      ) : (
        <T variant="caption" color={colors.textSecondary} style={styles.meta}>
          Sending…
        </T>
      )}
    </Animated.View>
  );
}

/** A word you can tap in a status line: small to see, 44pt to hit. */
function LineButton({
  label,
  onPress,
  muted,
}: {
  label: string;
  onPress: () => void;
  muted?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      android_ripple={{ ...ripple, borderless: true }}
      onPress={onPress}
    >
      <T variant="caption" color={muted ? colors.textSecondary : colors.textWhite}>
        {label}
      </T>
    </Pressable>
  );
}

/** A reply being written: revealed at the display's own pace (`useReveal`). */
export function DraftRow({
  id,
  text,
  onHeight,
}: {
  id: string;
  text: string;
  onHeight?: (height: number) => void;
}) {
  return (
    <View
      style={styles.agentRow}
      onLayout={onHeight && ((e: LayoutChangeEvent) => onHeight(e.nativeEvent.layout.height))}
    >
      <Prose id={id} text={text} streaming />
    </View>
  );
}

/**
 * An agent's words. While they're still being revealed (streaming, or the
 * finished message catching up with where its draft had got to) they go
 * through the streaming renderer; once caught up, the plain one.
 */
function Prose({ id, text, streaming = false }: { id: string; text: string; streaming?: boolean }) {
  const shown = useReveal(id, text, streaming);
  return shown.length < text.length || streaming ? (
    <Markdown text={shown} streaming />
  ) : (
    <Markdown text={text} />
  );
}

export function WorkingRow({ label }: { label: string }) {
  return (
    <Animated.View entering={FadeIn.duration(250)} style={styles.workingRow}>
      <Spinner size={12} />
      <T variant="small" color={colors.textSecondary} numberOfLines={1}>
        {label}
      </T>
    </Animated.View>
  );
}

/**
 * Follows `target`, catching up over a few frames rather than in jumps.
 * Anything that isn't an append (a restart, the final message) shows at once.
 */
export function useSmoothText(target: string): string {
  const [shown, setShown] = useState(target);
  const appending = target.startsWith(shown);
  useEffect(() => {
    if (shown === target) return;
    const timer = setTimeout(() => {
      if (!appending) return setShown(target);
      const backlog = target.length - shown.length;
      // Never more than ~6 frames behind; end on a word where one is close.
      let n = Math.max(2, Math.ceil(backlog / 6));
      const word = target.indexOf(' ', shown.length + n);
      if (word !== -1 && word - shown.length - n < 8) n = word - shown.length;
      setShown(target.slice(0, shown.length + n));
    }, 32);
    return () => clearTimeout(timer);
  }, [target, shown, appending]);
  return appending ? shown : target;
}

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end', gap: space.xs, paddingLeft: '18%' },
  userBubble: {
    backgroundColor: colors.surfaceSelected,
    borderRadius: radius.lg + 6,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 1,
  },
  held: { backgroundColor: colors.surfaceControlHover },
  heldProse: { opacity: 0.7 },
  bubbleQuote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.textMuted,
    paddingLeft: space.sm,
  },
  meta: { marginRight: space.xs },
  failedLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginRight: space.xs,
  },
  agentRow: { gap: space.xs, paddingRight: space.sm },
  day: { alignItems: 'center', paddingVertical: space.sm },
  errorRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: alpha(colors.accentError, 0.08),
  },
  systemRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  workingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
  },
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
  sessionLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    alignSelf: 'flex-start',
    paddingVertical: space['2xs'],
  },
  sessionCard: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  sessionHead: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  sessionOpen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
  },
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
