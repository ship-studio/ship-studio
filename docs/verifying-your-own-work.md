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
- **Make a check fail on purpose before trusting it.** If you have not seen it
  red, you do not know it can go red.
- **Prefer checks that cannot pass vacuously.** A guard over an empty set, a
  selector that matches page chrome, an assertion on a value nobody reads.
- **Say "locally verified, CI has not seen this" when that is the case.** It
  costs nothing and it is usually the whole question.

The harness applies this to itself: an unmocked command is recorded rather than
given a plausible default, a scenario declares a `requires` selector so it
cannot photograph the wrong screen, and every report names the checkout and
commit it came from. See [ui-harness.md](ui-harness.md).
