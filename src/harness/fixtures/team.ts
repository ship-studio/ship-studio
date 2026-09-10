/**
 * Team — the harness's backend.
 *
 * `get_team_snapshot` reads a real repository, which is exactly what a harness
 * cannot have: the machine running a capture has no teammates, no pull requests
 * and usually no remote. So this stands in for it — every person, SHA, PR
 * number and sentence below is invented, and none of it ships.
 *
 * Two rules keep it honest as a stand-in:
 *
 * 1. **It adopts whichever project the scenario opened.** The screens are about
 *    *your* project with people in it, so the fixture takes the open project's
 *    name and path rather than inventing a repo nobody has heard of.
 * 2. **`avatarUrl` is null for everyone.** A real GitHub avatar is a network
 *    image, and inventing URLs would photograph a broken one. Initials are the
 *    design for a missing avatar, so the fixture exercises the path that
 *    actually has to be good.
 *
 * The updates are written the way an agent would write them under the bundled
 * skill: what changed, why, what it touched, what it needs. That is the whole
 * argument for the feature, so the fixture holds itself to it — if these read
 * like commit messages, the design is wrong.
 *
 * @module harness/fixtures/team
 */

import type { TeamActor, TeamMember, TeamSnapshot, TeamThread, TeamUpdate } from '../../lib/team';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const actor = (login: string, name: string): TeamActor => ({ login, name, avatarUrl: null });

export const FIXTURE_ACTORS = {
  self: actor('you', 'You'),
  maya: actor('mayareed', 'Maya Reed'),
  jordan: actor('jordanchen', 'Jordan Chen'),
  enid: actor('enidshah', 'Enid Shah'),
  sarah: actor('sarahpark', 'Sarah Park'),
  /** Has repo access and has never opened Harbr. */
  theo: actor('theo-vance', 'Theo Vance'),
};

export interface TeamFixtureOptions {
  now?: number;
  /** The project the user actually has open, so the fixture is about it. */
  projectName?: string;
  projectPath?: string;
  /** The signed-in user's real display name, when we know it. */
  selfName?: string;
  /**
   * Make the user's own recent rows the thin kind — a commit subject and no
   * body. The state `TeamSelfCoverageNote` exists for, and one that is
   * otherwise slow to reach: it takes three pushes in a row with no summary.
   */
  selfRowsAreThin?: boolean;
}

/** Builds the snapshot relative to a `now`, so ages read correctly on open. */
export function buildTeamFixture(options: TeamFixtureOptions = {}): TeamSnapshot {
  const {
    now = Date.now(),
    projectName = 'your project',
    projectPath = '',
    selfName,
    selfRowsAreThin = false,
  } = options;

  const self: TeamActor = selfName
    ? { ...FIXTURE_ACTORS.self, name: selfName }
    : FIXTURE_ACTORS.self;
  const at = (ms: number) => now - ms;

  // Stands in for the project's real `owner/repo`. In the real build every one
  // of these links is built from the remote, which is why they can be offered
  // for a teammate who has never opened Harbr.
  const repo = `acme-studio/${projectName}`;

  let seq = 0;
  const update = (
    ms: number,
    partial: Omit<TeamUpdate, 'id' | 'at' | 'projectName' | 'projectPath' | 'githubUrl'> & {
      githubUrl?: string | null;
    }
  ): TeamUpdate => {
    seq += 1;
    // Derived rather than written out per row: a PR if there is one, otherwise
    // the newest commit. Same rule the real one uses.
    const derived = partial.prNumber
      ? `https://github.com/${repo}/pull/${partial.prNumber}`
      : partial.commits[0]
        ? `https://github.com/${repo}/commit/${partial.commits[0].sha}`
        : null;
    return {
      id: `01K4J8Q2${String(seq).padStart(4, '0')}`,
      at: at(ms),
      projectName,
      projectPath,
      githubUrl: derived,
      ...partial,
    };
  };

  const updates: TeamUpdate[] = [
    update(6 * MINUTE, {
      actor: FIXTURE_ACTORS.maya,
      writtenBy: 'agent',
      agentName: 'Claude Code',
      headline: 'Rebuilt the pricing tiers as a CSS grid',
      why: 'The flex row could not hold three columns at 1024px without the third wrapping under the first two, and the fix people kept reaching for was a hardcoded width that broke again at every new tier.',
      changes: [
        'Replaced the flex row with a 3-up grid that collapses to 1-up under 768px',
        'Removed the four hardcoded card widths this was working around',
        'Tier badges now sit in the card flow instead of absolutely positioned',
      ],
      asks: 'The middle tier is visually taller than the others now. That looks deliberate to me, but it was not before — worth a look.',
      branch: 'feat/pricing-tiers',
      status: 'needs-review',
      commits: [
        { sha: 'a3f2c81', message: 'Move pricing tiers to grid' },
        { sha: '9d1e04b', message: 'Drop the hardcoded card widths' },
        { sha: '2b77fa9', message: 'Reflow tier badges' },
      ],
      files: [
        { path: 'src/components/PricingTiers.astro', added: 41, removed: 78 },
        { path: 'src/styles/pricing.css', added: 18, removed: 52 },
      ],
      prNumber: 142,
      buildError: null,
    }),

    update(52 * MINUTE, {
      actor: FIXTURE_ACTORS.enid,
      writtenBy: 'app',
      agentName: null,
      headline: 'fix plan type',
      // `app`-written rows genuinely do not know why. Padding this with a
      // guess is exactly the thing the whole feature is trying not to do.
      why: null,
      changes: [],
      asks: null,
      branch: 'main',
      status: 'broken',
      commits: [{ sha: '77b0e14', message: 'fix plan type' }],
      files: [{ path: 'src/lib/plans.ts', added: 6, removed: 2 }],
      prNumber: null,
      buildError:
        "Type error: Property 'tier' does not exist on type 'Plan'. (src/lib/plans.ts:42)",
    }),

    update(2 * HOUR + 10 * MINUTE, {
      actor: FIXTURE_ACTORS.jordan,
      writtenBy: 'agent',
      agentName: 'Codex',
      headline: 'Made the mobile nav usable one-handed',
      why: 'The menu opened from the top of a 780px-tall sheet, so every link on a phone was out of thumb reach. Reported twice in support and worked around both times by scrolling.',
      changes: [
        'Menu now opens from the bottom and caps at 60vh',
        'Primary links sit in the lower half, secondary above the fold line',
        'Backdrop closes on tap — it previously only closed via the X',
      ],
      asks: null,
      branch: 'fix/nav-reach',
      status: 'in-review',
      commits: [
        { sha: 'c40a1d2', message: 'Bottom-anchored mobile nav' },
        { sha: 'ee9b330', message: 'Close nav on backdrop tap' },
      ],
      files: [
        { path: 'src/components/MobileNav.tsx', added: 63, removed: 44 },
        { path: 'src/styles/nav.css', added: 27, removed: 11 },
      ],
      prNumber: 141,
      buildError: null,
    }),

    update(5 * HOUR, {
      actor: FIXTURE_ACTORS.sarah,
      writtenBy: 'person',
      agentName: null,
      headline: 'Pulled the launch banner until legal sign-off',
      why: 'The pricing claim in it has not been approved and we are one push away from it being live. Reverting is cheaper than explaining.',
      changes: ['Banner component removed from the layout, not deleted — the branch still has it'],
      asks: 'Nobody re-add this until legal comes back. I will put the date in here when I have it.',
      branch: 'main',
      status: 'deployed',
      commits: [{ sha: '5f0c9aa', message: 'Remove launch banner from layout' }],
      files: [{ path: 'src/layouts/Base.astro', added: 0, removed: 4 }],
      prNumber: null,
      buildError: null,
    }),

    update(DAY + 30 * MINUTE, {
      actor: FIXTURE_ACTORS.theo,
      writtenBy: 'app',
      agentName: null,
      headline: 'Merge pull request #139 from acme-studio/copy-tweaks',
      why: null,
      changes: [],
      asks: null,
      branch: 'main',
      status: 'merged',
      commits: [{ sha: '1d77e42', message: 'Merge pull request #139' }],
      files: [{ path: 'src/content/copy.json', added: 31, removed: 28 }],
      prNumber: 139,
      buildError: null,
    }),

    update(DAY + 3 * HOUR, {
      actor: FIXTURE_ACTORS.maya,
      writtenBy: 'agent',
      agentName: 'Claude Code',
      headline: 'Cut the largest image on the homepage from 2.4MB to 180KB',
      why: 'The hero was shipping a full-resolution PNG export. On a throttled 4G profile it was 3.1s of the 4.4s LCP by itself.',
      changes: [
        'Hero converted to AVIF with a WebP fallback',
        'Added width/height so it stops shifting the layout while it loads',
        'Four other unoptimised PNGs found in the same pass, listed below',
      ],
      asks: 'The other four are the same one-line fix if someone wants an easy one.',
      branch: 'perf/hero-image',
      status: 'merged',
      commits: [
        { sha: '81ce773', message: 'AVIF hero with WebP fallback' },
        { sha: 'b0d4e19', message: 'Add intrinsic dimensions to hero' },
      ],
      files: [
        { path: 'src/components/Hero.astro', added: 22, removed: 9 },
        { path: 'public/hero.avif', added: 1, removed: 0 },
      ],
      prNumber: 138,
      buildError: null,
    }),

    update(DAY + 7 * HOUR, {
      actor: FIXTURE_ACTORS.jordan,
      writtenBy: 'agent',
      agentName: 'Codex',
      headline: 'Deleted the duplicate Button component',
      why: 'There were two — one in components/ and one in ui/ — and new code had been picking whichever it found first for about three months. They had drifted on focus rings and disabled states.',
      changes: [
        'ui/Button.tsx removed; 23 imports repointed at components/Button.tsx',
        'Kept the ui/ focus ring, which was the accessible one of the two',
      ],
      asks: null,
      branch: 'chore/one-button',
      status: 'merged',
      commits: [{ sha: '3ac7f01', message: 'Consolidate Button' }],
      files: [
        { path: 'src/components/Button.tsx', added: 14, removed: 3 },
        { path: 'src/ui/Button.tsx', added: 0, removed: 91 },
      ],
      prNumber: 136,
      buildError: null,
    }),

    update(2 * DAY + 4 * HOUR, {
      actor: FIXTURE_ACTORS.enid,
      writtenBy: 'agent',
      agentName: 'Claude Code',
      headline: 'Contact form was silently dropping submissions',
      why: 'The handler returned 200 before awaiting the send, so failures never surfaced anywhere. Going by the logs this has been happening since the 14th.',
      changes: [
        'Await the send and return its real status',
        'Failures now log with the submission id instead of being swallowed',
        'Added the one test that would have caught this',
      ],
      asks: 'Somebody should check whether anything was lost between the 14th and today. I could not tell from the logs.',
      branch: 'fix/contact-form',
      status: 'deployed',
      commits: [
        { sha: 'd82b114', message: 'Await send in contact handler' },
        { sha: '4e0a97c', message: 'Test: failed send returns 500' },
      ],
      files: [
        { path: 'src/pages/api/contact.ts', added: 19, removed: 7 },
        { path: 'src/pages/api/contact.test.ts', added: 34, removed: 0 },
      ],
      prNumber: 133,
      buildError: null,
    }),
  ];

  const members: TeamMember[] = [
    {
      actor: self,
      role: 'admin',
      branch: 'main',
      projectName,
      lastPushedAt: at(3 * HOUR),
      commitsAhead: 0,
      prNumber: null,
      doing: null,
      explainsWork: true,
      isSelf: true,
    },
    {
      actor: FIXTURE_ACTORS.maya,
      role: 'write',
      branch: 'feat/pricing-tiers',
      projectName,
      lastPushedAt: at(6 * MINUTE),
      commitsAhead: 3,
      prNumber: 142,
      doing: 'Rebuilt the pricing tiers as a CSS grid',
      explainsWork: true,
      isSelf: false,
    },
    {
      actor: FIXTURE_ACTORS.jordan,
      role: 'maintainer',
      branch: 'fix/nav-reach',
      projectName,
      lastPushedAt: at(2 * HOUR + 10 * MINUTE),
      commitsAhead: 2,
      prNumber: 141,
      doing: 'Made the mobile nav usable one-handed',
      explainsWork: true,
      isSelf: false,
    },
    {
      actor: FIXTURE_ACTORS.enid,
      role: 'admin',
      branch: 'main',
      projectName,
      lastPushedAt: at(52 * MINUTE),
      commitsAhead: 0,
      prNumber: null,
      doing: 'Pushed to main — the build is failing',
      explainsWork: false,
      isSelf: false,
    },
    {
      actor: FIXTURE_ACTORS.theo,
      role: 'write',
      branch: 'main',
      projectName,
      lastPushedAt: at(DAY + 30 * MINUTE),
      commitsAhead: 0,
      prNumber: null,
      doing: 'Merged #139 — copy tweaks',
      explainsWork: false,
      isSelf: false,
    },
    {
      actor: FIXTURE_ACTORS.sarah,
      role: 'write',
      branch: 'main',
      projectName,
      lastPushedAt: at(5 * HOUR),
      commitsAhead: 0,
      prNumber: null,
      doing: 'Pulled the launch banner until legal sign-off',
      explainsWork: true,
      isSelf: false,
    },
  ];

  const threads: TeamThread[] = [
    {
      id: 'th-1',
      projectName,
      projectPath,
      branch: 'feat/pricing-tiers',
      route: '/pricing',
      target: 'h1 · Simple pricing, no surprises',
      pin: 1,
      resolved: false,
      resolvedBy: null,
      messages: [
        {
          id: 'm-1',
          actor: FIXTURE_ACTORS.jordan,
          at: at(40 * MINUTE),
          body: 'This headline wraps to three lines on a 390px screen and pushes the tier cards below the fold. Can we drop it to two?',
        },
        {
          id: 'm-2',
          actor: FIXTURE_ACTORS.maya,
          at: at(12 * MINUTE),
          body: 'Shortening it to “Simple pricing” fixes it without a breakpoint. Taking it on my branch.',
        },
      ],
    },
    {
      id: 'th-2',
      projectName,
      projectPath,
      branch: 'main',
      route: '/',
      target: 'section · Testimonials',
      pin: 2,
      resolved: false,
      resolvedBy: null,
      messages: [
        {
          id: 'm-3',
          actor: FIXTURE_ACTORS.sarah,
          at: at(3 * HOUR),
          body: 'Two of these three quotes are from the same company. Can we swap one out before this goes in front of anybody?',
        },
      ],
    },
    {
      id: 'th-3',
      projectName,
      projectPath,
      branch: 'main',
      route: '/pricing',
      target: 'table · Compare plans',
      pin: 3,
      resolved: true,
      resolvedBy: FIXTURE_ACTORS.maya,
      messages: [
        {
          id: 'm-4',
          actor: FIXTURE_ACTORS.enid,
          at: at(DAY + 2 * HOUR),
          body: 'The comparison table scrolls sideways on tablet with nothing showing that it can.',
        },
        {
          id: 'm-5',
          actor: FIXTURE_ACTORS.maya,
          at: at(DAY),
          body: 'Added a fade on the right edge that disappears once you reach the end. Pushed.',
        },
      ],
    },
  ];

  // Three of your own pushes with a subject and nothing under it. Newest, so
  // they are the rows you are looking at when the note appears beneath them.
  if (selfRowsAreThin) {
    updates.unshift(
      ...[2, 40, 90].map((minutes, i) =>
        update(minutes * MINUTE, {
          actor: self,
          writtenBy: 'app',
          agentName: null,
          headline: ['Update the footer links', 'Fix the nav on mobile', 'Bump the deps'][i],
          why: null,
          changes: [],
          asks: null,
          branch: 'main',
          status: 'working',
          commits: [{ sha: `a${i}f39b2`, message: 'chore: update' }],
          files: [],
          prNumber: null,
          buildError: null,
        })
      )
    );
  }

  return {
    updates,
    members,
    threads,
    sync: {
      repo: null, // filled in by the store from the project's real remote
      lastSyncedAt: at(2 * MINUTE),
      pendingCount: 0,
      error: null,
      syncing: false,
    },
    // Everything older than the two most recent counts as already seen, so
    // "new since you were here" has something to show on first open.
    seenIds: updates.slice(2).map((u) => u.id),
    commitGuidanceInstalled: false,
  };
}
