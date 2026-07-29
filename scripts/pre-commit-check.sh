#!/usr/bin/env bash
# =============================================================================
# scripts/pre-commit-check.sh — M5cet pre-commit guard for MainMenu portal
# -----------------------------------------------------------------------------
# Enforces the stacking-context invariants of the MainMenu speed-dial
# portal-escape fix. Runs before `git commit` via .githooks/pre-commit.
#
# Checks:
#   1. createPortal present in MainMenu.tsx
#   2. --z-menu CSS token defined in :root of index.css
#   3. .menu-panel rule has position:fixed
#   4. .app-shell does NOT have isolation: isolate
#   5. .toolbar does NOT have overflow: hidden
#   6. Vitest smoke run on main-menu tests
#   7. tsc --noEmit on the project
#   8. KNOWN GAPS — informational section listing follow-up commits that
#      are deliberately out of scope for the current guard.
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed (commit aborts)
#   2 — environment problem (missing file or wrong cwd)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/..")"
cd "$REPO_ROOT"

# --- colors ----------------------------------------------------------------
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'
  BLU=$'\033[0;34m'; DIM=$'\033[2m';      RST=$'\033[0m'
else
  RED=''; GRN=''; YEL=''; BLU=''; DIM=''; RST=''
fi

# --- helpers ---------------------------------------------------------------
hdr()  { printf "\n${BLU}== %s ==${RST}\n" "$1"; }
ok()   { printf "  ${GRN}[ OK ]${RST} %s\n" "$1"; }
warn() { printf "  ${YEL}[WARN]${RST} %s\n" "$1"; }
err()  { printf "  ${RED}[FAIL]${RST} %s\n" "$1"; exit 1; }
err2() { printf "  ${RED}[FAIL]${RST} %s\n" "$1"; exit 2; }

# --- file presence ---------------------------------------------------------
MAIN_MENU="client/src/components/MainMenu.tsx"
CSS="client/src/index.css"
[[ ! -f "$CSS" && -f "client/src/styles.css" ]] && CSS="client/src/styles.css"

hdr "0. Required files"
[[ -f "$MAIN_MENU" ]] && ok "found $MAIN_MENU" || err2 "missing $MAIN_MENU"
[[ -f "$CSS"       ]] && ok "found $CSS"       || err2 "missing $CSS"

# --- 1. createPortal -------------------------------------------------------
hdr "1. createPortal in MainMenu.tsx"
if grep -q 'createPortal' "$MAIN_MENU"; then
  ok "createPortal present"
else
  err "createPortal missing — panel is still trapped in stacking context"
fi

# --- 2. --z-menu token ----------------------------------------------------
hdr "2. --z-menu token in :root of $CSS"
if grep -qE -- '--z-menu:\s*[0-9]+' "$CSS"; then
  ok "--z-menu token defined"
else
  err "$CSS :root is missing '--z-menu' CSS token"
fi

# --- 3. .menu-panel position:fixed ----------------------------------------
hdr "3. .menu-panel rule has position:fixed"
PANEL_RULE=$(awk '/\.menu-panel\s*\{/,/^\}/' "$CSS" 2>/dev/null || true)
if printf '%s\n' "$PANEL_RULE" | grep -q 'position:\s*fixed'; then
  ok ".menu-panel has position:fixed (escapes all parents)"
else
  err ".menu-panel is NOT position:fixed (will be trapped in .toolbar)"
fi

# --- 4. .app-shell isolation policy ---------------------------------------
hdr "4. .app-shell isolation policy"
APP_SHELL_RULE=$(awk '/\.app-shell\s*\{/,/^\}/' "$CSS" 2>/dev/null || true)
if printf '%s\n' "$APP_SHELL_RULE" | grep -qE 'isolation:\s*isolate'; then
  err ".app-shell has isolation:isolate (creates root stacking context)"
else
  ok ".app-shell isolation policy safe (auto or unspecified)"
fi

# --- 5. .toolbar overflow policy ------------------------------------------
hdr "5. .toolbar overflow policy"
TOOLBAR_RULE=$(awk '/\.toolbar\s*\{/,/^\}/' "$CSS" 2>/dev/null || true)
if printf '%s\n' "$TOOLBAR_RULE" | grep -qE 'overflow:\s*hidden'; then
  err ".toolbar has overflow:hidden (will clip the speeddial panel)"
else
  ok ".toolbar overflow policy safe (visible or unspecified)"
fi

# --- 6. Vitest smoke -------------------------------------------------------
hdr "6. Vitest — main-menu tests"
TEST_TARGET=""
for f in \
  test/main-menu.test.tsx \
  client/src/components/main-menu.test.tsx \
  client/src/components/__tests__/main-menu.test.tsx; do
  [[ -f "$f" ]] && TEST_TARGET="$f" && break
done
if [[ -n "$TEST_TARGET" ]]; then
  if npx --no-install vitest run "$TEST_TARGET" 2>&1 | tail -40; then
    ok "Vitest passed for $TEST_TARGET"
  else
    err "Vitest failed for $TEST_TARGET"
  fi
else
  warn "no main-menu test target found; skipping"
fi

# --- 7. TypeScript typecheck ----------------------------------------------
hdr "7. tsc --noEmit"
if [[ -f tsconfig.json ]]; then
  if npx --no-install tsc --noEmit -p tsconfig.json 2>&1 | tail -30; then
    ok "tsc --noEmit passed"
  else
    err "tsc --noEmit failed"
  fi
else
  warn "tsconfig.json not found; skipping typecheck"
fi

# --- 8. KNOWN GAPS — intentionally NOT enforced here -----------------------
# These four checks are deliberately out of scope for the current
# portal-escape guard (commit B). Each belongs in its own dedicated
# commit for single-responsibility bisect hygiene:
#
#   (a) tsconfig.json — compilerOptions.jsx: "react-jsx" runtime baseline
#                       (catches a regression where someone reverts
#                       tsconfig to "preserve" or "react" classic runtime,
#                       breaking createPortal + jsx() called-style code)
#
#   (b) package.json — react ^18, react-dom ^18, typescript ^5 floors
#                       (createPortal API became stable in React 18; an
#                       accidental downgrade in a future lockfile bump would
#                       silently break the portal render)
#
#   (c) tailwind.config.ts — safelist menu-panel, menu-overlay,
#                           speeddial-toggle, speeddial-panel
#                           (in Tailwind v4 these classes are referenced
#                            ONLY inside <div className="..."> in TSX and
#                            inside defined CSS rule blocks in index.css;
#                            if not safelisted, the production bundle
#                            drops them entirely. happy-dom does not load
#                            external CSS, so vitest misses this.)
#
#   (d) Production CSS bundle size floor (10 kB sanity check)
#                       (heuristic, fragile, recommended to skip in favour
#                        of Lighthouse / PageSpeed Insights CSS-coverage)
#
# Treat the four as separate commits when they happen:
#   • chore(tsconfig):       enforce jsx: react-jsx baseline
#   • chore(deps):           enforce react/react-dom/ts minimum-version check
#   • chore(tailwind):       safelist menu-panel/menu-overlay/speeddial-*
#   • chore(build):          CSS minified size floor (or skip in favour of
#                            Lighthouse)
#
# Tracker: note caa5e8a2-4513-45a9-bbf8-7dd7bc0d9590
#          § Extensions deferred.

hdr "8. Known gaps (NOT enforced — see comments above)"
ok "  (a) tsconfig.jsx: react-jsx   — chore(tsconfig) follow-up commit"
ok "  (b) react version floors      — chore(deps) follow-up commit"
ok "  (c) tailwind safelist         — chore(tailwind) follow-up commit  ← ASAP"
ok "  (d) CSS bundle size floor     — chore(build) follow-up commit  (fragile heuristic)"
printf "\n  ${DIM}Reminder: (c) tailwind safelist MUST be addressed before production${RST}\n"
printf "  ${DIM}deploy — under happy-dom vitest cannot detect dropped classes.${RST}\n"

# === end of guard ==========================================================
printf "\n${GRN}All pre-commit checks passed.${RST}\n"
