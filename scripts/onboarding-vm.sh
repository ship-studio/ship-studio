#!/usr/bin/env bash
# Fresh-machine onboarding testing in a disposable macOS VM (Tart).
#
# The gold-standard test for onboarding: a factory-fresh macOS with no
# Homebrew, no Node, no git config — what a brand-new user's machine looks
# like. Clones are copy-on-write, so each test run starts pristine and is
# cheap to throw away.
#
# One-time setup (done once per machine):
#   1. Install Tart (standalone, no Homebrew needed):
#        mkdir -p ~/Applications && cd ~/Applications \
#          && curl -sL -o tart.tar.gz https://github.com/cirruslabs/tart/releases/latest/download/tart.tar.gz \
#          && tar -xzf tart.tar.gz && rm tart.tar.gz
#   2. Pull the truly-blank image (~25GB; "vanilla" — NOT "base", which
#      ships with Homebrew preinstalled and ruins the test):
#        tart clone ghcr.io/cirruslabs/macos-sequoia-vanilla:latest pristine-mac
#
# Usage:
#   ./scripts/onboarding-vm.sh fresh    # build DMG, clone pristine → test-run, boot with DMG mounted
#   ./scripts/onboarding-vm.sh run      # boot the existing test-run VM again
#   ./scripts/onboarding-vm.sh reset    # delete test-run (next `fresh` starts pristine)
#
# Inside the VM (user: admin, password: admin):
#   - The DMG folder appears in Finder under "My Shared Files" → dmg
#   - The app isn't notarized when built locally: right-click → Open,
#     or `xattr -cr "/Applications/Ship Studio.app"` in Terminal
#   - Onboarding appears automatically — no env vars; this is the real path

set -euo pipefail

TART="${TART:-$HOME/Applications/tart.app/Contents/MacOS/tart}"
if ! command -v "$TART" >/dev/null 2>&1 && [ ! -x "$TART" ]; then
  TART="$(command -v tart || true)"
fi
if [ -z "${TART:-}" ] || [ ! -x "$TART" ]; then
  echo "tart not found — see the one-time setup in this script's header." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DMG_DIR="$REPO_ROOT/src-tauri/target/release/bundle/dmg"
PRISTINE="pristine-mac"
TEST_VM="test-run"

case "${1:-fresh}" in
  fresh)
    if ! "$TART" list --quiet 2>/dev/null | grep -qx "$PRISTINE"; then
      echo "Pristine image '$PRISTINE' not found — run the one-time setup first." >&2
      exit 1
    fi
    if ! ls "$DMG_DIR"/*.dmg >/dev/null 2>&1; then
      echo "No DMG found — building (pnpm tauri build)…"
      (cd "$REPO_ROOT" && pnpm tauri build)
    fi
    "$TART" delete "$TEST_VM" 2>/dev/null || true
    "$TART" clone "$PRISTINE" "$TEST_VM"
    echo "Booting fresh VM (admin/admin). DMG shared at: My Shared Files → dmg"
    exec "$TART" run "$TEST_VM" --dir="dmg:$DMG_DIR"
    ;;
  run)
    exec "$TART" run "$TEST_VM" --dir="dmg:$DMG_DIR"
    ;;
  reset)
    "$TART" delete "$TEST_VM" 2>/dev/null || true
    echo "Deleted $TEST_VM — next 'fresh' starts pristine."
    ;;
  *)
    echo "Usage: $0 [fresh|run|reset]" >&2
    exit 1
    ;;
esac
