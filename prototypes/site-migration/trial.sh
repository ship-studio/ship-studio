#!/usr/bin/env bash
#
# Run one migration end to end, headless, the way the app would.
#
# The app's own path is a GUI click followed by an agent in a terminal, which
# is not something a development loop can drive. This reproduces exactly what
# that click sets up — a scaffolded project, the engine in `.shipstudio/`, the
# opening status, and the same prompt — and then runs the agent against it
# unattended, so the skill can be exercised repeatedly and the places it gets
# stuck can be found rather than guessed at.
#
# Design and results: docs/site-migration.md
#
# Usage:
#   prototypes/site-migration/trial.sh <url> <trial-name> [starter-repo]
#
# Everything lands in ~/Harbr/<trial-name> so the app can open it too.
set -euo pipefail

URL="${1:?usage: trial.sh <url> <trial-name> [starter-repo]}"
NAME="${2:?usage: trial.sh <url> <trial-name> [starter-repo]}"
STARTER="${3:-https://github.com/ship-studio/astro-html-starter}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$HOME/Harbr/$NAME"
LOG="$ROOT/.shipstudio/trial.log"

if [ -e "$ROOT" ]; then
  echo "refusing to overwrite $ROOT" >&2
  exit 1
fi

echo "── scaffolding $NAME from $STARTER"
git clone --quiet --depth 1 "$STARTER" "$ROOT"
rm -rf "$ROOT/.git"
mkdir -p "$ROOT/.shipstudio/fidelity"

# The same two files `init_migration` embeds, from the same source.
cp "$REPO_ROOT/scripts/site-fidelity.mjs" "$ROOT/.shipstudio/fidelity/"
cp "$REPO_ROOT/scripts/site-fidelity-compare.mjs" "$ROOT/.shipstudio/fidelity/"

node -e '
  const [url, out] = process.argv.slice(1);
  const phase = (id, label) => ({ id, label, status: "not-started", detail: "Not started." });
  require("fs").writeFileSync(out, JSON.stringify({
    sourceUrl: url,
    startedAt: new Date().toISOString(),
    phases: [
      phase("survey", "Survey"),
      phase("design-system", "Design system"),
      phase("homepage", "Homepage"),
      phase("templates", "Templates"),
      phase("remainder", "Remainder"),
    ],
    doing: null,
    done: [],
    notDone: ["Everything — the agent has not surveyed the site yet."],
    cannotCarry: [],
    needsYou: [],
  }, null, 2) + "\n");
' "$URL" "$ROOT/.shipstudio/migration.json"

echo "── installing dependencies"
(cd "$ROOT" && [ -f package.json ] && npm install --silent --no-audit --no-fund >/dev/null 2>&1 || true)

# The prompt the app queues, read out of the app's own source so a trial can
# never drift from what a real user gets.
PROMPT="$(node "$REPO_ROOT/prototypes/site-migration/print-prompt.mjs" "$URL")"

# The prompt is written out rather than the agent being launched here: a
# process backgrounded by this script dies with it, which is how the first
# trial produced an empty log and no run at all. The caller launches the agent
# and owns its lifetime.
printf '%s' "$PROMPT" > "$ROOT/.shipstudio/trial-prompt.txt"

cat <<EOF
── scaffolded. Start the agent with:

     cd "$ROOT" && claude --print --permission-mode bypassPermissions \\
       "\$(cat .shipstudio/trial-prompt.txt)" > .shipstudio/trial.log 2>&1

EOF
