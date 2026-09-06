/**
 * Whole-app scenarios: the states a reviewer most often needs to *see* and
 * which are otherwise expensive to reach (a fresh machine, an empty account,
 * a wedged setup check).
 */

import type { Scenario } from '../types';
import { projects, readySetupItems } from './base';

const notInstalled = (id: string, friendlyName: string) => ({
  id,
  friendlyName,
  status: 'not_installed' as const,
});

export const appScenarios: Scenario[] = [
  {
    id: 'dashboard',
    title: 'Dashboard — the normal case',
    looksRightWhen:
      'Projects render as cards with readable names, consistent spacing, and no placeholder or "undefined" text anywhere.',
    commands: {},
  },
  {
    id: 'dashboard-empty',
    title: 'Dashboard — no projects yet',
    looksRightWhen:
      'A deliberate empty state with a clear primary action, not a blank panel or a stuck spinner.',
    commands: {
      list_projects: [],
      get_projects: [],
      get_pinned_projects: [],
    },
  },
  {
    id: 'dashboard-many',
    title: 'Dashboard — a crowded account',
    looksRightWhen:
      'Layout holds at 24 projects: no overflow past the container, no clipped names, scrolling works.',
    commands: {
      list_projects: Array.from({ length: 24 }, (_, i) => ({
        name: `project-${String(i + 1).padStart(2, '0')}`,
        path: `/Users/harness/ShipStudio/project-${i + 1}`,
        thumbnail: null,
      })),
      get_projects: Array.from({ length: 24 }, (_, i) => ({
        name: `project-${String(i + 1).padStart(2, '0')}`,
        path: `/Users/harness/ShipStudio/project-${i + 1}`,
        thumbnail: null,
      })),
    },
  },
  {
    id: 'dashboard-long-names',
    title: 'Dashboard — hostile project names',
    looksRightWhen:
      'Very long and non-Latin names truncate cleanly instead of breaking the card grid.',
    commands: {
      list_projects: [
        {
          name: 'a-deliberately-extremely-long-project-name-that-should-truncate-rather-than-overflow',
          path: '/Users/harness/ShipStudio/long',
          thumbnail: null,
        },
        { name: '日本語のプロジェクト名', path: '/Users/harness/ShipStudio/jp', thumbnail: null },
        { name: 'emoji-🚀-project', path: '/Users/harness/ShipStudio/emoji', thumbnail: null },
        ...projects,
      ],
    },
  },
  {
    id: 'dashboard-calendar',
    title: 'Dashboard — with the GitHub contributions calendar',
    looksRightWhen:
      'The calendar sits in the dashboard without pushing anything off-screen. Note: it fetches GitHub directly, so under the hermetic capture run it renders its failed/empty state and may differ between runs.',
    commands: { get_calendar_hidden: false },
  },
  {
    id: 'onboarding-fresh',
    title: 'Onboarding — nothing installed',
    looksRightWhen:
      'The agent-led onboarding opens on a fresh machine and every tool reads as not installed.',
    commands: {
      quick_setup_check: { allPresent: false, setupCompleteCached: false },
      get_full_setup_status: {
        allReady: false,
        items: [
          notInstalled('homebrew', 'Homebrew'),
          notInstalled('node', 'Node.js'),
          notInstalled('git', 'Git'),
          notInstalled('gh', 'GitHub CLI'),
          notInstalled('claude', 'Claude Code'),
        ],
        optionalAuths: { githubAuthenticated: false },
        detectedAgents: [],
      },
      get_onboarding_test_mode: { mock: true, forceOnboarding: false },
      get_default_agent_id: null,
    },
  },
  {
    id: 'onboarding-auth-only',
    title: 'Onboarding — installed but signed out',
    looksRightWhen: 'Tools show versions, and only the sign-in steps are outstanding.',
    commands: {
      quick_setup_check: { allPresent: true, setupCompleteCached: false },
      get_full_setup_status: {
        allReady: false,
        items: readySetupItems.map((i) =>
          i.id.endsWith('_auth')
            ? { ...i, status: 'not_authenticated' as const, username: undefined }
            : i
        ),
        optionalAuths: { githubAuthenticated: false },
        detectedAgents: [],
      },
      get_onboarding_test_mode: { mock: true, forceOnboarding: false },
    },
  },
];
