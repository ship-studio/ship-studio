/**
 * Select Text: a message in a sheet where any part of it can be selected,
 * then quoted into the reply or copied. Message bodies themselves aren't
 * selectable in place, so a long-press there is always the menu.
 */

import type { AgentMessage } from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Modal, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { plainText } from '../lib/actions';
import { haptic } from '../lib/haptics';
import { colors, fonts, lineHeight, space, type } from '../lib/theme';
import { Button, T } from './ui';

export function SelectSheet({
  message,
  onClose,
  onQuote,
}: {
  message: AgentMessage | null;
  onClose: () => void;
  onQuote: (text: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const text = message ? (message.kind === 'agent' ? plainText(message.text) : message.text) : '';
  // Keyed by the message, so a new one never inherits the last selection.
  const [range, setRange] = useState({ id: '', start: 0, end: 0 });
  const picked = range.id === message?.id ? text.slice(range.start, range.end).trim() : '';

  return (
    <Modal
      visible={!!message}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.page, { paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.head}>
          <T variant="subhead" color={colors.textWhite}>
            Select Text
          </T>
          <Button title="Done" variant="ghost" size="compact" onPress={onClose} />
        </View>
        <TextInput
          value={text}
          editable={false}
          multiline
          scrollEnabled
          contextMenuHidden={false}
          onSelectionChange={(e) => setRange({ id: message?.id ?? '', ...e.nativeEvent.selection })}
          selectionColor={colors.accentActive}
          style={styles.text}
          accessibilityLabel="Message text. Select a part of it to quote or copy"
        />
        <T variant="caption" color={colors.textSecondary} style={styles.hint}>
          {picked ? `${picked.length} characters selected` : 'Select a part, or quote it all'}
        </T>
        <View style={styles.actions}>
          <Button
            title="Copy"
            style={{ flex: 1 }}
            onPress={() => {
              void Clipboard.setStringAsync(picked || text);
              haptic.success();
              onClose();
            }}
          />
          <Button
            title={picked ? 'Quote selection' : 'Quote all'}
            variant="primary"
            style={{ flex: 1 }}
            onPress={() => onQuote(picked || text)}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surfacePanel, paddingTop: space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  text: {
    flex: 1,
    paddingHorizontal: space.lg,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.5),
    color: colors.textPrimary,
  },
  hint: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  actions: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
});
