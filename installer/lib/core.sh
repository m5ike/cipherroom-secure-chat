# shellcheck shell=bash
# M5cet installer — core helpers: logging, dry-run, privilege, safe removal.
#
# Every file under installer/lib is sourced by install.sh / update.sh /
# uninstall.sh. Written for bash >= 3.2 (macOS ships 3.2): no associative
# arrays, no ${var,,}, no mapfile, and empty arrays are expanded with the
# ${arr[@]+"${arr[@]}"} idiom so `set -u` does not trip.

M5_INSTALLER_VERSION="3.0.0"

DRY_RUN="${DRY_RUN:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
VERBOSE="${VERBOSE:-0}"

# UI language for the wizard: cs when the locale says so, else en.
if [ -z "${M5_LANG:-}" ]; then
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
    cs*|sk*) M5_LANG="cs" ;;
    *)       M5_LANG="en" ;;
  esac
fi

# L "english" "česky" — pick the string for the current UI language.
L() { if [ "${M5_LANG}" = "cs" ] && [ -n "${2:-}" ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'; C_YEL=$'\033[1;33m'
  C_BLU=$'\033[1;34m'; C_MAG=$'\033[1;35m'; C_CYN=$'\033[1;36m'
  C_BLD=$'\033[1m';    C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_MAG=''; C_CYN=''; C_BLD=''; C_RST=''
fi

log()    { printf '%s[+]%s %s\n' "${C_GRN}" "${C_RST}" "$*"; }
info()   { printf '%s[i]%s %s\n' "${C_CYN}" "${C_RST}" "$*"; }
warn()   { printf '%s[!]%s %s\n' "${C_YEL}" "${C_RST}" "$*" >&2; }
die()    { printf '%s[x]%s %s\n' "${C_RED}" "${C_RST}" "$*" >&2; exit 1; }
step()   { printf '\n%s==>%s %s%s%s\n' "${C_MAG}" "${C_RST}" "${C_BLD}" "$*" "${C_RST}"; }
ok()     { printf '%s  OK %s %s\n' "${C_GRN}" "${C_RST}" "$*"; }
fail()   { printf '%s FAIL%s %s\n' "${C_RED}" "${C_RST}" "$*"; }
skipln() { printf '%s SKIP%s %s\n' "${C_YEL}" "${C_RST}" "$*"; }
debug()  { [ "${VERBOSE}" = "1" ] && printf '%s[d]%s %s\n' "${C_BLU}" "${C_RST}" "$*" >&2; return 0; }

have() { command -v "$1" >/dev/null 2>&1; }

# run CMD ARGS... — execute, or only print under --dry-run.
run() {
  if [ "${DRY_RUN}" = "1" ]; then
    printf '%s[dry-run]%s %s\n' "${C_BLU}" "${C_RST}" "$*"
    return 0
  fi
  debug "run: $*"
  "$@"
}

# run_sh 'shell snippet' — same, for pipelines / redirections.
run_sh() {
  if [ "${DRY_RUN}" = "1" ]; then
    printf '%s[dry-run]%s %s\n' "${C_BLU}" "${C_RST}" "$*"
    return 0
  fi
  debug "run_sh: $*"
  bash -c "$*"
}

# write_file PATH MODE — write stdin to PATH atomically with MODE.
# Under dry-run the content is discarded and only the intent is printed.
write_file() {
  local path="$1" mode="${2:-0644}" tmp
  if [ "${DRY_RUN}" = "1" ]; then
    cat >/dev/null
    printf '%s[dry-run]%s write %s (mode %s)\n' "${C_BLU}" "${C_RST}" "${path}" "${mode}"
    return 0
  fi
  mkdir -p "$(dirname "${path}")"
  tmp="${path}.tmp.$$"
  # Create with a tight umask first so secrets never exist world-readable.
  ( umask 077; cat > "${tmp}" )
  chmod "${mode}" "${tmp}"
  mv -f "${tmp}" "${path}"
}

is_root() { [ "$(id -u)" -eq 0 ]; }

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_stamp() { date +%Y%m%d-%H%M%S; }

# random_hex BYTES — cryptographically random hex string.
random_hex() {
  local bytes="${1:-32}"
  if have openssl; then
    openssl rand -hex "${bytes}"
  else
    head -c "${bytes}" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# abs_path PATH — absolute path without requiring the target to exist.
abs_path() {
  # shellcheck disable=SC2088  # matching a literal, unexpanded ~ is the point
  case "$1" in
    /*) printf '%s' "$1" ;;
    "~"|"~/"*) printf '%s' "${HOME}${1#\~}" ;;
    *)  printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}

# is_safe_install_dir PATH — refuse paths we must never create inside blindly
# or remove recursively: /, top-level system dirs, $HOME itself, or anything
# shallower than two components.
is_safe_install_dir() {
  local p="$1"
  [ -n "${p}" ] || return 1
  case "${p}" in /*) ;; *) return 1 ;; esac
  p="${p%/}"
  [ -n "${p}" ] || return 1
  [ "${p}" != "${HOME%/}" ] || return 1
  case "${p}" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/Users|/Applications|/Library|/System|/private|/usr/local|/var/lib|/var/backups)
      return 1 ;;
  esac
  # at least two path components: /a/b
  case "${p#/}" in */*) return 0 ;; *) return 1 ;; esac
}

# safe_rm_install_dir PATH — recursive delete, only for a directory that this
# installer created (it must carry our marker file).
safe_rm_install_dir() {
  local p="${1%/}"
  is_safe_install_dir "${p}" || die "Refusing to remove unsafe path: '${p}'"
  if [ "${DRY_RUN}" != "1" ] && [ -d "${p}" ] && [ ! -f "${p}/.m5cet/install.conf" ]; then
    die "Refusing to remove ${p}: no .m5cet/install.conf marker (not created by this installer)."
  fi
  run rm -rf -- "${p}"
}

# version_major "v24.1.0" -> 24
version_major() { printf '%s' "$1" | sed -E 's/^[^0-9]*([0-9]+).*/\1/'; }

# port_in_use PORT — 0 when something listens on the TCP port.
port_in_use() {
  local port="$1"
  if have ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$"
  elif have lsof; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
  elif have netstat; then
    netstat -an 2>/dev/null | grep -E "[:.]${port}[[:space:]].*LISTEN" >/dev/null
  else
    return 1
  fi
}

on_error() {
  local rc=$? line="${1:-?}"
  printf '%s[x] %s: line %s exited with status %s%s\n' "${C_RED}" "${M5_SCRIPT_NAME:-installer}" "${line}" "${rc}" "${C_RST}" >&2
}
