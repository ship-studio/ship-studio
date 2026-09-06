#!/usr/bin/env bash
# Lightweight grep-based pattern check. Runs in CI to catch regressions into
# pre-refactor patterns. Each rule below returns exit 1 if it finds an
# offender; failures accumulate and the script exits non-zero at the end.
#
# Deliberately kept simple — no AST, no TypeScript program, just POSIX grep.
# (It used ripgrep originally; rg wasn't installed in CI or on dev machines,
# so every rg-based rule silently reported zero offenders for months. Plain
# grep is slower but cannot silently vanish.)
#
# Exempt directories/files are listed per-rule because the primitives and
# implementation files legitimately contain the patterns they're meant to
# encapsulate.
set -uo pipefail

FAIL=0

rule() {
  local name="$1"
  local exit_code="$2"
  if [ "$exit_code" -ne 0 ]; then
    echo "✗ $name"
    FAIL=1
  else
    echo "  $name — ok"
  fi
}

echo "==> Ship Studio pattern-check"
echo

# 1. New Result<T, String> in Rust command signatures (only warn — existing
#    callers still use this; flag only fresh introductions)
echo "Checking Rust command signatures for Result<T, String> (informational)…"
RUST_STRING_RESULTS=$(grep -rE 'Result<.*, String>' src-tauri/src/commands/ 2>/dev/null | wc -l | tr -d ' ')
echo "  (informational) $RUST_STRING_RESULTS Result<T,String> sites remain — see Block 8.3–8.5 in DX_REFACTOR_PLAN.md"
echo

# 2. Direct navigator.clipboard.writeText in components/src (outside primitives)
echo "Checking for raw navigator.clipboard.writeText in components…"
CLIPBOARD_VIOLATIONS=$(grep -rl 'navigator\.clipboard\.writeText' src/ \
  --include='*.ts' --include='*.tsx' \
  --exclude='useCopyToClipboard.ts' \
  --exclude='*.test.ts' --exclude='*.test.tsx' \
  --exclude-dir='primitives' 2>/dev/null | wc -l | tr -d ' ')
echo "  (informational) $CLIPBOARD_VIOLATIONS file(s) still use navigator.clipboard directly"
echo

# 3. Raw color literals in CSS — FAILS on any offender.
# All colors live in design tokens: global ones in src/styles/global/base.css,
# intentional one-offs as file-local tokens in a :root block at the top of the
# feature file. Allowed lines: custom-property definitions (--x: #hex) and
# lines tagged with a `css-ok` comment explaining why the raw value must stay.
echo "Checking for raw color literals in src/styles…"
RAW_COLORS=$(grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\([0-9]' src/styles --include='*.css' 2>/dev/null |
  grep -v 'css-ok' |
  grep -vE '^[^:]+:[0-9]+:[[:space:]]*(/\*|\*)' |
  grep -vE '^[^:]+:[0-9]+:[[:space:]]*--[a-zA-Z0-9-]+[[:space:]]*:' || true)
if [ -n "$RAW_COLORS" ]; then
  echo "  Raw color literals (use a token, or define a file-local token in :root):"
  echo "$RAW_COLORS" | head -20 | sed 's/^/    /'
  rule "raw color literals in CSS" 1
else
  rule "raw color literals in CSS" 0
fi
echo

# 3b. CSS custom-property definitions, references, duplicates, and cycles.
# A small Node parser owns this check because grep cannot distinguish scopes or
# produce a useful dependency chain for transitive cycles.
echo "Checking CSS custom-property graph…"
if node scripts/check-css-tokens.mjs; then
  rule "CSS custom-property graph" 0
else
  rule "CSS custom-property graph" 1
fi
echo

# 3d. Token taxonomy and direct primitive-consumer policy. Existing migration
# consumers are recorded in scripts/token-layer-baseline.json; new usage or
# growth beyond that baseline fails.
echo "Checking token taxonomy and layer policy…"
if node scripts/token-inventory.mjs --check; then
  rule "token taxonomy and layer policy" 0
else
  rule "token taxonomy and layer policy" 1
fi
echo

# 3e. CSS ownership and selector namespace policy.
echo "Checking CSS ownership and selector namespace policy…"
if node scripts/check-css-ownership.mjs; then
  rule "CSS ownership and selector namespace policy" 0
else
  rule "CSS ownership and selector namespace policy" 1
fi
echo

# 3f. Static inline-style delta policy. Existing signatures are intentionally
# frozen in a checked-in baseline; computed geometry and platform API values
# remain valid exceptions.
echo "Checking static inline-style delta policy…"
if node scripts/check-inline-styles.mjs; then
  rule "static inline-style delta policy" 0
else
  rule "static inline-style delta policy" 1
fi
echo

# 3c. Duplicate @keyframes names. Keyframe names are GLOBAL — a feature-file
# duplicate silently overrides every consumer app-wide based on import order
# (skeleton-pulse rendered the "wrong" values for months this way). Shared
# keyframes belong in base.css; feature-specific ones get a feature prefix.
echo "Checking for duplicate @keyframes names…"
DUP_KEYFRAMES=$(grep -rhoE '@keyframes[[:space:]]+[a-zA-Z0-9_-]+' src/styles --include='*.css' 2>/dev/null |
  awk '{print $2}' | sort | uniq -d)
if [ -n "$DUP_KEYFRAMES" ]; then
  echo "  Keyframe names defined more than once:"
  for k in $DUP_KEYFRAMES; do
    echo "    $k"
    grep -rnE "@keyframes[[:space:]]+$k\{?" src/styles --include='*.css' | sed 's/^/      /'
  done
  rule "duplicate @keyframes names" 1
else
  rule "duplicate @keyframes names" 0
fi
echo

# 3d. The hosting section's fixed geometry. Its whole purpose is that the Push
# popover stops resizing while deployment status loads, so nothing in that
# stylesheet may change *layout* on hover or focus — the previous, plugin-
# rendered version grew ~105px under the user's cursor because the host revealed
# hidden actions on :hover.
#
# `opacity` and `visibility` are deliberately NOT banned: neither reflows, so
# revealing a control in space that was already reserved for it is exactly the
# right way to do a hover affordance. Only the properties that move things are
# listed. Enforced here rather than in a unit test because Vitest stubs CSS
# imports to an empty string, so a test asserting on stylesheet text passes
# against nothing.
echo "Checking hosting section geometry…"
HOSTING_CSS=src/styles/features/publish/hosting.css
if [ ! -f "$HOSTING_CSS" ]; then
  rule "hosting section fixed geometry" 0
else
  HOSTING_BODY=$(perl -0pe 's{/\*.*?\*/}{}gs' "$HOSTING_CSS")
  HOSTING_OFFENDERS=$(printf '%s' "$HOSTING_BODY" | awk '
    /:hover|:focus-within/ { inrule = 1 }
    inrule && /(^|[ \t;{])(display|height|width|padding|margin|gap|font-size)[ \t]*:/ { print; inrule = 0 }
    /}/ { inrule = 0 }
  ')
  HOSTING_MISSING=""
  printf '%s' "$HOSTING_BODY" | grep -qE 'height:[[:space:]]*var\(--hosting-row-h\)' ||
    HOSTING_MISSING="$HOSTING_MISSING --hosting-row-h"
  printf '%s' "$HOSTING_BODY" | grep -qE 'height:[[:space:]]*var\(--hosting-links-h\)' ||
    HOSTING_MISSING="$HOSTING_MISSING --hosting-links-h"

  if [ -n "$HOSTING_OFFENDERS" ] || [ -n "$HOSTING_MISSING" ]; then
    [ -n "$HOSTING_OFFENDERS" ] && {
      echo "  Rules that resize the hosting section on hover/focus:"
      echo "$HOSTING_OFFENDERS" | sed 's/^/    /'
    }
    [ -n "$HOSTING_MISSING" ] && echo "  Row heights no longer token-driven:$HOSTING_MISSING"
    rule "hosting section fixed geometry" 1
  else
    rule "hosting section fixed geometry" 0
  fi
fi
echo

# 4. New onToast?: prop interface introductions (the prop-drilling pattern we killed in Block 5.6)
echo "Checking for new onToast?: prop interfaces…"
TOAST_PROPS=$(grep -rn 'onToast?:' src/components/ 2>/dev/null || true)
if [ -n "$TOAST_PROPS" ]; then
  echo "  Offenders (use useOptionalToast from contexts/ToastContext instead):"
  echo "$TOAST_PROPS" | head -5 | sed 's/^/    /'
  rule "onToast?: prop drilling" 1
else
  rule "onToast?: prop drilling" 0
fi
echo

# 5. Dialog/overlay recipes anywhere in components. This is intentionally a
# repository scan rather than a filename heuristic: a hand-rolled shell can
# live in WorkspaceModals, a feature panel, or a multi-step flow. Known
# anchored/non-modal and follow-up surfaces must be explicit in the scanner's
# allowlist with a reason.
echo "Checking component dialog/overlay recipes for ModalFrame usage…"
if node scripts/check-modal-shells.mjs; then
  rule "component dialog/overlay recipes use ModalFrame or an explicit exception" 0
else
  rule "component dialog/overlay recipes use ModalFrame or an explicit exception" 1
fi
echo

if [ $FAIL -ne 0 ]; then
  echo "==> FAIL: some pattern rules violated. See CLAUDE.md → How to Do Things."
  exit 1
fi

echo "==> OK: all pattern rules pass."
