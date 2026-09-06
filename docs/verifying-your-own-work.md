# Verifying your own work

Almost every wrong claim made while building this app's tooling had the same
shape. Not a careless check — a **correct check, correctly reported, answering
a question nobody had noticed was different from the one being asked.**

> The mechanism was present. The outcome was never confirmed.

This is written down because it recurred six times in one evening across four
people working in parallel, and each time it was found by someone other than
the person who made it. That rate suggests it is the normal failure mode of
verifying your own work, not anyone's sloppiness.

## The rule

**Check that the outcome changed. Not that the mechanism is present.**

Before believing a check, ask what a *passing* result would still permit.

| You asked | It answered | What it still permits |
| --- | --- | --- |
| Did this ship? | `[ -f file ]` — is it on disk? | Untracked, ignored, on one machine |
| Did the fix work? | The CSS is in the built binary | The measured value is unchanged |
| Do these screenshots show my build? | A server answered on the port | It was another checkout's server |
| Did this tree pass CI? | These commits passed | They were the pre-rebase commits |
| Did my edit apply? | The command exited 0 | The pattern matched nothing |
| Does the suite cover this? | The test passes | It found nothing to assert on |
| Was this reviewed? | A green tick from the reviewer | It was rate-limited and declined |

## The one to read first

A deployments panel had no scenario and no unit test. Its only coverage was an
automated screenshot of the command that opens it. That screenshot showed a
permanent "Loading…" — every project, before connecting a host, opened the panel
to a spinner for a request that was never going to be made.

Three independent signals said it was fine. All four required CI checks passed.
The suite of 2269 tests passed. The screenshot was marked ✓ **with no unmocked
backend calls, and that was correct**: the call which would have been flagged as
missing a fixture was never made, *because the bug prevented it*.

So there were two defects, and each one hid the other from the tooling. A
missing fixture — a real gap — was concealed by a downstream bug that stopped
the call being issued. Every check was sound. Every check answered a different
question than "does this panel work".

It was found by opening the image.

Two things follow from it, and they are the most useful conclusions here.

**Assert what appears, not what was asked for.** The obvious remedy — "every
command must have fixtures for everything it invokes" — passes cleanly on that
broken panel, because the broken panel invokes nothing. Only an expectation
about the rendered result ("this should produce a populated list") fails.

**Prove the test detects the bug.** The fix came with three tests, and their
author reinstated the old field and watched two of them fail before trusting
them. That is the only method used across a long night of this that actually
demonstrates a test detects what it claims to. Everyone else watched tests pass
and inferred coverage from it.

## A second, worse category

Everything above is a check that **measured the wrong thing, correctly** — a
cheap proxy standing in for an expensive truth. Those degrade honestly once you
know what the proxy covers.

This one does not:

```
CodeRabbit | success | Review rate limited
```

A green tick whose meaning is *"I declined to run."* Not a proxy for review —
not a measurement at all. It is indistinguishable from a pass in the checks
list, which shows the state and hides the description, and the only way to tell
is to read a string nobody reads when six other ticks are green.

Three PRs here carried it. One was 39 files and +6060 lines, reported as "all
seven checks green" and merged. Another was this repo's harness, likewise
merged. On a third, five Major findings had been fixed *in response to* that
reviewer, and the re-run was rate-limited — so the fixes made in answer to a
review were themselves reviewed by nothing. A review loop that closed on itself
without ever completing.

**A green check whose description says it did not run is not a green check.**

The checks list will not tell you. Ask for the descriptions:

```bash
gh api repos/<owner>/<repo>/commits/<sha>/status \
  --jq '.statuses[] | "\(.context) | \(.state) | \(.description)"'
```

## The four that cost the most

**A screenshot with no provenance.** A capture runner checked that *something*
answered on its port. Several worktrees ran on that machine, so it attached to
a neighbour's server and wrote seventy-one green ticks and a report captioned
with this checkout's scenario names. Real images, wrong tree, no warning — and
one screenshot away from "all ten states verified" against a build that did not
contain the feature. Fixed by having the server declare its own checkout, and
by recording it in every report: *a tick is evidence of nothing until you say
which commit it ran against.*

**An edit that silently matched nothing.** A scripted string replacement
targeted text a formatter had reshaped since it was read. The script exited 0,
reported success, changed nothing — and forty-five tests then passed against a
code path that never ran. Assert the anchor exists **in the same operation as
the write**: the gap between reading a file and editing it is exactly where a
formatter lives.

**A test that found nothing to test.** A table asserting fixtures stay within
what each adapter can emit would have gone green forever if a field were
renamed, because it would have iterated an empty set. Every such check needs a
companion asserting it *found something*, and a run against known-bad input to
watch it fail.

**A fix that felt like one.** A proposal to assert a selector on a capture would
have applied to a category the failing capture was not in. Plausible, adjacent,
and would have changed nothing while closing the question. This is the most
dangerous variant: it ends the investigation.

## In practice

- **Verify by content, not by existence.** `git cat-file -e origin/main:path`
  and grep the content, not `[ -f path ]`.
- **State what a result is about.** "Green" is meaningless; "green on
  `4dc4fff4`, which is my HEAD" is a claim someone can check.
- **Make a check fail on purpose before trusting it.** Reintroduce the bug and
  watch the test go red. If you have not seen it fail, you know it passes — not
  that it detects anything.
- **Prefer checks that cannot pass vacuously.** A guard over an empty set, a
  selector that matches page chrome, an assertion on a value nobody reads.
- **Open the artifact.** A green tick on a screenshot means it was captured, not
  that the screen is right. Nothing above was found by a report; every one was
  found by a person looking at the thing.
- **Say "locally verified, CI has not seen this" when that is the case.** It
  costs nothing and it is usually the whole question.

The harness applies this to itself: an unmocked command is recorded rather than
given a plausible default, a scenario declares a `requires` selector so it
cannot photograph the wrong screen, and every report names the checkout and
commit it came from. See [ui-harness.md](ui-harness.md).
