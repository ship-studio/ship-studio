/**
 * Every layer of the link, in order, each ok / a problem / unknown. What the
 * phone can't observe is said to be unknown, never guessed.
 */

import type { Device } from '@shipstudio/companion-protocol';
import { PROTOCOL_VERSION } from '@shipstudio/companion-protocol';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { useNow } from '../components/ConnectionPill';
import { Button, Dot, Section, T, toneColor } from '../components/ui';
import { formatAgo } from '../lib/agents';
import { layers, pill } from '../lib/connection';
import { appInfo, openTailscale } from '../lib/pairing';
import { currentTransport, deviceSelf } from '../lib/session';
import { useApp } from '../lib/store';
import { colors, space } from '../lib/theme';

export default function Connection() {
  const now = useNow(5_000);
  const state = useApp(
    useShallow((s) => ({
      link: s.link,
      refusal: s.refusal,
      mac: s.mac,
      overview: s.overview,
      phoneOnline: s.phoneOnline,
      syncedAt: s.syncedAt,
      credentials: s.credentials,
    }))
  );
  const [device, setDevice] = useState<Device | null>(null);
  const connected = state.link.kind === 'connected';
  useEffect(() => {
    if (connected) deviceSelf().then(setDevice, () => {});
  }, [connected]);

  const t = currentTransport();
  const p = pill(state, now);
  const rows = layers(
    state,
    { latencyMs: t?.latencyMs ?? null, lastSeenAt: t?.lastSeenAt ?? 0 },
    now
  );
  const failures = (state.overview?.agents ?? []).filter((a) => a.failure);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.head}>
        <T variant="title" color={colors.textWhite}>
          {state.credentials?.name ?? 'Your Mac'}
        </T>
        <View style={styles.headLine}>
          <Dot color={toneColor[p.tone]} size={7} />
          <T variant="small" color={colors.textSecondary}>
            {p.label}
          </T>
        </View>
        {state.refusal && (
          <T variant="small" color={colors.accentErrorLight}>
            {state.refusal.message}
          </T>
        )}
      </View>

      <Section>
        {rows.map((layer, i) => (
          <View key={layer.title} style={[styles.layer, i < rows.length - 1 && styles.divider]}>
            <View style={styles.dot}>
              <Dot color={toneColor[layer.tone]} size={8} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T color={colors.textPrimary}>{layer.title}</T>
              <T variant="small" color={colors.textMuted}>
                {layer.detail}
              </T>
            </View>
          </View>
        ))}
      </Section>

      {failures.length > 0 && (
        <Section title="Agents">
          {failures.map((a, i) => (
            <View key={a.id} style={[styles.layer, i < failures.length - 1 && styles.divider]}>
              <View style={styles.dot}>
                <Dot
                  color={
                    a.failure?.kind === 'usage_limit' ? colors.accentWarning : colors.accentError
                  }
                />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T color={colors.textPrimary}>{a.name}</T>
                <T variant="small" color={colors.textMuted}>
                  {a.failure?.kind === 'signed_out'
                    ? 'Last turn failed: Claude Code is signed out'
                    : a.failure?.kind === 'usage_limit'
                      ? 'At its usage limit'
                      : 'Last turn didn’t finish'}
                  {a.capabilities ? ` · as of ${formatAgo(a.capabilities.seenAt, now)}` : ''}
                </T>
              </View>
            </View>
          ))}
        </Section>
      )}

      <Section title="This phone">
        <Info label="Name" value={device?.name ?? 'Unknown until connected'} />
        <Info
          label="Paired"
          value={
            state.credentials ? new Date(state.credentials.pairedAt).toLocaleDateString() : '—'
          }
        />
        <Info label="App" value={`${appInfo().version} (${appInfo().build})`} />
        <Info label="Protocol" value={`v${t?.welcome?.protocol ?? PROTOCOL_VERSION}`} last />
      </Section>

      {!connected && (
        <Button title="Open Tailscale" icon="network" onPress={() => void openTailscale()} />
      )}
    </ScrollView>
  );
}

function Info({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.info, !last && styles.divider]}>
      <T color={colors.textPrimary}>{label}</T>
      <T color={colors.textMuted} numberOfLines={1} style={{ flexShrink: 1 }}>
        {value}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.lg, paddingTop: space.xl, gap: space.xs },
  head: { gap: space.tight, marginBottom: space.lg, paddingHorizontal: space.xs },
  headLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  layer: { flexDirection: 'row', gap: space.md, padding: space.lg, alignItems: 'flex-start' },
  dot: { paddingTop: 6 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  info: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, padding: space.lg },
});
