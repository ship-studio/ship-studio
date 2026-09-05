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
  | 'Experience'
  | 'Quality'
  | 'Content'
  | 'Maintenance'
  | 'Research';

/** The categories, in the order the picker offers them. */
export const TEMPLATE_CATEGORIES: WorkflowTemplateCategory[] = [
  'Security',
  'Experience',
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

  {
    id: 'tpl-fresh-eyes',
    icon: '👀',
    name: 'Fresh eyes',
    description: 'Walks your app like a first-time visitor and says where it got lost.',
    detail:
      'The one thing you cannot do for your own product. It arrives knowing nothing, tries to do the main thing your app is for, and reports where it hesitated — not bugs, confusion.',
    category: 'Experience',
    requires: 'the project open with its dev server running',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Open the running preview and use this app the way someone who has never seen it would. Work out what it is for from the screen in front of you, then try to do that thing.

Report where you hesitated: a button whose label did not tell you what would happen, a screen with no obvious next step, a term used before it was explained, a form that failed without saying why, a moment you could not tell whether something had worked.

Report confusion, not bugs. Say what you expected and what you got. Skip anything you only noticed by reading the source — if you had to look at the code, it does not count.`,
    example: {
      severity: 'warning',
      title: 'Nothing tells you the project was created',
      summary:
        'After Create, the dialog closes to the same empty list — the new project appears further down, off-screen, with no confirmation.',
    },
  },
  {
    id: 'tpl-mobile',
    icon: '📱',
    name: 'Phone check',
    description: 'Looks at your pages at phone width for the things that break there.',
    detail:
      'Everything is built at desktop width and checked on a phone in a hurry. This does the pass properly: overflow, tap targets, text that shrinks below readable, and menus that trap you.',
    category: 'Experience',
    requires: 'the project open with its dev server running',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Look at each page of the running preview at a phone viewport (around 390px wide).

Report: anything overflowing horizontally, tap targets smaller than about 44px, text below 14px, content hidden behind a fixed header, a modal or menu you cannot scroll or dismiss, and images that force a sideways scroll.

Name the page and the element. Ignore anything that is deliberately desktop-only, and ignore differences that are merely aesthetic.`,
    example: {
      severity: 'warning',
      title: 'The pricing table scrolls sideways on a phone',
      summary:
        'Four columns at a fixed 240px each — the page scrolls horizontally and the last plan is off-screen.',
      location: 'src/components/PricingTable.tsx:18',
    },
  },
  {
    id: 'tpl-dark-mode',
    icon: '🌗',
    name: 'Dark mode audit',
    description: 'Finds what breaks in the theme you look at least often.',
    detail:
      'Theme bugs live in whichever mode you do not develop in, and they are always the same three: a hardcoded colour, a token used for the wrong role, and an image with a baked-in background.',
    category: 'Experience',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Find what breaks in the other theme: hardcoded colours that do not change with the theme, text and background pairs that lose contrast in one mode, borders that vanish, images or icons with a baked-in background, and shadows tuned for one mode only.

Say which mode it breaks in and what it should use instead. Ignore anything intentionally fixed across both themes, such as brand colours.`,
    example: {
      severity: 'warning',
      title: 'Empty-state illustrations have a white background baked in',
      summary: 'Three PNGs sit as bright rectangles on the dark canvas.',
      location: 'src/assets/graphics/empty-projects.png',
    },
  },
  {
    id: 'tpl-empty-states',
    icon: '🫙',
    name: 'Empty & error states',
    description: 'Finds the screens nobody designed: no data, slow, offline, failed.',
    detail:
      'Every screen gets designed full and happy. This looks for the other four states — empty, loading, failed, and denied — and reports the ones that were never given a design at all.',
    category: 'Experience',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Go through the screens and lists in this project and work out what each one shows when it has no data, when it is still loading, when the request fails, and when the user lacks permission.

Report the ones that show nothing at all, a raw error object, a spinner with no way out, or a message that gives the user nothing to do next. Quote what is rendered today and say what it should say instead.

Ignore internal or debug screens.`,
    example: {
      severity: 'warning',
      title: 'A failed project list renders as a blank panel',
      summary:
        'The catch sets an error nothing reads, so a network failure looks identical to having no projects.',
      location: 'src/components/dashboard/ProjectList.tsx:212',
    },
  },
  {
    id: 'tpl-forms',
    icon: '📝',
    name: 'Form audit',
    description: 'Checks the forms you make money from, field by field.',
    detail:
      'Forms are where users quit. This checks the boring things that decide whether they finish: what happens on a bad value, whether the keyboard works, and whether a slow network double-charges anyone.',
    category: 'Experience',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Go through every form in this project — sign-up, checkout, contact, settings — and check the things that decide whether people finish them.

For each: does an invalid value get explained in words, next to the field it belongs to? Does Enter submit? Is there anything stopping a double submit on a slow connection? Do the inputs carry the right type and autocomplete attributes so a phone shows the right keyboard and a password manager can fill them? Does an error preserve what was typed?

Report the failures with the file and field. Skip fields that are genuinely optional and unvalidated.`,
    example: {
      severity: 'critical',
      title: 'Checkout can be submitted twice',
      summary:
        'The pay button is not disabled while the request is in flight — a double click on a slow connection charges twice.',
      location: 'src/components/Checkout.tsx:64',
    },
  },
  {
    id: 'tpl-preflight',
    icon: '🚦',
    name: 'Before you deploy',
    description: 'A pre-flight check to run in the minute before you ship.',
    detail:
      'The list you keep in your head and forget under pressure: debug flags, stray logging, secrets pointing at the wrong environment, and whether the thing even builds.',
    category: 'Quality',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Run the checks worth doing in the minute before a deploy.

Look for: debug or feature flags left on, console logging left in shipped code, TODOs added in the last few commits that block release, environment variables the code needs that production configuration does not set, API endpoints pointing at localhost or staging, and whether the build and type check pass.

Report only what would actually matter in production, in the order you would fix it. Ignore cosmetic issues and anything that is deliberate. If everything is clean, say so in one line and file nothing else.`,
    example: {
      severity: 'critical',
      title: 'The analytics endpoint still points at staging',
      summary:
        'NEXT_PUBLIC_API_URL falls back to the staging host, so a production build with the variable unset sends live traffic there.',
      location: 'src/lib/config.ts:9',
    },
  },
  {
    id: 'tpl-i18n',
    icon: '🌍',
    name: 'Translation gaps',
    description: 'Finds the strings that never made it into your other languages.',
    detail:
      'Adds up what each locale is missing and what has drifted since the source string changed — the two ways a translated site quietly goes half-English.',
    category: 'Content',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Compare this project's locale files against the default language and against the code.

Report: keys missing from a locale, keys still holding the source-language text, hardcoded user-facing strings in components that never went through the translation layer, and keys nothing references any more.

Group by locale and give counts. Ignore keys that are deliberately identical across languages, such as product names.`,
    example: {
      severity: 'warning',
      title: 'German is missing 23 keys, all added since June',
      summary:
        'The whole billing flow falls back to English, including the payment error messages.',
      location: 'src/locales/de.json',
    },
  },
  {
    id: 'tpl-images',
    icon: '🖼️',
    name: 'Image weight',
    description: 'Finds the images making your pages slow to appear.',
    detail:
      'Almost always the single biggest thing you can fix on a marketing page, and almost always one file somebody dropped in at full resolution.',
    category: 'Maintenance',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Look at the images this project ships: their file sizes, their formats, and how they are loaded.

Report images far larger than the space they are displayed in, anything still in PNG or JPEG that would be much smaller in a modern format, images missing width and height (so the page jumps as they load), and below-the-fold images loaded eagerly.

Give the file size and the display size. Ignore anything under about 50 kB, and ignore icons and favicons.`,
    example: {
      severity: 'warning',
      title: 'The hero image is 4.2 MB',
      summary:
        'A 4000px PNG displayed at 1200px wide, loaded eagerly on the landing page — most of the time before first paint.',
      location: 'public/hero.png',
    },
  },
  {
    id: 'tpl-network',
    icon: '🛰️',
    name: 'What your pages load',
    description: 'Watches the preview’s network traffic for weight, waste, and strangers.',
    detail:
      'Reads the preview’s own network activity — which Ship Studio can see and a static code review cannot. Third-party scripts, duplicate calls, and requests to domains you never chose all show up here and nowhere else.',
    category: 'Security',
    requires: 'the project open with its dev server running',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Load each page of the running preview and look at what it actually fetches.

Report: requests to third-party domains, especially any that could see who your visitors are; the same data fetched more than once on one page; large responses that block first paint; requests that fail or 404 silently; and anything still hitting a staging or localhost host.

Give the domain, the page, and the size or count. Ignore your own API and anything the framework requests in development only.`,
    example: {
      severity: 'warning',
      title: 'The blog loads three analytics scripts, two of them unused',
      summary:
        'One was replaced in March and never removed. Together they add 210 kB and see every visitor’s IP and page path.',
      location: 'src/app/layout.tsx:31',
    },
  },
  {
    id: 'tpl-simulator',
    icon: '📲',
    name: 'Simulator smoke test',
    description: 'Runs your mobile app in the simulator and tries the main flow.',
    detail:
      'Uses the simulator Ship Studio already boots for mobile previews. It launches the app, walks the primary flow, and reports where it hung, crashed, or stopped making sense — the pass you keep meaning to do by hand.',
    category: 'Experience',
    requires: 'a mobile project with its simulator preview running',
    trigger: { kind: 'manual' },
    permission: 'read-only',
    prompt: `Use the running simulator preview of this mobile app. Launch it cold, then walk the main flow a first-time user would: open, sign in or skip, reach the primary screen, and do the main thing the app is for.

Report: crashes, screens that never finish loading, buttons that do nothing, text clipped by the notch or the home indicator, and anything that needed a scroll you would not have guessed was there.

Say which step you were on. If the simulator is not running, report nothing and stop.`,
    example: {
      severity: 'critical',
      title: 'The app hangs on a white screen after sign-in',
      summary:
        'The session token is read before the storage module is ready; a cold launch with a saved session never leaves the splash screen.',
      location: 'app/(auth)/callback.tsx:22',
    },
  },
  {
    id: 'tpl-live-vs-local',
    icon: '🚀',
    name: 'Live vs local',
    description: 'Compares what you published with what is in your repo now.',
    detail:
      'Ship Studio records what you published and where. This fetches the live site and holds it against the branch you are on, which is how you find the deploy that quietly failed a fortnight ago.',
    category: 'Maintenance',
    requires: 'the project published at least once',
    trigger: { kind: 'weekly', weekday: 1, atHour: 9, atMinute: 0 },
    permission: 'read-only',
    prompt: `Find this project's published URL in .shipstudio/project.json, fetch the live site, and compare it against the current state of the repository.

Report anything visibly out of date: copy, prices, or links that changed in the repo but not on the live site; pages that exist locally and 404 in production; and a live build older than the last commit on the default branch. Say which commit the live site appears to be from if you can tell.

If no publish record exists, report nothing and stop. Ignore differences that are obviously environment-specific, such as analytics or feature flags.`,
    example: {
      severity: 'warning',
      title: 'Production is eleven commits behind main',
      summary:
        'The pricing change from two weeks ago is not live — the deploy after it failed and nothing said so.',
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
