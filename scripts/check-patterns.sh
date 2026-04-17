#!/usr/bin/env bash
# Lightweight grep-based pattern check. Runs in CI to catch regressions into
# pre-refactor patterns. Each rule below returns exit 1 if it finds an
# offender; the last rule's exit status is the script's exit status.
#
# Deliberately kept simple — no AST, no TypeScript program, just ripgrep.
# Whenever a new guardrail is needed, add a new block below.
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
RUST_STRING_RESULTS=$(rg -c 'Result<.*, String>' src-tauri/src/commands/ 2>/dev/null || true)
if [ -n "$RUST_STRING_RESULTS" ]; then
  echo "  (informational) $(rg -c 'Result<.*, String>' src-tauri/src/commands/ | awk -F: '{s+=$2} END{print s}') Result<T,String> sites remain — see Block 8.3–8.5 in DX_REFACTOR_PLAN.md"
fi
echo

# 2. Direct navigator.clipboard.writeText in components/src (outside primitives)
echo "Checking for raw navigator.clipboard.writeText in components…"
CLIPBOARD_VIOLATIONS=$(rg -l 'navigator\.clipboard\.writeText' src/ \
  --glob '!src/hooks/useCopyToClipboard.ts' \
  --glob '!src/components/primitives/**' \
  --glob '!src/**/*.test.{ts,tsx}' 2>/dev/null | wc -l | tr -d ' ')
# Inform, don't fail — existing migration debt tracked in Block 5.4.
echo "  (informational) $CLIPBOARD_VIOLATIONS file(s) still use navigator.clipboard directly"
echo

# 3. Raw hex colors in CSS (informational — ongoing migration tracked in Block 3)
# base.css holds canonical token values; setup.css has branded install-button
# colors that aren't yet in the token scale. Allowlisted until Block 13 cleanup.
echo "Checking for raw hex colors in src/styles (informational)…"
HEX_COUNT=$(rg -c --no-heading '(color|background|border)(-[a-z-]+)?\s*:\s*#[0-9a-fA-F]{3,8}' src/styles/ \
  --glob '!src/styles/base.css' \
  --glob '!src/styles/setup.css' 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
echo "  (informational) $HEX_COUNT hex color offender(s) outside base.css/setup.css"
echo

# 4. New onToast?: prop interface introductions (the prop-drilling pattern we killed in Block 5.6)
echo "Checking for new onToast?: prop interfaces…"
TOAST_PROPS=$(rg -c 'onToast\?:' src/components/ 2>/dev/null || true)
if [ -n "$TOAST_PROPS" ]; then
  TOTAL=$(echo "$TOAST_PROPS" | awk -F: '{s+=$2} END{print s}')
  if [ "${TOTAL:-0}" -gt 0 ]; then
    echo "  Offenders (use useOptionalToast from contexts/ToastContext instead):"
    echo "$TOAST_PROPS" | head -5 | sed 's/^/    /'
    rule "onToast?: prop drilling" 1
  else
    rule "onToast?: prop drilling" 0
  fi
else
  rule "onToast?: prop drilling" 0
fi
echo

# 5. Modal files that don't import ModalFrame (heuristic — new modal files only)
echo "Checking new *Modal.tsx files for ModalFrame usage…"
MODAL_FILES=$(ls src/components/*Modal.tsx 2>/dev/null)
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
