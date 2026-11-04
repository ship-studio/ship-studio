/**
 * The rows of a conversation. Yours are neutral bubbles on the right; the
 * agent's replies are prose on the left with no bubble (as on the desktop);
 * everything else is a quiet line or a card.
 */

import type { Agent, AgentMessage, Approval } from '@shipstudio/companion-protocol';
import * as Haptics from 'expo-haptics';
import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { describeScope, failureLine, folderName, formatClock, sessionLabel } from '../lib/agents';
import { describeError, answerApproval, discardPending, send } from '../lib/session';
import type { PendingSend } from '../lib/sync';
import { alpha, colors, fonts, radius, space, type } from '../lib/theme';
import { Attachments } from './attachments';
import { Markdown } from './Markdown';
import { Button, Icon, T, tap } from './ui';
import { Spinner } from './agent';
import { useApp } from '../lib/store';

const enter = FadeInDown.duration(220).springify().damping(18);

export const MessageRow = memo(function MessageRow({
  message,
  agent,
  queued,
  onError,
}: {
  message: AgentMessage;
  agent: Agent;
  queued: boolean;
  onError: (text: string) => void;
}) {
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
            <View style={styles.userBubble}>
              <T selectable>{message.text}</T>
            </View>
          )}
          {queued && (
            <T variant="caption" color={colors.textMuted} style={styles.meta}>
              Queued · {agent.name} reads it when this turn ends
            </T>
          )}
        </View>
      );
    case 'agent':
      return (
        <View style={styles.agentRow}>
          <Markdown text={message.text} />
          {!!message.attachments?.length && (
            <Attachments
              agentId={message.agentId}
              attachments={message.attachments}
              onError={onError}
            />
          )}
          {message.stopped && (
            <T variant="caption" color={colors.textMuted}>
              Stopped
            </T>
          )}
        </View>
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
        tap();
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
        <Icon name="terminal" size={12} color={colors.textMuted} />
        <T variant="small" color={colors.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
          {mark.event === 'started'
            ? `Started a session in ${project}`
            : `Sent to ${project} · ${tab}`}
        </T>
        {open && <Icon name="chevron.right" size={10} color={colors.textFaint} />}
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
        <T variant="caption" color={colors.textFaint}>
          {formatClock(message.ts)}
        </T>
      </View>
      {mark.event === 'reply' ? (
        <T color={colors.textPrimary} numberOfLines={8} selectable>
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
        <Pressable onPress={open} hitSlop={8} style={styles.sessionOpen} accessibilityRole="button">
          <T variant="small" color={colors.textPrimary}>
            Open session
          </T>
          <Icon name="chevron.right" size={10} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

/** Notes, check-ins, delegation and session lines: one muted line each. */
function SystemLine({ message }: { message: AgentMessage }) {
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
  return (
    <View style={styles.systemRow}>
      <T variant="small" color={colors.textMuted} numberOfLines={4}>
        {text}
      </T>
      <T variant="caption" color={colors.textFaint}>
        {formatClock(message.ts)}
      </T>
    </View>
  );
}

const OUTCOME = {
  allowed: 'Allowed',
  denied: 'Declined',
  expired: 'Not answered in time',
} as const;

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
  const pending = approval.status === 'pending';
  const paused = pending && agent.status.state === 'idle';

  const answer = async (allow: boolean, always = false, why?: string) => {
    setBusy(always ? 'always' : allow ? 'allow' : 'deny');
    void Haptics.notificationAsync(
      allow ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
    );
    try {
      await answerApproval(message.agentId, approval.requestId, allow, always, why);
      setNoting(false);
    } catch (error) {
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

  return (
    <View style={[styles.card, pending && styles.cardPending]}>
      <View style={styles.cardTitle}>
        {pending && (
          <Icon name="exclamationmark.triangle.fill" size={14} color={colors.accentWarning} />
        )}
        <T variant="subhead" color={colors.textWhite} style={{ flex: 1 }}>
          {approval.title}
        </T>
      </View>
      {!!approval.detail && (
        <View style={styles.cardDetail}>
          <T variant="mono" color={colors.textPrimary} selectable numberOfLines={12}>
            {approval.detail}
          </T>
        </View>
      )}
      {paused && (
        <T variant="small" color={colors.textSecondary}>
          It paused here for you. Allow it and it picks up where it left off.
        </T>
      )}
      {pending && noting ? (
        <View style={{ gap: space.sm }}>
          <TextInput
            autoFocus
            value={note}
            onChangeText={setNote}
            maxLength={500}
            placeholder={`Tell ${agent.name} what to do instead`}
            placeholderTextColor={colors.textMuted}
            style={styles.noteInput}
            returnKeyType="send"
            onSubmitEditing={() => void answer(false, false, note)}
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
              onPress={() => void answer(false, false, note)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : pending ? (
        <View style={{ gap: space.sm }}>
          <View style={styles.actions}>
            <Button
              title="Deny"
              busy={busy === 'deny'}
              disabled={!!busy}
              onPress={() => void answer(false)}
              style={{ flex: 1 }}
            />
            <Button
              title="Allow"
              variant="primary"
              busy={busy === 'allow'}
              disabled={!!busy}
              onPress={() => void answer(true)}
              style={{ flex: 1 }}
            />
          </View>
          {approval.always && (
            <Pressable
              disabled={!!busy}
              onPress={() => void answer(true, true)}
              style={({ pressed }) => [
                styles.always,
                pressed && { backgroundColor: colors.surfaceControl },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Always allow ${approval.always.label}`}
            >
              <T variant="small" color={colors.textPrimary}>
                Always allow{' '}
                <T variant="small" style={{ fontFamily: fonts.mono }} color={colors.textWhite}>
                  {approval.always.label}
                </T>
              </T>
              <T variant="caption" color={colors.textMuted}>
                {describeScope(approval.always, agent.name)}
              </T>
            </Pressable>
          )}
          <Pressable onPress={() => setNoting(true)} hitSlop={6} style={styles.denyNote}>
            <T variant="small" color={colors.textSecondary}>
              Deny with note…
            </T>
          </Pressable>
        </View>
      ) : (
        <Animated.View entering={FadeIn.duration(200)}>
          <T
            variant="small"
            color={approval.status === 'allowed' ? colors.accentSuccess : colors.textSecondary}
          >
            {outcome}
          </T>
        </Animated.View>
      )}
    </View>
  );
}

/** Yours, before the Mac has it: shown at once, and retryable in place. */
export function PendingRow({ pending }: { pending: PendingSend }) {
  return (
    <Animated.View entering={enter} style={styles.userRow}>
      {!!pending.attachments?.length && (
        <View style={pending.failed && { opacity: 0.6 }}>
          <Attachments
            agentId={pending.agentId}
            align="right"
            attachments={pending.attachments.map((a) => ({ ...a, path: '', localUri: a.uri }))}
          />
        </View>
      )}
      {!!pending.text && (
        <View style={[styles.userBubble, pending.failed && { opacity: 0.6 }]}>
          <T>{pending.text}</T>
        </View>
      )}
      {pending.failed ? (
        <View style={styles.failedLine}>
          <T variant="caption" color={colors.accentErrorLight}>
            Not sent ·{' '}
          </T>
          <Pressable
            hitSlop={8}
            onPress={() => {
              tap();
              void send(
                pending.agentId,
                pending.text,
                false,
                pending.clientId,
                pending.attachments
              ).catch(() => {});
            }}
          >
            <T variant="caption" color={colors.textPrimary}>
              Send
            </T>
          </Pressable>
          <T variant="caption" color={colors.textMuted}>
            {'  ·  '}
          </T>
          <Pressable hitSlop={8} onPress={() => discardPending(pending.agentId, pending.clientId)}>
            <T variant="caption" color={colors.textMuted}>
              Discard
            </T>
          </Pressable>
        </View>
      ) : (
        <T variant="caption" color={colors.textFaint} style={styles.meta}>
          Sending…
        </T>
      )}
    </Animated.View>
  );
}

/** A reply being written. Text arriving in 100 ms chunks is revealed at an even pace. */
export function DraftRow({ text }: { text: string }) {
  const shown = useSmoothText(text);
  return (
    <View style={styles.agentRow}>
      <Markdown text={shown} />
    </View>
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
    borderBottomRightRadius: radius.sm,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 1,
  },
  meta: { marginRight: space.xs },
  failedLine: { flexDirection: 'row', alignItems: 'center', marginRight: space.xs },
  agentRow: { gap: space.xs, paddingRight: space.sm },
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
    borderRadius: radius.lg,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  cardPending: { borderColor: alpha(colors.accentWarning, 0.45) },
  cardTitle: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  cardDetail: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.card,
    padding: space.md,
  },
  actions: { flexDirection: 'row', gap: space.sm },
  always: {
    gap: space['2xs'],
    padding: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.card,
  },
  denyNote: { alignSelf: 'flex-start' },
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
