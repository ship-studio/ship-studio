/**
 * A new agent session in a project, from the phone: Remote Access's
 * `start_agent`. Ship Studio opens a new agent tab on the Mac that starts
 * on what you type here; once the tab exists, you're watching it.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Button, T } from '../components/ui';
import { haptic } from '../lib/haptics';
import { describeError, startSession } from '../lib/session';
import { useApp } from '../lib/store';
import { colors, fonts, lineHeight, radius, space, type } from '../lib/theme';

export default function Start() {
  const { project, name } = useLocalSearchParams<{ project: string; name: string }>();
  const router = useRouter();
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    haptic.light();
    startSession(project, text)
      .then(({ sessionId }) => {
        haptic.success();
        router.replace({
          pathname: '/session/[id]',
          params: { id: sessionId, project: name, path: project },
        });
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
        setBusy(false);
      });
  };

  return (
    <View style={styles.content}>
      <T variant="title" color={colors.textWhite}>
        New session in {name}
      </T>
      <T variant="small" color={colors.textSecondary}>
        Ship Studio opens a new agent tab on {macName} that starts on this. It can take up to a
        minute.
      </T>
      <TextInput
        autoFocus
        multiline
        value={prompt}
        onChangeText={setPrompt}
        placeholder="What should it do?"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        keyboardAppearance="dark"
        selectionColor={colors.accentActive}
        accessibilityLabel="What the new session should do"
      />
      {error && (
        <T variant="small" color={colors.accentErrorLight}>
          {error}
        </T>
      )}
      <Button
        title={busy ? 'Opening a tab…' : 'Start'}
        variant="primary"
        busy={busy}
        disabled={!connected || !prompt.trim()}
        onPress={start}
      />
      {!connected && (
        <T variant="caption" color={colors.textSecondary}>
          Starting a session needs {macName}.
        </T>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textPrimary,
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.lg,
    padding: space.md,
    minHeight: 120,
    textAlignVertical: 'top',
  },
});
