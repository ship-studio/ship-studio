/** The paired Mac, alerts (with the honest limit), updates, and about. */

import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet } from 'react-native';
import { Row, Section, T } from '../components/ui';
import { appInfo } from '../lib/pairing';
import { unpair } from '../lib/session';
import { useApp } from '../lib/store';
import { colors, space } from '../lib/theme';

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string };

export default function Settings() {
  const router = useRouter();
  const credentials = useApp((s) => s.credentials);
  const [alerts, setAlerts] = useState<Notifications.PermissionStatus | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });

  const readAlerts = useCallback(() => {
    Notifications.getPermissionsAsync().then(
      (p) => setAlerts(p.status),
      () => {}
    );
  }, []);
  useEffect(() => {
    readAlerts();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && readAlerts());
    return () => sub.remove();
  }, [readAlerts]);

  const check = async () => {
    setUpdate({ kind: 'checking' });
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) return setUpdate({ kind: 'current' });
      await Updates.fetchUpdateAsync();
      setUpdate({ kind: 'ready' });
    } catch (error) {
      setUpdate({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const confirmUnpair = () =>
    Alert.alert(
      `Forget ${credentials?.name ?? 'this Mac'}?`,
      'This phone stops reaching your agents, and the Mac removes it from its paired devices. You can pair again any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => {
            await unpair();
            router.replace('/pair');
          },
        },
      ]
    );

  const { version, build } = appInfo();
  const updateLabel =
    update.kind === 'checking'
      ? 'Checking…'
      : update.kind === 'current'
        ? 'Up to date'
        : update.kind === 'ready'
          ? 'Restart to update'
          : update.kind === 'failed'
            ? 'Couldn’t check'
            : undefined;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Section title="Paired Mac">
        <Row
          label={credentials?.name ?? 'None'}
          value={credentials ? 'Over Tailscale' : undefined}
        />
        {credentials && (
          <Row label="Paired" value={new Date(credentials.pairedAt).toLocaleDateString()} />
        )}
        <Row label="Connection details" onPress={() => router.push('/connection')} />
        <Row label="Forget this Mac" destructive onPress={confirmUnpair} last />
      </Section>

      <Section
        title="Alerts"
        footer="Alerts arrive while Ship Studio is open on your phone. Your Mac still notifies you at the desk."
      >
        <Row
          label="Alerts"
          value={
            alerts === Notifications.PermissionStatus.GRANTED
              ? 'On'
              : alerts === Notifications.PermissionStatus.DENIED
                ? 'Off'
                : 'Not asked yet'
          }
          onPress={() => {
            if (alerts === Notifications.PermissionStatus.UNDETERMINED) {
              void Notifications.requestPermissionsAsync().then(readAlerts);
            } else void Linking.openSettings();
          }}
          last
        />
      </Section>

      <Section
        title="Updates"
        footer={
          Updates.isEnabled
            ? 'Updates download in the background and apply the next time the app starts.'
            : 'Over-the-air updates are off in this build (a development or self-built app). Reinstall from Ship Studio on your Mac to update.'
        }
      >
        <Row label="Version" value={`${version} (${build})`} />
        <Row label="Channel" value={Updates.channel || 'None'} />
        <Row label="Runtime" value={Updates.runtimeVersion ?? 'Development'} />
        {Updates.updateId && <Row label="Update" value={Updates.updateId.slice(0, 8)} />}
        {Updates.isEnabled && (
          <Row
            label={update.kind === 'ready' ? 'Restart to update' : 'Check for update'}
            value={update.kind === 'ready' ? undefined : updateLabel}
            onPress={() => (update.kind === 'ready' ? void Updates.reloadAsync() : void check())}
            last
          />
        )}
      </Section>
      {update.kind === 'failed' && (
        <T variant="small" color={colors.accentErrorLight} style={styles.error}>
          {update.message}
        </T>
      )}

      <Section title="About">
        <Row
          label="Source code"
          value="GitHub"
          onPress={() => void Linking.openURL('https://github.com/ship-studio/ship-studio')}
          last
        />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.lg },
  error: { marginHorizontal: space.lg, marginTop: -space.md, marginBottom: space.lg },
});
