# Site migration — URL in, rebuilt site out

One input: a URL. The agent surveys the site, settles the decisions, extracts
the design system, then rebuilds it template by template and **measures each
one against the original** before calling it done.

Four parts:

- **`scripts/site-fidelity.mjs`** — how close is it? Screenshots both sides at
  chosen widths and scores the pixel match.
- **`scripts/site-structure.mjs`** — what is different? Reads both pages'
  computed styles and names the discrepancies.
- **The `shipstudio-site-to-code` skill** — the method, and the rules about how
  the agent reports, when it asks, and when it must stop.
- **New Project → From a URL** — creates the project, installs both tools into
  `.shipstudio/fidelity/`, and hands the agent its brief.

## What the trials established

Five unattended runs against real sites, driven by `trial.sh` + `run-agent.sh`.
Every fix below came from watching one fail, not from reasoning about it.

### The method converges

Two independent from-scratch rebuilds of the same marketing site's homepage,
each starting from an empty Astro starter:

```
trial 1   62.18%  →  77.72%  →  99.62%  →  99.87%
trial 2   88.66%  →  88.66%  →  79.18%  →  76.30%  →  99.87%
tiny      39.77%  →  98.78%  →  100.00%   (confirmed 100% across all four widths)
```

All three reached the Matches band and one reached parity. Trial 2 is the more
interesting: it went backwards for two passes and recovered anyway — see "the
score only goes up".

Both of those runs then did the thing the worst-breakpoint rule exists for. Each
scored ~99.9% at its widest width, ran the full set, found a mobile width at
93.2%, and fixed *that* — a mean would have called both finished.

### Eight bugs the runs found

| Symptom | Cause | Fix |
|---|---|---|
| Migration stalls forever, no output | The engine awaited every incomplete image's `onload` with no deadline. One lazy or blocked image hung it, and `awaitPromise` hung the tool with it. | Bounded image wait, stepped scroll, watchdog on every capture |
| "It thinks my site is Webflow" | The engine copied into every project opened with "A Webflow migration is judged on…" — 12 mentions. The agent reads it to learn the tool. | Builder-agnostic; the one runtime-specific block is guarded and labelled |
| Panel says the migration is broken | The agent wrote `needsYou` as sentences and `"in-progress"` as a status. The first failed the parse; the second killed an icon. | Prompt carries the schema; reader normalises what an agent plausibly writes |
| "I have no idea what it did" | Status was only written *after* a phase. A 31-URL survey is minutes of silence. | Mark the phase active **before** the work. Measured: 5+ min silent → under 1 min |
| Agent chases a meaningless number | A failed navigation still screenshots — Chrome's error page. A TLS failure scored "39.77%". | Navigation errors are named, not scored |
| Half of every pass wasted | The original was re-captured every iteration, though it never changes. | Reference captures cached for an hour, keyed by URL and width |
| Four passes walking downhill | Nothing said what to do when a change makes the score worse, so the agent built on top of the damage. | The score only goes up: worse means undo, and the best score is a floor |
| Confirmation runs vanish | The report was written only after *every* width. A four-width run takes ~4 min; an agent's shell call is killed before that, discarding work already done. | Report written after each breakpoint, carrying `complete` |

### The score cannot say what is wrong

A container sixty pixels too narrow shifts every image on the page, so a tenth
of it turns magenta and the finding reads "a lot is wrong here". An agent
mid-migration noticed this and hand-rolled its own extractor, which settled it.

`site-structure.mjs` reports the design instead. Against a real half-built
rebuild, in one pass:

```
widest block   original 3215px   rebuild 1240px   ← content is constrained differently

container widths
  original has   1072 (30 blocks)   1200 (10 blocks)
  rebuild has     768 (14 blocks)    696 (6 blocks)

type
  original has   14px/21 400 Söhne   (565 chars)
  rebuild has    14px/20 400 Söhne   (223 chars)

text colour
  rebuild has    rgb(255, 98, 71)    ← starter default, never replaced

vertical rhythm
  original has   96 (14 blocks)
  rebuild has    64 (2 blocks)   32 (2 blocks)
```

The pixel score for that same pair was 62%.

Aggregates, deliberately — not an element-by-element diff. Two DOMs written by
different people cannot be aligned, and the attempt would be most fragile
exactly when the rebuild differs most. "The widest content box is 1140 here and
1200 there" needs no alignment and is the sentence that fixes the bug.

### The agent drives

Asked to migrate a 30-route marketing site, the survey ended with seven
decisions, each carrying its own recommendation — where content should live and
whether that means a CMS, an unlicensable typeface, where a form submits,
whether to copy 62 image assets, verbatim content or marked placeholders,
whether to reimplement scroll motion, and how a `?pillar=` filter survives a
static build. Told "you pick", it took all seven and recorded which way it went
in `MIGRATION.md`.

Asking at the end of the survey is the point: it is the first moment there is
enough to ask well, and the last moment asking is cheap. An earlier run raised
the CMS question only on reaching the templates, with two already built on an
assumption.

## Running it

```bash
# Measure how close
node scripts/site-fidelity.mjs \
  --reference https://example.com/ --rebuild http://localhost:4321/ \
  --breakpoints 1240 --label home --out .shipstudio/fidelity/pass-1

# Find out what is different
node scripts/site-structure.mjs \
  --reference https://example.com/ --rebuild http://localhost:4321/ --width 1240

# Run a whole migration unattended
prototypes/site-migration/trial.sh https://example.com/ my-trial
prototypes/site-migration/run-agent.sh ~/Harbr/my-trial

# Watch trials without touching them
node prototypes/site-migration/trial-status.mjs ~/Harbr/my-trial
node prototypes/site-migration/watch-trials.mjs ~/Harbr/my-trial …
```

`print-prompt.mjs` reads the brief out of `src/lib/migration.ts` rather than
copying it, so a trial can never exercise a prompt the product does not send.

## Reviewing the UI

```bash
pnpm harness
```

Four scenarios: `migration-start` (the URL tab), `migration-fidelity` (a
migration mid-flight), `migration-interrupted` (state with no comparison yet),
`migration-done` (finished, and still honest about its gaps).

Their captures live in `harness/migration-demo/` and are served by the harness
config, deliberately **not** from `public/` — anything there is copied into the
shipped app, and these are megabytes of full-page screenshots a user has no use
for. They are downscaled fixtures for looking at a UI; the measurements they
came from are in the trial projects.

## The measurement is trustworthy

Determinism came first, and the first version did not have it: comparing a page
**against itself** scored 96.5%. Animations were pinned after settling rather
than before paint, sliders autoplayed, and the two captures raced for CPU.
Freezing on new document, tearing down known runtimes, and capturing
sequentially puts self-comparison at **99.96%** at 1440 and **99.69%** at 479.

That ~0.3% is the noise floor, and it is where the 99.5% "Matches" threshold
comes from — a stricter bar would be unreachable and would keep every migration
permanently unfinished.

## Known limits

- A comparison costs about a minute per width. The method says to iterate at
  one width and confirm at the full set, because otherwise most of the time
  goes on re-confirming what already matched.
- The score cannot see interactive states, sizes between breakpoints, keyboard
  order, or behaviour with content of a different length. The skill lists these
  as separate checks rather than letting a percentage imply them.
- Licensed fonts, third-party embeds and anything behind auth cannot come
  across. These are declared in `MIGRATION.md`, never absorbed into a score.
