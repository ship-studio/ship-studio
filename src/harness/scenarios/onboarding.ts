/**
 * The onboarding playground's fixture.
 *
 * One scenario rather than one per state: the playground's whole point is that
 * the state is a control, not a checkout. `get_full_setup_status` is a handler
 * so it answers from whatever the playground currently has selected instead of
 * from a frozen literal.
 */

import type { CommandMap, Scenario } from '../types';

const ALL_ITEMS: { id: string; friendlyName: string; version: string }[] = [
  { id: 'homebrew', friendlyName: 'Homebrew', version: '4.3.0' },
  { id: 'node', friendlyName: 'Node.js', version: 'v22.4.0' },
  { id: 'git', friendlyName: 'Git', version: '2.45.2' },
  { id: 'gh', friendlyName: 'GitHub CLI', version: '2.52.0' },
  { id: 'claude', friendlyName: 'Claude Code', version: '2.1.4' },
  { id: 'codex', friendlyName: 'Codex', version: '0.9.0' },
  { id: 'cursor', friendlyName: 'Cursor', version: '1.2.0' },
  { id: 'opencode', friendlyName: 'Opencode', version: '0.4.0' },
];

/**
 * Which setup items the playground currently says are installed.
 *
 * Module state rather than a prop because the fixture backend is reached
 * through the Tauri IPC mock, not through React — there is no component tree
 * between the playground's dropdown and this handler.
 */
let present = new Set<string>();

/** Called by the playground whenever its machine selection changes. */
export function setHarnessSetupPresent(ids: Iterable<string>): void {
  present = new Set(ids);
}

function presentIds(): Set<string> {
  return present;
}

const playgroundCommands: CommandMap = {
  quick_setup_check: { allPresent: false, setupCompleteCached: false },
  get_full_setup_status: () => {
    const present = presentIds();
    return {
      allReady: false,
      items: ALL_ITEMS.map((item) =>
        present.has(item.id)
          ? { ...item, status: 'ready' as const }
          : { id: item.id, friendlyName: item.friendlyName, status: 'not_installed' as const }
      ),
      optionalAuths: { githubAuthenticated: false },
      detectedAgents: [...present].filter((id) =>
        ['claude', 'codex', 'cursor', 'opencode'].includes(id)
      ),
    };
  },
  get_onboarding_test_mode: { mock: true, forceOnboarding: false },
  get_default_agent_id: null,
};

export const onboardingScenarios: Scenario[] = [
  {
    id: 'onboarding-playground',
    title: 'Onboarding — playground',
    looksRightWhen:
      'A control rail on the left and the real onboarding flow on the right. Changing any control restarts the flow at that state. Not a capture target: it exists to be driven by hand.',
    commands: playgroundCommands,
  },
];
