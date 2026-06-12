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

# 3b. var() references to custom properties that are never defined anywhere.
# An undefined var() makes the declaration invalid at computed-value time —
# the style silently doesn't apply (this bit us: hover states rendering as
# transparent for months). Definitions may live in CSS or be set from TS/TSX.
echo "Checking for undefined CSS custom properties…"
DEFINED=$(mktemp) && USED=$(mktemp)
{
  grep -rhoE '\-\-[a-zA-Z0-9-]+[[:space:]]*:' src/styles --include='*.css' 2>/dev/null | sed 's/[[:space:]]*:$//'
  grep -rhoE "['\"]--[a-zA-Z0-9-]+['\"]" src --include='*.ts' --include='*.tsx' 2>/dev/null | tr -d "'\""
} | sort -u > "$DEFINED"
grep -rhoE 'var\([[:space:]]*--[a-zA-Z0-9-]+' src/styles --include='*.css' 2>/dev/null |
  grep -oE '\-\-[a-zA-Z0-9-]+' | sort -u > "$USED"
UNDEFINED=$(comm -13 "$DEFINED" "$USED")
rm -f "$DEFINED" "$USED"
if [ -n "$UNDEFINED" ]; then
  echo "  var() references with no definition in CSS or TS/TSX:"
  for v in $UNDEFINED; do
    echo "    $v"
    grep -rn "var($v" src/styles --include='*.css' | head -2 | sed 's/^/      /'
  done
  rule "undefined CSS custom properties" 1
else
  rule "undefined CSS custom properties" 0
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

# 5. Modal files that don't import ModalFrame (heuristic — new modal files only)
echo "Checking new *Modal.tsx files for ModalFrame usage…"
MODAL_FILES=$(find src/components -name '*Modal.tsx' 2>/dev/null)
MISSING_MODAL_FRAME=0
for f in $MODAL_FILES; do
  if ! grep -q "ModalFrame" "$f"; then
    echo "  $f does not import ModalFrame"
    MISSING_MODAL_FRAME=1
  fi
done
rule "modal files use ModalFrame primitive" $MISSING_MODAL_FRAME
echo

if [ $FAIL -ne 0 ]; then
  echo "==> FAIL: some pattern rules violated. See CLAUDE.md → How to Do Things."
  exit 1
fi

echo "==> OK: all pattern rules pass."
