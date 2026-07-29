#!/usr/bin/env bash
# =============================================================================
# scripts/merge-and-tag-v2.4.1.sh — M5cet release runbook
# -----------------------------------------------------------------------------
# End-to-end release script for cipherroom-secure-chat v2.4.1.
#
# Flow:
#   0. Branch check (must be update-with-ai)
#   1. git fetch origin
#   2. Confirm stash with server/index.ts WIP exists
#   3. Switch to master
#   4. Fast-forward local master from origin/master (refuse if diverged)
#   5. Merge update-with-ai into master (--no-ff). STOP on conflict.
#   6. Verify menu-fix invariants still hold in the merged tree
#   7. Push master to origin
#   8. Tag v2.4.1 (annotated) and push it to origin
#   9. Switch back to update-with-ai and pop the stash
#  10. Final report (HEADs, tag, last 5 log lines)
#
# Pre-requisites:
#   - Working tree mostly clean. server/index.ts is expected to be stashed.
#   - git config core.hooksPath .githooks   (otherwise pre-commit guard is
#     not enforced automatically; this script always runs the guard manually).
#   - You have permission to push to origin (SSH key or https PAT set up).
#
# Exit codes:
#   0 — release completed end-to-end
#   1 — unexpected script error (set -e)
#   2 — wrong starting branch
#   3 — local master diverged from origin/master
#   4 — merge conflict (merge aborted; report printed)
#   5 — tag v2.4.1 already exists locally or on origin
#  10 — verification step (STEP 6/7) failed (read output)
#
# Idempotency:
#   - Running this script twice is safe. Merge in step 5 produces an empty
#     merge commit on the second run; manual review recommended before
#     pushing that.
#   - The tag in step 8 refuses to create a duplicate (exit 5).
# =============================================================================

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# --- terminal colors -------------------------------------------------------
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'
  BLU=$'\033[0;34m'; DIM=$'\033[2m';      RST=$'\033[0m'
else
  RED=''; GRN=''; YEL=''; BLU=''; DIM=''; RST=''
fi

# --- helpers ---------------------------------------------------------------
hdr()  { printf "\n${BLU}===== %s =====${RST}\n" "$1"; }
ok()   { printf "  ${GRN}[ OK ]${RST} %s\n" "$1"; }
warn() { printf "  ${YEL}[WARN]${RST} %s\n" "$1"; }
fail() { printf "  ${RED}[FAIL]${RST} %s\n" "$1"; }

# --- STEP 0: Branch check --------------------------------------------------
hdr "STEP 0: Branch check"
CURRENT=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT" != "update-with-ai" ]]; then
  fail "must be on 'update-with-ai' branch, currently: $CURRENT"
  echo "  Run: git checkout update-with-ai"
  exit 2
fi
ok "on branch update-with-ai"

# --- STEP 1: Fetch origin --------------------------------------------------
hdr "STEP 1: git fetch origin"
git fetch origin
ok "fetched from origin"

# --- STEP 2: Confirm stash -------------------------------------------------
hdr "STEP 2: Confirm stash for server/index.ts WIP"
if git stash list | grep -q "wip: reusePort"; then
  ok "stash found: 'wip: reusePort' (server/index.ts)"
else
  warn "expected stash not found; continuing"
  warn "  If you have not stashed server/index.ts, that change will"
  warn "  leak into the merge commit. Verify with 'git status' after."
fi

# --- STEP 3: Switch to master ---------------------------------------------
hdr "STEP 3: Switch to master"
git checkout master
ok "now on master"

# --- STEP 4: Fast-forward local master ------------------------------------
hdr "STEP 4: Fast-forward local master from origin/master"
if ! git merge --ff-only origin/master; then
  fail "local master diverged from origin/master; refusing to fast-forward"
  echo "  Inspect with: git log --oneline origin/master..master"
  echo "  Either: 'git reset --hard origin/master' (DANGEROUS; discards local commits)"
  echo "  Or:    'git rebase origin/master' to replay your local commits on top"
  exit 3
fi
ok "master is fast-forwarded"

# --- STEP 5: Merge update-with-ai (no-ff) ---------------------------------
hdr "STEP 5: Merge update-with-ai into master (--no-ff)"
if ! git merge --no-ff update-with-ai \
  -m "merge: MainMenu speed-dial portal-escape + guard (v2.4.1)

Brings the speed-dial portal-escape fix into production branch
together with a pre-commit guard that prevents working-tree
regression and three CSS / DOM invariant tests.

Replaces the previous in-package panel position:absolute with
createPortal(..., document.body) + position:fixed z-index:10000
so the menu renders in the top layer regardless of parent
stacking context (.app-shell isolation, .app-header backdrop-filter,
.toolbar overflow history).

Refs: note caa5e8a2-4513-45a9-bbf8-7dd7bc0d9590
Fix:  db7b824a (on master, reintroduced via update-with-ai)
Commits brought in from update-with-ai:
  - chore(git):       untrack stale tilde backup, ignore editor swap files
  - fix(menu):        portal-escape working-tree regression on speed-dial
  - chore(scripts)+test(menu): portal-escape guard + 3 invariants"; then
  echo
  echo "${RED}==========================${RST}"
  echo "${RED}STOP: merge produced conflicts${RST}"
  echo "${RED}==========================${RST}"
  echo
  echo "${BLU}--- git status ---${RST}"
  git status
  echo
  echo "${BLU}--- conflicted files (Unmerged) ---${RST}"
  git diff --name-only --diff-filter=U || true
  echo
  echo "${BLU}--- conflict markers with line numbers ---${RST}"
  for FILE in $(git diff --name-only --diff-filter=U); do
    echo "${YEL}>> $FILE${RST}"
    grep -nE '^(<<<<<<<|=======|>>>>>>>)' "$FILE" 2>/dev/null \
      || echo "  (no markers detected)"
  done
  echo
  echo "${BLU}--- unified conflict diff ---${RST}"
  git diff --cc | head -200 || true
  echo
  echo "${YEL}--- aborting merge ---${RST}"
  git merge --abort
  echo
  echo "Merge aborted. Master is in its pre-merge state."
  echo "Paste the output above to parent agent for resolution advice."
  exit 4
fi
ok "merge commit created on master"

# --- STEP 6: Verify invariants ---------------------------------------------
hdr "STEP 6: Verify menu-fix invariants on master"
INVARIANTS_FAILED=0

if grep -q 'createPortal' client/src/components/MainMenu.tsx; then
  ok "createPortal present in MainMenu.tsx"
else
  fail "createPortal missing in MainMenu.tsx"
  INVARIANTS_FAILED=1
fi

if grep -qE -- '--z-menu:\s*[0-9]+' client/src/index.css; then
  ok "--z-menu token defined in index.css"
else
  fail "--z-menu token missing in index.css :root"
  INVARIANTS_FAILED=1
fi

PANEL_RULE=$(awk '/\.menu-panel\s*\{/,/^\}/' client/src/index.css 2>/dev/null || true)
if printf '%s\n' "$PANEL_RULE" | grep -q 'position:\s*fixed'; then
  ok ".menu-panel has position:fixed"
else
  fail ".menu-panel has position:absolute or unspecified"
  INVARIANTS_FAILED=1
fi

if [[ -x scripts/pre-commit-check.sh ]]; then
  ok "scripts/pre-commit-check.sh exists and is executable"
else
  fail "scripts/pre-commit-check.sh missing or not executable"
  INVARIANTS_FAILED=1
fi

if [[ -x .githooks/pre-commit ]]; then
  ok ".githooks/pre-commit exists and is executable"
else
  fail ".githooks/pre-commit missing or not executable"
  INVARIANTS_FAILED=1
fi

# --- STEP 7: Vitest sanity run --------------------------------------------
hdr "STEP 7: Vitest smoke run on master"
TEST_TARGET=""
for f in \
  test/main-menu.test.tsx \
  client/src/components/main-menu.test.tsx \
  client/src/components/__tests__/main-menu.test.tsx; do
  [[ -f "$f" ]] && TEST_TARGET="$f" && break
done
if [[ -n "$TEST_TARGET" ]]; then
  if npx --no-install vitest run "$TEST_TARGET" 2>&1 | tail -25; then
    ok "Vitest menu tests passed"
  else
    fail "Vitest menu tests failed"
    INVARIANTS_FAILED=1
  fi
else
  warn "main-menu test target not found; skipping Vitest"
fi

if [[ $INVARIANTS_FAILED -ne 0 ]]; then
  echo
  echo "${RED}STEP 6/7 reported failures.${RST}"
  echo "  You can still push master and tag v2.4.1, but be aware"
  echo "  the merge commit may have a regression. Recommended: revert"
  echo "  the merge commit before tagging."
  echo
  echo "  Recovery (before push):"
  echo "    git reset --hard origin/master   # if you have NOT pushed yet"
  echo "  Recovery (after push):"
  echo "    git revert -m 1 HEAD            # if you HAVE pushed"
  echo
  echo "  Override: comment out the INVARIANTS_FAILED check in this script."
  echo "Aborting now to prevent broken tagging."
  exit 10
fi

# --- STEP 8: Push master ---------------------------------------------------
hdr "STEP 8: Push master to origin"
if ! git push origin master; then
  fail "git push origin master failed (likely non-fast-forward or auth)"
  echo "  Inspect with: git remote -v; ssh -T git@github.com"
  exit 1
fi
ok "master pushed"

# --- STEP 9: Tag v2.4.1 (annotated) ----------------------------------------
hdr "STEP 9: Tag v2.4.1"
TAG="v2.4.1"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "tag $TAG already exists locally"
  echo "  Resolve: git tag -d $TAG"
  echo "  Then re-run STEP 9 only, or use a different tag (e.g. v2.4.1-hotfix1)."
  exit 5
fi

if git ls-remote origin "refs/tags/$TAG" 2>/dev/null | grep -q "$TAG"; then
  fail "tag $TAG exists on origin"
  echo "  Resolve: git push origin :refs/tags/$TAG    # delete remote tag"
  echo "           git tag -d \$TAG                   # delete local"
  echo "  Then re-run STEP 9."
  exit 5
fi

git tag -a "$TAG" -m "v2.4.1 — MainMenu speed-dial portal-escape fix

Brings the floating menu into document.body root via createPortal,
with position:fixed z-index:10000, plus a pre-commit guard
(check:menu) preventing working-tree regression and three CSS
invariants tests.

Includes:
  - .menu-panel rewrite (position:fixed, defensive isolation:auto,
    contain:layout style, will-change:auto)
  - .app-shell isolation:auto (was: isolate)
  - .toolbar overflow:visible (was: hidden)
  - Stacking-context tokens --z-shell / --z-header / --z-menu-toggle /
    --z-menu-overlay / --z-menu in :root
  - .menu-overlay transparent fixed-position backdrop for outside-click
  - Known-gaps reminder section in scripts/pre-commit-check.sh
  - Three CSS / DOM invariants tests in test/main-menu.test.tsx

Refs: note caa5e8a2-4513-45a9-bbf8-7dd7bc0d9590 (M5cet portal-escape
fix full bundle)"

if ! git push origin "$TAG"; then
  fail "git push origin $TAG failed"
  echo "  Tag is local-only; re-run 'git push origin $TAG' once issue is resolved."
  exit 1
fi
ok "tag $TAG created and pushed"
git ls-remote origin "refs/tags/$TAG"

# --- STEP 10: Switch back, restore stash, final report --------------------
hdr "STEP 10: Switch back to update-with-ai and restore stash"

git checkout update-with-ai
ok "switched back to update-with-ai"

if git stash list | grep -q "wip: reusePort"; then
  if git stash pop; then
    ok "stash popped — server/index.ts WIP restored on update-with-ai"
  else
    warn "git stash pop failed (possible conflict with another working tree change)"
    warn "  Inspect with: git stash list; git stash show -p stash@{0}"
    warn "  Resolve manually, OR drop with: git stash drop stash@{0}"
  fi
else
  warn "no stash to pop; server/index.ts WIP not recovered by this script"
fi

hdr "FINAL REPORT"
echo "${GRN}master HEAD:${RST}    $(git rev-parse origin/master)"
echo "${GRN}tag $TAG ->:${RST}    $(git rev-parse refs/tags/$TAG)"
echo "${GRN}update-with-ai HEAD:${RST} $(git rev-parse HEAD)"
echo
echo "${BLU}--- master log (last 5 commits) ---${RST}"
git log --oneline -5 origin/master

echo
echo "${BLU}--- update-with-ai log (last 5 commits) ---${RST}"
git log --oneline -5

echo
echo "${GRN}Done. v2.4.1 released to origin/master.${RST}"
echo "${DIM}Next steps (manual, not in this script):${RST}"
echo "${DIM}  1. Watch CI/CD deploy pipeline for v2.4.1 tag push trigger${RST}"
echo "${DIM}  2. Manual browser smoke test on production URL (7 scenarios)${RST}"
echo "${DIM}  3. If runtime regression found:${RST}"
echo "${DIM}     - 'git revert -m 1 v2.4.1' to revert merge commit, OR${RST}"
echo "${DIM}     - cut a v2.4.1-hotfix1 tag with a fix-forward commit${RST}"
