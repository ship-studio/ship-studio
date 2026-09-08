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
    requires: '.project-card',
    title: 'Dashboard — the normal case',
    looksRightWhen:
      'Projects render as cards with readable names, consistent spacing, and no placeholder or "undefined" text anywhere.',
    commands: {},
  },
  {
    id: 'dashboard-empty',
    // Without this the scenario photographed the three projects from the base
    // fixture: the dashboard reads `get_dashboard_projects`, and only the two
    // commands beside it were being emptied. `requires` now names the CTA, so
    // a fixture that fails to empty the list fails the run instead of quietly
    // certifying a populated grid as the empty state.
    requires: '.empty-state-action',
    title: 'Dashboard — no projects yet',
    looksRightWhen:
      'A deliberate empty state with a clear primary action, not a blank panel or a stuck spinner.',
    commands: {
      get_dashboard_projects: [],
      list_projects: [],
      get_projects: [],
      get_pinned_projects: [],
    },
  },
  {
    id: 'dashboard-many',
    // `.project-card` alone was satisfied by the base fixture's three cards, so
    // this claimed to hold at 24 while photographing 3. Requiring the tenth
    // card means the crowd has to actually be there.
    requires: '.project-card:nth-of-type(10)',
    title: 'Dashboard — a crowded account',
    looksRightWhen:
      'Layout holds at 24 projects: no overflow past the container, no clipped names, scrolling works.',
    commands: {
      get_dashboard_projects: Array.from({ length: 24 }, (_, i) => ({
        name: `project-${String(i + 1).padStart(2, '0')}`,
        path: `/Users/harness/ShipStudio/project-${i + 1}`,
        thumbnail: null,
      })),
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
    requires: '.project-card',
    title: 'Dashboard — hostile project names',
    looksRightWhen:
      'Very long and non-Latin names truncate cleanly instead of breaking the card grid.',
    commands: {
      get_dashboard_projects: [
        {
          name: 'a-deliberately-extremely-long-project-name-that-should-truncate-rather-than-overflow',
          path: '/Users/harness/ShipStudio/long',
          thumbnail: null,
        },
        { name: '日本語のプロジェクト名', path: '/Users/harness/ShipStudio/jp', thumbnail: null },
        { name: 'emoji-🚀-project', path: '/Users/harness/ShipStudio/emoji', thumbnail: null },
        ...projects,
      ],
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
    requires: '.flow-choice-row',
    title: 'Onboarding — the first question',
    looksRightWhen:
      'One question, five options, nothing else. Every row aligns on the same three columns — letter, icon, text — including the option that has no icon. The hairline progress bar is at the very top.',
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
    id: 'onboarding-flow-admin',
    requires: '.flow-action',
    openSelector: '.flow-choice-row',
    // The prompt arrives a beat after the click, since the agent speaks first.
    // Steps wait for their selector, so this one is purely that wait — the
    // click lands on the panel itself, which has no handler.
    steps: [{ click: '.flow-action' }],
    title: 'Onboarding — the agent needs your password',
    looksRightWhen:
      'Picking an agent leads to the first thing only a person can do. The screen explains who is asking for the password (macOS, not us) before any system sheet appears, and "Not now" is as easy to find as "Continue".',
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
    id: 'onboarding-flow-installing',
    requires: '.flow-step',
    openSelector: '.flow-choice-row',
    steps: [{ click: '.flow-action .button--primary' }],
    title: 'Onboarding — the agent doing the work',
    looksRightWhen:
      'Plain-English steps, exactly one of them moving, everything else receded. No terminal, no scrolling log. The step being worked on is the only line at full contrast.',
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
    id: 'onboarding-flow-partial',
    requires: '.flow-choice-row.satisfied',
    title: 'Onboarding — some of it is already here',
    looksRightWhen:
      'A machine that already has Claude Code says so on the row itself, with a check rather than a badge. Nothing else about the question changes.',
    commands: {
      quick_setup_check: { allPresent: false, setupCompleteCached: false },
      get_full_setup_status: {
        allReady: false,
        items: [
          { id: 'claude', friendlyName: 'Claude Code', status: 'ready' as const, version: '2.1.4' },
          notInstalled('homebrew', 'Homebrew'),
          notInstalled('node', 'Node.js'),
          notInstalled('git', 'Git'),
          notInstalled('gh', 'GitHub CLI'),
        ],
        optionalAuths: { githubAuthenticated: false },
        detectedAgents: ['claude'],
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
