/** The in-app QR scanner. A pairing link goes straight to the pairing screen. */

import { parsePairingLink } from '@shipstudio/companion-protocol';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, IconButton, T } from '../components/ui';
import { haptic } from '../lib/haptics';
import { colors, radius, space } from '../lib/theme';

export default function Scan() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const [wrong, setWrong] = useState(false);
  const done = useRef(false);

  const onScan = ({ data }: { data: string }) => {
    if (done.current) return;
    if (!parsePairingLink(data)) {
      setWrong(true);
      return;
    }
    done.current = true;
    haptic.success();
    router.dismissTo({ pathname: '/pair', params: { link: data } });
  };

  return (
    <View style={styles.page}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScan}
        />
      ) : (
        <View style={styles.ask}>
          <T variant="title" color={colors.textWhite}>
            Scan the code on your Mac
          </T>
          <T color={colors.textSecondary}>
            The camera is only used to read the pairing code. Nothing is recorded.
          </T>
          {permission && !permission.canAskAgain ? (
            <Button
              title="Open Settings"
              variant="primary"
              onPress={() => void Linking.openSettings()}
            />
          ) : (
            <Button title="Allow camera" variant="primary" onPress={() => void request()} />
          )}
        </View>
      )}
      {permission?.granted && (
        <View pointerEvents="none" style={styles.frameWrap}>
          <View style={styles.frame} />
          <T color={colors.textWhite} style={styles.caption}>
            {wrong
              ? 'That code isn’t a Ship Studio pairing code'
              : 'Point at the code in Settings → Phone on your Mac'}
          </T>
        </View>
      )}
      <View style={[styles.close, { top: insets.top + space.sm }]}>
        <IconButton
          name="xmark"
          label="Close"
          color={colors.textWhite}
          fallback="✕"
          onPress={() => router.back()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surfaceApp },
  ask: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  frameWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
  },
  frame: {
    width: 240,
    height: 240,
    borderRadius: radius.lg + 12,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.85)',
  },
  caption: { textAlign: 'center', paddingHorizontal: space.xl },
  close: { position: 'absolute', right: space.lg },
});
