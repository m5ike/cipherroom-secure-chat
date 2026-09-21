# shellcheck shell=bash
# M5cet installer — user interface: plain text prompts or a whiptail/dialog
# TUI ("GUI"). Both back ends expose the same four primitives, so the wizard
# does not care which one is active.
#
#   ui_input  VAR "Title" "Prompt" "default"
#   ui_secret VAR "Title" "Prompt"
#   ui_yesno  "Prompt" [default: 1=yes 0=no]      -> exit status 0 = yes
#   ui_menu   VAR "Title" "Prompt" "default-tag" tag1 "label1" tag2 "label2" ...
#   ui_msg    "Title" "Text"

UI="${UI:-auto}"          # auto | text | dialog
UI_BACKEND=""             # resolved: text | whiptail | dialog

_ui_has_tty() { { : </dev/tty; } 2>/dev/null; }

# Resolve the back end once. "dialog" means "a TUI": whiptail or dialog,
# whichever exists. Falls back to text when there is no terminal or no tool.
ui_init() {
  UI_BACKEND="text"
  [ "${NON_INTERACTIVE}" = "1" ] && return 0
  case "${UI}" in
    text) return 0 ;;
    auto|dialog)
      if _ui_has_tty || [ -t 0 ]; then
        if have whiptail; then UI_BACKEND="whiptail"
        elif have dialog; then UI_BACKEND="dialog"
        elif [ "${UI}" = "dialog" ]; then
          warn "$(L 'No whiptail/dialog found — using the text wizard.' 'whiptail/dialog není k dispozici — použiji textového průvodce.')"
        fi
      elif [ "${UI}" = "dialog" ]; then
        warn "$(L 'No terminal available — using the text wizard.' 'Není k dispozici terminál — použiji textového průvodce.')"
      fi
      ;;
    *) die "Unknown --ui value '${UI}' (use auto, text or dialog)." ;;
  esac
  debug "ui backend: ${UI_BACKEND}"
}

# _ui_readline VAR [-s] — one line from the terminal. Reads /dev/tty when
# stdin is not a terminal (so a piped script cannot be mistaken for answers);
# without any terminal it falls back to stdin, which lets tests and CI feed
# answers. Returns 1 at EOF so callers keep their default.
_ui_readline() {
  local __var="$1" __silent="${2:-}" __line="" __rc=0
  if [ -t 0 ]; then
    if [ "${__silent}" = "-s" ]; then IFS= read -r -s __line || __rc=1; echo
    else IFS= read -r __line || __rc=1; fi
  elif _ui_has_tty; then
    if [ "${__silent}" = "-s" ]; then IFS= read -r -s __line </dev/tty || __rc=1; echo
    else IFS= read -r __line </dev/tty || __rc=1; fi
  else
    IFS= read -r __line || __rc=1
  fi
  printf -v "${__var}" '%s' "${__line}"
  return "${__rc}"
}

# _ui_tui ARGS... — run whiptail/dialog, print the chosen value on stdout.
_ui_tui() {
  if [ -t 0 ]; then
    "${UI_BACKEND}" "$@" 3>&1 1>&2 2>&3
  else
    "${UI_BACKEND}" "$@" 3>&1 1>&2 2>&3 </dev/tty
  fi
}

ui_msg() {
  local title="$1" text="$2"
  [ "${NON_INTERACTIVE}" = "1" ] && { info "${text}"; return 0; }
  if [ "${UI_BACKEND}" = "text" ]; then
    printf '\n%s%s%s\n%s\n' "${C_BLD}" "${title}" "${C_RST}" "${text}"
  else
    _ui_tui --title "${title}" --msgbox "${text}" 16 74 >/dev/null || true
  fi
}

ui_input() {
  local __var="$1" title="$2" prompt="$3" default="${4:-}" ans=""
  if [ "${NON_INTERACTIVE}" = "1" ]; then
    printf -v "${__var}" '%s' "${default}"; return 0
  fi
  if [ "${UI_BACKEND}" = "text" ]; then
    if [ -n "${default}" ]; then printf '%s [%s]: ' "${prompt}" "${default}"
    else printf '%s: ' "${prompt}"; fi
    _ui_readline ans || true
    printf -v "${__var}" '%s' "${ans:-${default}}"
  else
    if ans="$(_ui_tui --title "${title}" --inputbox "${prompt}" 10 74 "${default}")"; then
      printf -v "${__var}" '%s' "${ans}"
    else
      die "$(L 'Cancelled.' 'Zrušeno.')"
    fi
  fi
}

ui_secret() {
  local __var="$1" title="$2" prompt="$3" ans=""
  if [ "${NON_INTERACTIVE}" = "1" ]; then
    printf -v "${__var}" '%s' ""; return 0
  fi
  if [ "${UI_BACKEND}" = "text" ]; then
    printf '%s: ' "${prompt}"
    _ui_readline ans -s || true
    printf -v "${__var}" '%s' "${ans}"
  else
    if ans="$(_ui_tui --title "${title}" --passwordbox "${prompt}" 10 74)"; then
      printf -v "${__var}" '%s' "${ans}"
    else
      die "$(L 'Cancelled.' 'Zrušeno.')"
    fi
  fi
}

ui_yesno() {
  local prompt="$1" default_yes="${2:-1}" ans="" hint
  if [ "${ASSUME_YES}" = "1" ]; then return 0; fi
  if [ "${NON_INTERACTIVE}" = "1" ]; then [ "${default_yes}" = "1" ]; return $?; fi
  if [ "${UI_BACKEND}" = "text" ]; then
    if [ "${default_yes}" = "1" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
    printf '%s %s ' "${prompt}" "${hint}"
    _ui_readline ans || true
    case "${ans}" in
      "")                         [ "${default_yes}" = "1" ] ;;
      [Yy]|[Yy][Ee][Ss]|[Aa]|[Aa][Nn][Oo]) return 0 ;;
      *)                          return 1 ;;
    esac
  else
    if [ "${default_yes}" = "1" ]; then
      _ui_tui --title "M5cet" --yesno "${prompt}" 10 74 >/dev/null
    else
      _ui_tui --title "M5cet" --defaultno --yesno "${prompt}" 10 74 >/dev/null
    fi
  fi
}

ui_menu() {
  local __var="$1" title="$2" prompt="$3" default="$4"
  shift 4
  local -a tags labels
  local n=0 i ans=""
  while [ $# -ge 2 ]; do tags[n]="$1"; labels[n]="$2"; n=$((n+1)); shift 2; done
  [ "${n}" -gt 0 ] || die "ui_menu: no options"

  if [ "${NON_INTERACTIVE}" = "1" ]; then
    printf -v "${__var}" '%s' "${default}"; return 0
  fi

  if [ "${UI_BACKEND}" = "text" ]; then
    printf '\n%s%s%s\n' "${C_BLD}" "${prompt}" "${C_RST}"
    i=0
    while [ "${i}" -lt "${n}" ]; do
      if [ "${tags[i]}" = "${default}" ]; then
        printf '  %s%d) %-10s %s  (default)%s\n' "${C_GRN}" "$((i+1))" "${tags[i]}" "${labels[i]}" "${C_RST}"
      else
        printf '  %d) %-10s %s\n' "$((i+1))" "${tags[i]}" "${labels[i]}"
      fi
      i=$((i+1))
    done
    while :; do
      printf '%s [%s]: ' "$(L 'Choose' 'Vyberte')" "${default}"
      if ! _ui_readline ans; then ans=""; fi
      [ -n "${ans}" ] || ans="${default}"
      # accept either the number or the tag
      i=0
      while [ "${i}" -lt "${n}" ]; do
        if [ "${ans}" = "$((i+1))" ] || [ "${ans}" = "${tags[i]}" ]; then
          printf -v "${__var}" '%s' "${tags[i]}"; return 0
        fi
        i=$((i+1))
      done
      warn "$(L 'Invalid choice:' 'Neplatná volba:') ${ans}"
      # At EOF (piped answers ran out) do not spin forever.
      if ! [ -t 0 ] && ! _ui_has_tty; then
        printf -v "${__var}" '%s' "${default}"; return 0
      fi
    done
  else
    local -a args
    i=0
    while [ "${i}" -lt "${n}" ]; do args[i*2]="${tags[i]}"; args[i*2+1]="${labels[i]}"; i=$((i+1)); done
    if ans="$(_ui_tui --title "${title}" --default-item "${default}" --menu "${prompt}" 18 74 "${n}" "${args[@]}")"; then
      printf -v "${__var}" '%s' "${ans}"
    else
      die "$(L 'Cancelled.' 'Zrušeno.')"
    fi
  fi
}
