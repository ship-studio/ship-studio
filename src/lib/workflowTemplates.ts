/**
 * Starting points for a new workflow.
 *
 * These carry most of the weight of the feature's first impression. Nobody
 * arrives at an empty prompt box knowing what a good standing instruction
 * looks like, so the templates have to do three jobs at once: be worth running
 * as written, teach the shape of a well-aimed instruction, and show what comes
 * back — which is why each one ships an `example` of the finding it would file.
 *
 * Two rules hold the set together:
 *
 * - **Every prompt says what *not* to report.** The way a workflow fails is by
 *   being noisy, and an agent asked to find problems will always find some.
 * - **Nothing is armed faster than hourly.** A template's cadence is the one
 *   nobody thinks about, and it spends the user's own agent subscription.
 *
 * @module lib/workflowTemplates
 */

import type { Severity, WorkflowPermission, WorkflowTrigger } from './workflows';

export type WorkflowTemplateCategory =
  | 'Security'
  | 'Quality'
  | 'Content'
  | 'Maintenance'
  | 'Research';

/** The categories, in the order the picker offers them. */
export const TEMPLATE_CATEGORIES: WorkflowTemplateCategory[] = [
  'Security',
  'Quality',
  'Content',
  'Maintenance',
  'Research',
];

/**
 * A finding this template would plausibly file.
 *
 * Shown in the picker before anything is created. A description says what a
 * workflow looks at; this says what you get back, which is the thing people
 * are actually deciding about — and it teaches the shape of the Inbox before
 * they have ever seen one.
 */
export interface WorkflowTemplateExample {
  severity: Severity;
  title: string;
  summary: string;
  /** `path:line`, as a real finding carries. */
  location?: string;
}

export interface WorkflowTemplate {
  id: string;
  /** One emoji; becomes the workflow's mark in the list. */
  icon: string;
  name: string;
  /** One line, benefit first. Shown in the picker list. */
  description: string;
  /**
   * How this one actually behaves, for the preview pane.
   *
   * Deliberately not a longer description: the row beside it already says
   * what the workflow is for, and repeating that in bigger type teaches
   * nothing. This says how it decides what is worth telling you — which is
   * the difference between a workflow people keep and one they disarm in a
   * week.
   */
  detail?: string;
  category: WorkflowTemplateCategory;
  trigger: WorkflowTrigger;
  permission: WorkflowPermission;
  prompt: string;
  /** Shown to a first-time user, before anything else. */
  starter?: boolean;
  /** A condition the workflow needs to be useful, in a short phrase. */
  requires?: string;
  example?: WorkflowTemplateExample;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  /* ------------------------------------------------------------ Security */
  {
    id: 'tpl-security',
    icon: '🔒',
    name: 'Security sweep',
    description: 'Reviews what you just pushed for secrets, auth gaps, and unsafe input.',
    detail:
      'Reads the diff rather than the whole tree, so it stays cheap and stays specific — and it only speaks up for things it can point at with a file and a line.',
    category: 'Security',
    starter: true,
    // Push, not a timer. The prompt is diff-shaped, and the moment worth
    // checking is the moment code leaves the machine.
    trigger: { kind: 'event', event: 'push' },
    permission: 'read-only',
    prompt: `Review everything that changed since your last run for security regressions: secrets committed to source, unvalidated user input reaching the filesystem or a shell, auth checks removed from a route, dependencies from an unfamiliar registry.

Include the exact file and line for each finding. Ignore test fixtures.`,
    example: {
      severity: 'critical',
      title: 'Checkout route trusts the cookie header for identity',
      summary:
        'The raw Cookie header is passed to charge() as the user id, with no session lookup — any caller can set it.',
      location: 'src/app/api/checkout/route.ts:12',
    },
  },
  {
    id: 'tpl-secrets',
    icon: '🔑',
    name: 'Secrets & env drift',
    description: 'Finds keys that reached the client, the repo, or a log line.',
    detail:
      'Looks at where a value ends up, not just where it is declared: a key is only a finding here if something actually ships it, logs it, or commits it.',
    category: 'Security',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Look for credentials that have ended up somewhere they should not be: keys committed to the repository, secrets read through a client-exposed prefix (NEXT_PUBLIC_, VITE_, PUBLIC_) and therefore shipped in the browser bundle, tokens printed to logs or error messages, and variables the code reads that .env.example never mentions.

For each one say where it leaks and who can see it. Ignore obvious placeholders and test keys.`,
    example: {
      severity: 'critical',
      title: 'Payment secret is readable in the browser bundle',
      summary:
        'Read through a NEXT_PUBLIC_ prefix, so it ships to every visitor in the client JavaScript.',
      location: 'src/components/Checkout.tsx:8',
    },
  },

  /* ------------------------------------------------------------- Quality */
  {
    id: 'tpl-pr',
    icon: '🔍',
    name: 'PR review pass',
    description: 'Reviews every PR you open, before a human sees it.',
    detail:
      'Correctness only. If it cannot describe the inputs that produce a wrong result, it is told not to file anything — which is what keeps it from turning into a style bot.',
    category: 'Quality',
    trigger: { kind: 'event', event: 'pr-opened' },
    permission: 'read-only',
    prompt: `Review the PR diff for correctness bugs only — not style, not naming.

For each finding, give me the concrete inputs that produce the wrong output. If you can't describe a failure, don't file it.`,
    example: {
      severity: 'warning',
      title: 'Pagination drops the last page on an exact multiple',
      summary:
        'With 40 items and a page size of 20, the loop stops at page 1 — the boundary is < instead of <=.',
      location: 'src/lib/paginate.ts:38',
    },
  },
  {
    id: 'tpl-a11y',
    icon: '♿️',
    name: 'Accessibility pass',
    description: 'Reads your components for the accessibility basics, with fixes.',
    detail:
      'Reads the code rather than guessing from a rendered page, so every finding names the element and the fix. Anything it cannot verify by reading, it drops.',
    category: 'Quality',
    starter: true,
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Review the components for accessibility problems that are real, not theoretical: an interactive element that is a div, an icon-only button with no accessible name, an input with no label, a colour pair that fails contrast, a dialog nothing returns focus from, an ARIA role that contradicts the element it sits on.

For each one, name the file, the element, and the fix in a sentence. Skip anything you cannot verify by reading the code.`,
    example: {
      severity: 'warning',
      title: 'Toolbar icon buttons announce as "button" and nothing else',
      summary:
        'Six icon-only buttons have no aria-label, so a screen reader offers no way to tell them apart.',
      location: 'src/components/Toolbar.tsx:22',
    },
  },
  {
    id: 'tpl-design',
    icon: '🎨',
    name: 'Design-system drift',
    description: 'Holds each push to the design rules your repo already documents.',
    detail:
      'Reads your own CLAUDE.md and design docs first, then judges the diff against those — so it enforces your rules, not somebody else’s taste.',
    category: 'Quality',
    trigger: { kind: 'event', event: 'push' },
    permission: 'read-only',
    prompt: `Read CLAUDE.md and the design-system docs first, then review the pushed diff for drift: raw hex colours, off-scale spacing, a hand-rolled component where a primitive exists, a new button class.

Only report things the docs actually forbid.`,
    example: {
      severity: 'info',
      title: 'New pricing section uses raw hex instead of tokens',
      summary: 'Three colours and two spacing values bypass the token layers the docs require.',
      location: 'src/components/Pricing.tsx:44',
    },
  },
  {
    id: 'tpl-links',
    icon: '🔗',
    name: 'Broken links & images',
    description: 'Crawls your running preview for 404s and images that never load.',
    detail:
      'Crawls the preview you already have running. If no dev server is up it reports nothing and stops rather than starting one behind your back.',
    category: 'Quality',
    requires: 'the project open with its dev server running',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Crawl the pages of this project's running dev-server preview. Report links that 404, images that fail to load, and any page that throws in the console on first paint.

Group repeats by cause — one broken link in a shared footer is one finding, not one per page. Ignore external links that merely rate-limit or block crawlers, and ignore anchors to sections that exist.

If no preview is running, report nothing and stop. Do not start a server yourself.`,
    example: {
      severity: 'warning',
      title: 'Three links on the pricing page 404',
      summary: 'All three point at /docs/billing, which was renamed to /docs/payments in June.',
      location: 'src/content/pricing.mdx:31',
    },
  },
  {
    id: 'tpl-console',
    icon: '🐛',
    name: 'Console errors',
    description: 'Opens each page and reports what the browser complains about.',
    detail:
      'Groups by cause instead of by page, so one bad shared layout is one finding rather than twelve, and third-party noise is left out.',
    category: 'Quality',
    requires: 'the project open with its dev server running',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Visit each page of the running preview and report errors and warnings the browser logs on load: hydration mismatches, failed requests, React key and prop warnings, uncaught exceptions.

Group them by cause rather than by page — one hydration bug on a shared layout is one finding, not twelve. Ignore warnings from third-party scripts you cannot change.`,
    example: {
      severity: 'warning',
      title: 'Every blog post hydrates with a mismatch',
      summary:
        'The published date is formatted with the server locale and re-formatted in the client.',
      location: 'src/components/PostMeta.tsx:14',
    },
  },
  {
    id: 'tpl-tests',
    icon: '🧪',
    name: 'Test gaps',
    description: 'Points at the risky code that changed without a test.',
    detail:
      'Starts from what changed this week and ranks by blast radius — money, auth, deletion, retries — instead of chasing a coverage number.',
    category: 'Quality',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Look at what changed in the last week and find the changes that carry risk and have no test covering them: money, auth, data deletion, anything with retries or timeouts, anything with a boundary condition.

Rank by what would hurt most if it broke. Do not ask for coverage of glue code, config, or styling, and do not report a coverage percentage.`,
    example: {
      severity: 'warning',
      title: 'Payment retry logic changed twice with no test',
      summary:
        'The backoff branch is the one that decides whether a customer gets charged twice, and nothing exercises it.',
      location: 'src/lib/payments/retry.ts:52',
    },
  },

  /* ------------------------------------------------------------- Content */
  {
    id: 'tpl-copy',
    icon: '✍️',
    name: 'Copy review',
    description: 'Catches the typos and mixed-up naming your users would see.',
    detail:
      'Reads only the strings a user can actually see, and reports the ones that would embarrass you: typos, mixed-up naming, errors nobody can act on.',
    category: 'Content',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Read the user-facing strings in this project — page copy, button labels, empty states, error messages — and report only things that would embarrass us in front of a user: typos, a product or feature name spelled differently in different places, an error message that tells the user nothing they can act on, sentence case fighting title case in the same surface.

Quote the exact string and give the file. Ignore code comments, tests, and anything the user never sees.`,
    example: {
      severity: 'warning',
      title: 'The product name is spelled three ways in onboarding',
      summary: 'Two screens say "Ship studio", one says "ShipStudio", the rest say "Ship Studio".',
      location: 'src/components/setup/Welcome.tsx:19',
    },
  },
  {
    id: 'tpl-seo',
    icon: '🧭',
    name: 'SEO & metadata',
    description: 'Checks the tags that decide how your pages show up elsewhere.',
    detail:
      'Reports the pages, not the theory — the ones shipping a default title, missing a description, or invisible in a link preview.',
    category: 'Content',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Check the metadata across the site's pages: missing or duplicated titles and descriptions, pages shipping the default template title, missing Open Graph images, images with no alt text, headings that skip levels, and anything the sitemap or robots rules exclude by accident.

Report the pages, not the theory. Skip pages that are meant to be private or noindexed.`,
    example: {
      severity: 'warning',
      title: 'Six pages still ship the starter template title',
      summary:
        'They appear in search and in link previews as "Create Next App", including the pricing page.',
      location: 'src/app/pricing/page.tsx:3',
    },
  },
  {
    id: 'tpl-docs',
    icon: '📚',
    name: 'Docs drift',
    description: 'Finds the places your README now describes an app you no longer have.',
    detail:
      'Checks the README against the code that is actually there, so you find out a setup step is dead before a new contributor does.',
    category: 'Content',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Compare the README and any docs in this repository against what the code actually does: setup steps that reference scripts or files that no longer exist, environment variables documented but never read (or read but never documented), described behaviour that has since changed, and examples that would fail if someone ran them.

Only report a mismatch you have verified in the code.`,
    example: {
      severity: 'warning',
      title: 'README setup steps fail on a clean clone',
      summary:
        'Step 3 runs `pnpm db:seed`, which was removed in April — a new contributor stops there.',
      location: 'README.md:41',
    },
  },
  {
    id: 'tpl-shipped',
    icon: '📰',
    name: 'What shipped this week',
    description: 'Turns the week’s commits into release notes you can actually publish.',
    detail:
      'Writes the notes for you, grouped by what a user would notice. If nothing user-visible shipped, it says so in one line instead of padding.',
    category: 'Content',
    trigger: { kind: 'weekly', weekday: 5, atHour: 16, atMinute: 0 },
    permission: 'read-only',
    prompt: `Read this week's commits and write the release notes: what a user would notice, grouped by what it means to them rather than by file or by commit.

Skip refactors, dependency bumps, and anything invisible from outside. Write it in plain language, ready to paste. File it as one finding, even if the week was quiet — and if nothing user-visible shipped, say that in one line instead.`,
    example: {
      severity: 'info',
      title: 'Release notes for this week — 14 commits, 3 worth mentioning',
      summary:
        'Faster project switching, a fix for the duplicate-invoice bug, and Danish added to the locale switcher.',
    },
  },

  /* --------------------------------------------------------- Maintenance */
  {
    id: 'tpl-deps',
    icon: '📦',
    name: 'Dependency drift',
    description: 'A daily read on advisories, and which upgrades are worth taking.',
    detail:
      'Tells you whether the vulnerable path is reachable from your code, which is the part an audit command never answers.',
    category: 'Maintenance',
    starter: true,
    trigger: { kind: 'daily', atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Run the project's audit and outdated commands. For each advisory above "low", tell me whether the vulnerable path is actually reachable from this codebase. For majors we're behind on, give me a one-line read on whether the migration is worth doing now, later, or never.

Ignore dev-only packages unless the advisory is remotely exploitable.`,
    example: {
      severity: 'warning',
      title: 'One advisory is reachable, the other four are not',
      summary:
        'The parser flaw is on your upload path with user-controlled input; a patch exists in 4.2.1.',
      location: 'package.json:24',
    },
  },
  {
    id: 'tpl-build',
    icon: '🩺',
    name: 'Build health',
    description: 'Tells you the build broke before your host does.',
    detail:
      'Runs the same checks your host will. If everything passes it reports nothing at all, so it is only ever bad news.',
    category: 'Maintenance',
    trigger: { kind: 'event', event: 'push' },
    permission: 'read-only',
    prompt: `Run this project's type check, lint, and build. If any of them fail, report the failure with the first error that matters and the file it points at — not the whole log.

If they all pass, report nothing. Do not try to fix anything.`,
    example: {
      severity: 'critical',
      title: 'The build fails on what you just pushed',
      summary:
        'A type error in the cart reducer: `total` is possibly undefined after the discount branch.',
      location: 'src/state/cart.ts:71',
    },
  },
  {
    id: 'tpl-perf',
    icon: '📉',
    name: 'Bundle watch',
    description: 'A weekly read on what is quietly making the app heavier.',
    detail:
      'Compares against its own last run, so you see the drift rather than a number you have no reference for.',
    category: 'Maintenance',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Build the project if it has a build command, and look at what the bundle is made of. Report anything that grew meaningfully since your last run, any dependency pulling in far more weight than the job needs, and anything heavy being imported at the top level that could be loaded when it is actually used.

Give sizes, and only report growth someone would feel — ignore a few kilobytes of drift and anything the framework itself put there. If the build fails, report that as the finding and stop; do not try to fix it.`,
    example: {
      severity: 'warning',
      title: 'The marketing page pulls in the whole chart library',
      summary: '480 kB for one sparkline, loaded on the page most first-time visitors land on.',
      location: 'src/app/page.tsx:6',
    },
  },
  {
    id: 'tpl-deadcode',
    icon: '🧹',
    name: 'Dead code sweep',
    description: 'Finds the files, exports, and packages nothing uses any more.',
    detail:
      'Says how it verified each one, and leaves alone anything reached dynamically or by framework convention — the two ways this check usually goes wrong.',
    category: 'Maintenance',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Find code that nothing reaches: exports with no importer, files nothing references, dependencies in package.json that never appear in the source, and feature flags whose branch is now unreachable.

Say how you verified each one. Do not report anything reached only by dynamic import or by a framework convention (route files, config, entry points) unless you are certain.`,
    example: {
      severity: 'info',
      title: 'Nine exports and two packages nothing imports',
      summary:
        'Includes the old checkout flow, which is 400 lines and still shows up in every search.',
      location: 'src/legacy/checkout/index.ts:1',
    },
  },
  {
    id: 'tpl-branches',
    icon: '🌿',
    name: 'Stale branches & PRs',
    description: 'A weekly tidy-up list for work that stalled.',
    detail:
      'One finding for the whole list, with a read on whether each is abandoned or just forgotten.',
    category: 'Maintenance',
    requires: 'the GitHub CLI signed in',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `List the branches and pull requests that have gone quiet: PRs open more than three weeks, branches with no commits in a month, PRs that have gathered conflicts, and branches already merged that were never deleted.

For each, say whether it looks abandoned or forgotten, and what it would take to finish it. Ignore long-lived release, staging, and dependency-bot branches. File it as one finding, not one per branch.`,
    example: {
      severity: 'info',
      title: 'Two PRs have been open more than a month',
      summary:
        'One is approved and just needs a merge; the other has conflicts and its branch is 40 commits behind.',
    },
  },
  {
    id: 'tpl-loose-ends',
    icon: '📌',
    name: 'Loose ends',
    description: 'Surfaces the TODOs and skipped tests everyone stopped seeing.',
    detail:
      'Ranks by what sits closest to something that matters, so the TODO next to your auth check surfaces above the one about a variable name.',
    category: 'Maintenance',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Find the loose ends: TODO and FIXME comments older than a couple of months, skipped or disabled tests, commented-out blocks of code, and temporary workarounds whose comment says they are temporary.

Rank by what sits closest to something that matters — auth, payments, data loss. Ignore anything trivial or clearly deliberate.`,
    example: {
      severity: 'info',
      title: 'Four old TODOs, two of them next to the auth check',
      summary: 'The oldest is from March: "TODO: verify the signature before trusting this token".',
      location: 'src/lib/auth/session.ts:88',
    },
  },

  /* ------------------------------------------------------------ Research */
  {
    id: 'tpl-competitors',
    icon: '🕵️',
    name: 'Competitor watch',
    description: 'Reads their blogs and changelogs, and tells you what it means for you.',
    detail:
      'Fill in the names below and it reads their blogs and changelogs, skipping anything it has already told you about.',
    category: 'Research',
    requires: 'the competitor names filled in below',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Read the blog and changelog of <competitor 1>, <competitor 2> and <competitor 3>.

Report anything published since your last run that changes what we should be building. Skip launch posts for things we don't compete with, skip hiring posts, and skip anything you've already told me about. End with one paragraph on what it means for this project specifically.`,
    example: {
      severity: 'info',
      title: 'A competitor shipped the thing on your roadmap',
      summary:
        'Announced Tuesday, free on their entry tier. Their version has no offline mode, which yours does.',
    },
  },
  {
    id: 'tpl-framework',
    icon: '🚀',
    name: 'Framework release watch',
    description: 'Watches your framework’s releases for the changes that affect you.',
    detail:
      'Works out what you depend on, then reports only the changes that touch something this codebase actually does.',
    category: 'Research',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Work out which framework and major libraries this project depends on, then read their recent releases and changelogs.

Report only changes that touch something this codebase actually does — a breaking change in an API we call, a deprecation on a pattern we use, a fix for a bug we have worked around. Say what we would have to change. Ignore new features we are not asking for.`,
    example: {
      severity: 'warning',
      title: 'The next major changes caching behaviour you rely on',
      summary:
        'Fetches are no longer cached by default; four of your data loaders assume they are.',
      location: 'src/app/lib/data.ts:12',
    },
  },

  /* -------------------------------------------------------- escape hatch */
  {
    id: 'tpl-blank',
    icon: '✨',
    name: 'Blank workflow',
    description: 'Start from an empty prompt.',
    category: 'Quality',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: '',
  },
];

/** The blank template, kept out of the browsable list. */
export const BLANK_TEMPLATE_ID = 'tpl-blank';

export function isBlankTemplate(template: WorkflowTemplate): boolean {
  return template.id === BLANK_TEMPLATE_ID;
}

/** Everything worth browsing — i.e. everything but the escape hatch. */
export function browsableTemplates(): WorkflowTemplate[] {
  return WORKFLOW_TEMPLATES.filter((template) => !isBlankTemplate(template));
}
