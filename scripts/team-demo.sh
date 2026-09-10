#!/usr/bin/env bash
#
# Build a repository that shows the Team feature doing its whole job.
#
# Everything here is *real git*. Real commits, real branches, a real merge, real
# `.shipstudio-team/` records with the real `Ship-Studio-Update` trailer joining
# them to their commits. Harbr reads it with exactly the same code path it
# uses on your own repositories — nothing about the feature is mocked.
#
# What is staged is only the cast: three people committing over three days, so a
# recording has something to show without waiting a week for a team to generate
# it. Each of them is a genuine git author with their own email, which is how
# the feed tells them apart.
#
# The point of the repo is the contrast it sets up:
#
#   Maya   pushes through Harbr  -> rows say what changed AND why
#   Theo   pushes from a terminal      -> rows say only what git can prove
#   You    have work in flight         -> your own branch, ahead of main
#
# Usage:
#   ./scripts/team-demo.sh                    # ~/Harbr/team-demo
#   ./scripts/team-demo.sh my-demo-name
#   ./scripts/team-demo.sh my-demo-name --remote git@github.com:me/demo.git
#
# With --remote (a repo you own and can force-push to) you additionally get
# avatars, roles, pull-request status and working "Open in GitHub" buttons,
# because those come from the GitHub API rather than from local git. Without it
# the feed still works and falls back to initials, which is the designed
# behaviour for a project with no remote.

set -euo pipefail

NAME="${1:-team-demo}"
[[ "$NAME" == --* ]] && NAME="team-demo"
REMOTE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

ROOT="${HARBR_ROOT:-$HOME/Harbr}"
DIR="$ROOT/$NAME"

if [[ -e "$DIR" ]]; then
  echo "error: $DIR already exists."
  echo "       Remove it first, or pass a different name:"
  echo "         rm -rf \"$DIR\" && $0 $NAME"
  exit 1
fi

mkdir -p "$DIR"
cd "$DIR"

# --------------------------------------------------------------------- people
#
# GitHub noreply addresses, because that is the one form of email that carries a
# login as a *fact* rather than a guess. The feed refuses to infer a GitHub
# account from an ordinary address, so demo people using @example.com would show
# as unlinked names with no avatar.
MAYA_NAME="Maya Reed";   MAYA_LOGIN="mayareed"; MAYA_EMAIL="4100001+mayareed@users.noreply.github.com"
THEO_NAME="Theo Vance";  THEO_LOGIN="theovance"; THEO_EMAIL="4100002+theovance@users.noreply.github.com"

# You, as git already knows you. Falls back to something sensible outside a repo.
ME_NAME="$(git config --global user.name  || echo 'You')"
ME_EMAIL="$(git config --global user.email || echo 'you@example.com')"
ME_LOGIN="$(gh api user --jq .login 2>/dev/null || echo 'you')"

# Times are given to git as `@<epoch> +0000` rather than as a formatted string.
# A bare "2026-09-03T21:00:00" is read in *local* time, so the same script
# produced different gaps between commits depending on the machine's timezone —
# and the gap is what decides whether two commits group into one row.
#
# Both take days-ago; STAMP also takes an optional hours-ago, so a pair of
# commits can be put a known distance apart.
EPOCH() { python3 -c "import time;print(int(time.time()-$1*86400-${2:-0}*3600))"; }
DAY() { python3 -c "
import time
print(time.strftime('%Y-%m-%d', time.gmtime(time.time()-$1*86400)))
"; }
STAMP() { echo "@$(EPOCH "$1" "${2:-0}") +0000"; }
MS() { python3 -c "print(int($(EPOCH "$1" "${2:-0}"))*1000)"; }

# ULIDs are 26 Crockford-base32 characters, time-ordered. Close enough for a
# demo: a timestamp prefix and random tail, which sorts the same way.
ULID() { python3 -c "
import random, time
A='0123456789ABCDEFGHJKMNPQRSTVWXYZ'
t=int((time.time()-$1*86400)*1000)
s=''
for _ in range(10):
    t,r=divmod(t,32); s=A[r]+s
print(s+''.join(random.choice(A) for _ in range(16)))
"; }

commit_as() { # name email date message [trailer]
  local n="$1" e="$2" d="$3" m="$4" t="${5:-}"
  local full="$m"
  [[ -n "$t" ]] && full="$m

Ship-Studio-Update: $t"
  git add -A
  GIT_AUTHOR_NAME="$n" GIT_AUTHOR_EMAIL="$e" GIT_AUTHOR_DATE="$d" \
  GIT_COMMITTER_NAME="$n" GIT_COMMITTER_EMAIL="$e" GIT_COMMITTER_DATE="$d" \
    git commit -q --no-verify -m "$full"
}

record() { # login name day agent id json-body-fragment
  local login="$1" name="$2" day="$3" agent="$4" id="$5" body="$6"
  local dir=".shipstudio-team/updates/$(DAY "$day")"
  mkdir -p "$dir"
  local agent_field="null"
  [[ -n "$agent" ]] && agent_field="\"$agent\""
  cat > "$dir/$id-$login.json" <<JSON
{
  "v": 1,
  "kind": "update",
  "id": "$id",
  "at": $(MS "$day"),
  "actor": { "login": "$login", "name": "$name" },
  "agent": $agent_field,
$body
}
JSON
}

echo "==> Building $DIR"
git init -q --initial-branch=main
git config user.name "$ME_NAME"
git config user.email "$ME_EMAIL"
git config commit.gpgsign false

# ------------------------------------------------------------------ day -6
mkdir -p src/components src/data
cat > README.md <<'EOF'
# Acme Marketing

The demo repository for Harbr's Team feature.
EOF
cat > src/components/PricingTable.tsx <<'EOF'
export function PricingTable() {
  return <div className="flex">{/* three tiers */}</div>;
}
EOF
commit_as "$ME_NAME" "$ME_EMAIL" "$(STAMP 6)" "Set up the marketing site"

# ------------------------------------------------- day -4: Theo, from a terminal
#
# No record and no trailer, because Theo does not use Harbr. His rows are
# the honest floor of the feature: what git can prove and nothing more.
cat > src/data/plans.ts <<'EOF'
export type Plan = { name: string; price: number; seats: number };
export const plans: Plan[] = [
  { name: 'Starter', price: 12, seats: 1 },
  { name: 'Team', price: 40, seats: 10 },
];
EOF
commit_as "$THEO_NAME" "$THEO_EMAIL" "$(STAMP 4 1)" "fix plan type"

cat >> src/data/plans.ts <<'EOF'

export const featured = 'Team';
EOF
commit_as "$THEO_NAME" "$THEO_EMAIL" "$(STAMP 4 0)" "wip"

# ------------------------------------------- day -2: Maya, through Harbr
#
# A branch, a record, and a commit carrying the trailer that joins them. This is
# the row the whole feature exists to produce.
git checkout -q -b feat/pricing-tiers
MAYA_ID="$(ULID 2)"
cat > src/components/PricingTable.tsx <<'EOF'
export function PricingTable() {
  return (
    <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
      {/* three tiers, one column under 768px */}
    </div>
  );
}
EOF
record "$MAYA_LOGIN" "$MAYA_NAME" 2 "Claude Code" "$MAYA_ID" '  "headline": "Rebuild the pricing tiers as a CSS grid",
  "why": "The flex row could not hold three columns at 1024px without the third wrapping under the first two, and the fix people kept reaching for was a hardcoded width that broke again at every new tier.",
  "changes": [
    "Replace the flex row with a 3-up grid that collapses to 1-up under 768px",
    "Remove the four hardcoded card widths this was working around"
  ],
  "asks": "The middle tier is visually taller than the others now. That looks deliberate to me, but it was not before, so worth a look.",
  "branch": "feat/pricing-tiers"'
commit_as "$MAYA_NAME" "$MAYA_EMAIL" "$(STAMP 2)" \
  "Rebuild the pricing tiers as a CSS grid" "$MAYA_ID"

# A comment thread, so the Comments tab has something in it. Folded from an
# append-only pair of records, exactly as two machines would have written them.
COMMENT_ID="$(ULID 2)"
REPLY_ID="$(ULID 1)"
CDIR=".shipstudio-team/updates/$(DAY 2)"
mkdir -p "$CDIR"
cat > "$CDIR/$COMMENT_ID-$MAYA_LOGIN.json" <<JSON
{
  "v": 1, "kind": "comment", "id": "$COMMENT_ID", "at": $(MS 2),
  "actor": { "login": "$MAYA_LOGIN", "name": "$MAYA_NAME" },
  "branch": "feat/pricing-tiers", "route": "/pricing",
  "target": "h1 · Simple pricing", "pin": 1,
  "body": "Should this say 'per seat' rather than 'per user'? The plans data calls them seats."
}
JSON
RDIR=".shipstudio-team/updates/$(DAY 1)"
mkdir -p "$RDIR"
cat > "$RDIR/$REPLY_ID-$ME_LOGIN.json" <<JSON
{
  "v": 1, "kind": "reply", "id": "$REPLY_ID", "thread": "$COMMENT_ID", "at": $(MS 1),
  "actor": { "login": "$ME_LOGIN", "name": "$ME_NAME" },
  "body": "Agreed, seats everywhere. I'll take it."
}
JSON
git add -A
GIT_AUTHOR_NAME="$MAYA_NAME" GIT_AUTHOR_EMAIL="$MAYA_EMAIL" GIT_AUTHOR_DATE="$(STAMP 2 -1)" \
GIT_COMMITTER_NAME="$MAYA_NAME" GIT_COMMITTER_EMAIL="$MAYA_EMAIL" GIT_COMMITTER_DATE="$(STAMP 2 -1)" \
  git commit -q --no-verify -m "Ask about the pricing copy"

# ------------------------------------------------------- day -1: it lands
git checkout -q main
GIT_AUTHOR_NAME="$ME_NAME" GIT_AUTHOR_EMAIL="$ME_EMAIL" GIT_AUTHOR_DATE="$(STAMP 1)" \
GIT_COMMITTER_NAME="$ME_NAME" GIT_COMMITTER_EMAIL="$ME_EMAIL" GIT_COMMITTER_DATE="$(STAMP 1)" \
  git merge -q --no-ff feat/pricing-tiers -m "Merge pull request #142 from acme/feat-pricing-tiers"

# ------------------------------------------------- today: your work in flight
git checkout -q -b fix/testimonial-duplication
cat > src/data/testimonials.ts <<'EOF'
export const testimonials = [
  { quote: 'It paid for itself in a week.', name: 'Priya N.', company: 'Northwind' },
  { quote: 'We shipped the rebrand in four days.', name: 'Sam O.', company: 'Halcyon' },
];
EOF
commit_as "$ME_NAME" "$ME_EMAIL" "$(STAMP 0)" \
  "Credit both testimonial quotes"

git checkout -q main

if [[ -n "$REMOTE" ]]; then
  echo "==> Adding remote $REMOTE"
  git remote add origin "$REMOTE"
  echo "    Push it yourself when you're ready:"
  echo "      cd \"$DIR\" && git push -u origin main && git push origin fix/testimonial-duplication"
fi

echo
echo "==> Done: $DIR"
echo
git --no-pager log --oneline --graph --all | head -12
echo
echo "Open it in Harbr, then click the faces in the workspace header."
