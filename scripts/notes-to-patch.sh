#!/usr/bin/env bash
# =============================================================================
# scripts/notes-to-patch.sh
# -----------------------------------------------------------------------------
# Rekonstruuje M5cet MainMenu speed-dial fix z Notes ID v tomto chatu
# a uloží dva .patch soubory do /tmp/fix-menu.{tsx,css}.patch.
#
# POUŽITÍ:
#   ./scripts/notes-to-patch.sh
#   # nebo pro danou verzi:
#   ./scripts/notes-to-patch.sh A    # STDIN varianta
#
# POŽADAVKY:
#   - bash 4+
#   - curl + jq (jen pro verzi B/C)
#   - přístup k Notes API (defaultně https://notes.example.org — viz verze B)
#   NEBO ruční copy-paste do /tmp/notes-input.diff (verze A)
#
# VYSTUP:
#   /tmp/fix-menu.tsx.patch
#   /tmp/fix-menu.css.patch
#
# PAK:
#   git apply --check /tmp/fix-menu.tsx.patch
#   git apply /tmp/fix-menu.tsx.patch
#   git apply --check /tmp/fix-menu.css.patch
#   git apply /tmp/fix-menu.css.patch
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

# --- konfigurace -------------------------------------------------------------

# !!! DOPLŇ SVŮJ Notes API endpoint, klíč a Notes ID !!!
# (zde jsou defaulty pro tuto konverzaci - viz "Master" reference v chatu)
NOTES_API="${NOTES_API:-https://notes.example.org/api/v1}"
NOTES_TOKEN="${NOTES_TOKEN:-}"   # export NOTES_TOKEN=...  nebo nastav zde
NOTE_ID_TSX="${NOTE_ID_TSX:-9f25594f-2a36-4fc1-bc31-0cbd49f00887}"
NOTE_ID_CSS="${NOTE_ID_CSS:-0f3a7d5f-d94a-48b4-b4cb-10bc40ec3705}"

OUT_TSX="/tmp/fix-menu.tsx.patch"
OUT_CSS="/tmp/fix-menu.css.patch"

# --- helpery ----------------------------------------------------------------

log() { printf "\033[1;34m[notes-to-patch]\033[0m %s\n" "$*"; }
err() { printf "\033[0;31m[ERROR]\033[0m %s\n" "$*" >&2; exit 1; }
ok()  { printf "\033[0;32m[ OK ]\033[0m %s\n" "$*"; }

# Extrahuje unified diff z markdownu Note.
# Vstup: markdown s ```diff … ``` blokem (případně i více takových bloků).
# Výstup: pouze unified diff (řádky začínající --- / +++ / @@ / +/- / mezera),
#         zbavené markdown wrapperů.
extract_diff() {
  awk '
    BEGIN { in_block = 0; }
    /^```diff$/ { in_block = 1; next; }
    /^```$/     { in_block = 0; next; }
    in_block == 1 { print; }
  '
}

# Uloží diff do souboru + ověří unified diff formát.
write_patch() {
  local out="$1"
  local content="$2"
  printf "%s\n" "$content" > "$out"
  # Ověření: alespoň 1 hlavička --- a +++
  if ! grep -qE '^--- ' "$out" || ! grep -qE '^\+\+\+ ' "$out"; then
    err "extract failed: $out does not look like a unified diff (missing '--- a/' or '+++ b/')."
  fi
  if ! grep -qE '^@@ ' "$out"; then
    err "extract failed: $out does not look like a unified diff (no '@@' hunk header)."
  fi
  ok "wrote $out  ($(wc -l < "$out") lines, $(wc -c < "$out") bytes)"
}

# --- verze A: STDIN ----------------------------------------------------------

version_a_stdin() {
  log "VERSION A: copy-paste notes content via stdin"
  log "  Please paste content of Note 9f25594f-… (MainMenu.tsx patch)."
  log "  Press Ctrl+D when done."
  local tsx_raw
  tsx_raw=$(cat)
  if [[ -z "$tsx_raw" ]]; then
    err "empty stdin for MainMenu.tsx note"
  fi
  local tsx_diff
  tsx_diff=$(printf "%s" "$tsx_raw" | extract_diff)
  [[ -n "$tsx_diff" ]] || err "no ```diff block found in MainMenu.tsx paste```"
  write_patch "$OUT_TSX" "$tsx_diff"

  log "  Now please paste content of Note 0f3a7d5f-… (styles.css patch)."
  log "  Press Ctrl+D when done."
  local css_raw
  css_raw=$(cat)
  if [[ -z "$css_raw" ]]; then
    err "empty stdin for styles.css note"
  fi
  local css_diff
  css_diff=$(printf "%s" "$css_raw" | extract_diff)
  [[ -n "$css_diff" ]] || err "no ```diff block found in styles.css paste```"
  write_patch "$OUT_CSS" "$css_diff"
}

# --- verze B: Notes API přes curl + jq --------------------------------------

version_b_api() {
  log "VERSION B: fetch from Notes API ($NOTES_API)"

  [[ -n "$NOTES_TOKEN" ]] || err "NOTES_TOKEN not set (export NOTES_TOKEN=... or edit skript)"

  fetch_note() {
    local id="$1"
    curl -fsSL \
      -H "Authorization: Bearer $NOTES_TOKEN" \
      -H "Accept: application/json" \
      "$NOTES_API/notes/$id" \
      | jq -r '.content // .body // .markdown // .text // error'
  }

  local tsx_raw css_raw tsx_diff css_diff
  log "fetching $NOTE_ID_TSX..."
  tsx_raw=$(fetch_note "$NOTE_ID_TSX") || err "fetch failed for $NOTE_ID_TSX"
  tsx_diff=$(printf "%s" "$tsx_raw" | extract_diff)
  [[ -n "$tsx_diff" ]] || err "no ```diff block in fetched note $NOTE_ID_TSX```"
  write_patch "$OUT_TSX" "$tsx_diff"

  log "fetching $NOTE_ID_CSS..."
  css_raw=$(fetch_note "$NOTE_ID_CSS") || err "fetch failed for $NOTE_ID_CSS"
  css_diff=$(printf "%s" "$css_raw" | extract_diff)
  [[ -n "$css_diff" ]] || err "no ```diff block in fetched note $NOTE_ID_CSS```"
  write_patch "$OUT_CSS" "$css_diff"
}

# --- verze C: ruční zápis do /tmp/notes-input.diff ---------------------------

version_c_file() {
  log "VERSION C: read pre-saved files from /tmp/notes-input.tsx.txt and /tmp/notes-input.css.txt"
  log "  1. From chat, copy each Note and save raw markdown (INCLUDING ``` fences```) as:"
  log "       /tmp/notes-input.tsx.txt   (from Note 9f25594f-…)"
  log "       /tmp/notes-input.css.txt   (from Note 0f3a7d5f-…)"
  log "  2. Run this version again."

  [[ -f /tmp/notes-input.tsx.txt ]] || err "/tmp/notes-input.tsx.txt not found"
  [[ -f /tmp/notes-input.css.txt ]] || err "/tmp/notes-input.css.txt not found"

  local tsx_diff css_diff
  tsx_diff=$(extract_diff < /tmp/notes-input.tsx.txt)
  [[ -n "$tsx_diff" ]] || err "no ''diff block in /tmp/notes-input.tsx.txt"
  write_patch "$OUT_TSX" "$tsx_diff"

  css_diff=$(extract_diff < /tmp/notes-input.css.txt)
  [[ -n "$css_diff" ]] || err "no ''diff block in /tmp/notes-input.css.txt"
  write_patch "$OUT_CSS" "$css_diff"
}

# --- dispatcher --------------------------------------------------------------

VER="${1:-}"
case "$VER" in
  A|a|stdin) version_a_stdin ;;
  B|b|api)   version_b_api   ;;
  C|c|file)  version_c_file  ;;
  "")
    log "No version specified — printing help and exiting cleanly."
    cat <<HELP

USAGE:
  $0 A    # copy-paste notes via STDIN (no API needed)
  $0 B    # fetch from Notes API (needs \$NOTES_TOKEN)
  $0 C    # read pre-saved /tmp/notes-input.{tsx,css}.txt files

OUTPUT (regardless of version):
  $OUT_TSX
  $OUT_CSS
HELP
    exit 0
    ;;
  *) err "unknown version: $VER (use A | B | C)" ;;
esac

# --- post-processing ---------------------------------------------------------

log ""
log "================================================================"
log "Both patches written. Next steps:"
log "================================================================"
cat <<NEXT

  cd /Users/m5ike/CodeAgent/workspaces/cipherroom-secure-chat-v2

  # 1. suchá kontrola
  git apply --check $OUT_TSX && echo "\u2713 tsx applies" || echo "\u2717 tsx fails"
  git apply --check $OUT_CSS && echo "\u2713 css applies" || echo "\u2717 css fails"

  # 2. pokud suchá kontrola prošla, aplikuj
  git apply $OUT_TSX
  git apply $OUT_CSS

  # 3. ověř (grep defensiv)
  echo "--- verifikace ---"
  grep -q "createPortal"          client/src/components/MainMenu.tsx && echo "\u2713 createPortal"
  grep -q "useAnchorPosition"     client/src/components/MainMenu.tsx && echo "\u2713 useAnchorPosition"
  grep -q "document.body"         client/src/components/MainMenu.tsx && echo "\u2713 portal target"
  grep -q -- "--z-menu:"          client/src/styles.css               && echo "\u2713 --z-menu token"
  grep -q "isolation: auto"       client/src/styles.css               && echo "\u2713 isolation:auto"
  grep -q "overflow: visible"     client/src/styles.css               && echo "\u2713 overflow:visible"
  grep -q ".menu-overlay {"       client/src/styles.css               && echo "\u2713 .menu-overlay"
  grep -q "@keyframes menu-pop"   client/src/styles.css               && echo "\u2713 menu-pop anim"

  # 4. testy + build
  npm test
  npm run build

  # 5. commit + push + PR
  git add client/src/components/MainMenu.tsx client/src/styles.css
  git commit -F /tmp/fix-menu-portal.txt
  git push -u origin fix/menu-speed-dial-portal-escape

NEXT
ok "done"