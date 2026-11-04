/**
 * Add or edit a check-in in one line, the desktop's composer: "when: what".
 * The Mac's own parser reads the "when" as you type and says what it means
 * (or what it can't read), so what you save is what it will do.
 */

import {
  describeRepeat,
  formatWhen,
  scheduleWhenPhrase,
  splitScheduleInput,
  type SchedulePreview,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Button, T } from '../components/ui';
import { describeError, schedule } from '../lib/session';
import { useApp } from '../lib/store';
import { WireFailure } from '../lib/transport';
import { colors, fonts, radius, space, type } from '../lib/theme';

type Reading =
  | { kind: 'empty' }
  | { kind: 'reading' }
  | { kind: 'ok'; preview: SchedulePreview }
  | { kind: 'bad'; reason: string };

/** "Every weekday at 9:00 AM · first Tomorrow 9:00 AM", or "Once · Today 5:00 PM". */
function previewLine(p: SchedulePreview, now = Date.now()): string {
  const when = formatWhen(p.nextAt, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
  return p.repeat ? `${describeRepeat(p.repeat)} · first ${when}` : `Once · ${when}`;
}

export default function Schedule() {
  const router = useRouter();
  const { agentId, id } = useLocalSearchParams<{ agentId: string; id?: string }>();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === agentId));
  const editing = agent?.checkIns?.find((c) => c.id === id);
  const [text, setText] = useState(() =>
    editing ? `${scheduleWhenPhrase(editing)}: ${editing.note}` : ''
  );
  const [answer, setAnswer] = useState<{ when: string; reading: Reading } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { when, note } = splitScheduleInput(text);

  useEffect(() => {
    if (!when) return;
    let live = true;
    const timer = setTimeout(() => {
      schedule.preview(when).then(
        (preview) => live && setAnswer({ when, reading: { kind: 'ok', preview } }),
        (e: unknown) =>
          live &&
          setAnswer({
            when,
            reading: {
              kind: 'bad',
              reason:
                e instanceof WireFailure && e.error.type === 'Validation'
                  ? e.error.reason
                  : describeError(e),
            },
          })
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [when]);

  const reading: Reading = !when
    ? { kind: 'empty' }
    : answer?.when === when
      ? answer.reading
      : { kind: 'reading' };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing) await schedule.update(agentId, editing.id, when, note);
      else await schedule.create(agentId, when, note);
      router.back();
    } catch (e) {
      setError(describeError(e));
      setSaving(false);
    }
  };

  const ready = reading.kind === 'ok' && note.length > 0;
  return (
    <View style={styles.root}>
      <T variant="title" color={colors.textWhite}>
        {editing
          ? editing.repeat
            ? 'Edit routine'
            : 'Edit check-in'
          : `Schedule ${agent?.name ?? ''}`}
      </T>
      <TextInput
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder="every weekday 9am: brief me on the launch"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        selectionColor={colors.accentActive}
        keyboardAppearance="dark"
        autoCapitalize="none"
        returnKeyType="done"
        multiline
        submitBehavior="blurAndSubmit"
        onSubmitEditing={() => ready && void save()}
        accessibilityLabel="When, a colon, then what to do"
      />
      <View style={styles.reading}>
        {reading.kind === 'ok' ? (
          <Animated.View entering={FadeIn.duration(150)} style={{ gap: space['2xs'] }}>
            <T variant="small" color={colors.textPrimary}>
              {previewLine(reading.preview)}
            </T>
            {!note && (
              <T variant="caption" color={colors.textMuted}>
                Now a colon and what to do: “…: check the error rate”
              </T>
            )}
          </Animated.View>
        ) : reading.kind === 'bad' ? (
          <T variant="small" color={colors.accentErrorLight}>
            {reading.reason}
          </T>
        ) : (
          <T variant="caption" color={colors.textMuted}>
            When it should happen, a colon, then what {agent?.name ?? 'the agent'} should do.
          </T>
        )}
      </View>
      {error && (
        <T variant="small" color={colors.accentErrorLight}>
          {error}
        </T>
      )}
      <View style={styles.actions}>
        <Button title="Cancel" variant="ghost" onPress={() => router.back()} style={{ flex: 1 }} />
        <Button
          title={editing ? 'Save' : 'Schedule'}
          variant="primary"
          disabled={!ready}
          busy={saving}
          onPress={() => void save()}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.md },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textWhite,
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
    minHeight: 52,
  },
  reading: { minHeight: 38, paddingHorizontal: space.xs },
  actions: { flexDirection: 'row', gap: space.sm },
});
