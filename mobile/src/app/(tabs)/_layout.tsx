/**
 * The three places you go from home: your agents, the projects they work
 * in, and search across every conversation. Native tabs, so the bar is the
 * system's own (Liquid Glass on iOS 26) and search is the system search tab.
 */

import { NativeTabs } from 'expo-router/native-tabs';
import { needsAttention } from '../../lib/agents';
import { useApp } from '../../lib/store';
import { colors } from '../../lib/theme';

export default function TabsLayout() {
  // Count only, so a streaming reply never re-renders the tab bar.
  const waiting = useApp(
    (s) => s.overview?.agents.filter((a) => !a.hidden && needsAttention(a)).length ?? 0
  );
  const asking = useApp(
    (s) =>
      s.projects?.reduce(
        (n, p) => n + p.sessions.filter((x) => x.state === 'needs_decision').length,
        0
      ) ?? 0
  );
  return (
    <NativeTabs tintColor={colors.textWhite} iconColor={{ default: colors.textMuted }}>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        {waiting > 0 && <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Icon sf={{ default: 'folder', selected: 'folder.fill' }} md="folder" />
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        {/* Rendered only when there's a count: a hidden badge could linger as "0". */}
        {asking > 0 && <NativeTabs.Trigger.Badge>{String(asking)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
