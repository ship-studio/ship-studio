/**
 * A project session's state as one short line, the way Remote Access reads
 * it off the screen: working (with the spinner's own words), waiting on a
 * decision, finished, or ended.
 */

import type { SessionSummary } from '@shipstudio/companion-protocol';
import { StyleSheet, View } from 'react-native';
import { colors, space } from '../lib/theme';
import { Spinner } from './agent';
import { Dot, T } from './ui';

const CLI_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'Opencode',
};

/** "Claude Code 2", as the project's tab bar names the tab. */
export const tabName = (s: Pick<SessionSummary, 'cli' | 'tab'>) =>
  `${(s.cli && CLI_NAMES[s.cli]) ?? s.cli ?? 'Terminal'} ${s.tab}`;

export function sessionStateText(s: SessionSummary): string {
  switch (s.state) {
    case 'working':
      return s.activity ?? 'Working…';
    case 'needs_decision':
      return s.question?.question ?? 'Waiting for your decision';
    case 'finished':
      return 'Finished · ready for a message';
    case 'exited':
      return 'Ended';
  }
}

export function SessionState({ session }: { session: SessionSummary }) {
  const tone =
    session.state === 'needs_decision'
      ? colors.accentWarning
      : session.state === 'working'
        ? colors.textSecondary
        : colors.textMuted;
  return (
    <View style={styles.row}>
      <View style={styles.mark}>
        {session.state === 'working' ? (
          <Spinner size={11} />
        ) : session.state === 'needs_decision' ? (
          <Dot color={colors.accentWarning} glow size={7} />
        ) : (
          <Dot
            color={session.state === 'finished' ? colors.accentSuccess : colors.textMuted}
            size={7}
          />
        )}
      </View>
      <T variant="small" color={tone} numberOfLines={1} style={{ flex: 1 }}>
        {sessionStateText(session)}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mark: { width: 12, alignItems: 'center' },
});
