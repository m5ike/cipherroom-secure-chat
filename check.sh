#!/usr/bin/env bash
# =============================================================================
# M5cet — kontrola instalace a hostitele / installation and host check (6.12)
# -----------------------------------------------------------------------------
# A thorough, READ-ONLY check of an M5cet installation and of the host it runs
# on, in sections:
#
#   package   release manifest + signature, build, SQLCipher, npm ls / audit, versions
#   config    .env (never printed), important variables, file permissions
#   runtime   Node, the service (systemd hardening / process / compose), ports, health
#   http      reverse proxy (nginx parsed from `nginx -T`, others detected), TLS
#   firewall  ufw / firewalld / nftables / iptables: policy, 80/443, app ports, TURN, SSH
#   kernel    sysctl settings that matter for a public WebSocket / WebRTC server
#   network   DNS, outbound HTTPS, time sync, MTU, IPv6, TURN, descriptors, ports
#   system    OS support, resources, disks, noexec, AppArmor/SELinux, bubblewrap,
#             speech tools, Redis, backups, security updates, reboot, service user
#   docker    daemon, container health and hardening, published ports (docker mode)
#   security  the app's own security settings, summarised
#
#   ./check.sh                          everything (run as root for the full picture)
#   ./check.sh --only http,firewall     some sections
#   ./check.sh --json                   machine-readable report
#
# Every check prints PASS / WARN / FAIL / SKIP, one line of reason and, for
# WARN / FAIL, a fix. Exit code: 0 no FAIL, 1 at least one FAIL, 2 usage error.
#
# It never changes the system: no service is restarted, nothing is installed,
# no file is written outside a private temporary directory (removed at exit;
# `--report FILE` writes only FILE). Secrets from .env are never printed —
# only whether a variable is set and, for secrets, how long it is; URLs appear
# without user:password, path and query (redis://***@host:6379); plain
# settings (addresses, ports, paths, modes) are quoted where a result needs
# them. Everything printed is stripped of terminal control sequences and is
# valid UTF-8. .env values are data only: never evaluated, never part of a
# shell string. When the check runs as root, nothing from the install tree is
# executed as root: the SQLCipher probe, `npm ls` and `git status` run as the
# service user (or the owner of the tree / of .git) via runuser / setpriv /
# sudo, or are skipped when no such non-root user is known.
#
# Works with bash >= 3.2, coreutils / grep / awk / sed; uses ss, ip, sysctl
# files, systemctl, nginx -T, openssl, nft / iptables / ufw / firewall-cmd,
# docker, timedatectl / chronyc, getent, node, npm, curl when they exist and
# says SKIP when they do not.
#
# Tests: M5CHECK_FAKE_ROOT / --sysroot DIR reads /proc, /sys, /etc … from DIR;
# M5CHECK_ABSENT="cmd …" hides commands; M5CHECK_UID fakes the user id.
# Docs: docs/install-check.md
# =============================================================================
set -u
umask 077
export LC_ALL=C

CHECK_VERSION="1.0.0"
SECTIONS_ALL="package config runtime http firewall kernel network system docker security"

# Keep in sync with EXCLUDE_* in script/release-manifest.ts (test/release-manifest.test.ts compares them).
M5_EXCL_ANY_DIRS=".git node_modules .gradle .kotlin .idea .vscode __pycache__"
M5_EXCL_ROOT_DIRS="dist .m5cet .claude .vite .memory coverage data admin-ui/public/vendor android/build android/app/build test-results playwright-report"
M5_EXCL_FILE_GLOBS=".env* *.key *.pem *.p12 *.pfx *.jks *.keystore *firebase-adminsdk*.json serviceAccount*.json *.db *.db-shm *.db-wal *.db-journal *.sqlite *.sqlite3 *.log .DS_Store *~ .*.swp *.bak local.properties .git"
M5_EXCL_ROOT_FILES="release.json release.json.sig"

ROOT=""
SYSROOT="${M5CHECK_FAKE_ROOT:-}"
LANG_SEL="cs"
JSON=0
QUIET=0
NO_COLOR_OPT=0
ONLY=""
SKIPS=""
OFFLINE="${M5CHECK_OFFLINE:-0}"
PUBKEY_ARG="${M5CHECK_RELEASE_PUBKEY:-}"
REPORT=""

# Admin tools often live in sbin, which a non-root PATH lacks.
case ":${PATH}:" in *":/usr/sbin:"*) ;; *) PATH="${PATH}:/usr/sbin:/sbin" ;; esac
export PATH

# L "english" "česky" — the message in the selected language.
L() { if [ "${LANG_SEL}" = "en" ]; then printf '%s' "$1"; else printf '%s' "${2:-$1}"; fi; }

usage() {
  cat <<EOF
M5cet check.sh ${CHECK_VERSION} — $(L 'read-only check of the installation and the host' 'kontrola instalace a hostitele (jen čtení)')

$(L 'Usage' 'Použití'): ./check.sh [$(L 'options' 'volby')]

  --root DIR          $(L 'installation directory (default: where check.sh lives, else /opt/m5cet)' 'instalační adresář (výchozí: kde leží check.sh, jinak /opt/m5cet)')
  --only S[,S…]       $(L 'run only these sections' 'jen tyto sekce')
  --skip S[,S…]       $(L 'skip these sections' 'tyto sekce vynechat')
                      ${SECTIONS_ALL}
  --json              $(L 'machine-readable report on stdout' 'strojově čitelný výstup na stdout')
  --report FILE       $(L 'also write the JSON report to FILE' 'navíc zapsat JSON do souboru FILE')
  --quiet, -q         $(L 'print only WARN / FAIL and the summary' 'vypsat jen WARN / FAIL a souhrn')
  --no-color          $(L 'no colours' 'bez barev')
  --lang cs|en        $(L 'language (default cs)' 'jazyk (výchozí cs)')
  --offline           $(L 'skip everything that needs the internet (npm audit, outbound, live TLS)' 'vynechat vše, co potřebuje internet (npm audit, odchozí spojení, živé TLS)')
  --pubkey FILE       $(L 'trusted release-signing public key (raw Ed25519, base64)' 'důvěryhodný veřejný klíč vydání (raw Ed25519, base64)')
  --sysroot DIR       $(L 'read /proc, /sys, /etc… from DIR (tests)' 'číst /proc, /sys, /etc… z DIR (testy)')
  --version, --help

$(L 'Exit code: 0 = no FAIL, 1 = at least one FAIL, 2 = usage error.' 'Návratový kód: 0 = žádný FAIL, 1 = aspoň jeden FAIL, 2 = chybné použití.')
$(L 'Run as root for the full picture; checks that need root say so.' 'Spusťte jako root pro úplný obraz; kontroly, které root potřebují, to řeknou.')
EOF
}

usage_err() { local m=""; clean_text m "$1"; printf 'check.sh: %s\n' "${m}" >&2; printf '%s\n' "$(L 'See ./check.sh --help' 'Viz ./check.sh --help')" >&2; exit 2; }

parse_args() {
  local v=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --root|--only|--skip|--lang|--pubkey|--sysroot|--report)
        [ $# -ge 2 ] || usage_err "$1 $(L 'needs a value' 'vyžaduje hodnotu')"
        v="$2"
        case "$1" in
          --root) ROOT="${v}" ;;
          --only) ONLY="${ONLY} ${v}" ;;
          --skip) SKIPS="${SKIPS} ${v}" ;;
          --lang) case "${v}" in cs|en) LANG_SEL="${v}" ;; *) usage_err "--lang cs|en" ;; esac ;;
          --pubkey) PUBKEY_ARG="${v}" ;;
          --sysroot) SYSROOT="${v}" ;;
          --report) REPORT="${v}" ;;
        esac
        shift ;;
      --root=*) ROOT="${1#*=}" ;;
      --only=*) ONLY="${ONLY} ${1#*=}" ;;
      --skip=*) SKIPS="${SKIPS} ${1#*=}" ;;
      --lang=*) case "${1#*=}" in cs|en) LANG_SEL="${1#*=}" ;; *) usage_err "--lang cs|en" ;; esac ;;
      --json) JSON=1 ;;
      -q|--quiet) QUIET=1 ;;
      --no-color) NO_COLOR_OPT=1 ;;
      --offline) OFFLINE=1 ;;
      -h|--help) usage; exit 0 ;;
      --version) printf '%s\n' "${CHECK_VERSION}"; exit 0 ;;
      *) usage_err "$(L 'unknown option' 'neznámá volba'): $1" ;;
    esac
    shift
  done
  ONLY="$(printf '%s' "${ONLY}" | tr ',' ' ')"
  SKIPS="$(printf '%s' "${SKIPS}" | tr ',' ' ')"
  local s=""
  for s in ${ONLY} ${SKIPS}; do
    case " ${SECTIONS_ALL} " in *" ${s} "*) ;; *) usage_err "$(L 'unknown section' 'neznámá sekce'): ${s} (${SECTIONS_ALL})" ;; esac
  done
  if [ -n "${SYSROOT}" ] && [ ! -d "${SYSROOT}" ]; then usage_err "--sysroot ${SYSROOT}: $(L 'not a directory' 'není adresář')"; fi
}

section_on() {
  local s="$1"
  if [ -n "${ONLY// /}" ]; then case " ${ONLY} " in *" ${s} "*) ;; *) return 1 ;; esac; fi
  case " ${SKIPS} " in *" ${s} "*) return 1 ;; esac
  return 0
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
C_G=""; C_Y=""; C_R=""; C_D=""; C_B=""; C_0=""
setup_colors() {
  if [ "${JSON}" = "0" ] && [ "${NO_COLOR_OPT}" = "0" ] && [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
    C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[1;31m'; C_D=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
  fi
}

N_PASS=0; N_WARN=0; N_FAIL=0; N_SKIP=0
R_N=0
R_SEC=(); R_ID=(); R_ST=(); R_MSG=(); R_HINT=()
CUR_SEC=""; CUR_TITLE=""; SEC_PRINTED=0

sec() {
  CUR_SEC="$1"; CUR_TITLE="$(L "$3" "$2")"; SEC_PRINTED=0
  if [ "${JSON}" = "0" ] && [ "${QUIET}" = "0" ]; then sec_header; fi
}
sec_header() { printf '\n%s== %s (%s) ==%s\n' "${C_B}" "${CUR_TITLE}" "${CUR_SEC}" "${C_0}"; SEC_PRINTED=1; }

# clean_text VAR STRING — STRING made safe for a terminal and for JSON, into
# VAR: only valid UTF-8 remains; C0 controls (ESC, CR, LF …), DEL, C1 controls
# (U+0080–U+009F), bidi / line-separator format characters and bytes that are
# not UTF-8 become '?', a tab a space. Everything check.sh prints passes
# through it (.env values, file names, nginx names and the health body can
# carry escape sequences that would rewrite the operator's terminal). Pure
# bash, no fork; LC_ALL=C makes ${s:i:1} one byte.
clean_text() {
  local _ct_s="$2" _ct_o="" _ct_p="" _ct_n=0 _ct_lo=128 _ct_hi=191 _ct_ok=1 _ct_b=0 _ct_b1=0 _ct_b2=0 _ct_b3=0
  while [ -n "${_ct_s}" ]; do
    _ct_p="${_ct_s%%[!\ -~]*}"                       # the longest printable-ASCII prefix
    _ct_o="${_ct_o}${_ct_p}"; _ct_s="${_ct_s:${#_ct_p}}"
    [ -n "${_ct_s}" ] || break
    printf -v _ct_b '%d' "'${_ct_s:0:1}"; [ "${_ct_b}" -lt 0 ] && _ct_b=$((_ct_b + 256))   # bash 3.2: signed char
    if [ "${_ct_b}" -lt 128 ]; then                  # C0 control or DEL
      if [ "${_ct_b}" = 9 ]; then _ct_o="${_ct_o} "; else _ct_o="${_ct_o}?"; fi
      _ct_s="${_ct_s:1}"; continue
    fi
    _ct_n=0; _ct_lo=128; _ct_hi=191
    if [ "${_ct_b}" -ge 194 ] && [ "${_ct_b}" -le 223 ]; then _ct_n=1
    elif [ "${_ct_b}" = 224 ]; then _ct_n=2; _ct_lo=160
    elif [ "${_ct_b}" = 237 ]; then _ct_n=2; _ct_hi=159
    elif [ "${_ct_b}" -ge 225 ] && [ "${_ct_b}" -le 239 ]; then _ct_n=2
    elif [ "${_ct_b}" = 240 ]; then _ct_n=3; _ct_lo=144
    elif [ "${_ct_b}" -ge 241 ] && [ "${_ct_b}" -le 243 ]; then _ct_n=3
    elif [ "${_ct_b}" = 244 ]; then _ct_n=3; _ct_hi=143
    fi
    _ct_ok=1
    if [ "${_ct_n}" = 0 ] || [ "${#_ct_s}" -le "${_ct_n}" ]; then _ct_ok=0
    else
      printf -v _ct_b1 '%d' "'${_ct_s:1:1}"; [ "${_ct_b1}" -lt 0 ] && _ct_b1=$((_ct_b1 + 256))
      { [ "${_ct_b1}" -ge "${_ct_lo}" ] && [ "${_ct_b1}" -le "${_ct_hi}" ]; } || _ct_ok=0
      _ct_b2=0; _ct_b3=0
      if [ "${_ct_ok}" = 1 ] && [ "${_ct_n}" -ge 2 ]; then
        printf -v _ct_b2 '%d' "'${_ct_s:2:1}"; [ "${_ct_b2}" -lt 0 ] && _ct_b2=$((_ct_b2 + 256))
        { [ "${_ct_b2}" -ge 128 ] && [ "${_ct_b2}" -le 191 ]; } || _ct_ok=0
      fi
      if [ "${_ct_ok}" = 1 ] && [ "${_ct_n}" = 3 ]; then
        printf -v _ct_b3 '%d' "'${_ct_s:3:1}"; [ "${_ct_b3}" -lt 0 ] && _ct_b3=$((_ct_b3 + 256))
        { [ "${_ct_b3}" -ge 128 ] && [ "${_ct_b3}" -le 191 ]; } || _ct_ok=0
      fi
    fi
    if [ "${_ct_ok}" = 0 ]; then _ct_o="${_ct_o}?"; _ct_s="${_ct_s:1}"; continue; fi
    # C1 controls (C2 80–9F); U+061C, U+200E/F, U+2028/9, U+202A–E, U+2066–9 (bidi, line separators)
    if { [ "${_ct_b}" = 194 ] && [ "${_ct_b1}" -le 159 ]; } || { [ "${_ct_b}" = 216 ] && [ "${_ct_b1}" = 156 ]; } \
      || { [ "${_ct_b}" = 226 ] && [ "${_ct_b1}" = 128 ] && { [ "${_ct_b2}" = 142 ] || [ "${_ct_b2}" = 143 ] || { [ "${_ct_b2}" -ge 168 ] && [ "${_ct_b2}" -le 174 ]; }; }; } \
      || { [ "${_ct_b}" = 226 ] && [ "${_ct_b1}" = 129 ] && [ "${_ct_b2}" -ge 166 ] && [ "${_ct_b2}" -le 169 ]; }; then
      _ct_o="${_ct_o}?"
    else
      _ct_o="${_ct_o}${_ct_s:0:$((_ct_n + 1))}"
    fi
    _ct_s="${_ct_s:$((_ct_n + 1))}"
  done
  printf -v "$1" '%s' "${_ct_o}"
}

# res STATUS ID MESSAGE [HINT]
res() {
  local st="$1" id="$2" msg="" hint="" col=""
  clean_text msg "$3"; clean_text hint "${4:-}"
  R_SEC[R_N]="${CUR_SEC}"; R_ID[R_N]="${id}"; R_ST[R_N]="${st}"; R_MSG[R_N]="${msg}"; R_HINT[R_N]="${hint}"
  R_N=$((R_N+1))
  case "${st}" in
    PASS) N_PASS=$((N_PASS+1)); col="${C_G}" ;;
    WARN) N_WARN=$((N_WARN+1)); col="${C_Y}" ;;
    FAIL) N_FAIL=$((N_FAIL+1)); col="${C_R}" ;;
    *)    N_SKIP=$((N_SKIP+1)); col="${C_D}" ;;
  esac
  [ "${JSON}" = "1" ] && return 0
  if [ "${QUIET}" = "1" ]; then case "${st}" in WARN|FAIL) ;; *) return 0 ;; esac; fi
  [ "${SEC_PRINTED}" = "1" ] || sec_header
  printf '  %s%-4s%s  %s\n' "${col}" "${st}" "${C_0}" "${msg}"
  if [ -n "${hint}" ]; then case "${st}" in WARN|FAIL) printf '        %s→ %s%s\n' "${C_D}" "${hint}" "${C_0}" ;; esac; fi
  return 0
}
pass() { res PASS "$@"; }
warn() { res WARN "$@"; }
fail() { res FAIL "$@"; }
skip() { res SKIP "$@"; }
need_root() { skip "$1" "$2 — $(L 'needs root' 'vyžaduje root')"; }

# json_esc VAR STRING — a JSON string body into VAR: valid UTF-8 without
# control characters (clean_text), then \ and " escaped.
json_esc() {
  local _je_s=""
  clean_text _je_s "$2"
  _je_s="${_je_s//\\/\\\\}"; _je_s="${_je_s//\"/\\\"}"
  printf -v "$1" '%s' "${_je_s}"
}

json_report() {
  local i="" last=$((R_N-1)) rc="$1" jr="" jh="" jm="" jt=""
  json_esc jr "${ROOT}"; json_esc jh "$(hostname 2>/dev/null || echo '?')"
  printf '{"tool":"m5cet-check","version":"%s","root":"%s","lang":"%s","host":"%s","time":"%s","exit":%s,\n' \
    "${CHECK_VERSION}" "${jr}" "${LANG_SEL}" "${jh}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${rc}"
  printf '"summary":{"pass":%d,"warn":%d,"fail":%d,"skip":%d},\n"checks":[\n' "${N_PASS}" "${N_WARN}" "${N_FAIL}" "${N_SKIP}"
  i=0
  while [ "${i}" -lt "${R_N}" ]; do
    json_esc jm "${R_MSG[i]}"; json_esc jt "${R_HINT[i]}"
    printf '{"section":"%s","id":"%s","status":"%s","message":"%s","hint":"%s"}' \
      "${R_SEC[i]}" "${R_ID[i]}" "${R_ST[i]}" "${jm}" "${jt}"
    if [ "${i}" -lt "${last}" ]; then printf ',\n'; else printf '\n'; fi
    i=$((i+1))
  done
  printf ']}\n'
}

summary() {
  local rc="$1" s="" i="" f="" w="" line=""
  [ "${JSON}" = "1" ] && return 0
  printf '\n%s%s:%s %s%d PASS%s, %s%d WARN%s, %s%d FAIL%s, %d SKIP\n' "${C_B}" "$(L 'Summary' 'Souhrn')" "${C_0}" \
    "${C_G}" "${N_PASS}" "${C_0}" "${C_Y}" "${N_WARN}" "${C_0}" "${C_R}" "${N_FAIL}" "${C_0}" "${N_SKIP}"
  for s in ${SECTIONS_ALL}; do
    f=0; w=0; i=0
    while [ "${i}" -lt "${R_N}" ]; do
      if [ "${R_SEC[i]}" = "${s}" ]; then
        case "${R_ST[i]}" in FAIL) f=$((f+1)) ;; WARN) w=$((w+1)) ;; esac
      fi
      i=$((i+1))
    done
    if [ "${f}" -gt 0 ] || [ "${w}" -gt 0 ]; then line="${line}  ${s}: ${f} FAIL / ${w} WARN"$'\n'; fi
  done
  [ -n "${line}" ] && printf '%s' "${line}"
  if [ "${rc}" = "0" ]; then
    printf '%s%s%s\n' "${C_G}" "$(L 'No FAIL.' 'Žádný FAIL.')" "${C_0}"
  else
    printf '%s%s%s\n' "${C_R}" "$(L 'At least one check FAILed — see the → hints above.' 'Aspoň jedna kontrola selhala (FAIL) — viz rady → výše.')" "${C_0}"
  fi
  if ! is_root; then printf '%s%s%s\n' "${C_D}" "$(L 'Not run as root: some checks were skipped.' 'Neběží jako root: některé kontroly byly přeskočeny.')" "${C_0}"; fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
have() {
  case " ${M5CHECK_ABSENT:-} " in *" $1 "*) return 1 ;; esac
  command -v "$1" >/dev/null 2>&1
}
is_root() { [ "${M5CHECK_UID:-$(id -u 2>/dev/null || echo 1)}" = "0" ]; }
now_s() { printf '%s' "${M5CHECK_NOW:-$(date +%s)}"; }

# to SECONDS CMD… — with a time limit when timeout(1) exists.
to() {
  local s="$1"; shift
  if have timeout; then timeout "${s}" "$@"
  elif have gtimeout; then gtimeout "${s}" "$@"
  else "$@"; fi
}

sp() { printf '%s%s' "${SYSROOT}" "$1"; }                       # a path on the checked system
rd() { local f; f="$(sp "$1")"; [ -r "${f}" ] && head -n1 "${f}" 2>/dev/null | tr -d '\r'; }
sysctl_v() { rd "/proc/sys/$(printf '%s' "$1" | tr '.' '/')"; }

STAT_GNU=0
if stat -c %a / >/dev/null 2>&1; then STAT_GNU=1; fi
f_mode()  { if [ "${STAT_GNU}" = "1" ]; then stat -c %a "$1" 2>/dev/null; else stat -f %Lp "$1" 2>/dev/null; fi; }
f_owner() { if [ "${STAT_GNU}" = "1" ]; then stat -c %U "$1" 2>/dev/null; else stat -f %Su "$1" 2>/dev/null; fi; }
f_uid()   { if [ "${STAT_GNU}" = "1" ]; then stat -c %u "$1" 2>/dev/null; else stat -f %u "$1" 2>/dev/null; fi; }
f_group() { if [ "${STAT_GNU}" = "1" ]; then stat -c %G "$1" 2>/dev/null; else stat -f %Sg "$1" 2>/dev/null; fi; }
f_mtime() { if [ "${STAT_GNU}" = "1" ]; then stat -c %Y "$1" 2>/dev/null; else stat -f %m "$1" 2>/dev/null; fi; }
# Last three octal digits: u g o.
mode3() { local m; m="$(f_mode "$1")"; m="000${m}"; printf '%s' "${m: -3}"; }
other_bits() { local m; m="$(mode3 "$1")"; printf '%s' "${m:2:1}"; }
group_bits() { local m; m="$(mode3 "$1")"; printf '%s' "${m:1:1}"; }

is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; return 0; }
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
first_line() { printf '%s\n' "$1" | head -n1; }
# join_lines TEXT [MAX] — "a, b, c (+N)".
join_lines() {
  local max="${2:-5}"
  printf '%s\n' "$1" | awk -v max="${max}" 'NF { n++; if (n <= max) out = out (n > 1 ? ", " : "") $0 } END { if (n > max) out = out " (+" (n - max) ")"; print out }'
}
count_lines() { printf '%s\n' "$1" | awk 'NF { n++ } END { print n + 0 }'; }

is_loopback() { case "$1" in 127.*|::1|"[::1]"|localhost|::ffff:127.*|"[::ffff:127."*) return 0 ;; esac; return 1; }
is_wildcard() { case "$1" in 0.0.0.0|"*"|::|"[::]"|"") return 0 ;; esac; return 1; }
is_private_ip() {
  case "$1" in
    10.*|192.168.*|127.*|169.254.*|fc*|fd*|fe80:*|::1) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}
# url_parts URL — UP_SCHEME (as written, may be empty); UP_AT: 0 no userinfo,
# 1 a userinfo (user:password@) before the host, 2 an '@' only after the
# authority (a password with '/', '?' or '#' in it, or an '@' in the path /
# query — the host cannot be told apart from the password); UP_HP host[:port]
# (after the last '@'), UP_HOST (no brackets), UP_PORT (digits or empty),
# UP_PATH (no query / fragment; empty when UP_AT is 2).
UP_SCHEME=""; UP_AT=0; UP_HP=""; UP_HOST=""; UP_PORT=""; UP_PATH=""
url_parts() {
  local u="$1" rest="" auth="" p=""
  UP_SCHEME=""; UP_AT=0; UP_HP=""; UP_HOST=""; UP_PORT=""; UP_PATH=""
  case "${u}" in [A-Za-z]*://*) UP_SCHEME="${u%%://*}" ;; esac
  case "${UP_SCHEME}" in *[!A-Za-z0-9+.-]*) UP_SCHEME="" ;; esac
  if [ -n "${UP_SCHEME}" ]; then rest="${u#*://}"; else rest="${u}"; fi
  auth="${rest%%[/?#]*}"
  case "${auth}" in
    *@*) UP_AT=1; UP_HP="${auth##*@}"; UP_PATH="${rest:${#auth}}" ;;
    *) case "${rest}" in
         *@*) UP_AT=2; UP_HP="${rest##*@}"; UP_HP="${UP_HP%%[/?#]*}" ;;
         *) UP_HP="${auth}"; UP_PATH="${rest:${#auth}}" ;;
       esac ;;
  esac
  UP_PATH="${UP_PATH%%[?#]*}"
  case "${UP_HP}" in
    \[*\]) UP_HOST="${UP_HP#\[}"; UP_HOST="${UP_HOST%\]}" ;;
    \[*\]:*) UP_HOST="${UP_HP#\[}"; UP_HOST="${UP_HOST%%\]*}"; UP_PORT="${UP_HP##*\]:}" ;;
    *:*) p="${UP_HP##*:}"; if is_uint "${p}"; then UP_HOST="${UP_HP%:*}"; UP_PORT="${p}"; else UP_HOST="${UP_HP}"; fi ;;
    *) UP_HOST="${UP_HP}" ;;
  esac
}
# url_host URL — host part (no userinfo, no port); url_port URL DEFAULT.
url_host() { url_parts "$1"; printf '%s' "${UP_HOST}"; }
url_port() { url_parts "$1"; if [ -n "${UP_PORT}" ]; then printf '%s' "${UP_PORT}"; else printf '%s' "$2"; fi; }
url_scheme() { printf '%s' "$1" | sed -nE 's#^([a-zA-Z][a-zA-Z0-9+.-]*)://.*#\1#p' | tr '[:upper:]' '[:lower:]'; }

# valid_host HOST — a DNS name or IPv4 address ([A-Za-z0-9.-], not starting
# with '-' or '.') or an IPv6 literal without brackets (hex digits, ':', '.',
# at least two ':'): nothing a shell or a tool could read as syntax or as an
# option. valid_port PORT — 1–65535.
valid_host() {
  case "$1" in
    ''|-*|.*) return 1 ;;
    *[!A-Za-z0-9.:-]*) return 1 ;;
    *:*:*) case "$1" in *[!0-9A-Fa-f:.]*) return 1 ;; esac ;;
    *:*) return 1 ;;
  esac
  [ "${#1}" -le 253 ]
}
valid_port() { is_uint "$1" && [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# safe_url URL [path] — the URL for messages, never with its userinfo
# (REDIS_URL, DATABASE_URL, TURN … carry user:password), query or fragment:
# scheme://***@host:port with a userinfo, scheme://*** when the host cannot be
# told apart from the password or is not a plain host, scheme://host:port
# otherwise (with "path" also the path: PUBLIC_BASE_URL).
safe_url() {
  local pre=""
  url_parts "$1"
  [ -n "${UP_SCHEME}" ] && pre="$(lc "${UP_SCHEME}")://"
  if [ "${UP_AT}" = "2" ] || ! valid_host "${UP_HOST}" || { [ -n "${UP_PORT}" ] && ! valid_port "${UP_PORT}"; }; then
    printf '%s***' "${pre}"; return 0
  fi
  if [ "${UP_AT}" = "1" ]; then printf '%s***@%s' "${pre}" "${UP_HP}"; return 0; fi
  if [ "${2:-}" = "path" ]; then printf '%s%s%s' "${pre}" "${UP_HP}" "${UP_PATH}"; else printf '%s%s' "${pre}" "${UP_HP}"; fi
}

# tcp_probe SECONDS HOST PORT — 0 when a TCP connection opens. HOST and PORT
# are validated and reach bash's /dev/tcp as positional parameters of a fixed
# script — never as shell text (C01: .env values were run as root). 2: invalid.
tcp_probe() {
  valid_host "$2" && valid_port "$3" || return 2
  to "$1" "${BASH:-bash}" -c 'exec 3<>"/dev/tcp/$1/$2"' tcp_probe "$2" "$3" 2>/dev/null
}

# kv_parse LINE — KV_K / KV_V from KEY=VALUE (installer syntax), 1 for anything else.
KV_K=""; KV_V=""
kv_parse() {
  local line="$1" v=""
  line="${line#"${line%%[![:space:]]*}"}"
  case "${line}" in ''|'#'*) return 1 ;; esac
  line="${line#export }"
  case "${line}" in *=*) ;; *) return 1 ;; esac
  KV_K="${line%%=*}"
  KV_K="${KV_K%"${KV_K##*[![:space:]]}"}"
  case "${KV_K}" in ''|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;; esac
  v="${line#*=}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "${v}" in
    \"*\") v="${v#\"}"; v="${v%\"}"; v="${v//\\\"/\"}"; v="${v//\\\\/\\}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    *) case "${v}" in *" #"*) v="${v%% #*}" ;; esac ;;
  esac
  KV_V="${v}"
  return 0
}

CONF_KEYS="INSTALL_MODE SCOPE SERVICE_NAME SERVICE_MANAGER SERVICE_USER SOURCE APP_PORT BIND_ADDRESS DOMAIN ENABLE_NGINX ENABLE_TLS FIREWALL_OPEN ENABLE_ADMIN ADMIN_PORT ENABLE_PUSH KEEP_NODE_MODULES BACKUP_ROOT BACKUP_KEEP INSTALLED_VERSION INSTALLED_COMMIT NGINX_SITE_PATH UNIT_FILES FIREWALL_RULES INSTALL_STATUS"
load_conf() {
  local line=""
  while IFS= read -r line || [ -n "${line}" ]; do
    kv_parse "${line}" || continue
    case " ${CONF_KEYS} " in *" ${KV_K} "*) printf -v "CF_${KV_K}" '%s' "${KV_V}" ;; esac
  done < "$1"
}
cf() { local n="CF_$1"; printf '%s' "${!n-}"; }

ENV_SEEN=" "; ENV_DUPS=""; ENV_BAD=0
load_env() {
  local line=""
  while IFS= read -r line || [ -n "${line}" ]; do
    if kv_parse "${line}"; then
      case "${ENV_SEEN}" in *" ${KV_K} "*) ENV_DUPS="${ENV_DUPS} ${KV_K}" ;; esac
      ENV_SEEN="${ENV_SEEN}${KV_K} "
      printf -v "E_${KV_K}" '%s' "${KV_V}"
    else
      case "${line}" in ''|[[:space:]]*'#'*|'#'*) ;; *[![:space:]]*) ENV_BAD=$((ENV_BAD+1)) ;; esac
    fi
  done < "$1"
}
ev() { local n="E_$1"; printf '%s' "${!n-}"; }
ev_or() { local v; v="$(ev "$1")"; printf '%s' "${v:-$2}"; }
ev_set() { case "${ENV_SEEN}" in *" $1 "*) return 0 ;; esac; return 1; }
is_on() { case "$(lc "$1")" in 1|true|yes|on) return 0 ;; esac; return 1; }

# running NAME — a process with exactly this name runs.
running() {
  if have pgrep; then pgrep -x "$1" >/dev/null 2>&1; return $?; fi
  ps -A -o comm= 2>/dev/null | awk -v n="$1" '{ sub(/^.*\//, ""); if ($0 == n) f = 1 } END { exit !f }'
}

# valid_user NAME — a plain account name ([A-Za-z_][A-Za-z0-9._-]*, '$' only
# last, ≤ 32): never an option, a pattern or shell syntax.
valid_user() {
  local n="${1%\$}"   # one trailing '$' (a machine account) is allowed
  case "${n}" in ''|[!A-Za-z_]*|*[!A-Za-z0-9._-]*) return 1 ;; esac
  [ "${#1}" -le 32 ]
}
# pw_entry NAME — the passwd line of exactly NAME (no regular expression).
pw_entry() {
  valid_user "$1" || return 0
  if [ -z "${SYSROOT}" ] && have getent; then getent passwd "$1" 2>/dev/null
  else awk -F: -v u="$1" '$1 == u { print; exit }' "$(sp /etc/passwd)" 2>/dev/null; fi
}
user_groups() {
  valid_user "$1" || return 0
  if [ -z "${SYSROOT}" ] && have id; then id -nG "$1" 2>/dev/null
  else awk -F: -v u="$1" '{ n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] == u) printf "%s ", $1 }' "$(sp /etc/group)" 2>/dev/null; fi
}

# switch_tool — the first of runuser / setpriv / sudo on this host.
switch_tool() { if have runuser; then printf 'runuser'; elif have setpriv; then printf 'setpriv'; elif have sudo; then printf 'sudo'; fi; }

# as_user USER GROUP SECONDS CMD… — CMD (fixed argv, no shell) with a time
# limit as USER; for root only. 126: no runuser / setpriv / sudo.
as_user() {
  local u="$1" g="$2" s="$3"; shift 3
  local -a pre
  pre=()
  if have timeout; then pre=(timeout "${s}"); elif have gtimeout; then pre=(gtimeout "${s}"); fi
  case "$(switch_tool)" in
    runuser) runuser -u "${u}" -- ${pre[@]+"${pre[@]}"} "$@" ;;
    setpriv) setpriv --reuid "${u}" --regid "${g}" --init-groups -- ${pre[@]+"${pre[@]}"} "$@" ;;
    sudo) sudo -n -u "${u}" -- ${pre[@]+"${pre[@]}"} "$@" ;;
    *) return 126 ;;
  esac
}

# DROP_USER / DROP_GROUP — who runs code from the install tree when check.sh
# runs as root: the service user, else the owner of the tree; never root or
# another uid 0, never a name that is not a plain account name. Empty when no
# such user is known — then those checks SKIP (C02).
DROP_USER=""; DROP_GROUP=""
# user_uid NAME — the uid NAME resolves to (passwd, else id -u), or nothing.
user_uid() {
  local u=""
  valid_user "$1" || return 0
  u="$(pw_entry "$1" | cut -d: -f3)"
  [ -n "${u}" ] || u="$(id -u "$1" 2>/dev/null)"
  is_uint "${u}" && printf '%s' "${u}"
}
# owner_name PATH — the owner of PATH as an account name that resolves back to
# the file's uid (never stat's UNKNOWN / a bare number), or nothing.
owner_name() {
  local n="" fu=""
  n="$(f_owner "$1")"; fu="$(f_uid "$1")"
  [ -n "${fu}" ] && [ "$(user_uid "${n}")" = "${fu}" ] && printf '%s' "${n}"
}
pick_drop_user() {
  local c="" pw="" uid="" gid="" owner=""
  DROP_USER=""; DROP_GROUP=""
  owner="$(owner_name "${ROOT}")"
  for c in "${SVC_USER}" "${owner}"; do
    valid_user "${c}" && [ "${c}" != "root" ] || continue
    pw="$(pw_entry "${c}")"; uid=""; gid=""
    if [ -n "${pw}" ]; then uid="$(printf '%s' "${pw}" | cut -d: -f3)"; gid="$(printf '%s' "${pw}" | cut -d: -f4)"; fi
    if [ "${c}" = "${owner}" ] && [ -z "${uid}" ]; then uid="$(f_uid "${ROOT}")"; fi
    [ "${uid}" = "0" ] && continue
    DROP_USER="${c}"; DROP_GROUP="${gid:-${c}}"
    return 0
  done
  return 0
}

# run_as SECONDS CMD… — with a time limit; when we are root as DROP_USER (code
# from the install tree never runs as root), else as ourselves. 126: root
# without a non-root user to switch to, or without runuser / setpriv / sudo —
# CMD did not run.
run_as() {
  local s="$1"; shift
  if is_root; then
    [ -n "${DROP_USER}" ] || return 126
    as_user "${DROP_USER}" "${DROP_GROUP}" "${s}" "$@"
    return $?
  fi
  to "${s}" "$@"
}

# tree_code_ok ID WHAT — 0 when code from the install tree may run now: not
# root, or root with a non-root user to run it as and a tool to switch;
# otherwise a SKIP for ID saying why (it is never run as root).
tree_code_ok() {
  is_root || return 0
  if [ -z "${DROP_USER}" ]; then
    skip "$1" "$(L "$2: no non-root service user (SERVICE_USER, owner of the tree) — code from the tree is not run as root" "$2: chybí uživatel služby jiný než root (SERVICE_USER, vlastník stromu) — kód ze stromu jako root nespouštím")"
    return 1
  fi
  if [ -z "$(switch_tool)" ]; then
    skip "$1" "$(L "$2: cannot switch to ${DROP_USER} (no runuser / setpriv / sudo) — code from the tree is not run as root" "$2: nelze přepnout na ${DROP_USER} (chybí runuser / setpriv / sudo) — kód ze stromu jako root nespouštím")"
    return 1
  fi
  return 0
}

ONLINE_STATE=""
online() {
  [ "${OFFLINE}" = "1" ] && return 1
  if [ -z "${ONLINE_STATE}" ]; then
    ONLINE_STATE="no"
    if have curl; then
      local code=""
      code="$(to 10 curl -s -o /dev/null -m 8 -w '%{http_code}' https://registry.npmjs.org/ 2>/dev/null || true)"
      case "${code}" in ''|000) ;; *) ONLINE_STATE="yes" ;; esac
    fi
  fi
  [ "${ONLINE_STATE}" = "yes" ]
}

# http_get URL [MAX_TIME] — HG_CODE (000 = nothing answered) and HG_BODY.
HG_CODE=""; HG_BODY=""
http_get() {
  local url="$1" t="${2:-4}" out=""
  HG_CODE="000"; HG_BODY=""
  if have curl; then
    out="$(curl -s -m "${t}" -w '\n%{http_code}' "${url}" 2>/dev/null || true)"
    HG_CODE="$(printf '%s' "${out}" | tail -n1)"
    HG_BODY="$(printf '%s' "${out}" | sed '$d' | head -c 4096)"
    [ -n "${HG_CODE}" ] || HG_CODE="000"
    return 0
  fi
  return 1
}

# Listening sockets: "proto<TAB>addr<TAB>port<TAB>process" in ${TMPD}/listen.
LISTEN_DONE=0
collect_listen() {
  [ "${LISTEN_DONE}" = "1" ] && return 0
  LISTEN_DONE=1
  : > "${TMPD}/listen"
  if have ss; then
    ss -lntup 2>/dev/null | awk 'NR == 1 && $1 == "Netid" { next }
      { proto = $1; local = $5; proc = ""
        for (i = 7; i <= NF; i++) proc = proc $i
        if (match(proc, /\(\("[^"]+"/)) proc = substr(proc, RSTART + 3, RLENGTH - 4); else proc = ""
        port = local; sub(/^.*:/, "", port); addr = local; sub(/:[^:]*$/, "", addr); sub(/%.*$/, "", addr)
        gsub(/^\[|\]$/, "", addr)
        print proto "\t" addr "\t" port "\t" proc }' > "${TMPD}/listen"
  elif have lsof; then
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { n = $9; port = n; sub(/^.*:/, "", port); addr = n; sub(/:[^:]*$/, "", addr); gsub(/^\[|\]$/, "", addr); print "tcp\t" addr "\t" port "\t" $1 }' > "${TMPD}/listen"
    lsof -nP -iUDP 2>/dev/null | awk 'NR > 1 { n = $9; if (n ~ /->/) next; port = n; sub(/^.*:/, "", port); addr = n; sub(/:[^:]*$/, "", addr); gsub(/^\[|\]$/, "", addr); print "udp\t" addr "\t" port "\t" $1 }' >> "${TMPD}/listen"
  fi
}
# listen_addrs PORT [tcp|udp] — one address per line.
listen_addrs() { collect_listen; awk -F'\t' -v p="$1" -v pr="${2:-tcp}" '$3 == p && index($1, pr) == 1 { print $2 }' "${TMPD}/listen" | sort -u; }
listen_procs() { collect_listen; awk -F'\t' -v p="$1" '$3 == p && $4 != "" { print $4 }' "${TMPD}/listen" | sort -u; }
listen_public() {   # PORT [proto] — 0 when bound to something other than loopback
  local a=""
  for a in $(listen_addrs "$1" "${2:-tcp}"); do is_loopback "${a}" || return 0; done
  return 1
}

sha256_tool() {
  if have sha256sum; then printf 'sha256sum'
  elif have shasum; then printf 'shasum -a 256'
  elif have openssl; then printf 'openssl dgst -sha256 -r'
  fi
}

# OpenSSL major version; 0 for LibreSSL (no `pkeyutl -rawin` for Ed25519).
openssl_major() { openssl version 2>/dev/null | awk '$1 == "OpenSSL" { split($2, v, "."); print v[1] + 0; f = 1; exit } END { if (!f) print 0 }'; }

# ---------------------------------------------------------------------------
# Context: where is the install, how was it made
# ---------------------------------------------------------------------------
INSTALLED=0; TREE=0; IS_LINUX=0; SVC_USER=""; MODE=""; MANAGER=""; SERVICE=""
APP_PORT=""; ADMIN_PORT=""; BIND=""; DOMAIN=""; ENV_FILE=""; ENV_READABLE=0
DATA_BASE=""; STORAGE_DIR=""; ADMIN_ON=0; PKG_VERSION=""

# root_only PATH… — 0 when every PATH exists, is no symlink, belongs to root
# and nobody else can write it.
root_only() {
  local p=""
  for p in "$@"; do
    [ -e "${p}" ] && [ ! -L "${p}" ] && [ "$(f_uid "${p}")" = "0" ] || return 1
    case "$(group_bits "${p}")$(other_bits "${p}")" in *[2367]*) return 1 ;; esac
  done
  return 0
}

# The tree to check: --root, else the directory check.sh lives in (when it is
# an install), else the installer's pointer, else /opt/m5cet. As root only the
# system pointer /etc/m5cet/install-dir counts, and only when root owns it and
# nobody else can write it — a user's ~/.config pointer (followed under
# sudo -E) must not pick the tree root inspects (C09).
pick_root() {
  local self="" dir="" cand="" ptr=""
  local -a ptrs
  if [ -n "${ROOT}" ]; then ROOT="${ROOT%/}"; [ -n "${ROOT}" ] || ROOT="/"; return 0; fi
  self="${BASH_SOURCE[0]:-$0}"
  dir="$(cd "$(dirname "${self}")" 2>/dev/null && pwd)"
  if [ -n "${dir}" ] && [ -f "${dir}/.m5cet/install.conf" ]; then ROOT="${dir}"; return 0; fi
  ptrs=(/etc/m5cet/install-dir)
  is_root || ptrs+=("${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/m5cet/install-dir")
  for ptr in "${ptrs[@]}"; do
    [ -r "${ptr}" ] || continue
    if is_root && ! root_only "${ptr}" "$(dirname "${ptr}")"; then continue; fi
    cand="$(head -n1 "${ptr}" 2>/dev/null)"
    case "${cand}" in /*) ;; *) continue ;; esac
    if [ -f "${cand}/.m5cet/install.conf" ]; then ROOT="${cand%/}"; return 0; fi
  done
  if [ -f /opt/m5cet/.m5cet/install.conf ]; then ROOT="/opt/m5cet"; return 0; fi
  ROOT="${dir:-/opt/m5cet}"
}

# env_path NAME — a path from .env as the app resolves it (relative to the
# install root, its working directory): never a word that a tool would read
# as an option.
env_path() {
  local v; v="$(ev "$1")"
  case "${v}" in '') ;; /*) printf '%s' "${v}" ;; *) printf '%s/%s' "${ROOT}" "${v}" ;; esac
}
# conf_path NAME — the same for a path from install.conf.
conf_path() {
  local v; v="$(cf "$1")"
  case "${v}" in '') ;; /*) printf '%s' "${v}" ;; *) printf '%s/%s' "${ROOT}" "${v}" ;; esac
}

init_context() {
  if [ -n "${SYSROOT}" ]; then [ -d "${SYSROOT}/proc" ] && IS_LINUX=1
  elif [ "$(uname -s 2>/dev/null)" = "Linux" ]; then IS_LINUX=1; fi

  if [ -f "${ROOT}/package.json" ] && grep -q '"name":[[:space:]]*"cipherroom-secure-chat"' "${ROOT}/package.json" 2>/dev/null; then
    TREE=1
    PKG_VERSION="$(json_str "${ROOT}/package.json" version)"
  fi
  if [ -f "${ROOT}/.m5cet/install.conf" ]; then
    INSTALLED=1
    if [ -r "${ROOT}/.m5cet/install.conf" ]; then load_conf "${ROOT}/.m5cet/install.conf"; fi
  fi
  MODE="$(cf INSTALL_MODE)"
  MANAGER="$(cf SERVICE_MANAGER)"
  SERVICE="$(cf SERVICE_NAME)"
  # A unit / container name, never an option for systemctl or docker.
  case "${SERVICE}" in ''|[!A-Za-z0-9_]*|*[!A-Za-z0-9_.@-]*) SERVICE="m5cet" ;; esac
  APP_PORT="$(cf APP_PORT)"; [ -n "${APP_PORT}" ] || APP_PORT="5000"
  ADMIN_PORT="$(cf ADMIN_PORT)"; [ -n "${ADMIN_PORT}" ] || ADMIN_PORT="5050"
  BIND="$(cf BIND_ADDRESS)"; [ -n "${BIND}" ] || BIND="127.0.0.1"
  ENV_FILE="${ROOT}/.env"
  if [ -r "${ENV_FILE}" ]; then ENV_READABLE=1; load_env "${ENV_FILE}"; fi
  # The installer derives these into .env; the conf is the fallback.
  if [ "${MODE}" != "docker" ] && is_uint "$(ev PORT)"; then APP_PORT="$(ev PORT)"; fi
  if is_uint "$(ev ADMIN_PORT)"; then ADMIN_PORT="$(ev ADMIN_PORT)"; fi
  if is_on "$(cf ENABLE_ADMIN)" || is_on "$(ev ENABLE_ADMIN)"; then ADMIN_ON=1; fi
  DOMAIN="$(cf DOMAIN)"
  if [ -z "${DOMAIN}" ] && [ -n "$(ev PUBLIC_BASE_URL)" ]; then DOMAIN="$(url_host "$(ev PUBLIC_BASE_URL)")"; fi
  case "${MANAGER}" in
    systemd) SVC_USER="$(cf SERVICE_USER)"; [ -n "${SVC_USER}" ] || SVC_USER="m5cet" ;;
    process) SVC_USER="$(owner_name "${ROOT}")" ;;
  esac
  if is_root; then pick_drop_user; fi
  if [ -n "$(ev DATA_DIR)" ]; then DATA_BASE="$(env_path DATA_DIR)"
  elif [ "${MANAGER}" = "systemd" ]; then DATA_BASE="/var/lib/${SERVICE}"
  elif [ "${MODE}" != "docker" ]; then DATA_BASE="${ROOT}/.m5cet"; fi
  if [ -n "$(ev STORAGE_DIR)" ]; then STORAGE_DIR="$(env_path STORAGE_DIR)"
  elif [ -n "${DATA_BASE}" ]; then STORAGE_DIR="${DATA_BASE}/storage"; fi
}

# Is a reverse proxy expected in front of the app?
proxy_front() {
  [ -n "$(cf NGINX_SITE_PATH)" ] && return 0
  [ "$(cf ENABLE_NGINX)" = "1" ] && return 0
  [ "$(cf ENABLE_NGINX)" = "auto" ] && [ -n "$(cf DOMAIN)" ] && [ "$(cf SCOPE)" = "system" ] && return 0
  [ -n "$(listen_addrs 443)" ] && return 0
  return 1
}

probe_host() { if is_wildcard "${BIND}"; then printf '127.0.0.1'; else printf '%s' "${BIND}"; fi; }

# ===========================================================================
# package
# ===========================================================================

# Release manifest verification (bash only: nothing from the verified tree is
# executed). Sets VM_* for the caller.
VM_ERR=""; VM_NAME=""; VM_VERSION=""; VM_COMMIT=""; VM_COUNT=0
VM_MISSING=""; VM_MODIFIED=""; VM_UNREAD=""; VM_EXTRA=""; VM_EXTRA_EXEC=""; VM_WITH_DIST=0

# json_str FILE KEY — the first "KEY": "value" in a JSON file (any layout).
json_str() { grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null | head -n1 | sed 's/.*:[[:space:]]*"\([^"]*\)"$/\1/'; }
manifest_header() { json_str "$1" "$2"; }

# manifest_tsv MANIFEST — "path<TAB>sha256" per file, or return 1 (unknown layout).
manifest_tsv() {
  awk '
    /"files"[[:space:]]*:[[:space:]]*\[/ { infiles = 1; next }
    infiles && /^[[:space:]]*\][[:space:]]*$/ { infiles = 0; done = 1; next }
    infiles {
      if (match($0, /^[[:space:]]*\{"path": "[^"]*", "size": [0-9]+, "sha256": "[0-9a-f]+"\},?[[:space:]]*$/) == 0) { bad = 1; exit }
      line = $0
      sub(/^[[:space:]]*\{"path": "/, "", line); p = line; sub(/", "size".*$/, "", p)
      h = line; sub(/^.*"sha256": "/, "", h); sub(/".*$/, "", h)
      if (length(h) != 64) { bad = 1; exit }
      print p "\t" h
    }
    END { if (bad || !done) exit 1 }' "$1"
}

# find_tree DIR MODE — every file a manifest of MODE (release|web) covers, relative, one per line.
find_tree() {
  local dir="$1" mode="$2" d="" g=""
  local -a args
  (
    cd "${dir}" || exit 1
    if [ "${mode}" = "web" ]; then
      find . -type f ! -name 'release-web.json' ! -name 'release-web.json.sig' -print 2>/dev/null | sed 's#^\./##'
      exit 0
    fi
    args=( . "(" -path "./.git" )
    for d in ${M5_EXCL_ROOT_DIRS}; do
      [ "${VM_WITH_DIST}" = "1" ] && [ "${d}" = "dist" ] && continue
      args+=( -o -path "./${d}" )
    done
    for d in ${M5_EXCL_ANY_DIRS}; do
      if [ "${VM_WITH_DIST}" = "1" ] && [ "${d}" = "node_modules" ]; then args+=( -o "(" -name "${d}" ! -path "./dist/*" ")" )
      else args+=( -o -name "${d}" ); fi
    done
    args+=( ")" -prune -o -type f )
    for g in ${M5_EXCL_FILE_GLOBS}; do args+=( ! -name "${g}" ); done
    for g in ${M5_EXCL_ROOT_FILES}; do args+=( ! -path "./${g}" ); done
    args+=( -print )
    find "${args[@]}" 2>/dev/null | sed 's#^\./##'
  )
}

# verify_manifest MANIFEST DIR MODE
verify_manifest() {
  local m="$1" dir="$2" mode="$3" tool=""
  VM_ERR=""; VM_MISSING=""; VM_MODIFIED=""; VM_UNREAD=""; VM_EXTRA=""; VM_EXTRA_EXEC=""; VM_COUNT=0; VM_WITH_DIST=0
  VM_NAME="$(manifest_header "${m}" name)"; VM_VERSION="$(manifest_header "${m}" version)"; VM_COMMIT="$(manifest_header "${m}" commit)"
  if [ "$(manifest_header "${m}" format)" != "m5cet-release/1" ]; then VM_ERR="format"; return 1; fi
  if ! manifest_tsv "${m}" > "${TMPD}/vm.tsv" 2>/dev/null; then VM_ERR="layout"; return 1; fi
  VM_COUNT="$(awk 'END { print NR }' "${TMPD}/vm.tsv")"
  # Every listed path stays inside the tree (C10): relative, no '.' / '..'
  # component, no empty component, no leading '-' (an option for the hash tool).
  if awk -F'\t' '{ p = $1; if (p == "" || p ~ /^[\/-]/ || p ~ /\/\// || p ~ /\/$/ || p ~ /(^|\/)\.\.?(\/|$)/) { bad = 1; exit } } END { exit !bad }' "${TMPD}/vm.tsv"; then
    VM_ERR="path"; return 1
  fi
  if grep -q '^dist/' "${TMPD}/vm.tsv"; then VM_WITH_DIST=1; fi
  tool="$(sha256_tool)"
  [ -n "${tool}" ] || { VM_ERR="nohash"; return 1; }
  # The files really in the tree (find never follows a symlink, so a path
  # through a symlinked directory is not "in the tree"); listed ∩ tree is
  # hashed in one batch, the rest of the list is missing.
  find_tree "${dir}" "${mode}" | sort > "${TMPD}/vm.tree"
  cut -f1 "${TMPD}/vm.tsv" | sort > "${TMPD}/vm.listed"
  comm -12 "${TMPD}/vm.listed" "${TMPD}/vm.tree" | sed 's#^#./#' | tr '\n' '\0' > "${TMPD}/vm.present"
  VM_MISSING="$(comm -23 "${TMPD}/vm.listed" "${TMPD}/vm.tree")"
  # shellcheck disable=SC2086  # the tool name is a word list on purpose
  ( cd "${dir}" && xargs -0 ${tool} < "${TMPD}/vm.present" 2>/dev/null ) > "${TMPD}/vm.sums"
  # Fixed columns, no FS switching between the files (BWK awk applies a
  # command-line FS change only from the second record of the next file).
  VM_MODIFIED="$(awk 'NR == FNR { i = index($0, "\t"); want[substr($0, 1, i - 1)] = substr($0, i + 1); next }
    { h = substr($0, 1, 64); p = substr($0, 67); sub(/^\*/, "", p); sub(/^\.\//, "", p); got[p] = h }
    END { for (p in want) if ((p in got) && got[p] != want[p]) print p }' "${TMPD}/vm.tsv" "${TMPD}/vm.sums" | sort)"
  # Present but not hashed (unreadable): not verified — never a silent match.
  awk '{ p = substr($0, 67); sub(/^\*/, "", p); sub(/^\.\//, "", p); print p }' "${TMPD}/vm.sums" | sort > "${TMPD}/vm.hashed"
  VM_UNREAD="$(comm -12 "${TMPD}/vm.listed" "${TMPD}/vm.tree" | comm -23 - "${TMPD}/vm.hashed")"
  VM_EXTRA="$(comm -23 "${TMPD}/vm.tree" "${TMPD}/vm.listed")"
  if [ -n "${VM_EXTRA}" ]; then
    local x=""
    while IFS= read -r x; do
      [ -n "${x}" ] || continue
      if [ "${mode}" = "web" ]; then
        case "$(lc "${x}")" in *.html|*.htm|*.xhtml|*.js|*.mjs|*.cjs|*.wasm|*.svg|*.xml) VM_EXTRA_EXEC="${VM_EXTRA_EXEC}${x}"$'\n' ;; esac
      else
        case "$(lc "${x}")" in *.node|*.so|*.dylib|*.dll|*.exe) VM_EXTRA_EXEC="${VM_EXTRA_EXEC}${x}"$'\n'; continue ;; esac
        if [ -x "${dir}/${x}" ]; then VM_EXTRA_EXEC="${VM_EXTRA_EXEC}${x}"$'\n'; fi
      fi
    done <<EOF_EXTRA
${VM_EXTRA}
EOF_EXTRA
  fi
  return 0
}

# Ed25519 signature: SIG_STATE valid|invalid|nokey|notool, SIG_FP (SHA-256 of the raw key, hex).
SIG_STATE=""; SIG_FP=""
verify_sig() {
  local file="$1" sigf="$2" pubf="$3" raw="" pem="" sigbin=""
  SIG_STATE="nokey"; SIG_FP=""
  [ -r "${pubf}" ] || return 1
  raw="$(tr -d ' \r\n' < "${pubf}")"
  if have openssl; then
    printf '%s' "${raw}" | openssl base64 -d -A > "${TMPD}/pub.raw" 2>/dev/null
    if [ "$(wc -c < "${TMPD}/pub.raw" | tr -d ' ')" != "32" ]; then SIG_STATE="badkey"; return 1; fi
    SIG_FP="$(openssl dgst -sha256 -r "${TMPD}/pub.raw" 2>/dev/null | awk '{ print $1 }')"
    if [ "$(openssl_major)" -ge 3 ] 2>/dev/null; then
      # SPKI DER = 302a300506032b6570032100 || raw key
      printf '\060\052\060\005\006\003\053\145\160\003\041\000' > "${TMPD}/pub.der"
      cat "${TMPD}/pub.raw" >> "${TMPD}/pub.der"
      pem="${TMPD}/pub.pem"
      { printf -- '-----BEGIN PUBLIC KEY-----\n'; openssl base64 -A < "${TMPD}/pub.der"; printf '\n-----END PUBLIC KEY-----\n'; } > "${pem}"
      sigbin="${TMPD}/sig.bin"
      tr -d ' \r\n' < "${sigf}" | openssl base64 -d -A > "${sigbin}" 2>/dev/null
      if openssl pkeyutl -verify -pubin -inkey "${pem}" -rawin -in "${file}" -sigfile "${sigbin}" >/dev/null 2>&1; then SIG_STATE="valid"; else SIG_STATE="invalid"; fi
      return 0
    fi
  fi
  if have node; then
    # Inline code (part of check.sh), not a script from the verified tree.
    local out=""
    out="$(node -e '
      const c = require("crypto"), fs = require("fs");
      const raw = Buffer.from(fs.readFileSync(process.argv[1], "utf8").trim(), "base64");
      if (raw.length !== 32) { console.log("badkey"); process.exit(0); }
      const key = c.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
      const sig = Buffer.from(fs.readFileSync(process.argv[2], "utf8").trim(), "base64");
      const ok = sig.length === 64 && c.verify(null, fs.readFileSync(process.argv[3]), key, sig);
      console.log((ok ? "valid " : "invalid ") + c.createHash("sha256").update(raw).digest("hex"));
    ' "${pubf}" "${sigf}" "${file}" 2>/dev/null)"
    case "${out}" in
      valid*|invalid*) SIG_STATE="${out%% *}"; SIG_FP="${out#* }"; return 0 ;;
      badkey) SIG_STATE="badkey"; return 1 ;;
    esac
  fi
  SIG_STATE="notool"
  return 1
}

# The trusted key: --pubkey, else the copy pinned at install time, else the tree's.
KEY_SRC=""; KEY_FILE=""
pick_pubkey() {
  KEY_SRC=""; KEY_FILE=""
  if [ -n "${PUBKEY_ARG}" ]; then KEY_FILE="${PUBKEY_ARG}"; KEY_SRC="arg"
  elif [ -f "${ROOT}/.m5cet/release-signing.pub" ]; then KEY_FILE="${ROOT}/.m5cet/release-signing.pub"; KEY_SRC="pinned"
  elif [ -f "${ROOT}/release-signing.pub" ]; then KEY_FILE="${ROOT}/release-signing.pub"; KEY_SRC="tree"; fi
}

list_hint() { join_lines "$1" 6; }

pkg_layout() {
  if [ "${TREE}" = "1" ]; then
    pass package.tree "$(L "M5cet source tree ${PKG_VERSION} in ${ROOT}" "zdrojový strom M5cet ${PKG_VERSION} v ${ROOT}")"
    if [ "${INSTALLED}" = "0" ]; then
      skip package.install "$(L 'no .m5cet/install.conf — not installed by install.sh (host checks still run)' 'chybí .m5cet/install.conf — neinstalováno přes install.sh (kontroly hostitele běží dál)')"
    fi
    return 0
  fi
  if [ "${INSTALLED}" = "1" ]; then
    fail package.tree "$(L "${ROOT} has install.conf but no M5cet package.json" "${ROOT} má install.conf, ale ne package.json M5cet")" \
      "$(L "repair it: ${ROOT}/update.sh --repair" "opravte: ${ROOT}/update.sh --repair")"
  else
    skip package.tree "$(L "${ROOT} is not an M5cet tree — host checks only (use --root)" "${ROOT} není strom M5cet — jen kontroly hostitele (použijte --root)")"
  fi
}

# git on the install tree (C07). `git status` honours the repository's own
# .git/config (core.fsmonitor, filter drivers run programs), so it never runs
# as root on a .git that someone else can change, and safe.directory is never
# overridden. As root git runs as the owner of .git (runuser / setpriv /
# sudo); on a root-owned .git as root only when nobody else can write the tree
# root, .git or .git/config. Always: no system / global config (clean HOME),
# core.fsmonitor=false, core.hooksPath=/dev/null, no optional locks, no
# repository discovery above the tree; status ignores submodules (their own
# config is not read).
# git_plan — 0 with GIT_RUNAS ("" = ourselves, "root", or a user); 1 with
# GIT_WHY (writable | owner | noswitch) when git must not run.
GIT_RUNAS=""; GIT_GROUP=""; GIT_WHY=""; GIT_OWNER=""
git_plan() {
  local g="${ROOT}/.git" uid=""
  GIT_RUNAS=""; GIT_GROUP=""; GIT_WHY=""; GIT_OWNER=""
  is_root || return 0
  uid="$(f_uid "${g}")"
  if [ "${uid}" = "0" ]; then
    if [ -d "${g}" ] && root_only "${ROOT}" "${g}" && { [ ! -e "${g}/config" ] || root_only "${g}/config"; }; then GIT_RUNAS="root"; return 0; fi
    GIT_WHY="writable"; return 1
  fi
  GIT_OWNER="$(owner_name "${g}")"
  if [ -z "${GIT_OWNER}" ] || [ -z "${uid}" ]; then GIT_WHY="owner"; return 1; fi
  if [ -z "$(switch_tool)" ]; then GIT_WHY="noswitch"; return 1; fi
  GIT_RUNAS="${GIT_OWNER}"
  GIT_GROUP="$(pw_entry "${GIT_OWNER}" | cut -d: -f4)"; [ -n "${GIT_GROUP}" ] || GIT_GROUP="${GIT_OWNER}"
  return 0
}
# git_tree ARGS… — git ARGS on the tree as git_plan decided.
git_tree() {
  local -a cmd
  cmd=(env -i "PATH=${PATH}" LC_ALL=C HOME=/nonexistent XDG_CONFIG_HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 "GIT_CEILING_DIRECTORIES=$(dirname "${ROOT}")"
    git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "${ROOT}" "$@")
  case "${GIT_RUNAS}" in
    ""|root) to 30 "${cmd[@]}" ;;
    *) as_user "${GIT_RUNAS}" "${GIT_GROUP}" 30 "${cmd[@]}" ;;
  esac
}

pkg_integrity() {
  local m="${ROOT}/release.json" n=""
  if [ -f "${m}" ]; then
    if ! verify_manifest "${m}" "${ROOT}" release; then
      case "${VM_ERR}" in
        nohash) skip package.integrity "$(L 'no sha256sum / shasum / openssl to hash files' 'chybí sha256sum / shasum / openssl pro výpočet hashů')" ;;
        path) fail package.integrity "$(L 'release.json lists a path outside the tree (absolute, .., or starting with -)' 'release.json uvádí cestu mimo strom (absolutní, .., nebo začínající -)')" \
                "$(L 'do not trust this package; reinstall from a verified release' 'tomuto balíčku nevěřte; přeinstalujte z ověřeného vydání')" ;;
        *) fail package.integrity "$(L 'release.json cannot be read (unknown format or layout)' 'release.json nelze přečíst (neznámý formát nebo rozložení)')" \
             "$(L 'regenerate it with npm run release:manifest, or delete it' 'vytvořte ho znovu přes npm run release:manifest, nebo ho smažte')" ;;
      esac
      return 0
    fi
    if [ "${VM_NAME}" != "m5cet" ]; then
      fail package.integrity "$(L "release.json is a manifest of '${VM_NAME}', not of the release tree" "release.json je manifest '${VM_NAME}', ne stromu vydání")" \
        "$(L 'use the release.json of this package' 'použijte release.json tohoto balíčku')"
      return 0
    fi
    if [ -n "${PKG_VERSION}" ] && [ "${VM_VERSION}" != "${PKG_VERSION}" ]; then
      fail package.integrity "$(L "release.json describes ${VM_VERSION}, the tree is ${PKG_VERSION} (stale manifest)" "release.json popisuje ${VM_VERSION}, strom je ${PKG_VERSION} (zastaralý manifest)")" \
        "$(L 'delete the stale release.json(.sig) or install the package it belongs to' 'smažte zastaralý release.json(.sig), nebo nainstalujte balíček, ke kterému patří')"
      return 0
    fi
    if [ -n "${VM_MISSING}" ] || [ -n "${VM_MODIFIED}" ] || [ -n "${VM_EXTRA_EXEC}" ] || [ -n "${VM_UNREAD}" ]; then
      local parts=""
      [ -n "${VM_MODIFIED}" ] && parts="${parts}$(L 'modified' 'změněno') $(count_lines "${VM_MODIFIED}"): $(list_hint "${VM_MODIFIED}"); "
      [ -n "${VM_MISSING}" ] && parts="${parts}$(L 'missing' 'chybí') $(count_lines "${VM_MISSING}"): $(list_hint "${VM_MISSING}"); "
      [ -n "${VM_EXTRA_EXEC}" ] && parts="${parts}$(L 'extra executable' 'navíc spustitelné') $(count_lines "${VM_EXTRA_EXEC}"): $(list_hint "${VM_EXTRA_EXEC}"); "
      [ -n "${VM_UNREAD}" ] && parts="${parts}$(L 'unreadable (not verified)' 'nečitelné (neověřeno)') $(count_lines "${VM_UNREAD}"): $(list_hint "${VM_UNREAD}"); "
      fail package.integrity "$(L "the tree does not match release.json (${VM_COUNT} files) — ${parts%; }" "strom neodpovídá release.json (${VM_COUNT} souborů) — ${parts%; }")" \
        "$(L 'find out who changed the files; restore the package (update.sh --repair, or reinstall from a verified release)' 'zjistěte, kdo soubory změnil; obnovte balíček (update.sh --repair, nebo reinstalace z ověřeného vydání)')"
    else
      pass package.integrity "$(L "all ${VM_COUNT} files match release.json (${VM_VERSION}, ${VM_COMMIT:0:12})" "všech ${VM_COUNT} souborů odpovídá release.json (${VM_VERSION}, ${VM_COMMIT:0:12})")"
    fi
    n="$(printf '%s\n' "${VM_EXTRA}" | grep -vxF -f <(printf '%s\n' "${VM_EXTRA_EXEC}") | awk 'NF' || true)"
    if [ -n "${n}" ]; then
      warn package.extra "$(L "files not in release.json: $(list_hint "${n}")" "soubory mimo release.json: $(list_hint "${n}")")" \
        "$(L 'remove what does not belong to the release (or keep it consciously)' 'odstraňte, co k vydání nepatří (nebo to vědomě ponechte)')"
    fi
    pkg_signature "${m}"
    return 0
  fi
  if [ -e "${ROOT}/.git" ] && have git; then
    local st="" mod="" untr="" untr_exec="" head="" x=""
    if ! git_plan; then
      case "${GIT_WHY}" in
        writable) skip package.integrity "$(L "git: ${ROOT}/.git belongs to root but is not a plain directory, or others can change it (or the tree root, or .git/config) — git is not run as root" "git: ${ROOT}/.git patří rootovi, ale není to obyčejný adresář, nebo ho mohou měnit i jiní (nebo kořen stromu, .git/config) — git jako root nespouštím")" ;;
        noswitch) skip package.integrity "$(L "git: cannot switch to the owner of .git (${GIT_OWNER}) — no runuser / setpriv / sudo; git is not run as root on a tree root does not own" "git: nelze přepnout na vlastníka .git (${GIT_OWNER}) — chybí runuser / setpriv / sudo; git jako root na cizím stromu nespouštím")" ;;
        *) skip package.integrity "$(L "git: .git is owned by an unknown or invalid user — git is not run as root" "git: .git patří neznámému nebo neplatnému uživateli — git jako root nespouštím")" ;;
      esac
      return 0
    fi
    st="$(git_tree status --porcelain=v1 --untracked-files=all --ignore-submodules=all 2>/dev/null)" || {
      skip package.integrity "$(L 'git status failed in the install tree (a repository of another user? git refuses it)' 'git status v instalačním stromu selhal (repozitář jiného uživatele? git ho odmítá)')"; return 0; }
    head="$(git_tree rev-parse HEAD 2>/dev/null)"
    mod="$(printf '%s\n' "${st}" | awk 'substr($0, 1, 2) != "??" && NF { print substr($0, 4) }')"
    untr="$(printf '%s\n' "${st}" | awk 'substr($0, 1, 2) == "??" { print substr($0, 4) }')"
    untr_exec=""
    if [ -n "${untr}" ]; then
      while IFS= read -r x; do
        [ -n "${x}" ] || continue
        [ -f "${ROOT}/${x}" ] && [ ! -L "${ROOT}/${x}" ] || continue
        case "$(lc "${x}")" in *.node|*.so|*.dylib|*.dll|*.exe) untr_exec="${untr_exec}${x}"$'\n'; continue ;; esac
        [ -x "${ROOT}/${x}" ] && untr_exec="${untr_exec}${x}"$'\n'
      done <<EOF_U
${untr}
EOF_U
    fi
    if [ -n "${mod}" ] || [ -n "${untr_exec}" ]; then
      local parts=""
      [ -n "${mod}" ] && parts="${parts}$(L 'changed tracked files' 'změněné sledované soubory') $(count_lines "${mod}"): $(list_hint "${mod}"); "
      [ -n "${untr_exec}" ] && parts="${parts}$(L 'extra executable' 'navíc spustitelné') $(count_lines "${untr_exec}"): $(list_hint "${untr_exec}"); "
      local fix=""
      fix="$(L "inspect (as the owner of the tree, not root): git -C ${ROOT} status / diff" "prohlédněte (jako vlastník stromu, ne root): git -C ${ROOT} status / diff")"
      [ "${INSTALLED}" = "1" ] && fix="${fix}; $(L "discard: ${ROOT}/update.sh --repair" "zahodit: ${ROOT}/update.sh --repair")"
      fail package.integrity "$(L "git: the tree differs from commit ${head:0:12} — ${parts%; }" "git: strom se liší od commitu ${head:0:12} — ${parts%; }")" "${fix}"
    else
      pass package.integrity "$(L "git: no local changes to tracked files (commit ${head:0:12})" "git: žádné místní změny sledovaných souborů (commit ${head:0:12})")"
    fi
    local plain=""
    plain="$(printf '%s\n' "${untr}" | grep -vxF -f <(printf '%s\n' "${untr_exec}") | awk 'NF' || true)"
    if [ -n "${plain}" ]; then
      warn package.extra "$(L "untracked files: $(list_hint "${plain}")" "nesledované soubory: $(list_hint "${plain}")")" \
        "$(L 'remove what does not belong to the install' 'odstraňte, co do instalace nepatří')"
    fi
    if [ -n "$(cf INSTALLED_COMMIT)" ] && [ -n "${head}" ] && [ "$(cf INSTALLED_COMMIT)" != "${head}" ]; then
      warn package.commit "$(L "the tree is at ${head:0:12}, the installer deployed $(cf INSTALLED_COMMIT | cut -c1-12)" "strom je na ${head:0:12}, instalátor nasadil $(cf INSTALLED_COMMIT | cut -c1-12)")" \
        "$(L 'update only through update.sh (it rebuilds and records the commit)' 'aktualizujte jen přes update.sh (přestaví a zaznamená commit)')"
    fi
    warn package.signature "$(L 'no release.json: integrity is checked against git only, without the developer signature' 'chybí release.json: integrita jen proti gitu, bez podpisu vývojáře')" \
      "$(L 'install from a signed release (release.json + release.json.sig) to verify the origin' 'pro ověření původu instalujte z podepsaného vydání (release.json + release.json.sig)')"
    return 0
  fi
  if [ "${TREE}" = "1" ]; then
    warn package.integrity "$(L 'no release.json and no git checkout: integrity cannot be verified' 'chybí release.json i git: integritu nelze ověřit')" \
      "$(L 'install from a release with release.json (npm run release:manifest), or from git' 'instalujte z vydání s release.json (npm run release:manifest), nebo z gitu')"
  fi
}

pkg_signature() {
  local m="$1" sig="$1.sig" pinned="${ROOT}/.m5cet/release-signing.pub" tree="${ROOT}/release-signing.pub"
  if [ -f "${pinned}" ] && [ -f "${tree}" ] && [ "$(tr -d ' \r\n' < "${pinned}")" != "$(tr -d ' \r\n' < "${tree}")" ]; then
    if [ -f "${sig}" ]; then
      fail package.signature "$(L 'release-signing.pub differs from the key pinned at install (.m5cet/release-signing.pub)' 'release-signing.pub se liší od klíče připnutého při instalaci (.m5cet/release-signing.pub)')" \
        "$(L 'a new release key? compare its fingerprint with the developer out of band, then copy it to .m5cet/release-signing.pub' 'nový klíč vydání? ověřte otisk u vývojáře jinou cestou a pak ho zkopírujte do .m5cet/release-signing.pub')"
      return 0
    fi
  fi
  if [ ! -f "${sig}" ]; then
    warn package.signature "$(L 'release.json is not signed: it detects corruption and local changes, not a substituted package' 'release.json není podepsaný: odhalí poškození a místní změny, ne podvržený balíček')" \
      "$(L 'use signed releases (npm run release:sign)' 'používejte podepsaná vydání (npm run release:sign)')"
    return 0
  fi
  pick_pubkey
  if [ -z "${KEY_FILE}" ]; then
    fail package.signature "$(L 'release.json.sig exists but there is no release-signing.pub to check it' 'release.json.sig existuje, ale chybí release-signing.pub k ověření')" \
      "$(L 'pass the developer key with --pubkey FILE' 'předejte klíč vývojáře přes --pubkey FILE')"
    return 0
  fi
  verify_sig "${m}" "${sig}" "${KEY_FILE}"
  case "${SIG_STATE}" in
    valid)
      if [ "${KEY_SRC}" = "tree" ]; then
        pass package.signature "$(L "signature valid (key SHA256 ${SIG_FP:0:16}…, from the same tree — compare the fingerprint with the published one)" "podpis platný (klíč SHA256 ${SIG_FP:0:16}…, ze stejného stromu — porovnejte otisk s oficiálním)")"
      else
        pass package.signature "$(L "signature valid (key SHA256 ${SIG_FP:0:16}…, ${KEY_SRC})" "podpis platný (klíč SHA256 ${SIG_FP:0:16}…, ${KEY_SRC})")"
      fi ;;
    invalid)
      fail package.signature "$(L 'release.json signature is INVALID — the manifest was changed or signed with another key' 'podpis release.json je NEPLATNÝ — manifest byl změněn nebo podepsán jiným klíčem')" \
        "$(L 'do not run this package; reinstall from a verified release' 'tento balíček nespouštějte; přeinstalujte z ověřeného vydání')" ;;
    badkey)
      fail package.signature "$(L "${KEY_FILE} is not a raw Ed25519 public key (base64)" "${KEY_FILE} není veřejný klíč Ed25519 (raw, base64)")" ;;
    *)
      skip package.signature "$(L 'cannot verify Ed25519: needs OpenSSL >= 3 or node' 'nelze ověřit Ed25519: potřebuje OpenSSL >= 3 nebo node')" ;;
  esac
}

pkg_web() {
  local pub="${ROOT}/dist/public" m="${ROOT}/dist/public/release-web.json"
  if [ ! -d "${pub}" ]; then
    if [ "${MODE}" = "docker" ]; then skip package.web "$(L 'docker mode: the assets live in the image' 'režim docker: assety jsou v image')"
    else skip package.web "$(L 'dist/public missing (not built)' 'dist/public chybí (nesestaveno)')"; fi
    return 0
  fi
  if [ ! -f "${m}" ]; then
    warn package.web "$(L 'dist/public/release-web.json missing (a build older than 6.12?)' 'chybí dist/public/release-web.json (build starší než 6.12?)')" \
      "$(L "rebuild: ${ROOT}/update.sh --repair" "přestavte: ${ROOT}/update.sh --repair")"
    return 0
  fi
  if ! verify_manifest "${m}" "${pub}" web; then
    case "${VM_ERR}" in
      nohash) skip package.web "$(L 'no sha256sum / shasum / openssl to hash files' 'chybí sha256sum / shasum / openssl pro výpočet hashů')" ;;
      path) fail package.web "$(L 'release-web.json lists a path outside dist/public (absolute, .., or starting with -)' 'release-web.json uvádí cestu mimo dist/public (absolutní, .., nebo začínající -)')" "$(L 'rebuild (update.sh --repair) and find the cause' 'přestavte (update.sh --repair) a zjistěte příčinu')" ;;
      *) fail package.web "$(L 'release-web.json cannot be read' 'release-web.json nelze přečíst')" "$(L 'rebuild (npm run build)' 'přestavte (npm run build)')" ;;
    esac
    return 0
  fi
  if [ -n "${VM_MISSING}" ] || [ -n "${VM_MODIFIED}" ] || [ -n "${VM_EXTRA_EXEC}" ] || [ -n "${VM_UNREAD}" ]; then
    local parts=""
    [ -n "${VM_MODIFIED}" ] && parts="${parts}$(L 'modified' 'změněno'): $(list_hint "${VM_MODIFIED}"); "
    [ -n "${VM_MISSING}" ] && parts="${parts}$(L 'missing' 'chybí'): $(list_hint "${VM_MISSING}"); "
    [ -n "${VM_EXTRA_EXEC}" ] && parts="${parts}$(L 'extra served code' 'navíc servírovaný kód'): $(list_hint "${VM_EXTRA_EXEC}"); "
    [ -n "${VM_UNREAD}" ] && parts="${parts}$(L 'unreadable (not verified)' 'nečitelné (neověřeno)'): $(list_hint "${VM_UNREAD}"); "
    fail package.web "$(L "served web assets do not match release-web.json — ${parts%; }" "servírované assety webu neodpovídají release-web.json — ${parts%; }")" \
      "$(L 'the browser would run changed code; rebuild (update.sh --repair) and find the cause' 'prohlížeč by spustil změněný kód; přestavte (update.sh --repair) a zjistěte příčinu')"
  else
    pass package.web "$(L "all ${VM_COUNT} served files match release-web.json" "všech ${VM_COUNT} servírovaných souborů odpovídá release-web.json")"
  fi
  if [ -n "${VM_EXTRA}" ] && [ -z "${VM_EXTRA_EXEC}" ]; then
    warn package.web_extra "$(L "extra files in dist/public: $(list_hint "${VM_EXTRA}")" "soubory navíc v dist/public: $(list_hint "${VM_EXTRA}")")" \
      "$(L 'they are served to everyone — remove them or rebuild' 'servírují se všem — odstraňte je nebo přestavte')"
  fi
  # The signature state is always reported (C12): an unsigned build is visible, not silent.
  if [ ! -f "${m}.sig" ]; then
    skip package.web_signature "$(L 'release-web.json is not signed (a build made on this host — package.web checks it against the build only)' 'release-web.json není podepsaný (build vytvořený na tomto stroji — package.web ho ověřuje jen proti buildu)')"
    return 0
  fi
  pick_pubkey
  if [ -z "${KEY_FILE}" ]; then
    warn package.web_signature "$(L 'release-web.json.sig exists but there is no release-signing.pub to check it' 'release-web.json.sig existuje, ale chybí release-signing.pub k ověření')" \
      "$(L 'pass the developer key with --pubkey FILE' 'předejte klíč vývojáře přes --pubkey FILE')"
    return 0
  fi
  verify_sig "${m}" "${m}.sig" "${KEY_FILE}"
  case "${SIG_STATE}" in
    valid) pass package.web_signature "$(L 'release-web.json signature valid' 'podpis release-web.json platný')" ;;
    invalid) fail package.web_signature "$(L 'release-web.json signature is INVALID' 'podpis release-web.json je NEPLATNÝ')" "$(L 'rebuild from a verified release' 'přestavte z ověřeného vydání')" ;;
    badkey) skip package.web_signature "$(L "${KEY_FILE} is not a raw Ed25519 public key (see package.signature)" "${KEY_FILE} není veřejný klíč Ed25519 (viz package.signature)")" ;;
    *) skip package.web_signature "$(L 'cannot verify Ed25519 (OpenSSL >= 3 or node)' 'nelze ověřit Ed25519 (OpenSSL >= 3 nebo node)')" ;;
  esac
}

pkg_build() {
  if [ "${MODE}" = "docker" ]; then skip package.build "$(L 'docker mode: the build is in the image (see docker)' 'režim docker: build je v image (viz docker)')"; return 0; fi
  if [ ! -d "${ROOT}/dist" ]; then
    if [ "${INSTALLED}" = "1" ]; then fail package.build "$(L 'dist/ is missing — the app is not built' 'chybí dist/ — aplikace není sestavená')" "$(L "${ROOT}/update.sh --repair" "${ROOT}/update.sh --repair")"
    else skip package.build "$(L 'not built (no dist/)' 'nesestaveno (chybí dist/)')"; fi
    return 0
  fi
  local f="" missing=""
  for f in index.cjs sandbox.cjs public/index.html public/build.json; do [ -f "${ROOT}/dist/${f}" ] || missing="${missing} dist/${f}"; done
  [ "${ADMIN_ON}" = "1" ] && { [ -f "${ROOT}/dist/admin.cjs" ] || missing="${missing} dist/admin.cjs"; }
  if [ -n "${missing}" ]; then
    fail package.build "$(L "build incomplete:${missing}" "neúplný build:${missing}")" "$(L "${ROOT}/update.sh --repair" "${ROOT}/update.sh --repair")"
  else
    pass package.build "$(L 'build present (dist/index.cjs, sandbox.cjs, public/)' 'build je kompletní (dist/index.cjs, sandbox.cjs, public/)')"
  fi
  if [ ! -d "${ROOT}/dist/node_modules/pyodide" ] && [ ! -d "${ROOT}/node_modules/pyodide" ]; then
    warn package.pyodide "$(L 'Pyodide missing from dist/node_modules — Python functions will not run' 'v dist/node_modules chybí Pyodide — funkce v Pythonu nepoběží')" "$(L 'rebuild: update.sh --repair' 'přestavte: update.sh --repair')"
  fi
}

SQLC_STATE=""
pkg_sqlcipher() {
  local mod="" out="" rc=""
  if [ "${MODE}" = "docker" ]; then skip package.sqlcipher "$(L 'docker mode: checked through the container (see docker)' 'režim docker: v kontejneru (viz docker)')"; return 0; fi
  for mod in "${ROOT}/dist/node_modules/better-sqlite3-multiple-ciphers" "${ROOT}/node_modules/better-sqlite3-multiple-ciphers" ""; do
    [ -z "${mod}" ] || [ -d "${mod}" ] && break
  done
  if [ -z "${mod}" ]; then
    if [ -d "${ROOT}/dist" ]; then
      SQLC_STATE="missing"
      fail package.sqlcipher "$(L 'the SQLCipher module (better-sqlite3-multiple-ciphers) is missing — nothing is stored (accounts DB, functions, telephony)' 'chybí modul SQLCipher (better-sqlite3-multiple-ciphers) — nic se neukládá (databáze, funkce, telefonie)')" \
        "$(L 'rebuild with build tools: apt install build-essential python3; update.sh --repair' 'přestavte s nástroji: apt install build-essential python3; update.sh --repair')"
    else skip package.sqlcipher "$(L 'not built' 'nesestaveno')"; fi
    return 0
  fi
  if ! have node; then skip package.sqlcipher "$(L 'node missing' 'chybí node')"; return 0; fi
  # Loading the module runs code from the tree: never as root (C02).
  tree_code_ok package.sqlcipher "$(L 'SQLCipher probe' 'zkouška SQLCipher')" || return 0
  out="$(cd "${ROOT}" 2>/dev/null && run_as 20 node -e '
    const D = require(process.argv[1]); const db = new D(":memory:");
    const v = db.prepare("select sqlite3mc_version() v").get().v; db.close(); console.log(v);
  ' "${mod}" 2>&1)"
  rc=$?
  if [ "${rc}" = "126" ] && is_root; then skip package.sqlcipher "$(L "cannot switch to ${DROP_USER} — not loading tree code as root" "nelze přepnout na ${DROP_USER} — kód stromu jako root nespouštím")"; return 0; fi
  if [ "${rc}" = "0" ] && [ -n "${out}" ]; then
    SQLC_STATE="ok"
    pass package.sqlcipher "$(L "SQLCipher loads: $(first_line "${out}")" "SQLCipher se načte: $(first_line "${out}")")"
  else
    SQLC_STATE="broken"
    fail package.sqlcipher "$(L "the SQLCipher module does not load: $(printf '%s' "${out}" | grep -m1 -E 'Error|error' | cut -c1-160)" "modul SQLCipher se nenačte: $(printf '%s' "${out}" | grep -m1 -E 'Error|error' | cut -c1-160)")" \
      "$(L 'a binary for another Node/arch? rebuild: update.sh --repair (needs build-essential python3 without a prebuilt binary)' 'binárka pro jiný Node/architekturu? přestavte: update.sh --repair (bez předkompilované binárky potřebuje build-essential python3)')"
  fi
}

pkg_npm() {
  if [ ! -d "${ROOT}/node_modules/." ]; then
    if [ "${INSTALLED}" = "1" ]; then skip package.npm_ls "$(L 'node_modules removed after the build (dist/ is self-contained)' 'node_modules po buildu odstraněny (dist/ je soběstačné)')"
    else skip package.npm_ls "$(L 'no node_modules' 'chybí node_modules')"; fi
  elif ! have npm; then
    skip package.npm_ls "$(L 'npm missing' 'chybí npm')"
  elif tree_code_ok package.npm_ls "npm ls"; then
    # npm inside the tree reads its .npmrc and node_modules: as root it runs as DROP_USER (C08).
    local out="" rc=""
    out="$(cd "${ROOT}" && run_as 120 npm ls --omit=dev --all --logs-max=0 --no-update-notifier 2>&1 >/dev/null)"; rc=$?
    if [ "${rc}" = "126" ] && is_root; then skip package.npm_ls "$(L "npm ls: cannot switch to ${DROP_USER} — npm is not run as root in the tree" "npm ls: nelze přepnout na ${DROP_USER} — npm jako root ve stromu nespouštím")"
    elif [ "${rc}" = "0" ]; then pass package.npm_ls "$(L 'npm ls --omit=dev: dependency tree consistent' 'npm ls --omit=dev: strom závislostí je v pořádku')"
    else
      warn package.npm_ls "$(L "npm ls --omit=dev reports problems: $(printf '%s\n' "${out}" | grep -m2 -E 'missing|invalid|extraneous|ERR' | tr '\n' ' ' | cut -c1-200)" "npm ls --omit=dev hlásí problémy: $(printf '%s\n' "${out}" | grep -m2 -E 'missing|invalid|extraneous|ERR' | tr '\n' ' ' | cut -c1-200)")" \
        "$(L "${ROOT}/update.sh --repair (clean npm ci)" "${ROOT}/update.sh --repair (čisté npm ci)")"
    fi
  fi
  if [ ! -f "${ROOT}/package-lock.json" ] || ! have npm; then
    skip package.npm_audit "$(L 'needs npm and package-lock.json' 'potřebuje npm a package-lock.json')"; return 0
  fi
  if ! online; then skip package.npm_audit "$(L 'offline' 'offline')"; return 0; fi
  local js="" crit="" high="" f=""
  # Not inside the tree (C08): a private copy of package.json + package-lock.json
  # (data only), audited from the lockfile — the tree's .npmrc (a registry that
  # would receive the lockfile, npm 6 onload-script) and node_modules are never read.
  mkdir -p "${TMPD}/audit" || { skip package.npm_audit "$(L 'cannot prepare a temporary copy' 'nelze připravit dočasnou kopii')"; return 0; }
  for f in package.json package-lock.json; do
    if [ ! -f "${ROOT}/${f}" ] || [ -L "${ROOT}/${f}" ] || ! cat "${ROOT}/${f}" > "${TMPD}/audit/${f}" 2>/dev/null; then
      skip package.npm_audit "$(L "${f} is not a readable regular file" "${f} není čitelný obyčejný soubor")"; return 0
    fi
  done
  js="$(cd "${TMPD}/audit" && to 90 npm audit --omit=dev --json --package-lock-only --logs-max=0 --no-update-notifier --cache "${TMPD}/npm-cache" 2>/dev/null)"
  crit="$(printf '%s' "${js}" | tr -d '\n ' | sed -n 's/.*"vulnerabilities":{[^}]*"critical":\([0-9]*\).*/\1/p')"
  high="$(printf '%s' "${js}" | tr -d '\n ' | sed -n 's/.*"vulnerabilities":{[^}]*"high":\([0-9]*\).*/\1/p')"
  if ! is_uint "${crit}" || ! is_uint "${high}"; then
    skip package.npm_audit "$(L 'npm audit gave no answer (registry unreachable?)' 'npm audit neodpověděl (registr nedostupný?)')"
  elif [ "${crit}" -gt 0 ]; then
    fail package.npm_audit "$(L "npm audit: ${crit} critical, ${high} high vulnerabilities in production dependencies" "npm audit: ${crit} kritických, ${high} vysokých zranitelností v produkčních závislostech")" \
      "$(L 'update M5cet (update.sh); details: npm audit --omit=dev' 'aktualizujte M5cet (update.sh); podrobnosti: npm audit --omit=dev')"
  elif [ "${high}" -gt 0 ]; then
    warn package.npm_audit "$(L "npm audit: ${high} high vulnerabilities in production dependencies" "npm audit: ${high} vysokých zranitelností v produkčních závislostech")" \
      "$(L 'update M5cet (update.sh); details: npm audit --omit=dev' 'aktualizujte M5cet (update.sh); podrobnosti: npm audit --omit=dev')"
  else
    pass package.npm_audit "$(L 'npm audit --omit=dev: no high or critical vulnerability' 'npm audit --omit=dev: žádná vysoká ani kritická zranitelnost')"
  fi
}

HEALTH_DONE=0; HEALTH_CODE=""; HEALTH_BODY=""
health_probe() {
  [ "${HEALTH_DONE}" = "1" ] && return 0
  HEALTH_DONE=1
  if http_get "http://$(probe_host):${APP_PORT}/api/health" 4; then HEALTH_CODE="${HG_CODE}"; HEALTH_BODY="${HG_BODY}"; else HEALTH_CODE="nocurl"; fi
}

pkg_versions() {
  local b="" inst="" h="" msg="" bad=""
  [ "${TREE}" = "1" ] || return 0
  [ -f "${ROOT}/dist/public/build.json" ] && b="$(manifest_header "${ROOT}/dist/public/build.json" version)"
  inst="$(cf INSTALLED_VERSION)"
  if [ "${INSTALLED}" = "1" ]; then
    health_probe
    [ "${HEALTH_CODE}" = "200" ] && h="$(printf '%s' "${HEALTH_BODY}" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  fi
  msg="package.json ${PKG_VERSION}${inst:+, install.conf ${inst}}${b:+, build ${b}}${h:+, $(L 'running' 'běží') ${h}}"
  [ -n "${b}" ] && [ "${b}" != "${PKG_VERSION}" ] && bad="$(L 'the build is not from these sources — rebuild (update.sh)' 'build není z těchto zdrojů — přestavte (update.sh)')"
  [ -z "${bad}" ] && [ -n "${h}" ] && [ -n "${b}" ] && [ "${h}" != "${b}" ] && bad="$(L 'the running service is older than the build — restart it' 'běžící služba je starší než build — restartujte ji')"
  [ -z "${bad}" ] && [ -n "${inst}" ] && [ "${inst}" != "${PKG_VERSION}" ] && bad="$(L 'the sources changed outside update.sh' 'zdrojáky se změnily mimo update.sh')"
  if [ -n "${bad}" ]; then warn package.versions "${msg}" "${bad}"; else pass package.versions "${msg}"; fi
}

check_package() {
  sec package "Balíček" "Package"
  pkg_layout
  if [ "${TREE}" = "0" ]; then return 0; fi
  pkg_integrity
  pkg_web
  pkg_build
  pkg_sqlcipher
  pkg_npm
  pkg_versions
}

# ===========================================================================
# config
# ===========================================================================

# token_bits VALUE — a rough entropy estimate (length × log2 of the alphabet used).
token_bits() {
  printf '%s' "$1" | awk '{
    s = $0; n = length(s); a = 0
    if (s ~ /^[0-9a-fA-F]+$/) a = 16
    else { if (s ~ /[a-z]/) a += 26; if (s ~ /[A-Z]/) a += 26; if (s ~ /[0-9]/) a += 10; if (s ~ /[^A-Za-z0-9]/) a += 32 }
    if (a < 2) a = 2
    u = 0; for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (!(c in seen)) { seen[c] = 1; u++ } }
    if (u < 6) { print 0; exit }
    printf "%d\n", n * log(a) / log(2) }'
}

cfg_env_file() {
  if [ ! -e "${ENV_FILE}" ]; then
    if [ "${INSTALLED}" = "1" ]; then fail config.env "$(L ".env missing (${ENV_FILE})" "chybí .env (${ENV_FILE})")" "$(L "${ROOT}/update.sh --repair recreates it" "${ROOT}/update.sh --repair ho vytvoří")"
    else skip config.env "$(L 'no .env (not installed)' 'chybí .env (neinstalováno)')"; fi
    return 0
  fi
  local m="" o="" g="" owner="" grp="" svcgrp=""
  m="$(mode3 "${ENV_FILE}")"; o="${m:2:1}"; g="${m:1:1}"; owner="$(f_owner "${ENV_FILE}")"; grp="$(f_group "${ENV_FILE}")"
  if [ "${o}" != "0" ]; then
    fail config.env "$(L ".env is accessible to everyone (mode ${m}, ${owner}:${grp}) — secrets exposed" ".env je přístupný všem (práva ${m}, ${owner}:${grp}) — tajemství jsou vystavená")" \
      "$(L "chmod 600 ${ENV_FILE} (systemd install: 640 root:${SVC_USER:-m5cet}), then rotate the secrets" "chmod 600 ${ENV_FILE} (instalace se systemd: 640 root:${SVC_USER:-m5cet}), pak tajemství vyměňte")"
    return 0
  fi
  case "${g}" in 2|3|6|7)
    fail config.env "$(L ".env is group-writable (mode ${m}, ${owner}:${grp})" ".env je zapisovatelný pro skupinu (práva ${m}, ${owner}:${grp})")" "$(L "chmod g-w ${ENV_FILE}" "chmod g-w ${ENV_FILE}")"
    return 0 ;;
  esac
  if [ "${MANAGER}" = "systemd" ]; then
    svcgrp="$(pw_entry "${SVC_USER}" | awk -F: '{ print $4 }')"
    [ -n "${svcgrp}" ] && svcgrp="$(awk -F: -v gid="${svcgrp}" '$3 == gid { print $1 }' "$(sp /etc/group)" 2>/dev/null | head -n1)"
    [ -n "${svcgrp}" ] || svcgrp="${SVC_USER}"
    if [ "${owner}" = "root" ] && [ "${g}" = "4" ] && [ "${grp}" = "${svcgrp}" ]; then
      pass config.env "$(L ".env ${m} root:${grp} (the service reads it, nobody else)" ".env ${m} root:${grp} (čte ho služba, nikdo jiný)")"
    elif [ "${owner}" = "${SVC_USER}" ]; then
      warn config.env "$(L ".env is owned by the service user ${SVC_USER} (mode ${m}): the service could rewrite its own configuration" ".env vlastní uživatel služby ${SVC_USER} (práva ${m}): služba by mohla přepsat vlastní konfiguraci")" \
        "chown root:${svcgrp} ${ENV_FILE}; chmod 640 ${ENV_FILE}"
    elif [ "${g}" = "0" ]; then
      fail config.env "$(L ".env ${m} ${owner}:${grp}: the service (${SVC_USER}) cannot read it — the app loads ./.env itself and stops on EACCES" ".env ${m} ${owner}:${grp}: služba (${SVC_USER}) ho nepřečte — aplikace načítá ./.env sama a na EACCES skončí")" \
        "chown root:${svcgrp} ${ENV_FILE}; chmod 640 ${ENV_FILE}"
    else
      warn config.env "$(L ".env ${m} ${owner}:${grp} (expected 640 root:${svcgrp})" ".env ${m} ${owner}:${grp} (očekáváno 640 root:${svcgrp})")" "chown root:${svcgrp} ${ENV_FILE}; chmod 640 ${ENV_FILE}"
    fi
  else
    if [ "${g}" = "0" ]; then pass config.env "$(L ".env ${m} ${owner} (private)" ".env ${m} ${owner} (soukromý)")"
    else warn config.env "$(L ".env is readable by group ${grp} (mode ${m})" ".env čte skupina ${grp} (práva ${m})")" "chmod 600 ${ENV_FILE}"; fi
  fi
  if [ "${ENV_READABLE}" = "0" ]; then need_root config.vars "$(L '.env values' 'hodnoty v .env')"; fi
  if [ -n "${ENV_DUPS}" ]; then
    warn config.env_dups "$(L "variables set twice in .env:${ENV_DUPS} (the last one wins)" "proměnné v .env nastavené dvakrát:${ENV_DUPS} (platí poslední)")" "$(L 'keep one line per variable' 'nechte jeden řádek na proměnnou')"
  fi
  if [ "${ENV_BAD}" -gt 0 ]; then
    warn config.env_syntax "$(L "${ENV_BAD} line(s) in .env are not KEY=VALUE" "${ENV_BAD} řádků v .env není KEY=VALUE")" "$(L 'fix or comment them out (#)' 'opravte je nebo zakomentujte (#)')"
  fi
}

cfg_node_env() {
  local v; v="$(ev NODE_ENV)"
  if [ "${v}" = "production" ]; then pass config.node_env "NODE_ENV=production"
  elif [ -n "${v}" ]; then
    if [ "${MANAGER}" = "process" ]; then warn config.node_env "$(L "NODE_ENV=${v} in .env (the process manager forces production)" "NODE_ENV=${v} v .env (správce procesu vynutí production)")" "$(L 'set NODE_ENV=production' 'nastavte NODE_ENV=production')"
    else fail config.node_env "$(L "NODE_ENV=${v}: the server runs the development middleware and a lax CSP" "NODE_ENV=${v}: server pustí vývojový middleware a volnou CSP")" "$(L 'NODE_ENV=production (update.sh --config-only rewrites it)' 'NODE_ENV=production (update.sh --config-only ho přepíše)')"; fi
  elif [ "${MANAGER}" = "systemd" ]; then
    fail config.node_env "$(L 'NODE_ENV is not set — the systemd service would run in development mode' 'NODE_ENV není nastaveno — služba systemd by běžela ve vývojovém režimu')" "$(L "${ROOT}/update.sh --config-only (writes NODE_ENV=production)" "${ROOT}/update.sh --config-only (zapíše NODE_ENV=production)")"
  else pass config.node_env "$(L 'NODE_ENV comes from the service manager (production)' 'NODE_ENV dodává správce služby (production)')"; fi
}

cfg_admin() {
  local t="" len="" bits="" bind=""
  if [ "${ADMIN_ON}" = "0" ]; then skip config.admin "$(L 'admin API off (ENABLE_ADMIN=0)' 'admin API vypnuté (ENABLE_ADMIN=0)')"; return 0; fi
  t="$(ev ADMIN_API_TOKEN)"; len="${#t}"
  if [ "${len}" -eq 0 ]; then
    fail config.admin_token "$(L 'ENABLE_ADMIN=1 but ADMIN_API_TOKEN is empty — the console refuses everyone' 'ENABLE_ADMIN=1, ale ADMIN_API_TOKEN je prázdný — konzole odmítne každého')" "$(L "${ROOT}/update.sh --config-only generates one" "${ROOT}/update.sh --config-only ho vygeneruje")"
  elif [ "${len}" -lt 24 ]; then
    fail config.admin_token "$(L "ADMIN_API_TOKEN is too short (${len} characters, minimum 24)" "ADMIN_API_TOKEN je příliš krátký (${len} znaků, minimum 24)")" "$(L 'use 64 random hex characters: openssl rand -hex 32' 'použijte 64 náhodných hex znaků: openssl rand -hex 32')"
  else
    bits="$(token_bits "${t}")"
    if [ "${bits}" -lt 96 ]; then
      fail config.admin_token "$(L "ADMIN_API_TOKEN looks weak (${len} characters, ~${bits} bits)" "ADMIN_API_TOKEN vypadá slabě (${len} znaků, ~${bits} bitů)")" "$(L 'openssl rand -hex 32' 'openssl rand -hex 32')"
    elif [ "${bits}" -lt 128 ] || [ "${len}" -lt 32 ]; then
      warn config.admin_token "$(L "ADMIN_API_TOKEN: ${len} characters, ~${bits} bits (recommended ≥ 32 characters, ≥ 128 bits)" "ADMIN_API_TOKEN: ${len} znaků, ~${bits} bitů (doporučeno ≥ 32 znaků, ≥ 128 bitů)")" "$(L 'openssl rand -hex 32' 'openssl rand -hex 32')"
    else
      pass config.admin_token "$(L "ADMIN_API_TOKEN set (${len} characters, ~${bits} bits)" "ADMIN_API_TOKEN nastaven (${len} znaků, ~${bits} bitů)")"
    fi
  fi
  if [ "${MODE}" != "docker" ]; then
    bind="$(ev ADMIN_BIND)"; [ -n "${bind}" ] || bind="127.0.0.1"
    if is_loopback "${bind}"; then pass config.admin_bind "$(L "admin API bound to ${bind}" "admin API naslouchá na ${bind}")"
    else fail config.admin_bind "$(L "ADMIN_BIND=${bind}: the admin API listens beyond this machine" "ADMIN_BIND=${bind}: admin API naslouchá i mimo tento stroj")" "$(L 'ADMIN_BIND=127.0.0.1; reach it through an SSH tunnel or a proxy with an IP allowlist' 'ADMIN_BIND=127.0.0.1; přístup přes SSH tunel nebo proxy s povolenými IP')"; fi
  fi
  t="$(ev METRICS_TOKEN)"
  if [ -n "${t}" ] && [ "${#t}" -lt 24 ]; then warn config.metrics_token "$(L "METRICS_TOKEN is short (${#t} characters)" "METRICS_TOKEN je krátký (${#t} znaků)")" "openssl rand -hex 32"; fi
}

cfg_urls() {
  local u="" du="" host="" sch="" rp="" o="" oh="" bad="" shown=""
  local -a origins
  u="$(ev PUBLIC_BASE_URL)"
  if [ -n "${u}" ]; then
    sch="$(url_scheme "${u}")"; host="$(url_host "${u}")"; du="$(safe_url "${u}" path)"
    if [ -z "${host}" ]; then fail config.public_url "$(L "PUBLIC_BASE_URL is not a URL" "PUBLIC_BASE_URL není URL")" "$(L 'e.g. PUBLIC_BASE_URL=https://chat.example.com' 'např. PUBLIC_BASE_URL=https://chat.example.com')"
    elif [ "${sch}" != "https" ] && ! is_loopback "${host}"; then
      fail config.public_url "$(L "PUBLIC_BASE_URL=${du} is not https — passkeys and provider signatures need the public https address" "PUBLIC_BASE_URL=${du} není https — passkeys a podpisy poskytovatelů potřebují veřejnou https adresu")" "PUBLIC_BASE_URL=https://${host}"
    elif [ -n "$(cf DOMAIN)" ] && [ "${host}" != "$(cf DOMAIN)" ]; then
      warn config.public_url "$(L "PUBLIC_BASE_URL host ${host} differs from DOMAIN $(cf DOMAIN)" "hostitel PUBLIC_BASE_URL ${host} se liší od DOMAIN $(cf DOMAIN)")" "$(L 'use the address clients really open' 'použijte adresu, kterou klienti opravdu otevírají')"
    else pass config.public_url "PUBLIC_BASE_URL=${du}"; fi
  elif is_on "$(ev ENABLE_TELEPHONY)"; then
    fail config.public_url "$(L 'ENABLE_TELEPHONY=1 without PUBLIC_BASE_URL: Twilio signatures and callback URLs need it' 'ENABLE_TELEPHONY=1 bez PUBLIC_BASE_URL: podpisy Twilio a URL zpětných volání ho potřebují')" "PUBLIC_BASE_URL=https://${DOMAIN:-<domain>}"
  elif [ -n "${DOMAIN}" ]; then
    warn config.public_url "$(L 'PUBLIC_BASE_URL not set: passkeys follow the Host header' 'PUBLIC_BASE_URL není nastaveno: passkeys se řídí hlavičkou Host')" "PUBLIC_BASE_URL=https://${DOMAIN}"
  else
    skip config.public_url "$(L 'PUBLIC_BASE_URL not set (no domain)' 'PUBLIC_BASE_URL nenastaveno (bez domény)')"
  fi
  # Passkeys: the RP ID must be the origin's host or a registrable suffix of it.
  rp="$(ev WEBAUTHN_RP_ID)"; [ -n "${rp}" ] || { [ -n "${u}" ] && rp="$(url_host "${u}")"; }
  # Split on ',' and blanks into an array: no pathname expansion of .env data.
  read -r -a origins <<EOF_O
$(ev WEBAUTHN_ORIGINS | tr ',' ' ')
EOF_O
  [ "${#origins[@]}" -gt 0 ] || { [ -n "${u}" ] && origins=("${u}"); }
  if [ -z "${rp}" ]; then
    if [ "${INSTALLED}" = "1" ] && [ -n "${DOMAIN}" ]; then warn config.webauthn "$(L 'no WEBAUTHN_RP_ID / PUBLIC_BASE_URL: the passkey RP ID follows the Host header' 'chybí WEBAUTHN_RP_ID / PUBLIC_BASE_URL: RP ID passkeys se řídí hlavičkou Host')" "PUBLIC_BASE_URL=https://${DOMAIN}"
    else skip config.webauthn "$(L 'passkey settings not set' 'nastavení passkeys chybí')"; fi
    return 0
  fi
  for o in ${origins[@]+"${origins[@]}"}; do
    oh="$(url_host "${o}")"; du="$(safe_url "${o}" path)"; shown="${shown} ${du}"
    if [ "$(url_scheme "${o}")" != "https" ] && ! is_loopback "${oh}"; then bad="${bad} ${du}(http)"; continue; fi
    case "${oh}" in "${rp}"|*".${rp}") ;; *) bad="${bad} ${du}" ;; esac
  done
  if [ -n "${bad}" ]; then
    fail config.webauthn "$(L "passkey origins do not fit the RP ID ${rp}:${bad}" "originy passkeys neodpovídají RP ID ${rp}:${bad}")" "$(L 'WEBAUTHN_RP_ID must be the origin host or its parent domain; origins https://' 'WEBAUTHN_RP_ID musí být hostitel originu nebo jeho nadřazená doména; originy https://')"
  else pass config.webauthn "$(L "passkeys: RP ID ${rp}" "passkeys: RP ID ${rp}")${shown:+, $(L 'origins' 'originy')${shown}}"; fi
}

cfg_network() {
  local tp="" host=""
  tp="$(ev TRUST_PROXY)"
  if proxy_front; then
    case "$(lc "${tp}")" in
      "") pass config.trust_proxy "$(L 'TRUST_PROXY default (loopback; in a container also private ranges) — fits a proxy on this host' 'TRUST_PROXY výchozí (loopback; v kontejneru i privátní rozsahy) — odpovídá proxy na tomto stroji')" ;;
      true) warn config.trust_proxy "$(L 'TRUST_PROXY=true trusts every hop: clients can forge their address (rate limits)' 'TRUST_PROXY=true věří každému skoku: klienti mohou podvrhnout adresu (limity)')" "$(L 'a hop count (1) or the proxy address' 'počet skoků (1) nebo adresu proxy')" ;;
      false|0|off|no|none) warn config.trust_proxy "$(L "TRUST_PROXY=${tp} behind a proxy: every visitor shares one rate-limit bucket" "TRUST_PROXY=${tp} za proxy: všichni návštěvníci sdílejí jeden limit")" "$(L 'remove it (default loopback) or set the proxy address' 'odstraňte ho (výchozí loopback), nebo zadejte adresu proxy')" ;;
      *) pass config.trust_proxy "TRUST_PROXY=${tp}" ;;
    esac
  else
    if [ "$(lc "${tp}")" = "true" ]; then warn config.trust_proxy "$(L 'TRUST_PROXY=true without a proxy: clients can forge X-Forwarded-For' 'TRUST_PROXY=true bez proxy: klienti mohou podvrhnout X-Forwarded-For')" "$(L 'remove TRUST_PROXY' 'odstraňte TRUST_PROXY')"
    else pass config.trust_proxy "TRUST_PROXY=${tp:-$(L 'default' 'výchozí')}"; fi
  fi
  if [ "${MODE}" = "docker" ]; then
    pass config.host "$(L "HOST inside the container; published as $(cf BIND_ADDRESS):${APP_PORT} (see docker)" "HOST v kontejneru; publikováno jako $(cf BIND_ADDRESS):${APP_PORT} (viz docker)")"
  else
    host="$(ev HOST)"; [ -n "${host}" ] || host="0.0.0.0"
    if is_loopback "${host}"; then pass config.host "$(L "the app binds to ${host}:${APP_PORT}" "aplikace naslouchá na ${host}:${APP_PORT}")"
    elif proxy_front; then warn config.host "$(L "HOST=${host}: the app is reachable directly, around the proxy (no TLS, no proxy limits)" "HOST=${host}: aplikace je dostupná přímo, mimo proxy (bez TLS a limitů proxy)")" "$(L "update.sh --set BIND_ADDRESS=127.0.0.1" "update.sh --set BIND_ADDRESS=127.0.0.1")"
    else pass config.host "$(L "the app binds to ${host}:${APP_PORT} (no proxy in front)" "aplikace naslouchá na ${host}:${APP_PORT} (bez proxy)")"; fi
  fi
}

cfg_features() {
  local p="" probs="" v=""
  if is_on "$(ev ENABLE_TELEPHONY)"; then
    is_on "$(ev TELEPHONY_ALLOW_UNSIGNED)" && probs="${probs} TELEPHONY_ALLOW_UNSIGNED=1"
    [ -n "$(ev TELNYX_API_KEY)" ] && [ -z "$(ev TELNYX_PUBLIC_KEY)" ] && probs="${probs} TELNYX_PUBLIC_KEY"
    { [ -n "$(ev VONAGE_API_KEY)" ] || [ -n "$(ev VONAGE_APPLICATION_ID)" ]; } && [ -z "$(ev VONAGE_SIGNATURE_SECRET)" ] && probs="${probs} VONAGE_SIGNATURE_SECRET"
    [ -n "$(ev TWILIO_ACCOUNT_SID)" ] && [ -z "$(ev TWILIO_AUTH_TOKEN)" ] && probs="${probs} TWILIO_AUTH_TOKEN"
    if [ -n "${probs}" ]; then
      fail config.telephony "$(L "telephony webhooks cannot be verified:${probs}" "webhooky telefonie nelze ověřit:${probs}")" "$(L 'set the provider signature keys; never TELEPHONY_ALLOW_UNSIGNED=1 in production' 'nastavte podpisové klíče poskytovatelů; nikdy TELEPHONY_ALLOW_UNSIGNED=1 v provozu')"
    else pass config.telephony "$(L 'telephony: provider webhooks are signature-checked' 'telefonie: webhooky poskytovatelů se ověřují podpisem')"; fi
    is_on "$(ev VONAGE_ALLOW_UNSIGNED_SMS)" && warn config.telephony_sms "$(L 'VONAGE_ALLOW_UNSIGNED_SMS=1 accepts unsigned SMS webhooks' 'VONAGE_ALLOW_UNSIGNED_SMS=1 přijímá nepodepsané SMS webhooky')" "$(L 'turn on signed webhooks in the Vonage SMS API' 'zapněte podepsané webhooky v SMS API Vonage')"
  else
    skip config.telephony "$(L 'telephony off' 'telefonie vypnutá')"
  fi
  if is_on "$(ev HUB_REQUIRE_ROOM_PROOF)"; then pass config.room_proof "$(L 'HUB_REQUIRE_ROOM_PROOF=1: rooms admit only members with the join proof' 'HUB_REQUIRE_ROOM_PROOF=1: místnost pustí jen člena s důkazem')"
  else warn config.room_proof "$(L 'HUB_REQUIRE_ROOM_PROOF is off: clients older than 6.12 join without a proof (G-09)' 'HUB_REQUIRE_ROOM_PROOF je vypnuté: klienti starší než 6.12 vstoupí bez důkazu (G-09)')" "$(L 'set HUB_REQUIRE_ROOM_PROOF=1 once every client (web, Android) is 6.12+' 'nastavte HUB_REQUIRE_ROOM_PROOF=1, až budou všichni klienti (web, Android) 6.12+')"; fi
  v="$(lc "$(ev FUNCTIONS_SANDBOX_ISOLATION)")"
  case "${v}" in
    none|off|0|false|no) warn config.sandbox "$(L "FUNCTIONS_SANDBOX_ISOLATION=${v}: functions run without process isolation (bubblewrap)" "FUNCTIONS_SANDBOX_ISOLATION=${v}: funkce běží bez izolace procesu (bubblewrap)")" "$(L 'install bubblewrap and remove the setting (see system.bwrap)' 'nainstalujte bubblewrap a nastavení odstraňte (viz system.bwrap)')" ;;
    "") pass config.sandbox "$(L 'FUNCTIONS_SANDBOX_ISOLATION default (bubblewrap when present)' 'FUNCTIONS_SANDBOX_ISOLATION výchozí (bubblewrap, je-li k dispozici)')" ;;
    *) pass config.sandbox "FUNCTIONS_SANDBOX_ISOLATION=${v}" ;;
  esac
  if is_on "$(ev ACCESS_LOG_FULL_IP)"; then warn config.access_log "$(L 'ACCESS_LOG_FULL_IP=1 stores full client addresses' 'ACCESS_LOG_FULL_IP=1 ukládá celé adresy klientů')" "$(L 'remove it unless you must keep full addresses (privacy, GDPR)' 'odstraňte, pokud plné adresy nemusíte uchovávat (soukromí, GDPR)')"
  elif [ "$(ev ACCESS_LOG)" = "0" ]; then pass config.access_log "$(L 'access log off (ACCESS_LOG=0)' 'přístupový log vypnutý (ACCESS_LOG=0)')"
  else pass config.access_log "$(L 'access log with truncated addresses' 'přístupový log se zkrácenými adresami')"; fi
  if is_on "$(ev LOG_EVENTS)"; then warn config.log_events "$(L 'LOG_EVENTS=1 records connection metadata' 'LOG_EVENTS=1 zaznamenává metadata spojení')" "$(L 'LOG_EVENTS=0 unless compliance requires it' 'LOG_EVENTS=0, pokud to nevyžaduje compliance')"; fi
  if [ -n "$(ev TURN_SERVER_URL)" ]; then
    if [ -n "$(ev TURN_SECRET)" ]; then pass config.turn "$(L 'TURN with short-lived credentials (TURN_SECRET)' 'TURN s krátkodobými údaji (TURN_SECRET)')"
    elif [ -n "$(ev TURN_CREDENTIAL)" ]; then warn config.turn "$(L 'TURN with static credentials: anyone can copy them and relay through your server (F-28)' 'TURN se statickými údaji: kdokoli je zkopíruje a použije váš server jako relay (F-28)')" "$(L 'coturn use-auth-secret + TURN_SECRET' 'coturn use-auth-secret + TURN_SECRET')"
    else warn config.turn "$(L 'TURN_SERVER_URL without credentials' 'TURN_SERVER_URL bez přihlašovacích údajů')" "TURN_SECRET"; fi
  fi
  if is_on "$(cf ENABLE_PUSH)" || [ -n "$(ev VAPID_PUBLIC_KEY)$(ev VAPID_PRIVATE_KEY)" ]; then
    if [ -z "$(ev VAPID_PUBLIC_KEY)" ] || [ -z "$(ev VAPID_PRIVATE_KEY)" ]; then fail config.push "$(L 'Web Push needs both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY' 'Web Push potřebuje VAPID_PUBLIC_KEY i VAPID_PRIVATE_KEY')" "$(L "${ROOT}/update.sh --set ENABLE_PUSH=1 generates them" "${ROOT}/update.sh --set ENABLE_PUSH=1 je vygeneruje")"
    elif [ "$(ev VAPID_SUBJECT)" = "mailto:admin@example.org" ] || [ -z "$(ev VAPID_SUBJECT)" ]; then warn config.push "$(L 'VAPID_SUBJECT is the placeholder — push services use it to contact you' 'VAPID_SUBJECT je zástupná hodnota — push služby přes něj kontaktují provozovatele')" "VAPID_SUBJECT=mailto:<$(L 'your address' 'vaše adresa')>"
    else pass config.push "$(L 'Web Push: VAPID key pair set' 'Web Push: pár VAPID klíčů nastaven')"; fi
  fi
  if [ -n "$(ev REDIS_URL)" ]; then
    if [ -z "$(ev CLUSTER_SECRET)" ]; then warn config.cluster "$(L "REDIS_URL ($(safe_url "$(ev REDIS_URL)")) without CLUSTER_SECRET: cluster messages are not signed" "REDIS_URL ($(safe_url "$(ev REDIS_URL)")) bez CLUSTER_SECRET: zprávy clusteru nejsou podepsané")" "CLUSTER_SECRET=$(L '<32+ random bytes>' '<32+ náhodných bajtů>')"
    else pass config.cluster "$(L 'cluster over Redis, messages signed' 'cluster přes Redis, zprávy podepsané')"; fi
  fi
  v="$(ev STORAGE_MASTER_KEY)"
  if [ -n "${v}" ]; then
    if printf '%s' "${v}" | grep -Eq '^[0-9a-fA-F]{64}$|^[A-Za-z0-9+/_-]{42,44}={0,2}$'; then pass config.storage_key "$(L 'STORAGE_MASTER_KEY set (32 bytes)' 'STORAGE_MASTER_KEY nastaven (32 bajtů)')"
    else fail config.storage_key "$(L 'STORAGE_MASTER_KEY is not 32 bytes in hex or base64 — the storage stops' 'STORAGE_MASTER_KEY není 32 bajtů v hex nebo base64 — úložiště se zastaví')" "openssl rand -hex 32"; fi
  fi
}

cfg_perms() {
  local d="" m="" bad="" f="" n=""
  if [ -n "${DATA_BASE}" ] && [ -d "${DATA_BASE}" ]; then
    if [ -r "${DATA_BASE}" ] || is_root; then
      m="$(mode3 "${DATA_BASE}")"
      if [ "${m:2:1}" != "0" ]; then fail config.data_dir "$(L "data directory ${DATA_BASE} is open to everyone (mode ${m})" "datový adresář ${DATA_BASE} je otevřený všem (práva ${m})")" "chmod 700 ${DATA_BASE}"
      elif [ "${m:1:1}" != "0" ]; then warn config.data_dir "$(L "data directory ${DATA_BASE} mode ${m} (expected 700)" "datový adresář ${DATA_BASE} má práva ${m} (očekáváno 700)")" "chmod 700 ${DATA_BASE}"
      else pass config.data_dir "$(L "data directory ${DATA_BASE} (${m}, $(f_owner "${DATA_BASE}"))" "datový adresář ${DATA_BASE} (${m}, $(f_owner "${DATA_BASE}"))")"; fi
      # NUL-separated (C05): a key file whose name has a space or a newline is
      # checked too; the .env paths are quoted — never word-split or globbed.
      local -a keys
      keys=()
      while IFS= read -r -d '' f; do keys+=("${f}"); done < <(find "${DATA_BASE}" -maxdepth 4 -type f -name '*.key' -print0 2>/dev/null)
      for d in STORAGE_KEY_FILE FUNCTIONS_ADM_KEY_FILE ANDROID_SIGNING_KEY_FILE APNS_KEY_FILE; do
        [ -n "$(ev "${d}")" ] && keys+=("$(env_path "${d}")")
      done
      for f in ${keys[@]+"${keys[@]}"}; do
        [ -f "${f}" ] || continue
        m="$(mode3 "${f}")"
        [ "${m:1:2}" = "00" ] || bad="${bad} ${f}(${m})"
      done
      d=""
      if [ -n "${bad}" ]; then fail config.keys "$(L "key files readable by group/others:${bad}" "soubory klíčů čitelné pro skupinu/ostatní:${bad}")" "chmod 600 <$(L 'file' 'soubor')>"
      else pass config.keys "$(L 'key files (storage.key, audit-signing.key, …) are private (600)' 'soubory klíčů (storage.key, audit-signing.key, …) jsou soukromé (600)')"; fi
    else need_root config.data_dir "$(L "data directory ${DATA_BASE}" "datový adresář ${DATA_BASE}")"; fi
  elif [ "${INSTALLED}" = "1" ] && [ "${MODE}" != "docker" ]; then
    skip config.data_dir "$(L "data directory ${DATA_BASE:-?} does not exist yet" "datový adresář ${DATA_BASE:-?} zatím neexistuje")"
  fi
  [ "${TREE}" = "1" ] || [ "${INSTALLED}" = "1" ] || return 0
  # World-writable anything under the install root: anyone could change what the service runs.
  n="$(find "${ROOT}" -xdev \( -path "${ROOT}/node_modules" -o -path "${ROOT}/.git" \) -prune -o -perm -0002 ! -type l -print 2>/dev/null | head -n 20)"
  if [ -n "${n}" ]; then fail config.world_writable "$(L "world-writable under the install root: $(list_hint "${n}")" "zapisovatelné pro všechny v instalačním adresáři: $(list_hint "${n}")")" "chmod o-w <$(L 'path' 'cesta')>"
  else pass config.world_writable "$(L 'nothing under the install root is world-writable' 'nic v instalačním adresáři není zapisovatelné pro všechny')"; fi
  # Secrets readable by others anywhere in the tree (backups of .env, keys, Firebase admin keys).
  n="$(find "${ROOT}" -xdev \( -path "${ROOT}/node_modules" -o -path "${ROOT}/dist/node_modules" -o -path "${ROOT}/.git" \) -prune -o -type f \( -name '.env*' -o -name '*.key' -o -name '*.pem' -o -name '*.p12' -o -name '*.jks' -o -name '*.keystore' -o -name '*firebase-adminsdk*.json' -o -name 'serviceAccount*.json' -o -name 'install.conf' \) ! -name '.env.example' -perm -0004 -print 2>/dev/null | head -n 20)"
  if [ -n "${n}" ]; then
    if [ "$(other_bits "${ROOT}")" = "0" ]; then
      warn config.secret_files "$(L "readable by others (the install directory itself is closed): $(list_hint "${n}")" "čitelné pro ostatní (instalační adresář je ale uzavřený): $(list_hint "${n}")")" "chmod 600 <$(L 'file' 'soubor')>"
    else
      fail config.secret_files "$(L "secret files readable by everyone: $(list_hint "${n}")" "soubory s tajemstvím čitelné pro všechny: $(list_hint "${n}")")" "chmod 600 <$(L 'file' 'soubor')>; $(L 'rotate what they contain' 'jejich obsah vyměňte')"
    fi
  else pass config.secret_files "$(L 'no secret file in the tree is readable by others' 'žádný soubor s tajemstvím ve stromu není čitelný pro ostatní')"; fi
  n="$(find "${ROOT}" -maxdepth 1 -type f \( -name '.env?*' -o -name '*.bak' \) ! -name '.env.example' 2>/dev/null)"
  if [ -n "${n}" ]; then warn config.stale_copies "$(L "copies of secrets next to .env: $(list_hint "${n}")" "kopie tajemství vedle .env: $(list_hint "${n}")")" "$(L 'delete them (backups are in BACKUP_ROOT, 0700)' 'smažte je (zálohy jsou v BACKUP_ROOT, 0700)')"; fi
  d="$(conf_path BACKUP_ROOT)"; [ -n "${d}" ] || d="${ROOT}/.m5cet/backups"
  if [ -d "${d}" ]; then
    m="$(mode3 "${d}")"
    if [ "${m:1:2}" != "00" ]; then warn config.backup_perms "$(L "installer backups ${d} mode ${m} (they hold .env copies)" "zálohy instalátoru ${d} mají práva ${m} (obsahují kopie .env)")" "chmod 700 ${d}"
    else pass config.backup_perms "$(L "installer backups ${d} (${m})" "zálohy instalátoru ${d} (${m})")"; fi
  fi
}

check_config() {
  sec config "Konfigurace" "Configuration"
  if [ "${INSTALLED}" = "0" ] && [ ! -e "${ENV_FILE}" ]; then
    skip config.env "$(L 'not installed (no .m5cet/install.conf, no .env)' 'neinstalováno (chybí .m5cet/install.conf i .env)')"
    return 0
  fi
  cfg_env_file
  if [ "${ENV_READABLE}" = "1" ]; then
    cfg_node_env; cfg_admin; cfg_urls; cfg_network; cfg_features
  fi
  cfg_perms
}

# ===========================================================================
# runtime
# ===========================================================================
UNIT_PROPS=""
unit_prop() { printf '%s\n' "${UNIT_PROPS}" | sed -n "s/^$1=//p" | head -n1; }
NODE_BIN=""

rt_node() {
  local v="" major=""
  if [ "${MODE}" = "docker" ]; then skip runtime.node "$(L 'docker mode: Node comes with the image' 'režim docker: Node je v image')"; return 0; fi
  NODE_BIN=""
  if [ "${MANAGER}" = "systemd" ] && have systemctl; then
    NODE_BIN="$(systemctl show "${SERVICE}.service" -p ExecStart 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -n1)"
    [ -n "${NODE_BIN}" ] && [ -x "${NODE_BIN}" ] || NODE_BIN=""
  fi
  if [ -z "${NODE_BIN}" ] && have node; then NODE_BIN="$(command -v node)"; fi
  if [ -z "${NODE_BIN}" ]; then
    if [ "${INSTALLED}" = "1" ]; then fail runtime.node "$(L 'node not found' 'node nenalezen')" "$(L 'install Node.js 24 LTS (update.sh --repair does it)' 'nainstalujte Node.js 24 LTS (update.sh --repair to udělá)')"
    else warn runtime.node "$(L 'node not found (the native mode needs Node >= 22)' 'node nenalezen (nativní režim potřebuje Node >= 22)')" "$(L 'install Node.js 24 LTS' 'nainstalujte Node.js 24 LTS')"; fi
    return 0
  fi
  v="$("${NODE_BIN}" --version 2>/dev/null)"; major="$(printf '%s' "${v}" | sed -E 's/^v?([0-9]+).*/\1/')"
  if ! is_uint "${major}"; then fail runtime.node "$(L "${NODE_BIN} does not run" "${NODE_BIN} nejde spustit")" "$(L 'reinstall Node.js 24 LTS' 'přeinstalujte Node.js 24 LTS')"; return 0; fi
  if [ "${major}" -lt 22 ]; then fail runtime.node "$(L "Node ${v} is too old (>= 22 required)" "Node ${v} je příliš starý (vyžadováno >= 22)")" "$(L 'install Node.js 24 LTS (update.sh --repair)' 'nainstalujte Node.js 24 LTS (update.sh --repair)')"
  elif [ $((major % 2)) -eq 1 ]; then warn runtime.node "$(L "Node ${v} is not an LTS line" "Node ${v} není řada LTS")" "$(L 'use Node.js 24 LTS' 'použijte Node.js 24 LTS')"
  else pass runtime.node "$(L "Node ${v} (${NODE_BIN})" "Node ${v} (${NODE_BIN})")"; fi
  if "${NODE_BIN}" --permission -e 0 >/dev/null 2>&1; then pass runtime.permission "$(L 'node --permission works (Functions sandbox)' 'node --permission funguje (sandbox funkcí)')"
  elif "${NODE_BIN}" --experimental-permission -e 0 >/dev/null 2>&1; then pass runtime.permission "$(L 'node --experimental-permission works (older 22.x)' 'node --experimental-permission funguje (starší 22.x)')"
  else fail runtime.permission "$(L 'this Node has no permission model — the Functions sandbox cannot start' 'tento Node nemá permission model — sandbox funkcí nenastartuje')" "$(L 'Node.js 24 LTS' 'Node.js 24 LTS')"; fi
}

rt_systemd_unit() {
  local unit="$1" label="$2" load="" active="" enabled="" user="" nnp="" ps="" ph="" pt="" caps="" raf="" mdwe="" nofile=""
  UNIT_PROPS="$(systemctl show "${unit}" -p LoadState -p ActiveState -p SubState -p UnitFileState -p User -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p CapabilityBoundingSet -p RestrictAddressFamilies -p MemoryDenyWriteExecute -p LimitNOFILE -p RestrictNamespaces -p MainPID 2>/dev/null)"
  load="$(unit_prop LoadState)"; active="$(unit_prop ActiveState)"; enabled="$(unit_prop UnitFileState)"
  if [ "${load}" != "loaded" ]; then fail "runtime.${label}" "$(L "${unit} is not installed (${load:-?})" "${unit} není nainstalovaná (${load:-?})")" "$(L "${ROOT}/update.sh --repair" "${ROOT}/update.sh --repair")"; return 1; fi
  if [ "${active}" = "active" ]; then pass "runtime.${label}" "$(L "${unit} active (${enabled})" "${unit} běží (${enabled})")"
  else fail "runtime.${label}" "$(L "${unit} is ${active:-?}" "${unit} je ${active:-?}")" "$(L "journalctl -u ${unit} -n 50; systemctl restart ${unit}" "journalctl -u ${unit} -n 50; systemctl restart ${unit}")"; fi
  [ "${enabled}" = "enabled" ] || warn "runtime.${label}_enabled" "$(L "${unit} does not start at boot (${enabled})" "${unit} nestartuje po zapnutí (${enabled})")" "systemctl enable ${unit}"
  user="$(unit_prop User)"; nnp="$(unit_prop NoNewPrivileges)"; ps="$(unit_prop ProtectSystem)"; ph="$(unit_prop ProtectHome)"
  pt="$(unit_prop PrivateTmp)"; caps="$(unit_prop CapabilityBoundingSet)"; raf="$(unit_prop RestrictAddressFamilies)"
  mdwe="$(unit_prop MemoryDenyWriteExecute)"; nofile="$(unit_prop LimitNOFILE)"
  local weak=""
  if [ -z "${user}" ] || [ "${user}" = "root" ] || [ "${user}" = "0" ]; then
    fail "runtime.${label}_user" "$(L "${unit} runs as root" "${unit} běží jako root")" "$(L "User=${SVC_USER:-m5cet} (update.sh --repair)" "User=${SVC_USER:-m5cet} (update.sh --repair)")"
  fi
  [ "${nnp}" = "yes" ] || weak="${weak} NoNewPrivileges=${nnp:-no}"
  case "${ps}" in strict) ;; *) weak="${weak} ProtectSystem=${ps:-no}" ;; esac
  case "${ph}" in yes|read-only|tmpfs) ;; *) weak="${weak} ProtectHome=${ph:-no}" ;; esac
  [ "${pt}" = "yes" ] || weak="${weak} PrivateTmp=${pt:-no}"
  case "${caps}" in ""|cap_net_bind_service) ;; *) weak="${weak} CapabilityBoundingSet=$(printf '%s' "${caps}" | cut -c1-40)…" ;; esac
  [ -n "${raf}" ] && [ "${raf}" != "none" ] || weak="${weak} RestrictAddressFamilies=-"
  if is_uint "${nofile}" && [ "${nofile}" -lt 65536 ]; then weak="${weak} LimitNOFILE=${nofile}"; fi
  if [ "${mdwe}" = "yes" ]; then
    fail "runtime.${label}_mdwe" "$(L "${unit}: MemoryDenyWriteExecute=yes breaks the V8 JIT (Node crashes)" "${unit}: MemoryDenyWriteExecute=yes rozbije JIT V8 (Node spadne)")" "$(L 'remove MemoryDenyWriteExecute from the unit / drop-ins' 'odstraňte MemoryDenyWriteExecute z jednotky / drop-inů')"
  fi
  if [ -n "${weak}" ]; then
    warn "runtime.${label}_hardening" "$(L "${unit} hardening weaker than the installer's:${weak}" "zabezpečení ${unit} je slabší než od instalátoru:${weak}")" "$(L "regenerate the unit: ${ROOT}/update.sh --repair; check drop-ins: systemctl cat ${unit}" "znovu vygenerujte jednotku: ${ROOT}/update.sh --repair; drop-iny: systemctl cat ${unit}")"
  else
    pass "runtime.${label}_hardening" "$(L "${unit}: User=${user}, NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, no capabilities, LimitNOFILE=${nofile}" "${unit}: User=${user}, NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, bez capabilities, LimitNOFILE=${nofile}")"
  fi
  return 0
}

# pid_alive PID — the process exists and is not a zombie (a crashed app whose
# parent never reaped it still answers kill -0).
pid_alive() {
  local pid="$1" stat=""
  is_uint "${pid}" || return 1
  kill -0 "${pid}" 2>/dev/null || ps -p "${pid}" >/dev/null 2>&1 || return 1
  if [ -r "/proc/${pid}/stat" ]; then
    stat="$(awk '{ sub(/^.*\) /, ""); print $1 }' "/proc/${pid}/stat" 2>/dev/null)"
    [ "${stat}" = "Z" ] && return 1
  fi
  return 0
}

# app_proc PID SCRIPT — 0 when PID is M5cet's own process for dist/SCRIPT as
# the process manager starts it (`node dist/SCRIPT` in the tree): a node
# binary, dist/SCRIPT among its arguments, run by the owner of the tree (or
# root — reported), and — where /proc or lsof shows it — in the tree. A pid
# file is written by whoever can write .m5cet/run; it must not make any
# other process (its limits, its user) count as the service (C11).
# APP_PROC_WHY: comm | args | user | cwd.
APP_PROC_WHY=""
app_proc() {
  local pid="$1" script="$2" comm="" args="" a0="" uid="" want="" cwd="" real=""
  APP_PROC_WHY=""
  comm="$(ps -o comm= -p "${pid}" 2>/dev/null | head -n1)"; comm="${comm##*/}"
  args="$(ps -o args= -p "${pid}" 2>/dev/null | head -n1)"
  a0="${args%% *}"; a0="${a0##*/}"
  # The binary (comm; Linux may show the main thread's name) or argv[0] is node.
  case "${comm}:${a0}" in node:*|nodejs:*|node[0-9]*:*|*:node|*:nodejs|*:node[0-9]*) ;; *) APP_PROC_WHY="comm"; return 1 ;; esac
  case " ${args} " in *" dist/${script} "*|*"/dist/${script} "*) ;; *) APP_PROC_WHY="args"; return 1 ;; esac
  uid="$(ps -o uid= -p "${pid}" 2>/dev/null | tr -d ' ')"; want="$(f_uid "${ROOT}")"
  if [ -n "${want}" ] && [ "${uid}" != "${want}" ] && [ "${uid}" != "0" ]; then APP_PROC_WHY="user"; return 1; fi
  real="$(cd "${ROOT}" 2>/dev/null && pwd -P)"
  if [ -z "${SYSROOT}" ] && [ -d "/proc/${pid}" ]; then cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null)"
  elif have lsof; then cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1)"; fi
  if [ -n "${cwd}" ] && [ -n "${real}" ] && [ "${cwd}" != "${real}" ]; then
    case " ${args} " in *" ${real}/dist/${script} "*|*" ${ROOT}/dist/${script} "*) ;; *) APP_PROC_WHY="cwd"; return 1 ;; esac
  fi
  return 0
}
app_proc_why() {
  case "${APP_PROC_WHY}" in
    comm) L 'not a node process' 'není to proces node' ;;
    args) L "not running dist/$1" "nespouští dist/$1" ;;
    user) L 'run by another user than the owner of the tree' 'běží pod jiným uživatelem než vlastník stromu' ;;
    *) L 'running outside the install tree' 'běží mimo instalační strom' ;;
  esac
}

MAIN_PID=""; SERVICE_UP=""
rt_service() {
  if [ "${INSTALLED}" = "0" ]; then skip runtime.service "$(L 'not installed' 'neinstalováno')"; return 0; fi
  case "${MANAGER}" in
    systemd)
      if ! have systemctl; then skip runtime.service "$(L 'systemctl missing' 'chybí systemctl')"; return 0; fi
      if rt_systemd_unit "${SERVICE}.service" service; then
        MAIN_PID="$(printf '%s\n' "${UNIT_PROPS}" | sed -n 's/^MainPID=//p')"
        if [ "$(unit_prop ActiveState)" = "active" ]; then SERVICE_UP=1; else SERVICE_UP=0; fi
      else SERVICE_UP=0; fi
      # bwrap needs namespaces the unit may forbid (see system.bwrap).
      UNIT_RESTRICT_NS="$(systemctl show "${SERVICE}.service" -p RestrictNamespaces 2>/dev/null | sed -n 's/^RestrictNamespaces=//p')"
      UNIT_RAF="$(systemctl show "${SERVICE}.service" -p RestrictAddressFamilies 2>/dev/null | sed -n 's/^RestrictAddressFamilies=//p')"
      if [ "${ADMIN_ON}" = "1" ]; then rt_systemd_unit "${SERVICE}-admin.service" admin; fi ;;
    process)
      local pf="${ROOT}/.m5cet/run/app.pid" pid="" u=""
      pid=""; [ -f "${pf}" ] && pid="$(head -n1 "${pf}" 2>/dev/null)"; case "${pid}" in ""|0*|*[!0-9]*) pid="" ;; esac
      if pid_alive "${pid}" && app_proc "${pid}" index.cjs; then
        MAIN_PID="${pid}"; SERVICE_UP=1; u="$(ps -o user= -p "${pid}" 2>/dev/null | tr -d ' ')"
        if [ "$(ps -o uid= -p "${pid}" 2>/dev/null | tr -d ' ')" = "0" ]; then warn runtime.service "$(L "the app (pid ${pid}) runs as root" "aplikace (pid ${pid}) běží jako root")" "$(L 'a user-scope install should run as its owner' 'uživatelská instalace má běžet pod svým vlastníkem')"
        else pass runtime.service "$(L "the app runs (pid ${pid}, ${u:-?})" "aplikace běží (pid ${pid}, ${u:-?})")"; fi
      elif pid_alive "${pid}"; then
        SERVICE_UP=0
        fail runtime.service "$(L "the app is not running — the pid file names pid ${pid}: $(app_proc_why index.cjs) (a stale or forged .m5cet/run/app.pid)" "aplikace neběží — soubor pid ukazuje na pid ${pid}: $(app_proc_why index.cjs) (zastaralý nebo podvržený .m5cet/run/app.pid)")" \
          "${ROOT}/install.sh --start; $(L 'logs' 'logy'): ${ROOT}/.m5cet/logs/app.log"
      else
        SERVICE_UP=0
        fail runtime.service "$(L 'the app is not running (process manager)' 'aplikace neběží (správce procesu)')" "${ROOT}/install.sh --start; $(L 'logs' 'logy'): ${ROOT}/.m5cet/logs/app.log"
      fi
      if [ "${ADMIN_ON}" = "1" ]; then
        pf="${ROOT}/.m5cet/run/admin.pid"; pid=""; [ -f "${pf}" ] && pid="$(head -n1 "${pf}" 2>/dev/null)"; case "${pid}" in ""|0*|*[!0-9]*) pid="" ;; esac
        if pid_alive "${pid}" && app_proc "${pid}" admin.cjs; then pass runtime.admin "$(L 'the admin API runs' 'admin API běží')"
        elif pid_alive "${pid}"; then
          fail runtime.admin "$(L "the admin API is not running — the pid file names pid ${pid}: $(app_proc_why admin.cjs)" "admin API neběží — soubor pid ukazuje na pid ${pid}: $(app_proc_why admin.cjs)")" "${ROOT}/install.sh --restart"
        else fail runtime.admin "$(L 'the admin API is not running' 'admin API neběží')" "${ROOT}/install.sh --restart"; fi
      fi ;;
    compose) skip runtime.service "$(L 'docker compose — see the docker section' 'docker compose — viz sekce docker')" ;;
    *) skip runtime.service "$(L "unknown service manager '${MANAGER}'" "neznámý správce služby '${MANAGER}'")" ;;
  esac
}

rt_ports() {
  [ "${INSTALLED}" = "1" ] || return 0
  if [ "${SERVICE_UP}" = "0" ]; then skip runtime.ports "$(L 'the service is not running' 'služba neběží')"; return 0; fi
  if ! have ss && ! have lsof; then skip runtime.ports "$(L 'neither ss nor lsof' 'chybí ss i lsof')"; return 0; fi
  local a=""
  a="$(listen_addrs "${APP_PORT}" | tr '\n' ' ')"
  if [ -z "${a// /}" ]; then fail runtime.ports "$(L "nothing listens on port ${APP_PORT}" "na portu ${APP_PORT} nic nenaslouchá")" "$(L 'start the service; check the logs' 'spusťte službu; podívejte se do logů')"
  else
    local exp="${BIND}"; [ "${MODE}" = "docker" ] && exp="$(cf BIND_ADDRESS)"
    if listen_public "${APP_PORT}" && is_loopback "${exp:-127.0.0.1}"; then
      warn runtime.ports "$(L "port ${APP_PORT} listens on ${a}but ${exp} was configured" "port ${APP_PORT} naslouchá na ${a}ale nastaveno je ${exp}")" "$(L 'restart the service after a BIND_ADDRESS change (update.sh)' 'po změně BIND_ADDRESS službu restartujte (update.sh)')"
    else pass runtime.ports "$(L "port ${APP_PORT}: ${a}" "port ${APP_PORT}: ${a}")"; fi
  fi
  if [ "${ADMIN_ON}" = "1" ]; then
    a="$(listen_addrs "${ADMIN_PORT}" | tr '\n' ' ')"
    if [ -z "${a// /}" ]; then fail runtime.admin_port "$(L "admin API: nothing listens on ${ADMIN_PORT}" "admin API: na ${ADMIN_PORT} nic nenaslouchá")" "$(L 'start the admin service' 'spusťte službu admin')"
    elif listen_public "${ADMIN_PORT}"; then fail runtime.admin_port "$(L "admin API listens on ${a}— beyond loopback" "admin API naslouchá na ${a}— mimo loopback")" "ADMIN_BIND=127.0.0.1"
    else pass runtime.admin_port "$(L "admin API on ${a}" "admin API na ${a}")"; fi
  fi
}

rt_health() {
  [ "${INSTALLED}" = "1" ] || return 0
  if [ "${SERVICE_UP}" = "0" ]; then skip runtime.health "$(L 'the service is not running' 'služba neběží')"; return 0; fi
  health_probe
  if [ "${HEALTH_CODE}" = "nocurl" ]; then skip runtime.health "$(L 'curl missing' 'chybí curl')"; return 0; fi
  if [ "${HEALTH_CODE}" = "200" ] && printf '%s' "${HEALTH_BODY}" | grep -q '"ok":true'; then
    pass runtime.health "$(L "GET /api/health → 200 ($(printf '%s' "${HEALTH_BODY}" | sed -n 's/.*"version":"\([^"]*\)".*"build":"\([^"]*\)".*/\1 · \2/p'))" "GET /api/health → 200 ($(printf '%s' "${HEALTH_BODY}" | sed -n 's/.*"version":"\([^"]*\)".*"build":"\([^"]*\)".*/\1 · \2/p'))")"
  else
    fail runtime.health "$(L "GET http://$(probe_host):${APP_PORT}/api/health → ${HEALTH_CODE}" "GET http://$(probe_host):${APP_PORT}/api/health → ${HEALTH_CODE}")" "$(L "${ROOT}/install.sh --logs" "${ROOT}/install.sh --logs")"
  fi
  local first=""
  first="$(curl -s -i -m 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://$(probe_host):${APP_PORT}/ws" 2>/dev/null | head -n1 | tr -d '\r')"
  case "${first}" in
    *" 101"*) pass runtime.websocket "$(L 'WebSocket /ws → 101' 'WebSocket /ws → 101')" ;;
    *) fail runtime.websocket "$(L "WebSocket /ws: ${first:-no answer}" "WebSocket /ws: ${first:-žádná odpověď}")" "$(L 'check the logs; the hub refuses upgrades on other paths' 'zkontrolujte logy; hub odmítá upgrade na jiných cestách')" ;;
  esac
  if [ "${ADMIN_ON}" = "1" ]; then
    http_get "http://127.0.0.1:${ADMIN_PORT}/admin/health" 4
    if [ "${HG_CODE}" = "200" ]; then pass runtime.admin_health "GET /admin/health → 200"
    else fail runtime.admin_health "$(L "GET /admin/health → ${HG_CODE}" "GET /admin/health → ${HG_CODE}")" "$(L "${ROOT}/install.sh --logs" "${ROOT}/install.sh --logs")"; fi
  fi
}

rt_logs() {
  [ "${INSTALLED}" = "1" ] || return 0
  local f="" sz=""
  case "${MANAGER}" in
    systemd) pass runtime.logs "$(L "logs in journald (journalctl -u ${SERVICE}), rotated by journald" "logy v journald (journalctl -u ${SERVICE}), rotuje journald")" ;;
    process)
      f="${ROOT}/.m5cet/logs/app.log"
      if [ -f "${f}" ]; then
        sz="$(wc -c < "${f}" 2>/dev/null | tr -d ' ')"
        if grep -rqs "${ROOT}/.m5cet/logs" "$(sp /etc/logrotate.d)" "$(sp /etc/newsyslog.d)" 2>/dev/null; then pass runtime.logs "$(L "${f} (rotated)" "${f} (rotuje se)")"
        elif is_uint "${sz}" && [ "${sz}" -gt 104857600 ]; then warn runtime.logs "$(L "${f} is $((sz/1048576)) MB and nothing rotates it" "${f} má $((sz/1048576)) MB a nic ho nerotuje")" "$(L 'add a logrotate rule (copytruncate) for it' 'přidejte pro něj pravidlo logrotate (copytruncate)')"
        else pass runtime.logs "$(L "${f} (${sz:-?} B, no rotation)" "${f} (${sz:-?} B, bez rotace)")"; fi
        if [ ! -w "${f}" ] && [ "$(f_owner "${f}")" = "$(id -un 2>/dev/null)" ]; then fail runtime.logs_writable "$(L "${f} is not writable" "${f} není zapisovatelný")" "chmod u+w ${f}"; fi
      else skip runtime.logs "$(L "no ${f} yet" "${f} zatím neexistuje")"; fi ;;
    compose) skip runtime.logs "$(L 'docker log driver — see docker' 'log driver dockeru — viz docker')" ;;
  esac
}

check_runtime() {
  sec runtime "Běh" "Runtime"
  rt_node
  rt_service
  rt_ports
  rt_health
  rt_logs
}

# ===========================================================================
# http — reverse proxy and TLS
# ===========================================================================

# nginx -T → "ctx<TAB>directive<TAB>args", block opens as "ctx<TAB>{<TAB>header".
# Includes are inlined where they appear (nginx -T prints every file once).
NGX_PARSE_AWK='
/^# configuration file .*:$/ { cur = $0; sub(/^# configuration file /, "", cur); sub(/:$/, "", cur); if (!(cur in seen)) { seen[cur] = 1; order[++nf] = cur } ; next }
{ if (cur != "") content[cur] = content[cur] $0 "\n" }
END {
  if (nf == 0) exit 3
  confdir = order[1]; sub(/\/[^\/]*$/, "", confdir)
  depth = 0; ctx[0] = "main"; srv = 0; inc = 0
  parse(order[1])
}
function parse(file,   s, n, i, c, tok, inq, nt, toks) {
  s = content[file]; n = length(s); tok = ""; inq = ""; nt = 0
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (inq != "") {
      if (c == "\\" && i < n) { tok = tok substr(s, i + 1, 1); i++; continue }
      if (c == inq) { inq = ""; continue }
      tok = tok c; continue
    }
    if (c == "#" && tok == "") { while (i <= n && substr(s, i, 1) != "\n") i++; continue }
    if ((c == "\"" || c == "\047") && tok == "") { inq = c; tok = ""; quoted = 1; continue }
    if (c == " " || c == "\t" || c == "\n" || c == "\r") { if (tok != "" || quoted) { toks[++nt] = tok; tok = ""; quoted = 0 } ; continue }
    if (c == ";" || c == "{" || c == "}") {
      if (tok != "" || quoted) { toks[++nt] = tok; tok = ""; quoted = 0 }
      if (c == ";") { if (nt > 0) stmt(toks, nt) }
      else if (c == "{") { blk(toks, nt) }
      else { if (depth > 0) depth-- }
      nt = 0; continue
    }
    tok = tok c
  }
}
function blk(toks, nt,   h, j, label) {
  h = toks[1]; for (j = 2; j <= nt; j++) h = h " " toks[j]
  if (toks[1] == "server" && ctx[depth] ~ /(^main|>http)$/) { srv++; label = "server#" srv }
  else if (toks[1] == "location") { label = "location:" toks[2]; for (j = 3; j <= nt; j++) label = label " " toks[j] }
  else if (toks[1] == "upstream") label = "upstream:" toks[2]
  else label = toks[1]
  depth++; ctx[depth] = ctx[depth - 1] ">" label
  print ctx[depth] "\t{\t" h
}
function stmt(toks, nt,   j, a, pat, re, f, k) {
  if (toks[1] == "include" && nt >= 2) {
    pat = toks[2]; if (pat !~ /^\//) pat = confdir "/" pat
    re = pat; gsub(/[.+^$(){}|\[\]\\]/, "\\\\&", re); gsub(/\*/, "[^/]*", re); gsub(/\?/, ".", re); re = "^" re "$"
    if (++inc > 200) return
    for (k = 1; k <= nf; k++) if (order[k] ~ re) parse(order[k])
    return
  }
  a = ""; for (j = 2; j <= nt; j++) a = a (j > 2 ? " " : "") toks[j]
  print ctx[depth] "\t" toks[1] "\t" a
}'

# Effective value(s) of directive D for request path P in server block S:
# "@loc<TAB>label" first, then one line per value (location > server > http,
# replaced as a whole — the nginx inheritance of add_header / proxy_set_header).
NGX_QUERY_AWK='
BEGIN { FS = "\t"; nloc = 0; ns = 0; nh = 0 }
$2 == "{" {
  if (index($1, S ">location:") == 1) { rest = substr($1, length(S) + 11); if (rest !~ />/) { nloc++; locctx[nloc] = $1; lab = rest; m = ""; if (lab ~ /^(=|~\*|~|\^~) /) { m = lab; sub(/ .*/, "", m); lab = substr(lab, length(m) + 2) } ; lmod[nloc] = m; lpat[nloc] = lab } }
  next
}
$2 != D { next }
$1 == S { sv[++ns] = $3; next }
$1 == "main>http" { hv[++nh] = $3; next }
{ for (i = 1; i <= nloc; i++) if ($1 == locctx[i]) { lv[i, ++lc[i]] = $3; next } }
END {
  best = 0; bestlen = -1
  for (i = 1; i <= nloc; i++) if (lmod[i] == "=" && lpat[i] == P) { best = i; break }
  if (!best) {
    for (i = 1; i <= nloc; i++) if ((lmod[i] == "" || lmod[i] == "^~") && index(P, lpat[i]) == 1 && length(lpat[i]) > bestlen) { best = i; bestlen = length(lpat[i]) }
    if (!(best && lmod[best] == "^~")) {
      for (i = 1; i <= nloc; i++) if (lmod[i] == "~" || lmod[i] == "~*") {
        re = lpat[i]; gsub(/\\d/, "[0-9]", re); gsub(/\\w/, "[A-Za-z0-9_]", re); gsub(/\\s/, "[ \t]", re); gsub(/\(\?:/, "(", re); gsub(/\(\?i\)/, "", re)
        if ((lmod[i] == "~" && P ~ re) || (lmod[i] == "~*" && tolower(P) ~ tolower(re))) { best = i; break }
      }
    }
  }
  if (best) print "@loc\t" lmod[best] (lmod[best] == "" ? "" : " ") lpat[best]; else print "@loc\t"
  if (best && lc[best] > 0) { for (j = 1; j <= lc[best]; j++) print lv[best, j]; exit }
  if (ns > 0) { for (j = 1; j <= ns; j++) print sv[j]; exit }
  for (j = 1; j <= nh; j++) print hv[j]
}'

NGX_FLAT=""
ngx_q() { awk -v S="$1" -v P="$2" -v D="$3" "${NGX_QUERY_AWK}" "${NGX_FLAT}" 2>/dev/null; }
ngx_loc() { ngx_q "$1" "$2" "$3" | head -n1 | cut -f2; }
ngx_vals() { ngx_q "$1" "$2" "$3" | tail -n +2; }
# Directive values set directly in a context (no inheritance).
ngx_in() { awk -F'\t' -v c="$1" -v d="$2" '$1 == c && $2 == d { print $3 }' "${NGX_FLAT}"; }
ngx_size_bytes() {   # 12m → bytes; 0 = unlimited
  printf '%s' "$1" | awk '{ v = tolower($0); n = v + 0; u = substr(v, length(v)); if (u == "k") n *= 1024; else if (u == "m") n *= 1048576; else if (u == "g") n *= 1073741824; printf "%d\n", n }'
}
ngx_secs() {   # 1h / 3600s / 60 → seconds
  printf '%s' "$1" | awk '{ v = tolower($0); t = 0; while (match(v, /^[0-9]+(ms|[smhd])?/)) { part = substr(v, 1, RLENGTH); n = part + 0; u = part; sub(/^[0-9]+/, "", u); if (u == "ms") n = n / 1000; else if (u == "m") n *= 60; else if (u == "h") n *= 3600; else if (u == "d") n *= 86400; t += n; v = substr(v, RLENGTH + 1) } printf "%d\n", t }'
}

HTTP_OURS=""; HTTP_TLS_SRV=""; APP_TARGET_RE=""; ADMIN_TARGET_RE=""
http_targets() {
  local ups_app="" ups_adm=""
  ups_app="$(awk -F'\t' -v p=":${APP_PORT}" '$1 ~ /^main>http>upstream:/ && $2 == "server" { split($3, a, " "); if (substr(a[1], length(a[1]) - length(p) + 1) == p) { u = $1; sub(/^.*upstream:/, "", u); print u } }' "${NGX_FLAT}" | sort -u | tr '\n' '|')"
  ups_adm="$(awk -F'\t' -v p=":${ADMIN_PORT}" '$1 ~ /^main>http>upstream:/ && $2 == "server" { split($3, a, " "); if (substr(a[1], length(a[1]) - length(p) + 1) == p) { u = $1; sub(/^.*upstream:/, "", u); print u } }' "${NGX_FLAT}" | sort -u | tr '\n' '|')"
  APP_TARGET_RE="://(127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0|${BIND//./\\.}):${APP_PORT}([/;]|$)"
  [ -n "${ups_app}" ] && APP_TARGET_RE="${APP_TARGET_RE}|://(${ups_app%|})([/:;]|$)"
  ADMIN_TARGET_RE="://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${ADMIN_PORT}([/;]|$)"
  [ -n "${ups_adm}" ] && ADMIN_TARGET_RE="${ADMIN_TARGET_RE}|://(${ups_adm%|})([/:;]|$)"
}
# Server blocks that belong to us: server_name = DOMAIN, else the ones proxying to the app.
http_our_servers() {
  local s="" names=""
  HTTP_OURS=""
  for s in $(awk -F'\t' '$2 == "{" && $1 ~ /^main>http>server#[0-9]+$/ { print $1 }' "${NGX_FLAT}"); do
    names=" $(ngx_in "${s}" server_name | tr '\n' ' ') "
    if [ -n "${DOMAIN}" ]; then
      case "${names}" in *" ${DOMAIN} "*) HTTP_OURS="${HTTP_OURS} ${s}"; continue ;; esac
      local w=""
      for w in ${names}; do case "${w}" in "*."*) case "${DOMAIN}" in *"${w#\*}") HTTP_OURS="${HTTP_OURS} ${s}"; continue 2 ;; esac ;; esac; done
    elif RE="${APP_TARGET_RE}" awk -F'\t' -v s="${s}>" 'index($1, s) == 1 && $2 == "proxy_pass" && $3 ~ ENVIRON["RE"] { f = 1 } END { exit !f }' "${NGX_FLAT}"; then
      HTTP_OURS="${HTTP_OURS} ${s}"
    fi
  done
  HTTP_TLS_SRV=""
  for s in ${HTTP_OURS}; do
    if ngx_in "${s}" listen | grep -Eq '(^| )(ssl|quic)( |$)|443' || [ "$(ngx_in "${s}" ssl | tail -n1)" = "on" ]; then HTTP_TLS_SRV="${s}"; break; fi
  done
}
# loc_proxies S PATH [admin] — 0 when the location serving PATH proxies to the app (or admin).
loc_proxies() {
  local re="${APP_TARGET_RE}"; [ "${3:-}" = "admin" ] && re="${ADMIN_TARGET_RE}"
  ngx_vals "$1" "$2" proxy_pass | grep -Eq "${re}"
}
has_header() { printf '%s\n' "$1" | awk -v h="$(lc "$2")" '{ split($0, a, " "); if (tolower(a[1]) == h) f = 1 } END { exit !f }'; }

http_nginx() {
  local out="" rc="" s="" tls="" srv="" proto="" ciphers="" v="" loc="" missing=""
  out="${TMPD}/nginx-T.txt"
  nginx -T > "${out}" 2> "${TMPD}/nginx-T.err"; rc=$?
  if [ "${rc}" != "0" ]; then
    if ! is_root && grep -qiE 'permission denied|could not open|\[emerg\].*(13:|denied)' "${TMPD}/nginx-T.err"; then need_root http.nginx "nginx -T"; return 0; fi
    fail http.nginx "$(L "nginx -t fails: $(grep -m1 -E 'emerg|error' "${TMPD}/nginx-T.err" | cut -c1-200)" "nginx -t selhává: $(grep -m1 -E 'emerg|error' "${TMPD}/nginx-T.err" | cut -c1-200)")" "$(L 'fix the configuration: nginx -t' 'opravte konfiguraci: nginx -t')"
    [ -s "${out}" ] || return 0
  else
    pass http.nginx "$(L "nginx $(nginx -v 2>&1 | sed 's#.*nginx/##'): configuration valid" "nginx $(nginx -v 2>&1 | sed 's#.*nginx/##'): konfigurace platná")"
  fi
  NGX_FLAT="${TMPD}/nginx.flat"
  if ! awk "${NGX_PARSE_AWK}" "${out}" > "${NGX_FLAT}" 2>/dev/null || [ ! -s "${NGX_FLAT}" ]; then skip http.nginx_parse "$(L 'cannot parse nginx -T output' 'výstup nginx -T nelze rozebrat')"; return 0; fi
  http_targets
  http_our_servers
  if [ -z "${HTTP_OURS}" ]; then
    if [ -n "${DOMAIN}" ]; then fail http.server "$(L "no nginx server block for ${DOMAIN}" "žádný blok server v nginx pro ${DOMAIN}")" "$(L "${ROOT}/update.sh --repair writes one (or see deploy/nginx/m5cet.conf)" "${ROOT}/update.sh --repair ho zapíše (nebo viz deploy/nginx/m5cet.conf)")"
    else warn http.server "$(L "nginx runs but no server block proxies to port ${APP_PORT}" "nginx běží, ale žádný blok server nepředává na port ${APP_PORT}")" "$(L 'set DOMAIN (update.sh --set DOMAIN=…) or add a proxy location' 'nastavte DOMAIN (update.sh --set DOMAIN=…) nebo doplňte proxy')"; fi
    return 0
  fi
  pass http.server "$(L "server block(s) for ${DOMAIN:-the app}: $(for s in ${HTTP_OURS}; do ngx_in "${s}" server_name | head -n1; done | tr '\n' ' ')" "blok(y) server pro ${DOMAIN:-aplikaci}: $(for s in ${HTTP_OURS}; do ngx_in "${s}" server_name | head -n1; done | tr '\n' ' ')")"
  tls="${HTTP_TLS_SRV}"
  if [ -z "${tls}" ]; then
    fail http.tls "$(L 'no TLS server (listen 443 ssl) for the app — WebRTC, passkeys and the microphone need HTTPS' 'chybí TLS server (listen 443 ssl) — WebRTC, passkeys a mikrofon vyžadují HTTPS')" "$(L "${ROOT}/update.sh --set ENABLE_TLS=1 --set ACME_EMAIL=… (certbot)" "${ROOT}/update.sh --set ENABLE_TLS=1 --set ACME_EMAIL=… (certbot)")"
    srv="$(printf '%s' "${HTTP_OURS}" | awk '{ print $1 }')"
  else
    srv="${tls}"
    proto="$(ngx_in "${tls}" ssl_protocols | tail -n1)"; [ -n "${proto}" ] || proto="$(ngx_in "main>http" ssl_protocols | tail -n1)"
    if [ -z "${proto}" ]; then
      v="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
      if printf '%s\n%s\n' "1.23.4" "${v}" | sort -t. -k1,1n -k2,2n -k3,3n -C 2>/dev/null; then proto="TLSv1.2 TLSv1.3 ($(L 'default' 'výchozí'))"; else proto="TLSv1 TLSv1.1 TLSv1.2 TLSv1.3 ($(L 'default' 'výchozí'))"; fi
    fi
    if printf '%s' " ${proto} " | grep -Eq ' (SSLv2|SSLv3|TLSv1|TLSv1\.1) '; then warn http.tls_protocols "ssl_protocols ${proto}" "ssl_protocols TLSv1.2 TLSv1.3;"
    else pass http.tls_protocols "ssl_protocols ${proto}"; fi
    ciphers="$(ngx_in "${tls}" ssl_ciphers | tail -n1)"; [ -n "${ciphers}" ] || ciphers="$(ngx_in "main>http" ssl_ciphers | tail -n1)"
    if [ -n "${ciphers}" ] && printf '%s' "${ciphers}" | tr ':' '\n' | grep -v '^[!-]' | grep -Eqi '(^|[^A-Z])(RC4|DES|3DES|MD5|NULL|EXP|EXPORT|LOW|ADH|AECDH|aNULL|eNULL)([^A-Z]|$)'; then
      warn http.tls_ciphers "$(L "weak ciphers allowed: ${ciphers}" "povolené slabé šifry: ${ciphers}")" "ssl_ciphers HIGH:!aNULL:!MD5; $(L '(or the Mozilla intermediate list)' '(nebo seznam Mozilla intermediate)')"
    else pass http.tls_ciphers "ssl_ciphers ${ciphers:-$(L 'default (HIGH:!aNULL:!MD5)' 'výchozí (HIGH:!aNULL:!MD5)')}"; fi
    http_cert_file "${tls}"
  fi
  # HTTP → HTTPS
  local plain=""
  for s in ${HTTP_OURS}; do [ "${s}" = "${tls}" ] && continue; plain="${plain} ${s}"; done
  if [ -n "${tls}" ]; then
    local redir=1 p=""
    for p in ${plain}; do
      if grep -F "${p}" "${NGX_FLAT}" | awk -F'\t' -v s="${p}" '($1 == s || index($1, s ">") == 1) && $2 == "return" && $3 ~ /^30[1278] +https:/ { f = 1 } END { exit !f }'; then :
      elif RE="${APP_TARGET_RE}" awk -F'\t' -v s="${p}>" 'index($1, s) == 1 && $2 == "proxy_pass" && $3 ~ ENVIRON["RE"] { f = 1 } END { exit !f }' "${NGX_FLAT}"; then redir=2
      else redir=0; fi
    done
    if [ -z "${plain}" ]; then warn http.redirect "$(L 'no port-80 server for the domain (no redirect to HTTPS, no HTTP-01 renewal)' 'chybí server na portu 80 (žádné přesměrování na HTTPS, ani obnova HTTP-01)')" "$(L 'add a listen 80 server with return 301 https://$host$request_uri;' 'přidejte server listen 80 s return 301 https://$host$request_uri;')"
    elif [ "${redir}" = "2" ]; then warn http.redirect "$(L 'plain HTTP also serves the app (no redirect to HTTPS)' 'aplikaci obslouží i čisté HTTP (bez přesměrování na HTTPS)')" "return 301 https://\$host\$request_uri;"
    elif [ "${redir}" = "1" ]; then pass http.redirect "$(L 'HTTP redirects to HTTPS' 'HTTP přesměrovává na HTTPS')"
    else warn http.redirect "$(L 'the port-80 server does not redirect to HTTPS' 'server na portu 80 nepřesměrovává na HTTPS')" "return 301 https://\$host\$request_uri;"; fi
  fi
  # WebSocket /ws (and the phone bridge's audio)
  http_ws_loc "${srv}" /ws http.websocket
  if is_on "$(ev ENABLE_TELEPHONY)"; then http_ws_loc "${srv}" /media/tel/x http.media_tel; fi
  # SSE of a function run
  loc="$(ngx_loc "${srv}" /api/functions/runs/x proxy_buffering)"
  if ! loc_proxies "${srv}" /api/functions/runs/x; then fail http.sse "$(L "/api/ is not proxied to the app (location ${loc:-/})" "/api/ se nepředává aplikaci (location ${loc:-/})")" "$(L 'proxy /api/ to the app' 'předávejte /api/ aplikaci')"
  elif [ "$(ngx_vals "${srv}" /api/functions/runs/x proxy_buffering | tail -n1)" = "off" ]; then pass http.sse "$(L "SSE (/api/functions): proxy_buffering off (location ${loc:-/})" "SSE (/api/functions): proxy_buffering off (location ${loc:-/})")"
  else warn http.sse "$(L "proxy_buffering is on for /api/functions — a function run's progress arrives only at the end" "proxy_buffering je zapnutý pro /api/functions — průběh běhu funkce dorazí až na konci")" "proxy_buffering off; $(L "in location ${loc:-/}" "v location ${loc:-/}")"; fi
  if ngx_vals "${srv}" /api/functions/runs/x gzip_types | grep -q 'text/event-stream'; then warn http.sse_gzip "$(L 'gzip_types includes text/event-stream (buffers SSE)' 'gzip_types obsahuje text/event-stream (bufferuje SSE)')" "$(L 'remove text/event-stream from gzip_types' 'odeberte text/event-stream z gzip_types')"; fi
  # Request body limits vs what the app accepts.
  local path="" need="" have_b="" lim="" short="" spec="" label=""
  # path:bytes the app accepts:label — the app's own body limits (server/index.ts, hooks 5 MB).
  for spec in "/api/storage/x:12582912:12m:/api/storage" "/api/account/vault:8388608:8m:/api/account/vault" "/api/speech/stt:10485760:10m:/api/speech/stt" "/hooks/m/x/y:5242880:5m:/hooks/"; do
    path="$(printf '%s' "${spec}" | cut -d: -f1)"; need="$(printf '%s' "${spec}" | cut -d: -f2)"
    lim="$(printf '%s' "${spec}" | cut -d: -f3)"; label="$(printf '%s' "${spec}" | cut -d: -f4)"
    have_b="$(ngx_vals "${srv}" "${path}" client_max_body_size | tail -n1)"; [ -n "${have_b}" ] || have_b="1m"
    v="$(ngx_size_bytes "${have_b}")"
    if [ "${v}" != "0" ] && [ "${v}" -lt "${need}" ]; then short="${short} ${label}(${have_b}<${lim})"; fi
  done
  if [ -n "${short}" ]; then warn http.body_size "$(L "client_max_body_size too small — nginx answers 413:${short}" "client_max_body_size je malé — nginx odpoví 413:${short}")" "client_max_body_size 12m; $(L '(APK upload in the console: 300m on its location)' '(nahrání APK v konzoli: 300m na jeho location)')"
  else pass http.body_size "$(L 'client_max_body_size fits the app (storage 12 MB, vault 8 MB, speech 10 MB, hooks 5 MB)' 'client_max_body_size odpovídá aplikaci (úložiště 12 MB, trezor 8 MB, řeč 10 MB, hooky 5 MB)')"; fi
  # Provider webhooks
  if is_on "$(ev ENABLE_TELEPHONY)"; then
    if loc_proxies "${srv}" /wh/twilio/sms; then pass http.webhooks "$(L '/wh/ (provider webhooks) reaches the app' '/wh/ (webhooky poskytovatelů) se dostanou k aplikaci')"
    else fail http.webhooks "$(L "/wh/ is not proxied to the app (location $(ngx_loc "${srv}" /wh/twilio/sms proxy_pass))" "/wh/ se nepředává aplikaci (location $(ngx_loc "${srv}" /wh/twilio/sms proxy_pass))")" "location /wh/ { proxy_pass http://127.0.0.1:${APP_PORT}; … }"; fi
  fi
  # Android passkeys: assetlinks must reach the app
  if loc_proxies "${srv}" /.well-known/assetlinks.json; then pass http.assetlinks "$(L '/.well-known/assetlinks.json reaches the app (Android passkeys)' '/.well-known/assetlinks.json se dostane k aplikaci (passkeys na Androidu)')"
  else warn http.assetlinks "$(L "/.well-known/assetlinks.json does not reach the app (location $(ngx_loc "${srv}" /.well-known/assetlinks.json proxy_pass)) — Android passkeys fail" "/.well-known/assetlinks.json se nedostane k aplikaci (location $(ngx_loc "${srv}" /.well-known/assetlinks.json proxy_pass)) — passkeys na Androidu selžou")" "location = /.well-known/assetlinks.json { proxy_pass http://127.0.0.1:${APP_PORT}; }"; fi
  # iOS passkeys (6.14): with APNS_TEAM_ID the app answers apple-app-site-association; Apple fetches it without redirects
  if [ -n "$(ev APNS_TEAM_ID)" ]; then
    if loc_proxies "${srv}" /.well-known/apple-app-site-association; then pass http.aasa "$(L '/.well-known/apple-app-site-association reaches the app (iOS passkeys)' '/.well-known/apple-app-site-association se dostane k aplikaci (passkeys na iOS)')"
    else warn http.aasa "$(L "/.well-known/apple-app-site-association does not reach the app (location $(ngx_loc "${srv}" /.well-known/apple-app-site-association proxy_pass)) — iOS passkeys fail" "/.well-known/apple-app-site-association se nedostane k aplikaci (location $(ngx_loc "${srv}" /.well-known/apple-app-site-association proxy_pass)) — passkeys na iOS selžou")" "location = /.well-known/apple-app-site-association { proxy_pass http://127.0.0.1:${APP_PORT}; }"; fi
  fi
  # Security headers set twice (helmet in the app + add_header in nginx)
  local dup="" h="" hh="" hide=""
  for path in / /api/health /ws; do
    loc_proxies "${srv}" "${path}" || continue
    hh="$(ngx_vals "${srv}" "${path}" add_header)"
    hide="$(ngx_vals "${srv}" "${path}" proxy_hide_header | tr '[:upper:]' '[:lower:]')"
    for h in Strict-Transport-Security Content-Security-Policy X-Content-Type-Options Referrer-Policy X-Frame-Options Permissions-Policy Cross-Origin-Opener-Policy Cross-Origin-Resource-Policy X-DNS-Prefetch-Control X-XSS-Protection Origin-Agent-Cluster; do
      if has_header "${hh}" "${h}" && ! printf '%s\n' "${hide}" | grep -qx "$(lc "${h}")"; then case " ${dup} " in *" ${h} "*) ;; *) dup="${dup} ${h}" ;; esac; fi
    done
  done
  if [ -n "${dup}" ]; then warn http.headers "$(L "nginx adds headers the app (helmet) already sends:${dup} — browsers get two values" "nginx přidává hlavičky, které už posílá aplikace (helmet):${dup} — prohlížeč dostane dvě hodnoty")" "$(L 'drop these add_header lines from proxied locations (or proxy_hide_header them)' 'odeberte tyto add_header z proxy location (nebo je skryjte přes proxy_hide_header)')"
  else pass http.headers "$(L 'security headers come once (from the app)' 'bezpečnostní hlavičky přicházejí jednou (z aplikace)')"; fi
  # server_tokens
  v="$(ngx_in "${srv}" server_tokens | tail -n1)"; [ -n "${v}" ] || v="$(ngx_in "main>http" server_tokens | tail -n1)"
  if [ "${v}" = "off" ]; then pass http.server_tokens "server_tokens off"
  else warn http.server_tokens "$(L 'nginx announces its version (server_tokens on)' 'nginx prozrazuje verzi (server_tokens on)')" "$(L 'server_tokens off; in http {}' 'server_tokens off; v http {}')"; fi
  # gzip of already-compressed types
  v="$(ngx_vals "${srv}" /assets/x.js gzip_types | tr '\n' ' ')"
  if printf '%s' " ${v} " | grep -Eq ' (image/(png|jpe?g|gif|webp|avif)|application/(zip|gzip|x-gzip|x-brotli|octet-stream|pdf)|video/[a-z0-9.+-]+|audio/[a-z0-9.+-]+|font/woff2) '; then
    warn http.gzip "$(L "gzip_types lists already-compressed types: ${v}" "gzip_types obsahuje už komprimované typy: ${v}")" "$(L 'keep text types only (text/css application/javascript application/json image/svg+xml)' 'ponechte jen textové typy (text/css application/javascript application/json image/svg+xml)')"
  else pass http.gzip "$(L 'gzip does not recompress compressed types (the build ships .br/.gz)' 'gzip nekomprimuje už komprimované typy (build dodává .br/.gz)')"; fi
  # Client address for the app's rate limits
  hh="$(ngx_vals "${srv}" /api/health proxy_set_header)"
  missing=""
  has_header "${hh}" X-Forwarded-For || missing="${missing} X-Forwarded-For"
  has_header "${hh}" X-Forwarded-Proto || missing="${missing} X-Forwarded-Proto"
  if [ -n "${missing}" ]; then warn http.forwarded "$(L "the app does not receive${missing} — every visitor shares one rate-limit bucket" "aplikace nedostává${missing} — všichni návštěvníci sdílejí jeden limit")" "proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme;"
  else pass http.forwarded "$(L 'X-Forwarded-For / -Proto passed to the app' 'X-Forwarded-For / -Proto se předávají aplikaci')"; fi
  # Second layer for WebSocket floods
  if [ -n "$(ngx_vals "${srv}" /ws limit_req)$(ngx_vals "${srv}" /ws limit_conn)" ]; then pass http.ws_limits "$(L '/ws limited per client (limit_req / limit_conn)' '/ws omezeno na klienta (limit_req / limit_conn)')"
  else warn http.ws_limits "$(L 'no limit_req / limit_conn on /ws (the app gate is the only layer)' 'na /ws chybí limit_req / limit_conn (jedinou vrstvou je brána aplikace)')" "$(L 'see the /ws location in deploy/nginx/m5cet.conf' 'viz location /ws v deploy/nginx/m5cet.conf')"; fi
  # Operator console reachable from the internet without an IP allowlist?
  local open_adm=""
  # /api/admin/* is served by the app; /admin/* and the console GUI by the admin service.
  for path in /api/admin/live /admin/health /console/; do
    case "${path}" in
      /api/*) loc_proxies "${srv}" "${path}" || continue ;;
      *) loc_proxies "${srv}" "${path}" admin || continue ;;
    esac
    [ -n "$(ngx_vals "${srv}" "${path}" deny)" ] || open_adm="${open_adm} ${path}"
  done
  if [ -n "${open_adm}" ]; then warn http.admin_paths "$(L "operator paths open to the internet (token only):${open_adm}" "cesty konzole otevřené do internetu (jen token):${open_adm}")" "$(L 'allow <your IPs>; deny all; in those locations' 'allow <vaše IP>; deny all; v těchto location')"; fi
}

http_ws_loc() {
  local srv="$1" path="$2" id="$3" hh="" loc="" t="" ver=""
  loc="$(ngx_loc "${srv}" "${path}" proxy_pass)"
  if ! loc_proxies "${srv}" "${path}"; then fail "${id}" "$(L "${path%/x} is not proxied to the app (location ${loc:-none})" "${path%/x} se nepředává aplikaci (location ${loc:-žádná})")" "$(L 'see the /ws location in deploy/nginx/m5cet.conf' 'viz location /ws v deploy/nginx/m5cet.conf')"; return 0; fi
  hh="$(ngx_vals "${srv}" "${path}" proxy_set_header)"
  ver="$(ngx_vals "${srv}" "${path}" proxy_http_version | tail -n1)"
  if ! has_header "${hh}" Upgrade || ! has_header "${hh}" Connection || [ "${ver}" != "1.1" ]; then
    fail "${id}" "$(L "${path%/x}: WebSocket upgrade not passed (proxy_http_version ${ver:-1.0}, Upgrade/Connection headers) — calls and chat cannot connect" "${path%/x}: WebSocket upgrade se nepředává (proxy_http_version ${ver:-1.0}, hlavičky Upgrade/Connection) — hovory ani chat se nepřipojí")" \
      "proxy_http_version 1.1; proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection \"upgrade\";"
    return 0
  fi
  t="$(ngx_secs "$(ngx_vals "${srv}" "${path}" proxy_read_timeout | tail -n1)")"; [ "${t}" -gt 0 ] 2>/dev/null || t=60
  if [ "${t}" -lt 3600 ]; then warn "${id}" "$(L "${path%/x}: proxy_read_timeout ${t}s — idle sockets drop" "${path%/x}: proxy_read_timeout ${t}s — nečinná spojení padají")" "proxy_read_timeout 3600s; proxy_send_timeout 3600s;"
  else pass "${id}" "$(L "${path%/x}: WebSocket upgrade, HTTP/1.1, timeout ${t}s (location ${loc})" "${path%/x}: WebSocket upgrade, HTTP/1.1, timeout ${t}s (location ${loc})")"; fi
}

# Certificate file(s) from the TLS server block.
http_cert_file() {
  local s="$1" f="" end="" san=""
  f="$(ngx_in "${s}" ssl_certificate | head -n1)"; [ -n "${f}" ] || f="$(ngx_in "main>http" ssl_certificate | head -n1)"
  [ -n "${f}" ] || return 0
  if ! have openssl; then skip http.cert "$(L 'openssl missing' 'chybí openssl')"; return 0; fi
  if [ ! -r "${f}" ]; then need_root http.cert "${f}"; return 0; fi
  end="$(openssl x509 -in "${f}" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
  if ! openssl x509 -in "${f}" -noout -checkend 0 >/dev/null 2>&1; then
    fail http.cert "$(L "certificate ${f} EXPIRED (${end})" "certifikát ${f} VYPRŠEL (${end})")" "$(L 'certbot renew && systemctl reload nginx' 'certbot renew && systemctl reload nginx')"
  elif ! openssl x509 -in "${f}" -noout -checkend 1209600 >/dev/null 2>&1; then
    warn http.cert "$(L "certificate ${f} expires within 14 days (${end})" "certifikát ${f} vyprší do 14 dnů (${end})")" "$(L 'certbot renew; check the renewal timer' 'certbot renew; zkontrolujte časovač obnovy')"
  else pass http.cert "$(L "certificate valid until ${end}" "certifikát platí do ${end}")"; fi
  if [ -n "${DOMAIN}" ]; then
    san="$(openssl x509 -in "${f}" -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -n1)"
    if printf '%s' "${san}" | tr ',' '\n' | sed 's/^ *DNS://' | awk -v d="${DOMAIN}" '{ if ($0 == d) f = 1; if (substr($0, 1, 2) == "*." && substr(d, index(d, ".")) == substr($0, 2)) f = 1 } END { exit !f }'; then
      pass http.cert_name "$(L "certificate covers ${DOMAIN}" "certifikát pokrývá ${DOMAIN}")"
    else fail http.cert_name "$(L "certificate does not name ${DOMAIN} (${san:-no SAN})" "certifikát neobsahuje ${DOMAIN} (${san:-bez SAN})")" "certbot --nginx -d ${DOMAIN}"; fi
  fi
  if [ -n "$(ngx_in "${s}" ssl_stapling | tail -n1)" ] && [ "$(ngx_in "${s}" ssl_stapling | tail -n1)" = "on" ]; then pass http.ocsp "ssl_stapling on"
  elif [ -n "$(openssl x509 -in "${f}" -noout -ocsp_uri 2>/dev/null)" ]; then warn http.ocsp "$(L 'the certificate has an OCSP responder but stapling is off' 'certifikát má OCSP, ale stapling je vypnutý')" "ssl_stapling on; ssl_stapling_verify on;"
  else pass http.ocsp "$(L 'the CA issues no OCSP (e.g. Let'"'"'s Encrypt since 2025) — stapling not needed' 'CA OCSP nevydává (např. Let'"'"'s Encrypt od 2025) — stapling netřeba')"; fi
  if openssl x509 -in "${f}" -noout -issuer 2>/dev/null | grep -qi "let's encrypt"; then
    if have systemctl && { systemctl is-enabled certbot.timer >/dev/null 2>&1 || systemctl is-enabled snap.certbot.renew.timer >/dev/null 2>&1; } || [ -f "$(sp /etc/cron.d/certbot)" ]; then pass http.cert_renew "$(L 'certbot renewal scheduled' 'obnova certbotem je naplánovaná')"
    else warn http.cert_renew "$(L 'no certbot renewal timer / cron found' 'nenalezen časovač / cron obnovy certbotu')" "systemctl enable --now certbot.timer"; fi
  fi
}

http_live_tls() {
  local out="" code="" end=""
  [ -n "${DOMAIN}" ] || return 0
  if ! have openssl; then return 0; fi
  if ! online; then skip http.tls_live "$(L 'offline' 'offline')"; return 0; fi
  out="$(to 15 openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" -verify_hostname "${DOMAIN}" -verify_return_error </dev/null 2>&1)"
  code="$(printf '%s\n' "${out}" | sed -n 's/^ *Verify return code: \([0-9]*\) (\(.*\))/\1 \2/p' | tail -n1)"
  if printf '%s' "${out}" | grep -q 'BEGIN CERTIFICATE' && [ "${code%% *}" = "0" ]; then
    end="$(printf '%s\n' "${out}" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
    if ! printf '%s\n' "${out}" | openssl x509 -noout -checkend 1209600 >/dev/null 2>&1; then warn http.tls_live "$(L "https://${DOMAIN}: chain OK, but the certificate expires within 14 days (${end})" "https://${DOMAIN}: řetěz v pořádku, ale certifikát vyprší do 14 dnů (${end})")" "certbot renew"
    else pass http.tls_live "$(L "https://${DOMAIN}: chain and name valid, until ${end}" "https://${DOMAIN}: řetěz i jméno platné, do ${end}")"; fi
  elif [ -n "${code}" ]; then
    fail http.tls_live "$(L "https://${DOMAIN}: certificate rejected (${code})" "https://${DOMAIN}: certifikát odmítnut (${code})")" "$(L 'serve the full chain (fullchain.pem) for the right name' 'servírujte celý řetěz (fullchain.pem) pro správné jméno')"
  else
    warn http.tls_live "$(L "https://${DOMAIN}: no TLS handshake ($(printf '%s\n' "${out}" | grep -m1 -iE 'error|refused|unknown|timeout' | cut -c1-120))" "https://${DOMAIN}: TLS handshake neproběhl ($(printf '%s\n' "${out}" | grep -m1 -iE 'error|refused|unknown|timeout' | cut -c1-120))")" "$(L 'is port 443 reachable from this host (NAT hairpin)? check from outside' 'je port 443 dosažitelný z tohoto stroje (NAT hairpin)? ověřte zvenku')"
  fi
}

check_http() {
  sec http "HTTP server a TLS" "HTTP server and TLS"
  local procs443="" found="" any443=""
  procs443="$(listen_procs 443 | tr '\n' ' ')$(listen_procs 80 | tr '\n' ' ')"
  any443="$(listen_addrs 443)$(listen_addrs 80)"
  # What runs (process names need root for ss -p; pgrep works for everyone).
  if have nginx && { case "${procs443}" in *nginx*) true ;; *) false ;; esac || running nginx; }; then found="${found} nginx"; fi
  if { have apache2ctl || have apachectl || have httpd; } && { case "${procs443}" in *apache2*|*httpd*) true ;; *) false ;; esac || running apache2 || running httpd; }; then found="${found} apache"; fi
  if have caddy && { case "${procs443}" in *caddy*) true ;; *) false ;; esac || running caddy; }; then found="${found} caddy"; fi
  if case "${procs443}" in *traefik*|*docker-proxy*|*haproxy*|*envoy*) true ;; *) false ;; esac || running traefik || running haproxy; then found="${found} other"; fi
  # nginx installed with our site but stopped: still check its configuration.
  if [ -z "${found}" ] && have nginx && [ -n "$(cf NGINX_SITE_PATH)" ]; then found=" nginx"; fi
  if [ -n "${DOMAIN}" ] && [ -z "${any443}" ] && { have ss || have lsof; }; then
    fail http.listen "$(L "nothing listens on 80/443, but the domain ${DOMAIN} is configured" "na 80/443 nic nenaslouchá, ale doména ${DOMAIN} je nastavená")" "$(L 'start the web server: systemctl start nginx' 'spusťte webový server: systemctl start nginx')"
  fi
  if [ -z "${found}" ]; then
    if [ -n "${DOMAIN}" ] || proxy_front; then fail http.proxy "$(L 'no reverse proxy found (nginx/Apache/Caddy/Traefik), but a domain is configured' 'reverzní proxy nenalezena (nginx/Apache/Caddy/Traefik), ale doména je nastavená')" "$(L "${ROOT}/update.sh --set ENABLE_NGINX=1" "${ROOT}/update.sh --set ENABLE_NGINX=1")"
    elif [ "${INSTALLED}" = "1" ] && ! is_loopback "${BIND}"; then warn http.proxy "$(L "no reverse proxy: the app is served directly on ${BIND}:${APP_PORT} without TLS — WebRTC needs HTTPS outside localhost" "bez reverzní proxy: aplikace běží přímo na ${BIND}:${APP_PORT} bez TLS — WebRTC mimo localhost vyžaduje HTTPS")" "$(L "${ROOT}/update.sh --set DOMAIN=… --set ENABLE_TLS=1" "${ROOT}/update.sh --set DOMAIN=… --set ENABLE_TLS=1")"
    else skip http.proxy "$(L 'no reverse proxy (loopback only)' 'bez reverzní proxy (jen loopback)')"; fi
    return 0
  fi
  pass http.proxy "$(L "found:${found}${procs443:+ (80/443: ${procs443})}" "nalezeno:${found}${procs443:+ (80/443: ${procs443})}")"
  case "${found}" in
    *nginx*) http_nginx ;;
    *apache*)
      local mods=""
      mods="$({ apache2ctl -M || apachectl -M || httpd -M; } 2>/dev/null)"
      if [ -z "${mods}" ]; then need_root http.apache "apachectl -M"
      elif printf '%s' "${mods}" | grep -q 'proxy_wstunnel_module' || printf '%s' "${mods}" | grep -q 'proxy_http_module'; then pass http.apache "$(L 'Apache: mod_proxy_http / proxy_wstunnel present — verify ProxyPass /ws with upgrade=websocket' 'Apache: mod_proxy_http / proxy_wstunnel je — ověřte ProxyPass /ws s upgrade=websocket')"
      else fail http.apache "$(L 'Apache without mod_proxy_wstunnel / proxy_http: WebSockets cannot pass' 'Apache bez mod_proxy_wstunnel / proxy_http: WebSockety neprojdou')" "a2enmod proxy proxy_http proxy_wstunnel"; fi ;;
    *caddy*) pass http.caddy "$(L 'Caddy: TLS and WebSockets are automatic — check reverse_proxy to the app port' 'Caddy: TLS i WebSockety řeší sám — ověřte reverse_proxy na port aplikace')" ;;
    *) skip http.other "$(L 'Traefik / a proxy in a container: check WebSocket, timeouts and TLS by hand' 'Traefik / proxy v kontejneru: WebSocket, timeouty a TLS ověřte ručně')" ;;
  esac
  http_live_tls
}

# ===========================================================================
# firewall
# ===========================================================================
FW=""; FW_TXT=""
fw_detect() {
  FW=""; FW_TXT="${TMPD}/fw.txt"; : > "${FW_TXT}"
  if have ufw && ufw status verbose > "${FW_TXT}" 2>/dev/null && grep -q '^Status: active' "${FW_TXT}"; then FW="ufw"; return 0; fi
  if have firewall-cmd && [ "$(firewall-cmd --state 2>/dev/null)" = "running" ]; then FW="firewalld"; firewall-cmd --list-all > "${FW_TXT}" 2>/dev/null; return 0; fi
  if have nft && nft list ruleset > "${FW_TXT}" 2>/dev/null && grep -q 'hook input' "${FW_TXT}"; then FW="nftables"; return 0; fi
  if have iptables && iptables -S > "${FW_TXT}" 2>/dev/null && [ -s "${FW_TXT}" ]; then
    if grep -qE '^-P INPUT (DROP|REJECT)' "${FW_TXT}" || grep -qE '^-A INPUT .*-j (DROP|REJECT)' "${FW_TXT}"; then FW="iptables"; return 0; fi
    FW="iptables-open"; return 0
  fi
  return 1
}

# fw_allows PORT PROTO — 0 open to everyone, 1 closed, 2 open to some addresses only.
fw_allows() {
  local port="$1" proto="${2:-tcp}"
  case "${FW}" in
    ufw)
      awk -v p="${port}" -v pr="${proto}" 'BEGIN { FS = "  +" } /^--/ { rules = 1; next }
        rules && NF >= 3 {
          to = $1; act = $2; from = $3; sub(/ \(v6\)$/, "", to)
          if (act !~ /^(ALLOW|LIMIT)/) next
          ports = to; tp = ""
          if (to == "Nginx Full" || to == "Apache Full" || to == "WWW Full") ports = "80,443/tcp"
          else if (to == "Nginx HTTP" || to == "WWW") ports = "80/tcp"
          else if (to == "Nginx HTTPS" || to == "WWW Secure" || to == "Apache Secure") ports = "443/tcp"
          else if (to == "OpenSSH") ports = "22/tcp"
          if (index(ports, "/")) { tp = ports; sub(/^.*\//, "", tp); sub(/\/.*$/, "", ports) }
          if (tp != "" && tp != pr) next
          n = split(ports, list, ","); hit = 0
          for (i = 1; i <= n; i++) { if (list[i] == p) hit = 1; if (split(list[i], r, ":") == 2 && p + 0 >= r[1] + 0 && p + 0 <= r[2] + 0) hit = 1 }
          if (!hit) next
          if (from ~ /^Anywhere/) any = 1; else some = 1
        }
        END { if (any) exit 0; if (some) exit 2; exit 1 }' "${FW_TXT}"; return $? ;;
    firewalld)
      local svc=""
      case "${port}/${proto}" in 80/tcp) svc="http" ;; 443/tcp) svc="https" ;; 22/tcp) svc="ssh" ;; 3478/*) svc="turn|stun" ;; 5349/*) svc="turns|stuns" ;; esac
      awk -v p="${port}" -v pr="${proto}" -v svc="${svc}" '
        /^ *services:/ { n = split($0, a, " "); for (i = 2; i <= n; i++) if (svc != "" && a[i] ~ ("^(" svc ")$")) hit = 1 }
        /^ *ports:/ { n = split($0, a, " "); for (i = 2; i <= n; i++) { split(a[i], q, "/"); if (q[2] != pr) continue; if (q[1] == p) hit = 1; if (split(q[1], r, "-") == 2 && p + 0 >= r[1] + 0 && p + 0 <= r[2] + 0) hit = 1 } }
        END { exit hit ? 0 : 1 }' "${FW_TXT}"; return $? ;;
    nftables)
      awk -v p="${port}" -v pr="${proto}" '
        index($0, pr " dport") && $0 ~ /accept/ {
          s = $0; sub(".*" pr " dport ", "", s); sub(/ (accept|counter|ct|log|meta|ip|ip6|limit).*$/, "", s); gsub(/[{},]/, " ", s)
          n = split(s, a, " "); for (i = 1; i <= n; i++) { v = a[i]; if (v == "http") v = 80; if (v == "https") v = 443; if (v == "ssh") v = 22; if (v == p) hit = 1; if (split(v, r, "-") == 2 && p + 0 >= r[1] + 0 && p + 0 <= r[2] + 0) hit = 1 }
        }
        END { exit hit ? 0 : 1 }' "${FW_TXT}"; return $? ;;
    iptables)
      awk -v p="${port}" -v pr="${proto}" '
        /^-A (INPUT|ufw-user-input|INPUT_direct)/ && / -j ACCEPT/ && index($0, "-p " pr) {
          s = ""; if (match($0, /--dports? [0-9:,]+/)) s = substr($0, RSTART, RLENGTH); sub(/^--dports? /, "", s)
          n = split(s, a, ","); for (i = 1; i <= n; i++) { if (a[i] == p) hit = (index($0, " -s ") ? 2 : 1); if (split(a[i], r, ":") == 2 && p + 0 >= r[1] + 0 && p + 0 <= r[2] + 0) hit = 1 }
        }
        END { if (hit == 1) exit 0; if (hit == 2) exit 2; exit 1 }' "${FW_TXT}"; return $? ;;
    iptables-open) return 0 ;;
  esac
  return 0
}

fw_policy() {
  case "${FW}" in
    ufw) if grep -qE '^Default: (deny|reject) \(incoming\)' "${FW_TXT}"; then pass firewall.policy "$(L 'ufw: incoming denied by default' 'ufw: příchozí spojení ve výchozím stavu zakázána')"
         else fail firewall.policy "$(L "ufw: $(grep '^Default:' "${FW_TXT}")" "ufw: $(grep '^Default:' "${FW_TXT}")")" "ufw default deny incoming"; fi ;;
    firewalld)
      local tgt; tgt="$(sed -n 's/^ *target: *//p' "${FW_TXT}" | head -n1)"
      case "${tgt}" in ACCEPT) fail firewall.policy "$(L 'firewalld default zone accepts everything (target ACCEPT)' 'výchozí zóna firewalld přijímá vše (target ACCEPT)')" "firewall-cmd --permanent --zone=$(firewall-cmd --get-default-zone 2>/dev/null) --set-target=default" ;;
        *) pass firewall.policy "$(L "firewalld zone $(head -n1 "${FW_TXT}" | awk '{ print $1 }'), target ${tgt:-default}" "firewalld zóna $(head -n1 "${FW_TXT}" | awk '{ print $1 }'), target ${tgt:-default}")" ;; esac ;;
    nftables)
      if grep -E 'hook input' "${FW_TXT}" | grep -q 'policy drop' || awk '/hook input/ { inp = 1 } inp && /^[[:space:]]*}/ { inp = 0 } inp && /(drop|reject)[[:space:]]*$/ { f = 1 } END { exit !f }' "${FW_TXT}"; then pass firewall.policy "$(L 'nftables: input chain drops by default' 'nftables: řetěz input ve výchozím stavu zahazuje')"
      else warn firewall.policy "$(L 'nftables: the input chain accepts by default' 'nftables: řetěz input ve výchozím stavu přijímá')" "$(L 'policy drop; on the input chain (allow 80, 443, SSH first)' 'policy drop; na řetězu input (nejdřív povolte 80, 443, SSH)')"; fi ;;
    iptables) pass firewall.policy "$(L 'iptables: INPUT drops / rejects by default' 'iptables: INPUT ve výchozím stavu zahazuje / odmítá')" ;;
    iptables-open) warn firewall.policy "$(L 'iptables: INPUT accepts everything (no inbound filter)' 'iptables: INPUT přijímá vše (žádný příchozí filtr)')" "$(L 'enable ufw or firewalld (default deny)' 'zapněte ufw nebo firewalld (výchozí zákaz)')" ;;
  esac
}

fw_app_ports() {
  local p="" label="" rc=""
  for p in "${APP_PORT}:app" "${ADMIN_PORT}:admin"; do
    label="${p#*:}"; p="${p%%:*}"
    [ "${label}" = "admin" ] && [ "${ADMIN_ON}" = "0" ] && continue
    if [ -z "$(listen_addrs "${p}")" ]; then continue; fi
    if ! listen_public "${p}"; then pass "firewall.${label}_port" "$(L "port ${p} (${label}) listens on loopback only" "port ${p} (${label}) naslouchá jen na loopbacku")"; continue; fi
    # rc: 0 open (or no firewall), 1 blocked, 2 open to some addresses, 3 unknown (not root)
    if ! is_root; then rc=3
    elif [ -n "${FW}" ]; then fw_allows "${p}" tcp; rc=$?
    else rc=0; fi
    if [ "${rc}" = "3" ]; then
      res "$( [ "${label}" = "admin" ] && echo FAIL || echo WARN )" "firewall.${label}_port" "$(L "port ${p} (${label}) listens on a public address (the firewall is not checked without root)" "port ${p} (${label}) naslouchá na veřejné adrese (firewall bez roota neověřen)")" \
        "$( [ "${label}" = "admin" ] && echo "ADMIN_BIND=127.0.0.1" || echo "update.sh --set BIND_ADDRESS=127.0.0.1" )"
      continue
    fi
    if [ "${label}" = "admin" ]; then
      if [ "${rc}" = "0" ]; then fail firewall.admin_port "$(L "admin port ${p} listens publicly and the firewall lets it through" "admin port ${p} naslouchá veřejně a firewall ho propouští")" "ADMIN_BIND=127.0.0.1; $(L 'close the port' 'zavřete port')"
      else warn firewall.admin_port "$(L "admin port ${p} listens publicly; only the firewall blocks it" "admin port ${p} naslouchá veřejně; blokuje ho jen firewall")" "ADMIN_BIND=127.0.0.1"; fi
    elif proxy_front; then
      if [ "${rc}" = "0" ]; then warn firewall.app_port "$(L "app port ${p} is open to the internet beside the proxy (no TLS, no proxy limits)" "port aplikace ${p} je otevřený do internetu vedle proxy (bez TLS a limitů proxy)")" "$(L "update.sh --set BIND_ADDRESS=127.0.0.1; close ${p} in the firewall" "update.sh --set BIND_ADDRESS=127.0.0.1; zavřete ${p} ve firewallu")"
      else warn firewall.app_port "$(L "app port ${p} listens publicly; only the firewall blocks it" "port aplikace ${p} naslouchá veřejně; blokuje ho jen firewall")" "update.sh --set BIND_ADDRESS=127.0.0.1"; fi
    else
      pass firewall.app_port "$(L "app port ${p} served directly (no proxy)" "port aplikace ${p} obsluhovaný přímo (bez proxy)")"
    fi
  done
}

TURN_LOCAL=0; TURN_MIN=49152; TURN_MAX=65535
turn_detect() {
  local conf=""
  TURN_LOCAL=0
  if [ -n "$(listen_addrs 3478 udp)$(listen_addrs 3478)" ] || { have systemctl && systemctl is-active coturn >/dev/null 2>&1; } || [ -f "$(sp /etc/turnserver.conf)" ]; then TURN_LOCAL=1; fi
  conf="$(sp /etc/turnserver.conf)"
  if [ -r "${conf}" ]; then
    TURN_MIN="$(sed -n 's/^[[:space:]]*min-port[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "${conf}" | tail -n1)"; [ -n "${TURN_MIN}" ] || TURN_MIN=49152
    TURN_MAX="$(sed -n 's/^[[:space:]]*max-port[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "${conf}" | tail -n1)"; [ -n "${TURN_MAX}" ] || TURN_MAX=65535
  fi
}

check_firewall() {
  sec firewall "Firewall" "Firewall"
  if [ "${IS_LINUX}" = "0" ]; then skip firewall.active "$(L 'not Linux (pf / Windows firewall not checked)' 'není Linux (pf / firewall Windows se nekontroluje)')"; return 0; fi
  if ! is_root; then need_root firewall.active "ufw / nft / iptables"; fw_app_ports; return 0; fi
  if ! fw_detect; then
    warn firewall.active "$(L 'no active firewall (ufw, firewalld, nftables, iptables)' 'žádný aktivní firewall (ufw, firewalld, nftables, iptables)')" "$(L 'ufw default deny incoming; ufw allow OpenSSH; ufw allow 80,443/tcp; ufw enable' 'ufw default deny incoming; ufw allow OpenSSH; ufw allow 80,443/tcp; ufw enable')"
    fw_app_ports
    return 0
  fi
  pass firewall.active "$(L "active: ${FW}" "aktivní: ${FW}")"
  fw_policy
  if [ -n "${DOMAIN}" ] || proxy_front; then
    local closed="" p="" rc=""
    for p in 80 443; do fw_allows "${p}" tcp; rc=$?; [ "${rc}" = "0" ] || closed="${closed} ${p}/tcp"; done
    if [ -n "${closed}" ] && [ "${FW}" != "iptables-open" ]; then fail firewall.web "$(L "web ports not open to everyone:${closed}" "webové porty nejsou otevřené všem:${closed}")" "ufw allow 80,443/tcp  |  firewall-cmd --permanent --add-service={http,https} && firewall-cmd --reload"
    else pass firewall.web "$(L '80/tcp and 443/tcp open' '80/tcp a 443/tcp otevřené')"; fi
  fi
  fw_app_ports
  turn_detect
  if [ "${TURN_LOCAL}" = "1" ]; then
    local miss=""
    fw_allows 3478 udp || miss="${miss} 3478/udp"
    fw_allows 3478 tcp || miss="${miss} 3478/tcp"
    if [ -n "$(listen_addrs 5349)" ]; then fw_allows 5349 tcp || miss="${miss} 5349/tcp"; fi
    fw_allows "${TURN_MIN}" udp || miss="${miss} ${TURN_MIN}-${TURN_MAX}/udp"
    if [ -n "${miss}" ]; then warn firewall.turn "$(L "TURN (coturn) ports not open:${miss}" "porty TURN (coturn) nejsou otevřené:${miss}")" "ufw allow 3478; ufw allow 5349/tcp; ufw allow ${TURN_MIN}:${TURN_MAX}/udp"
    else pass firewall.turn "$(L "TURN ports open (3478, relay ${TURN_MIN}-${TURN_MAX}/udp)" "porty TURN otevřené (3478, relay ${TURN_MIN}-${TURN_MAX}/udp)")"; fi
  else
    skip firewall.turn "$(L 'no TURN server on this host' 'na tomto stroji neběží TURN server')"
  fi
  # SSH open to the world without rate limiting
  local guard=""
  if [ -n "$(listen_addrs 22)" ]; then
    { have systemctl && { systemctl is-active fail2ban >/dev/null 2>&1 || systemctl is-active sshguard >/dev/null 2>&1 || systemctl is-active crowdsec >/dev/null 2>&1; }; } && guard="1"
    if [ "${FW}" = "ufw" ] && awk 'BEGIN { FS = "  +" } /^--/ { r = 1; next } r && ($1 ~ /^(22(\/tcp)?|OpenSSH)( \(v6\))?$/) && $2 ~ /^LIMIT/ { f = 1 } END { exit !f }' "${FW_TXT}"; then guard="1"; fi
    fw_allows 22 tcp; local rc=$?
    if [ "${rc}" = "0" ] && [ -z "${guard}" ]; then warn firewall.ssh "$(L 'SSH open to everyone without rate limiting (no ufw limit / fail2ban / sshguard)' 'SSH otevřené všem bez omezení pokusů (žádné ufw limit / fail2ban / sshguard)')" "ufw limit OpenSSH  |  apt install fail2ban"
    else pass firewall.ssh "$(L 'SSH restricted or rate-limited' 'SSH omezené nebo s limitem pokusů')"; fi
  fi
  # Docker publishes ports around ufw
  if [ "${FW}" = "ufw" ] && have docker && docker info >/dev/null 2>&1; then
    local pub=""
    pub="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '(0\.0\.0\.0|\[?::\]?):[0-9]+->' | awk '{ print $1 }' | tr '\n' ' ')"
    if [ -n "${pub}" ]; then warn firewall.docker "$(L "containers publish ports on all interfaces — Docker bypasses ufw: ${pub}" "kontejnery publikují porty na všech rozhraních — Docker obchází ufw: ${pub}")" "$(L 'publish on 127.0.0.1 (BIND_ADDRESS) or use the DOCKER-USER chain' 'publikujte na 127.0.0.1 (BIND_ADDRESS) nebo použijte řetěz DOCKER-USER')"
    else pass firewall.docker "$(L 'no container publishes on all interfaces' 'žádný kontejner nepublikuje na všech rozhraních')"; fi
  fi
}

# ===========================================================================
# kernel
# ===========================================================================
# kv_check ID KEY OP WANT MSG HINT [STATUS]  — OP: eq | ge | le | ne
k_check() {
  local id="$1" key="$2" op="$3" want="$4" why="$5" st="${6:-WARN}" v="" ok=1
  v="$(sysctl_v "${key}")"
  if [ -z "${v}" ]; then skip "${id}" "${key}: $(L 'not available' 'není k dispozici')"; return 0; fi
  v="$(printf '%s' "${v}" | awk '{ print $1 }')"
  case "${op}" in
    eq) [ "${v}" = "${want}" ] || ok=0 ;;
    ne) [ "${v}" != "${want}" ] || ok=0 ;;
    ge) is_uint "${v}" && [ "${v}" -ge "${want}" ] || ok=0 ;;
    le) is_uint "${v}" && [ "${v}" -le "${want}" ] || ok=0 ;;
  esac
  if [ "${ok}" = "1" ]; then pass "${id}" "${key} = ${v}"
  else res "${st}" "${id}" "${key} = ${v} — ${why}" "sysctl -w ${key}=${want}; $(L 'persist in /etc/sysctl.d/90-m5cet.conf' 'trvale v /etc/sysctl.d/90-m5cet.conf')"; fi
}

# virt_ifaces — 0 when there are VPN / container interfaces (forwarding is expected then).
virt_ifaces() {
  local f=""
  for f in "$(sp /sys/class/net)"/*; do
    case "${f##*/}" in wg*|tun*|tap*|docker*|br-*|cni*|flannel*|cali*|veth*|virbr*) return 0 ;; esac
  done
  return 1
}

check_kernel() {
  sec kernel "Jádro (sysctl)" "Kernel (sysctl)"
  if [ "${IS_LINUX}" = "0" ]; then skip kernel.linux "$(L 'not Linux' 'není Linux')"; return 0; fi
  k_check kernel.syncookies net.ipv4.tcp_syncookies eq 1 "$(L 'SYN floods fill the accept queue' 'SYN flood zaplní frontu spojení')"
  local rp; rp="$(sysctl_v net.ipv4.conf.all.rp_filter)"
  if [ -z "${rp}" ]; then skip kernel.rp_filter "net.ipv4.conf.all.rp_filter: $(L 'not available' 'není k dispozici')"
  elif [ "${rp}" = "0" ]; then warn kernel.rp_filter "net.ipv4.conf.all.rp_filter = 0 — $(L 'spoofed source addresses accepted' 'přijímá podvržené zdrojové adresy')" "sysctl -w net.ipv4.conf.all.rp_filter=2 $(L '(loose; 1 = strict)' '(volný; 1 = striktní)')"
  else pass kernel.rp_filter "net.ipv4.conf.all.rp_filter = ${rp}"; fi
  k_check kernel.accept_redirects net.ipv4.conf.all.accept_redirects eq 0 "$(L 'ICMP redirects can reroute traffic' 'ICMP redirect může přesměrovat provoz')"
  k_check kernel.accept_redirects6 net.ipv6.conf.all.accept_redirects eq 0 "$(L 'ICMPv6 redirects can reroute traffic' 'ICMPv6 redirect může přesměrovat provoz')"
  if [ "$(sysctl_v net.ipv4.ip_forward)" != "1" ]; then k_check kernel.send_redirects net.ipv4.conf.all.send_redirects eq 0 "$(L 'a server is not a router' 'server není router')"; fi
  k_check kernel.source_route net.ipv4.conf.all.accept_source_route eq 0 "$(L 'source-routed packets accepted' 'přijímá pakety se zdrojovým směrováním')"
  k_check kernel.icmp_broadcasts net.ipv4.icmp_echo_ignore_broadcasts eq 1 "$(L 'smurf amplification' 'zesílení typu smurf')"
  k_check kernel.log_martians net.ipv4.conf.all.log_martians eq 1 "$(L 'impossible addresses are not logged (CIS)' 'nemožné adresy se nelogují (CIS)')"
  k_check kernel.somaxconn net.core.somaxconn ge 1024 "$(L 'short accept queue for bursts of WebSocket connections' 'krátká fronta pro nárazy WebSocket spojení')"
  local pr="" lo="" hi=""
  pr="$(sysctl_v net.ipv4.ip_local_port_range)"
  if [ -n "${pr}" ]; then
    lo="$(printf '%s' "${pr}" | awk '{ print $1 }')"; hi="$(printf '%s' "${pr}" | awk '{ print $2 }')"
    if is_uint "${lo}" && is_uint "${hi}" && [ $((hi - lo)) -lt 16384 ]; then warn kernel.port_range "net.ipv4.ip_local_port_range = ${lo} ${hi} — $(L "only $((hi - lo)) ephemeral ports (proxy → app, provider APIs)" "jen $((hi - lo)) efemérních portů (proxy → aplikace, API poskytovatelů)")" "sysctl -w net.ipv4.ip_local_port_range='15000 65000'"
    else pass kernel.port_range "net.ipv4.ip_local_port_range = ${lo} ${hi}"; fi
  fi
  turn_detect
  if [ "${TURN_LOCAL}" = "1" ]; then
    k_check kernel.rmem_max net.core.rmem_max ge 2500000 "$(L 'small UDP buffers drop TURN / media packets' 'malé UDP buffery zahazují pakety TURN / médií')"
    k_check kernel.wmem_max net.core.wmem_max ge 2500000 "$(L 'small UDP buffers drop TURN / media packets' 'malé UDP buffery zahazují pakety TURN / médií')"
  else
    local r; r="$(sysctl_v net.core.rmem_max)"; [ -n "${r}" ] && pass kernel.udp_buffers "net.core.rmem_max = ${r} ($(L 'no TURN here' 'bez TURN'))"
  fi
  k_check kernel.file_max fs.file-max ge 65536 "$(L 'too few file handles for many sockets' 'málo popisovačů pro mnoho socketů')"
  k_check kernel.protected_symlinks fs.protected_symlinks eq 1 "$(L 'symlink attacks in shared directories' 'útoky přes symlinky ve sdílených adresářích')"
  k_check kernel.protected_hardlinks fs.protected_hardlinks eq 1 "$(L 'hardlink attacks' 'útoky přes hardlinky')"
  k_check kernel.kptr_restrict kernel.kptr_restrict ge 1 "$(L 'kernel addresses visible to users' 'adresy jádra viditelné uživatelům')"
  k_check kernel.dmesg_restrict kernel.dmesg_restrict eq 1 "$(L 'kernel log readable by every user' 'log jádra čte každý uživatel')"
  k_check kernel.bpf kernel.unprivileged_bpf_disabled ge 1 "$(L 'unprivileged eBPF is a common exploit path' 'neprivilegované eBPF je častá cesta exploitů')"
  k_check kernel.ptrace kernel.yama.ptrace_scope ge 1 "$(L 'any process can attach to the service of the same user' 'kterýkoli proces téhož uživatele se připojí ke službě')"
  # user namespaces — bubblewrap (the Functions sandbox) needs them
  local mun="" uc="" aar=""
  mun="$(sysctl_v user.max_user_namespaces)"; uc="$(sysctl_v kernel.unprivileged_userns_clone)"; aar="$(sysctl_v kernel.apparmor_restrict_unprivileged_userns)"
  if [ "${mun}" = "0" ]; then warn kernel.userns "$(L 'user.max_user_namespaces = 0: bubblewrap cannot isolate function runs' 'user.max_user_namespaces = 0: bubblewrap nemůže izolovat běhy funkcí')" "sysctl -w user.max_user_namespaces=15000"
  elif [ "${uc}" = "0" ]; then warn kernel.userns "$(L 'kernel.unprivileged_userns_clone = 0: bubblewrap without setuid cannot run' 'kernel.unprivileged_userns_clone = 0: bubblewrap bez setuid nepoběží')" "sysctl -w kernel.unprivileged_userns_clone=1"
  elif [ "${aar}" = "1" ]; then pass kernel.userns "$(L 'user namespaces on; AppArmor restricts them for unprivileged programs (see system.bwrap)' 'uživatelské jmenné prostory zapnuté; AppArmor je omezuje neprivilegovaným programům (viz system.bwrap)')"
  else pass kernel.userns "$(L "user namespaces available (max ${mun:-?})" "uživatelské jmenné prostory k dispozici (max ${mun:-?})")"; fi
  local oc; oc="$(sysctl_v vm.overcommit_memory)"
  if [ "${oc}" = "2" ]; then warn kernel.overcommit "$(L 'vm.overcommit_memory = 2: V8 / WebAssembly (Pyodide) reserve large address space and fail' 'vm.overcommit_memory = 2: V8 / WebAssembly (Pyodide) rezervují velký adresní prostor a selžou')" "sysctl -w vm.overcommit_memory=0"
  elif [ -n "${oc}" ]; then pass kernel.overcommit "vm.overcommit_memory = ${oc}"; fi
  local fw; fw="$(sysctl_v net.ipv4.ip_forward)"
  if [ "${fw}" = "1" ] && ! have docker && ! have podman && ! virt_ifaces; then warn kernel.ip_forward "$(L 'net.ipv4.ip_forward = 1 without containers or VPN: the server routes packets' 'net.ipv4.ip_forward = 1 bez kontejnerů či VPN: server směruje pakety')" "sysctl -w net.ipv4.ip_forward=0"
  elif [ -n "${fw}" ]; then pass kernel.ip_forward "net.ipv4.ip_forward = ${fw}"; fi
  local v6; v6="$(sysctl_v net.ipv6.conf.all.disable_ipv6)"
  [ -n "${v6}" ] && pass kernel.ipv6 "$(L "IPv6 $( [ "${v6}" = "1" ] && echo disabled || echo enabled ) (net.ipv6.conf.all.disable_ipv6 = ${v6})" "IPv6 $( [ "${v6}" = "1" ] && echo vypnuté || echo zapnuté ) (net.ipv6.conf.all.disable_ipv6 = ${v6})")"
  local thp; thp="$(rd /sys/kernel/mm/transparent_hugepage/enabled)"
  if [ -n "${thp}" ]; then
    case "${thp}" in
      *"[always]"*) if [ -n "$(ev REDIS_URL)" ] && is_loopback "$(url_host "$(ev REDIS_URL)")"; then warn kernel.thp "$(L 'transparent hugepages = always with a local Redis (latency, memory)' 'transparent hugepages = always s lokálním Redisem (latence, paměť)')" "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled"
                    else pass kernel.thp "transparent_hugepage: always"; fi ;;
      *) pass kernel.thp "transparent_hugepage: $(printf '%s' "${thp}" | sed -n 's/.*\[\([a-z]*\)\].*/\1/p')" ;;
    esac
  fi
  local ent; ent="$(rd /proc/sys/kernel/random/entropy_avail)"
  if is_uint "${ent}"; then
    if [ "${ent}" -lt 256 ]; then warn kernel.entropy "$(L "entropy_avail = ${ent} (old kernel without a seeded CRNG?)" "entropy_avail = ${ent} (staré jádro bez inicializovaného CRNG?)")" "$(L 'install haveged / rng-tools, or a kernel >= 5.18' 'nainstalujte haveged / rng-tools, nebo jádro >= 5.18')"
    else pass kernel.entropy "entropy_avail = ${ent}"; fi
  fi
}

# ===========================================================================
# network
# ===========================================================================
resolve_host() {
  local h="$1"
  if have getent && [ -z "${SYSROOT}" ]; then getent ahosts "${h}" 2>/dev/null | awk '{ print $1 }' | sort -u
  elif have dig; then { dig +short A "${h}"; dig +short AAAA "${h}"; } 2>/dev/null | grep -E '^[0-9a-fA-F:.]+$' | sort -u
  elif have host; then host "${h}" 2>/dev/null | awk '/has (IPv6 )?address/ { print $NF }' | sort -u
  elif have dscacheutil; then dscacheutil -q host -a name "${h}" 2>/dev/null | awk '/address:/ { print $2 }' | sort -u
  fi
}
local_addrs() {
  if have ip; then ip -o addr show 2>/dev/null | awk '$3 == "inet" || $3 == "inet6" { a = $4; sub(/\/.*/, "", a); print a }'
  elif have ifconfig; then ifconfig 2>/dev/null | awk '$1 == "inet" || $1 == "inet6" { a = $2; sub(/%.*/, "", a); sub(/^addr:/, "", a); print a }'
  fi
}

net_dns() {
  local ips="" mine="" hit=0 ip="" pub=0 has6=0
  if [ -z "${DOMAIN}" ]; then skip network.dns "$(L 'no domain configured' 'doména není nastavená')"; return 0; fi
  if [ "${OFFLINE}" = "1" ]; then skip network.dns "$(L 'offline' 'offline')"; return 0; fi
  ips="$(resolve_host "${DOMAIN}")"
  if [ -z "${ips}" ]; then
    if online; then fail network.dns "$(L "${DOMAIN} does not resolve" "${DOMAIN} se nepřekládá")" "$(L "create A/AAAA records for ${DOMAIN}" "vytvořte záznamy A/AAAA pro ${DOMAIN}")"
    else skip network.dns "$(L 'offline' 'offline')"; fi
    return 0
  fi
  pass network.dns "${DOMAIN} → $(printf '%s' "${ips}" | tr '\n' ' ')"
  mine="$(local_addrs)"
  for ip in ${ips}; do
    case "${ip}" in *:*) has6=1 ;; esac
    printf '%s\n' "${mine}" | grep -qxF "${ip}" && hit=1
  done
  for ip in ${mine}; do is_private_ip "${ip}" || pub=1; done
  if [ "${hit}" = "1" ]; then pass network.dns_here "$(L "${DOMAIN} points to this host" "${DOMAIN} ukazuje na tento stroj")"
  elif [ "${pub}" = "1" ]; then warn network.dns_here "$(L "${DOMAIN} does not point to any address of this host" "${DOMAIN} neukazuje na žádnou adresu tohoto stroje")" "$(L 'fix the DNS records (or this is a proxy/CDN in front — then fine)' 'opravte DNS (nebo je před serverem proxy/CDN — pak v pořádku)')"
  else skip network.dns_here "$(L 'behind NAT: cannot compare with the public address' 'za NAT: nelze porovnat s veřejnou adresou')"; fi
  if [ "${has6}" = "1" ]; then
    if printf '%s\n' "${mine}" | grep -vE '^(fe80|::1|fd|fc)' | grep -q ':'; then
      if listen_addrs 443 | grep -qE ':|^\*$'; then pass network.ipv6 "$(L 'AAAA record, global IPv6 address, 443 on IPv6' 'záznam AAAA, globální IPv6 adresa, 443 na IPv6')"
      else warn network.ipv6 "$(L 'AAAA record exists but nothing listens on [::]:443' 'záznam AAAA existuje, ale na [::]:443 nic nenaslouchá')" "listen [::]:443 ssl;"; fi
    else fail network.ipv6 "$(L "${DOMAIN} has an AAAA record but this host has no global IPv6 address — IPv6 clients fail" "${DOMAIN} má záznam AAAA, ale stroj nemá globální IPv6 — klienti s IPv6 se nepřipojí")" "$(L 'remove the AAAA record or configure IPv6' 'odstraňte záznam AAAA, nebo nastavte IPv6')"; fi
  fi
}

net_outbound() {
  local list="" u="" code="" bad="" ok=""
  if ! have curl; then skip network.outbound "$(L 'curl missing' 'chybí curl')"; return 0; fi
  if ! online; then skip network.outbound "$(L 'offline (or registry.npmjs.org unreachable)' 'offline (nebo registry.npmjs.org nedostupný)')"; return 0; fi
  list="https://registry.npmjs.org/ https://github.com/ https://tile.openstreetmap.org/"
  { is_on "$(cf ENABLE_PUSH)" || [ -n "$(ev VAPID_PRIVATE_KEY)" ]; } && list="${list} https://fcm.googleapis.com/ https://web.push.apple.com/"
  [ -n "$(ev TWILIO_ACCOUNT_SID)" ] && list="${list} https://api.twilio.com/"
  [ -n "$(ev TELNYX_API_KEY)" ] && list="${list} https://api.telnyx.com/"
  { [ -n "$(ev VONAGE_API_KEY)" ] || [ -n "$(ev VONAGE_APPLICATION_ID)" ]; } && list="${list} https://api.nexmo.com/"
  for u in ${list}; do
    code="$(to 12 curl -s -o /dev/null -m 10 -w '%{http_code}' "${u}" 2>/dev/null || true)"
    case "${code}" in ''|000) bad="${bad} ${u}" ;; *) ok="${ok} $(url_host "${u}")" ;; esac
  done
  if [ -n "${bad}" ]; then warn network.outbound "$(L "unreachable over HTTPS:${bad}" "nedostupné přes HTTPS:${bad}")" "$(L 'allow outbound 443 (firewall, proxy); the features using them will fail' 'povolte odchozí 443 (firewall, proxy); funkce, které je používají, selžou')"
  else pass network.outbound "$(L "outbound HTTPS works:${ok}" "odchozí HTTPS funguje:${ok}")"; fi
}

net_time() {
  local sync="" off=""
  if have chronyc && off="$(chronyc tracking 2>/dev/null | sed -nE 's/^System time *: *([0-9.]+) seconds (fast|slow).*/\1/p')" && [ -n "${off}" ]; then
    if awk -v o="${off}" 'BEGIN { exit !(o < 1) }'; then pass network.time "$(L "chrony: offset ${off} s" "chrony: odchylka ${off} s")"
    elif awk -v o="${off}" 'BEGIN { exit !(o < 30) }'; then warn network.time "$(L "clock off by ${off} s (TOTP, signatures, key-transparency timestamps)" "hodiny se liší o ${off} s (TOTP, podpisy, časy transparentnosti klíčů)")" "chronyc makestep"
    else fail network.time "$(L "clock off by ${off} s — TOTP codes and webhook signatures fail" "hodiny se liší o ${off} s — kódy TOTP a podpisy webhooků selžou")" "chronyc makestep"; fi
    return 0
  fi
  if have timedatectl && sync="$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" && [ -n "${sync}" ]; then
    if [ "${sync}" = "yes" ]; then pass network.time "$(L 'clock synchronised (NTP)' 'hodiny synchronizované (NTP)')"
    else warn network.time "$(L 'clock not synchronised (NTP off or unreachable)' 'hodiny nejsou synchronizované (NTP vypnuté nebo nedostupné)')" "timedatectl set-ntp true"; fi
    return 0
  fi
  if [ -e "$(sp /run/systemd/timesync/synchronized)" ]; then pass network.time "$(L 'systemd-timesyncd synchronised' 'systemd-timesyncd synchronizováno')"; return 0; fi
  skip network.time "$(L 'no chronyc / timedatectl' 'chybí chronyc / timedatectl')"
}

net_mtu() {
  local dev="" mtu=""
  have ip || { skip network.mtu "$(L 'ip missing' 'chybí ip')"; return 0; }
  dev="$(ip route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
  [ -n "${dev}" ] || { skip network.mtu "$(L 'no default route' 'chybí výchozí trasa')"; return 0; }
  mtu="$(rd "/sys/class/net/${dev}/mtu")"
  is_uint "${mtu}" || { skip network.mtu "${dev}: ?"; return 0; }
  if [ "${mtu}" -lt 1280 ]; then fail network.mtu "$(L "MTU ${mtu} on ${dev} (< 1280: IPv6 and DTLS break)" "MTU ${mtu} na ${dev} (< 1280: IPv6 i DTLS selžou)")" "ip link set ${dev} mtu 1500"
  elif [ "${mtu}" -lt 1400 ]; then warn network.mtu "$(L "MTU ${mtu} on ${dev}: large WebRTC / TURN packets fragment" "MTU ${mtu} na ${dev}: velké pakety WebRTC / TURN se fragmentují")" "$(L 'check the tunnel / VPN MTU' 'zkontrolujte MTU tunelu / VPN')"
  else pass network.mtu "MTU ${mtu} (${dev})"; fi
}

net_turn() {
  local u="" h="" p="" bad="" ok=""
  # A coturn on this host must run (whatever TURN_SERVER_URL says).
  if have systemctl && systemctl cat coturn.service >/dev/null 2>&1; then
    if systemctl is-active coturn >/dev/null 2>&1; then pass network.coturn "$(L 'coturn running' 'coturn běží')"
    else fail network.coturn "$(L 'coturn installed but not running' 'coturn je nainstalovaný, ale neběží')" "systemctl enable --now coturn"; fi
  fi
  [ -n "$(ev TURN_SERVER_URL)" ] || { skip network.turn "$(L 'no TURN_SERVER_URL' 'chybí TURN_SERVER_URL')"; return 0; }
  if [ "${OFFLINE}" = "1" ]; then skip network.turn "$(L 'offline' 'offline')"; return 0; fi
  local -a list
  read -r -a list <<EOF_T
$(ev TURN_SERVER_URL | tr ',' ' ')
EOF_T
  local n=0
  for u in ${list[@]+"${list[@]}"}; do
    n=$((n + 1))
    turn_target "${u}"; h="${TT_HOST}"; p="${TT_PORT}"
    # Only a plain host and port go anywhere — and never into shell text (C01).
    if ! valid_host "${h}" || ! valid_port "${p}"; then bad="${bad} #${n}($(L 'not turn:host[:port]' 'není turn:host[:port]'))"; continue; fi
    if have turnutils_stunclient && to 6 turnutils_stunclient -p "${p}" -- "${h}" >/dev/null 2>&1; then ok="${ok} ${h}:${p}(stun)"; continue; fi
    if tcp_probe 6 "${h}" "${p}"; then ok="${ok} ${h}:${p}/tcp"
    else bad="${bad} ${h}:${p}"; fi
  done
  if [ -n "${bad}" ]; then warn network.turn "$(L "TURN not reachable over TCP:${bad} (UDP not tested)" "TURN nedosažitelný přes TCP:${bad} (UDP netestováno)")" "$(L 'is coturn running, the port open? TURN_SERVER_URL entries are turn:host[:port] / turns:host[:port]' 'běží coturn, je port otevřený? položky TURN_SERVER_URL mají tvar turn:host[:port] / turns:host[:port]')"
  else pass network.turn "$(L "TURN reachable:${ok}" "TURN dosažitelný:${ok}")"; fi
}

# turn_target URL — TT_HOST / TT_PORT of a turn: / turns: / stun: / stuns:
# URL (host[:port][?transport=…], RFC 7065). A user:password@ some setups
# put in front is dropped (from the last '@'), so it is never printed.
TT_HOST=""; TT_PORT=""
turn_target() {
  local x="$1" sch=""
  TT_HOST=""; TT_PORT=""
  sch="$(lc "${x%%:*}")"
  case "${sch}" in turn|turns|stun|stuns) x="${x#*:}" ;; *) sch="" ;; esac
  x="${x#//}"
  case "${x}" in *@*) x="${x##*@}" ;; esac
  x="${x%%[?/#]*}"
  case "${x}" in
    \[*\]) TT_HOST="${x#\[}"; TT_HOST="${TT_HOST%\]}" ;;
    \[*\]:*) TT_HOST="${x#\[}"; TT_HOST="${TT_HOST%%\]*}"; TT_PORT="${x##*\]:}" ;;
    *:*:*) TT_HOST="${x}" ;;
    *:*) TT_HOST="${x%:*}"; TT_PORT="${x##*:}" ;;
    *) TT_HOST="${x}" ;;
  esac
  if [ -z "${TT_PORT}" ]; then case "${sch}" in turns|stuns) TT_PORT=5349 ;; *) TT_PORT=3478 ;; esac; fi
}

net_fds() {
  local fnr="" alloc="" max="" pct="" lim="" n=""
  if [ -z "${MAIN_PID}" ] && [ "${MANAGER}" = "systemd" ] && have systemctl; then MAIN_PID="$(systemctl show "${SERVICE}.service" -p MainPID 2>/dev/null | sed -n 's/^MainPID=//p')"; fi
  fnr="$(rd /proc/sys/fs/file-nr)"
  if [ -n "${fnr}" ]; then
    alloc="$(printf '%s' "${fnr}" | awk '{ print $1 }')"; max="$(printf '%s' "${fnr}" | awk '{ print $3 }')"
    if is_uint "${alloc}" && is_uint "${max}" && [ "${max}" -gt 0 ]; then
      pct=$((alloc * 100 / max))
      if [ "${pct}" -ge 80 ]; then warn network.fds "$(L "file handles ${alloc} of ${max} in use (${pct} %)" "popisovače souborů ${alloc} z ${max} (${pct} %)")" "sysctl -w fs.file-max=$((max * 2))"
      else pass network.fds "$(L "file handles ${alloc} of ${max}" "popisovače souborů ${alloc} z ${max}")"; fi
    fi
  fi
  if [ -n "${MAIN_PID}" ] && [ "${MAIN_PID}" != "0" ] && [ -r "$(sp "/proc/${MAIN_PID}/limits")" ]; then
    lim="$(awk '/^Max open files/ { print $4 }' "$(sp "/proc/${MAIN_PID}/limits")")"
    n="$(ls "$(sp "/proc/${MAIN_PID}/fd")" 2>/dev/null | wc -l | tr -d ' ')"
    if is_uint "${lim}" && is_uint "${n}" && [ "${lim}" -gt 0 ]; then
      if [ $((n * 100 / lim)) -ge 80 ]; then warn network.service_fds "$(L "the service uses ${n} of ${lim} descriptors" "služba používá ${n} z ${lim} popisovačů")" "LimitNOFILE=65536"
      elif [ "${lim}" -lt 65536 ]; then warn network.service_fds "$(L "the service may open only ${lim} files/sockets" "služba smí otevřít jen ${lim} souborů/socketů")" "LimitNOFILE=65536"
      else pass network.service_fds "$(L "the service: ${n} of ${lim} descriptors" "služba: ${n} z ${lim} popisovačů")"; fi
    fi
  fi
}

net_ports() {
  local tw="" lo="" hi="" range="" ov=""
  if have ss; then
    tw="$(ss -Htan state time-wait 2>/dev/null | wc -l | tr -d ' ')"
    lo="$(sysctl_v net.ipv4.ip_local_port_range | awk '{ print $1 }')"; hi="$(sysctl_v net.ipv4.ip_local_port_range | awk '{ print $2 }')"
    if is_uint "${tw}" && is_uint "${lo}" && is_uint "${hi}" && [ "${hi}" -gt "${lo}" ]; then
      range=$((hi - lo))
      if [ $((tw * 100 / range)) -ge 50 ]; then warn network.ephemeral "$(L "${tw} sockets in TIME-WAIT of ${range} ephemeral ports" "${tw} socketů v TIME-WAIT z ${range} efemérních portů")" "$(L 'keepalive to the upstream (upstream { keepalive 16; }), net.ipv4.tcp_tw_reuse=1' 'keepalive k upstreamu (upstream { keepalive 16; }), net.ipv4.tcp_tw_reuse=1')"
      else pass network.ephemeral "$(L "${tw} sockets in TIME-WAIT (${range} ephemeral ports)" "${tw} socketů v TIME-WAIT (${range} efemérních portů)")"; fi
    fi
  fi
  if [ -r "$(sp /proc/net/netstat)" ]; then
    ov="$(awk '$1 == "TcpExt:" { if (!h) { for (i = 2; i <= NF; i++) n[i] = $i; h = 1 } else { for (i = 2; i <= NF; i++) if (n[i] == "ListenOverflows") print $i } }' "$(sp /proc/net/netstat)")"
    if is_uint "${ov}" && [ "${ov}" -gt 0 ]; then warn network.listen_overflows "$(L "${ov} accept-queue overflows since boot (connections dropped)" "${ov} přetečení fronty spojení od startu (zahozená spojení)")" "sysctl -w net.core.somaxconn=4096 net.ipv4.tcp_max_syn_backlog=4096"
    elif is_uint "${ov}"; then pass network.listen_overflows "$(L 'no accept-queue overflow since boot' 'od startu žádné přetečení fronty spojení')"; fi
  fi
}

check_network() {
  sec network "Síť" "Network"
  net_dns
  net_outbound
  net_time
  if [ "${IS_LINUX}" = "1" ]; then net_mtu; net_fds; net_ports; fi
  net_turn
}

# ===========================================================================
# system
# ===========================================================================
os_support() {
  local id="$1" ver="$2" major=""
  major="${ver%%.*}"
  case "${id}" in
    ubuntu)
      case "${ver}" in
        22.04|24.04|26.04) printf 'lts' ;;
        20.04|18.04|16.04) printf 'eol' ;;
        *) if is_uint "${major}" && [ "${major}" -lt 22 ]; then printf 'eol'; else printf 'interim'; fi ;;
      esac ;;
    debian) if is_uint "${major}"; then if [ "${major}" -ge 12 ]; then printf 'ok'; else printf 'eol'; fi; else printf 'unknown'; fi ;;
    rhel|rocky|almalinux|ol|centos) if is_uint "${major}"; then if [ "${major}" -ge 8 ]; then printf 'ok'; else printf 'eol'; fi; else printf 'unknown'; fi ;;
    fedora) if is_uint "${major}" && [ "${major}" -ge 41 ]; then printf 'ok'; else printf 'eol'; fi ;;
    alpine) if printf '%s\n%s\n' "3.21" "${ver}" | sort -t. -k1,1n -k2,2n -C 2>/dev/null; then printf 'ok'; else printf 'eol'; fi ;;
    *) printf 'unknown' ;;
  esac
}

sys_os() {
  local f="" id="" ver="" pretty="" sup="" kv="" major="" minor=""
  if [ "${IS_LINUX}" = "0" ]; then
    pass system.os "$(uname -s 2>/dev/null) $(uname -r 2>/dev/null) ($(L 'not Linux: user-scope install only' 'není Linux: jen uživatelská instalace'))"
    return 0
  fi
  f="$(sp /etc/os-release)"
  if [ -r "${f}" ]; then
    id="$(sed -n 's/^ID=//p' "${f}" | tr -d '"' | head -n1)"; ver="$(sed -n 's/^VERSION_ID=//p' "${f}" | tr -d '"' | head -n1)"
    pretty="$(sed -n 's/^PRETTY_NAME=//p' "${f}" | tr -d '"' | head -n1)"
    sup="$(os_support "${id}" "${ver}")"
    case "${sup}" in
      eol) warn system.os "$(L "${pretty}: out of standard support" "${pretty}: mimo standardní podporu")" "$(L 'upgrade the distribution (no more security updates)' 'aktualizujte distribuci (už nedostává bezpečnostní opravy)')" ;;
      interim) warn system.os "$(L "${pretty}: an interim (non-LTS) release with a short support window" "${pretty}: průběžné (ne-LTS) vydání s krátkou podporou")" "$(L 'prefer an LTS release (Ubuntu 24.04, Debian 12/13)' 'raději LTS (Ubuntu 24.04, Debian 12/13)')" ;;
      unknown) pass system.os "$(L "${pretty:-${id}} (support not tracked by this check)" "${pretty:-${id}} (podporu tato kontrola nesleduje)")" ;;
      *) pass system.os "$(L "${pretty} (supported)" "${pretty} (podporované)")" ;;
    esac
  else skip system.os "/etc/os-release: $(L 'missing' 'chybí')"; fi
  kv="$(rd /proc/sys/kernel/osrelease)"; [ -n "${kv}" ] || kv="$(uname -r 2>/dev/null)"
  major="$(printf '%s' "${kv}" | cut -d. -f1)"; minor="$(printf '%s' "${kv}" | cut -d. -f2)"
  if is_uint "${major}" && is_uint "${minor}"; then
    if [ "${major}" -lt 4 ] || { [ "${major}" -eq 4 ] && [ "${minor}" -lt 18 ]; }; then fail system.kernel "$(L "kernel ${kv} is too old for Node.js 24" "jádro ${kv} je pro Node.js 24 příliš staré")" "$(L 'upgrade the OS' 'aktualizujte OS')"
    elif [ "${major}" -lt 5 ] || { [ "${major}" -eq 5 ] && [ "${minor}" -lt 10 ]; }; then warn system.kernel "$(L "kernel ${kv}: old (user namespaces / bubblewrap less mature)" "jádro ${kv}: staré (uživatelské jmenné prostory / bubblewrap méně vyzrálé)")" "$(L 'a 5.15+ / 6.x kernel' 'jádro 5.15+ / 6.x')"
    else pass system.kernel "$(L "kernel ${kv}" "jádro ${kv}")"; fi
  fi
}

sys_resources() {
  local mem_kb="" avail_kb="" swap_kb="" cpus="" mem_mb=""
  if [ "${IS_LINUX}" = "1" ]; then
    mem_kb="$(awk '/^MemTotal:/ { print $2 }' "$(sp /proc/meminfo)" 2>/dev/null)"
    avail_kb="$(awk '/^MemAvailable:/ { print $2 }' "$(sp /proc/meminfo)" 2>/dev/null)"
    swap_kb="$(awk '/^SwapTotal:/ { print $2 }' "$(sp /proc/meminfo)" 2>/dev/null)"
    cpus="$(grep -c '^processor' "$(sp /proc/cpuinfo)" 2>/dev/null)"
  else
    mem_kb="$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 ))"; cpus="$(sysctl -n hw.ncpu 2>/dev/null)"
  fi
  if ! is_uint "${mem_kb}" || [ "${mem_kb}" -eq 0 ]; then skip system.memory "$(L 'memory size unknown' 'velikost paměti neznámá')"; return 0; fi
  mem_mb=$((mem_kb / 1024))
  if [ "${mem_mb}" -lt 900 ]; then fail system.memory "$(L "${mem_mb} MB RAM, ${cpus:-?} CPU — the build and Functions need more" "${mem_mb} MB RAM, ${cpus:-?} CPU — build a funkce potřebují víc")" "$(L '>= 2 GB RAM (or add swap)' '>= 2 GB RAM (nebo přidejte swap)')"
  elif [ "${mem_mb}" -lt 1900 ]; then warn system.memory "$(L "${mem_mb} MB RAM, ${cpus:-?} CPU (2 GB recommended with Functions / Pyodide / local speech)" "${mem_mb} MB RAM, ${cpus:-?} CPU (s funkcemi / Pyodide / lokální řečí doporučeno 2 GB)")" "$(L 'more RAM or swap' 'víc RAM nebo swap')"
  else pass system.memory "$(L "${mem_mb} MB RAM, ${cpus:-?} CPU" "${mem_mb} MB RAM, ${cpus:-?} CPU")"; fi
  if is_uint "${avail_kb}" && [ "${avail_kb}" -lt $((mem_kb / 10)) ]; then warn system.memory_free "$(L "only $((avail_kb / 1024)) MB available now" "teď volných jen $((avail_kb / 1024)) MB")" "$(L 'find the memory hog: ps aux --sort=-rss | head' 'najděte žrouta paměti: ps aux --sort=-rss | head')"; fi
  if is_uint "${swap_kb}" && [ "${swap_kb}" -eq 0 ] && [ "${mem_mb}" -lt 4000 ]; then warn system.swap "$(L 'no swap with < 4 GB RAM: the build or a big function can be OOM-killed' 'bez swapu při < 4 GB RAM: build nebo velkou funkci může ukončit OOM killer')" "fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"; fi
}

sys_disk() {
  local p="" d="" seen=" " line="" fs="" pct="" free="" mnt="" ipct="" reported=""
  for p in "${ROOT}" "${DATA_BASE}" "$(conf_path BACKUP_ROOT)" "$(env_path BACKUP_DIR)" /var/log /tmp; do
    [ -n "${p}" ] || continue
    d="${p}"; while [ ! -d "${d}" ] && [ "${d}" != "/" ] && [ -n "${d}" ]; do d="$(dirname "${d}")"; done
    line="$(df -Pk "${d}" 2>/dev/null | tail -n1)"
    [ -n "${line}" ] || continue
    mnt="$(printf '%s' "${line}" | awk '{ print $NF }')"
    case "${seen}" in *" ${mnt} "*) continue ;; esac
    seen="${seen}${mnt} "
    free="$(printf '%s' "${line}" | awk '{ print int($4 / 1024) }')"
    pct="$(printf '%s' "${line}" | awk '{ v = $5; sub(/%/, "", v); print 100 - v }')"
    ipct="$(df -Pi "${d}" 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^(IUse%|%iused)$/) c = i } NR == 2 && c { v = $c; sub(/%/, "", v); print v }')"
    if is_uint "${pct}" && { [ "${free}" -lt 1024 ] || { [ "${pct}" -lt 5 ] && [ "${free}" -lt 5120 ]; }; }; then fail system.disk "$(L "${mnt}: ${free} MB free (${pct} %) — storage, logs and backups stop" "${mnt}: volných ${free} MB (${pct} %) — úložiště, logy i zálohy se zastaví")" "$(L 'free space (old backups, logs, docker system df)' 'uvolněte místo (staré zálohy, logy, docker system df)')"
    elif is_uint "${pct}" && [ "${pct}" -lt 10 ]; then warn system.disk "$(L "${mnt}: ${free} MB free (${pct} %)" "${mnt}: volných ${free} MB (${pct} %)")" "$(L 'free space before it runs out' 'uvolněte místo, než dojde')"
    else reported="${reported} ${mnt} ${free} MB (${pct} %),"; fi
    if is_uint "${ipct}" && [ "${ipct}" -ge 90 ]; then warn system.inodes "$(L "${mnt}: ${ipct} % inodes used" "${mnt}: využito ${ipct} % inodů")" "$(L 'many small files (session databases, logs)? clean up' 'mnoho malých souborů (databáze relací, logy)? ukliďte')"; fi
  done
  [ -n "${reported}" ] && pass system.disk "$(L "free:${reported%,}" "volno:${reported%,}")"
  # noexec where native modules load from
  local mf="" opts="" best="" bestlen=0 m="" o=""
  mf="$(sp /proc/mounts)"
  if [ -r "${mf}" ] && [ -d "${ROOT}/dist" ]; then
    while read -r _ m _ o _; do
      case "${ROOT}/" in "${m%/}/"*) if [ "${#m}" -gt "${bestlen}" ]; then best="${m}"; bestlen="${#m}"; opts="${o}"; fi ;; esac
    done < "${mf}"
    case ",${opts:-}," in *,noexec,*) fail system.noexec "$(L "${best} is mounted noexec: native modules in dist/node_modules (SQLCipher, speech) cannot load" "${best} je připojený s noexec: nativní moduly v dist/node_modules (SQLCipher, řeč) se nenačtou")" "$(L 'install elsewhere or remount without noexec' 'instalujte jinam, nebo připojte bez noexec')" ;;
      *) pass system.noexec "$(L "${best:-/} allows exec (native modules load)" "${best:-/} povoluje exec (nativní moduly se načtou)")" ;; esac
  fi
}

sys_mac() {
  local aa="" sel="" den=""
  [ "${IS_LINUX}" = "1" ] || return 0
  aa="$(rd /sys/module/apparmor/parameters/enabled)"
  if have getenforce; then sel="$(getenforce 2>/dev/null)"; fi
  if is_root; then
    den="$(cat "$(sp /var/log/kern.log)" "$(sp /var/log/syslog)" "$(sp /var/log/audit/audit.log)" 2>/dev/null | grep -E 'apparmor="DENIED"|avc: +denied' | grep -E 'comm="(node|bwrap|MainThread)"|profile="[^"]*(node|bwrap)' | tail -n 50 | wc -l | tr -d ' ')"
    if [ "${den:-0}" = "0" ] && have journalctl && [ -z "${SYSROOT}" ]; then
      den="$(journalctl -k --since '-7d' --no-pager 2>/dev/null | grep -E 'apparmor="DENIED"|avc: +denied' | grep -cE 'comm="(node|bwrap)"')"
    fi
  fi
  if [ "${aa}" = "Y" ]; then
    if is_uint "${den}" && [ "${den}" -gt 0 ]; then warn system.mac "$(L "AppArmor on; ${den} recent denials for node/bwrap" "AppArmor zapnutý; ${den} nedávných zamítnutí pro node/bwrap")" "$(L "journalctl -k | grep DENIED — adjust the profile" "journalctl -k | grep DENIED — upravte profil")"
    else pass system.mac "$(L 'AppArmor enabled, no denials for node/bwrap seen' 'AppArmor zapnutý, žádná zamítnutí pro node/bwrap')"; fi
  elif [ -n "${sel}" ]; then
    if is_uint "${den}" && [ "${den}" -gt 0 ]; then warn system.mac "$(L "SELinux ${sel}; ${den} AVC denials for node/bwrap" "SELinux ${sel}; ${den} zamítnutí AVC pro node/bwrap")" "ausearch -m avc -c node | audit2allow"
    else pass system.mac "SELinux ${sel}"; fi
  else
    pass system.mac "$(L 'no AppArmor / SELinux (systemd sandboxing still applies)' 'bez AppArmor / SELinux (sandbox systemd platí dál)')"
  fi
}

UNIT_RESTRICT_NS=""; UNIT_RAF=""
sys_bwrap() {
  local mode="" bw="" st="" aar="" prof="" out=""
  mode="$(lc "$(ev FUNCTIONS_SANDBOX_ISOLATION)")"
  case "${mode}" in none|off|0|false|no) skip system.bwrap "$(L 'process isolation turned off (FUNCTIONS_SANDBOX_ISOLATION)' 'izolace procesu vypnutá (FUNCTIONS_SANDBOX_ISOLATION)')"; return 0 ;; esac
  [ "${IS_LINUX}" = "1" ] || { skip system.bwrap "$(L 'not Linux (no bubblewrap)' 'není Linux (bez bubblewrap)')"; return 0; }
  st="WARN"; case "${mode}" in bwrap|required|require|on|1|true|yes) st="FAIL" ;; esac
  if ! have bwrap; then
    res "${st}" system.bwrap "$(L 'bubblewrap (bwrap) missing — function runs are not process-isolated' 'chybí bubblewrap (bwrap) — běhy funkcí nejsou izolované na úrovni procesu')" "apt install bubblewrap  |  dnf install bubblewrap"
    return 0
  fi
  aar="$(sysctl_v kernel.apparmor_restrict_unprivileged_userns)"
  if [ "${aar}" = "1" ] && [ ! -u "$(command -v bwrap)" ]; then
    prof="$(grep -lsE 'userns' "$(sp /etc/apparmor.d)"/* 2>/dev/null | xargs grep -lsE 'bwrap' 2>/dev/null | head -n1)"
    if [ -z "${prof}" ]; then
      res "${st}" system.bwrap "$(L 'AppArmor blocks unprivileged user namespaces (Ubuntu 24.04+) and no profile allows bwrap' 'AppArmor blokuje neprivilegované jmenné prostory (Ubuntu 24.04+) a žádný profil je bwrap nepovoluje')" \
        "$(L "a profile /etc/apparmor.d/bwrap: 'abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }' then apparmor_parser -r /etc/apparmor.d/bwrap" "profil /etc/apparmor.d/bwrap: 'abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }' a pak apparmor_parser -r /etc/apparmor.d/bwrap")"
      return 0
    fi
  fi
  if [ "${MANAGER}" = "systemd" ]; then
    # systemctl show: "yes" = every namespace forbidden, "no" = none, else the allowed list.
    case " ${UNIT_RESTRICT_NS} " in
      "  "|" no "|*" user "*) ;;
      *) res "${st}" system.bwrap "$(L "the unit restricts namespaces (RestrictNamespaces=${UNIT_RESTRICT_NS}) — bwrap cannot create a user namespace inside the service" "jednotka omezuje jmenné prostory (RestrictNamespaces=${UNIT_RESTRICT_NS}) — bwrap uvnitř služby nevytvoří uživatelský jmenný prostor")" \
           "$(L "drop-in: systemctl edit ${SERVICE} → [Service] RestrictNamespaces=user mnt pid net ipc uts" "drop-in: systemctl edit ${SERVICE} → [Service] RestrictNamespaces=user mnt pid net ipc uts")"
         return 0 ;;
    esac
    if [ -n "${UNIT_RAF}" ]; then
      case "${UNIT_RAF}" in
        "~"*) case " ${UNIT_RAF#\~} " in *" AF_NETLINK "*) UNIT_RAF="deny" ;; esac ;;
        *) case " ${UNIT_RAF} " in *" AF_NETLINK "*) ;; *) UNIT_RAF="deny" ;; esac ;;
      esac
      [ "${UNIT_RAF}" = "deny" ] && warn system.bwrap_netlink "$(L 'RestrictAddressFamilies forbids AF_NETLINK — bwrap --unshare-net cannot bring up loopback inside the service' 'RestrictAddressFamilies zakazuje AF_NETLINK — bwrap --unshare-net uvnitř služby nenahodí loopback')" "$(L 'add AF_NETLINK to RestrictAddressFamilies (drop-in)' 'přidejte AF_NETLINK do RestrictAddressFamilies (drop-in)')"
    fi
  fi
  if is_root && [ -z "${DROP_USER}" ]; then pass system.bwrap "$(L "bwrap $(bwrap --version 2>/dev/null | awk '{ print $2 }') present (not test-run as root)" "bwrap $(bwrap --version 2>/dev/null | awk '{ print $2 }') je k dispozici (jako root se nezkouší)")"; return 0; fi
  local who=""
  if is_root; then who="${DROP_USER}"; else who="$(id -un 2>/dev/null)"; fi
  out="$(run_as 10 bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / --proc /proc --dev /dev true 2>&1)"
  case $? in
    0) pass system.bwrap "$(L "bwrap $(bwrap --version 2>/dev/null | awk '{ print $2 }') isolates (test run as ${who:-?})" "bwrap $(bwrap --version 2>/dev/null | awk '{ print $2 }') izoluje (zkušební běh jako ${who:-?})")" ;;
    126) skip system.bwrap "$(L 'cannot switch to the service user to test bwrap' 'nelze přepnout na uživatele služby pro test bwrap')" ;;
    *) res "${st}" system.bwrap "$(L "bwrap fails: $(first_line "${out}" | cut -c1-160)" "bwrap selhává: $(first_line "${out}" | cut -c1-160)")" "$(L 'user namespaces (kernel.userns), AppArmor profile, or setuid bwrap' 'uživatelské jmenné prostory (kernel.userns), profil AppArmor, nebo setuid bwrap')" ;;
  esac
}

sys_speech() {
  local models="${DATA_BASE}/ai/speech-models" have_models=0 msg=""
  [ -n "$(ev AI_DATA_DIR)" ] && models="$(env_path AI_DATA_DIR)/speech-models"
  [ -d "${models}" ] && [ -n "$(ls -A "${models}" 2>/dev/null)" ] && have_models=1
  if ! have bzip2; then warn system.speech "$(L 'bzip2 missing — offline speech models cannot be unpacked' 'chybí bzip2 — modely offline řeči nejde rozbalit')" "apt install bzip2"; return 0; fi
  if [ "${have_models}" = "1" ] && [ "${MODE}" != "docker" ] && [ ! -d "${ROOT}/dist/node_modules/sherpa-onnx-node" ]; then
    warn system.speech "$(L 'speech models downloaded but the engine (sherpa-onnx-node) is not in dist' 'modely řeči jsou stažené, ale engine (sherpa-onnx-node) v dist chybí')" "$(L 'rebuild (update.sh --repair)' 'přestavte (update.sh --repair)')"
    return 0
  fi
  have ffmpeg && msg="ffmpeg" || msg="$(L 'no ffmpeg (WAV only — the chat app sends WAV)' 'bez ffmpeg (jen WAV — chatová aplikace posílá WAV)')"
  pass system.speech "$(L "speech tools: bzip2, ${msg}$( [ "${have_models}" = "1" ] && echo ', models present')" "nástroje řeči: bzip2, ${msg}$( [ "${have_models}" = "1" ] && echo ', modely staženy')")"
}

sys_redis() {
  local u="" h="" p=""
  u="$(ev REDIS_URL)"; [ -n "${u}" ] || return 0
  h="$(url_host "${u}")"; p="$(url_port "${u}" 6379)"
  # The host and port are validated and never become shell text (C01).
  if ! valid_host "${h}" || ! valid_port "${p}"; then
    fail system.redis "$(L "REDIS_URL ($(safe_url "${u}")) has no usable host:port — the cluster bus cannot connect" "REDIS_URL ($(safe_url "${u}")) nemá použitelné host:port — sběrnice clusteru se nepřipojí")" "$(L 'REDIS_URL=redis://[:password@]host:port (percent-encode / @ ? # in the password)' 'REDIS_URL=redis://[:heslo@]host:port (znaky / @ ? # v hesle zakódujte %xx)')"
  elif tcp_probe 5 "${h}" "${p}"; then pass system.redis "$(L "Redis $(safe_url "${u}") reachable" "Redis $(safe_url "${u}") je dosažitelný")"
  else fail system.redis "$(L "Redis $(safe_url "${u}") not reachable — the cluster bus is down" "Redis $(safe_url "${u}") není dosažitelný — sběrnice clusteru neběží")" "$(L 'start Redis / fix REDIS_URL' 'spusťte Redis / opravte REDIS_URL')"; fi
}

sys_backups() {
  local d="" n="" newest="" bd="" hours=""
  [ "${INSTALLED}" = "1" ] || return 0
  d="$(conf_path BACKUP_ROOT)"; [ -n "${d}" ] || d="${ROOT}/.m5cet/backups"
  if [ -d "${d}" ]; then
    n="$(ls -1d "${d}"/[0-9]*-* 2>/dev/null | wc -l | tr -d ' ')"
    newest="$(ls -1d "${d}"/[0-9]*-* 2>/dev/null | sort | tail -n1)"
    pass system.backups "$(L "installer backups: ${n} in ${d}${newest:+, newest $(basename "${newest}")} (configuration + dist, not data)" "zálohy instalátoru: ${n} v ${d}${newest:+, nejnovější $(basename "${newest}")} (konfigurace + dist, ne data)")"
  fi
  bd="$(env_path BACKUP_DIR)"
  if [ -z "${bd}" ]; then
    [ "${ENV_READABLE}" = "1" ] && warn system.app_backups "$(L 'BACKUP_DIR not set: the app does not back up its data (accounts, databases)' 'BACKUP_DIR není nastaven: aplikace nezálohuje svá data (účty, databáze)')" "BACKUP_DIR=/var/backups/m5cet-data; $(L 'storage.key / STORAGE_MASTER_KEY separately' 'storage.key / STORAGE_MASTER_KEY zvlášť')"
    return 0
  fi
  hours="$(ev BACKUP_INTERVAL_HOURS)"; is_uint "${hours}" || hours=24
  if [ ! -d "${bd}" ]; then
    if is_root || [ -r "$(dirname "${bd}")" ]; then fail system.app_backups "$(L "BACKUP_DIR ${bd} does not exist" "BACKUP_DIR ${bd} neexistuje")" "$(L "create it writable for the service: install -d -m 700 -o ${SVC_USER:-m5cet} ${bd}" "vytvořte ho zapisovatelný pro službu: install -d -m 700 -o ${SVC_USER:-m5cet} ${bd}")"
    else need_root system.app_backups "${bd}"; fi
    return 0
  fi
  newest="$(find "${bd}" -maxdepth 1 -name 'm5cet-*' -mmin "-$((hours * 2 * 60))" 2>/dev/null | head -n1)"
  if [ -n "${newest}" ]; then pass system.app_backups "$(L "app backups in ${bd}, the latest within $((hours * 2)) h" "zálohy aplikace v ${bd}, poslední do $((hours * 2)) h")"
  else warn system.app_backups "$(L "no app backup in ${bd} younger than $((hours * 2)) h" "v ${bd} není záloha aplikace mladší než $((hours * 2)) h")" "$(L 'check the audit log (backup failures) and the directory permissions' 'zkontrolujte audit (selhání zálohy) a práva adresáře')"; fi
}

sys_updates() {
  [ "${IS_LINUX}" = "1" ] || return 0
  local f="" id=""
  f="$(sp /etc/os-release)"; id="$(sed -n 's/^ID=//p' "${f}" 2>/dev/null | tr -d '"')"
  case " ${id} $(sed -n 's/^ID_LIKE=//p' "${f}" 2>/dev/null | tr -d '"') " in
    *" debian "*|*" ubuntu "*)
      if grep -qsE 'APT::Periodic::Unattended-Upgrade[[:space:]]+"1"' "$(sp /etc/apt/apt.conf.d)"/* && [ -e "$(sp /usr/bin/unattended-upgrade)" ]; then pass system.updates "$(L 'unattended security updates on' 'automatické bezpečnostní aktualizace zapnuté')"
      else warn system.updates "$(L 'unattended security updates are off' 'automatické bezpečnostní aktualizace jsou vypnuté')" "apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"; fi ;;
    *" rhel "*|*" fedora "*|*" centos "*|*" rocky "*|*" almalinux "*)
      if have systemctl && { systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1 || systemctl is-enabled dnf-automatic-install.timer >/dev/null 2>&1 || systemctl is-enabled dnf5-automatic.timer >/dev/null 2>&1; }; then pass system.updates "$(L 'dnf-automatic on' 'dnf-automatic zapnutý')"
      else warn system.updates "$(L 'automatic updates (dnf-automatic) are off' 'automatické aktualizace (dnf-automatic) jsou vypnuté')" "dnf install dnf-automatic && systemctl enable --now dnf-automatic-install.timer"; fi ;;
    *) skip system.updates "$(L "automatic updates not checked on ${id:-this OS}" "automatické aktualizace se na ${id:-tomto OS} nekontrolují")" ;;
  esac
  if [ -f "$(sp /var/run/reboot-required)" ] || [ -f "$(sp /run/reboot-required)" ]; then
    warn system.reboot "$(L "a reboot is pending ($(cat "$(sp /run/reboot-required.pkgs)" "$(sp /var/run/reboot-required.pkgs)" 2>/dev/null | sort -u | head -n3 | tr '\n' ' '))" "čeká se na restart ($(cat "$(sp /run/reboot-required.pkgs)" "$(sp /var/run/reboot-required.pkgs)" 2>/dev/null | sort -u | head -n3 | tr '\n' ' '))")" "$(L 'reboot in a maintenance window (security fixes are not active yet)' 'restartujte v servisním okně (bezpečnostní opravy ještě neplatí)')"
  elif have needs-restarting && [ -z "${SYSROOT}" ] && ! needs-restarting -r >/dev/null 2>&1; then
    warn system.reboot "$(L 'a reboot is pending (needs-restarting -r)' 'čeká se na restart (needs-restarting -r)')" "$(L 'reboot in a maintenance window' 'restartujte v servisním okně')"
  else pass system.reboot "$(L 'no reboot pending' 'restart nečeká')"; fi
}

sys_user() {
  local pw="" shell="" grps="" bad="" sudoers=""
  [ "${MANAGER}" = "systemd" ] || return 0
  pw="$(pw_entry "${SVC_USER}")"
  if [ -z "${pw}" ]; then fail system.service_user "$(L "service user ${SVC_USER} does not exist" "uživatel služby ${SVC_USER} neexistuje")" "${ROOT}/update.sh --repair"; return 0; fi
  shell="$(printf '%s' "${pw}" | awk -F: '{ print $7 }')"
  grps=" $(user_groups "${SVC_USER}") "
  case "${grps}" in *" sudo "*|*" wheel "*|*" admin "*|*" root "*) bad="${bad} sudo/wheel" ;; esac
  case "${grps}" in *" docker "*) bad="${bad} docker(=root)" ;; esac
  if is_root; then
    # The name compared as a string, not used as a regular expression.
    sudoers="$(grep -hs '' "$(sp /etc/sudoers)" "$(sp /etc/sudoers.d)"/* 2>/dev/null | awk -v u="${SVC_USER}" '$1 == u || $1 == "%" u { print; exit }')"
    [ -n "${sudoers}" ] && bad="${bad} sudoers"
  fi
  if [ -n "${bad}" ]; then fail system.service_user "$(L "service user ${SVC_USER} has privileges:${bad}" "uživatel služby ${SVC_USER} má oprávnění:${bad}")" "$(L "gpasswd -d ${SVC_USER} <group>; remove its sudoers line" "gpasswd -d ${SVC_USER} <skupina>; odeberte jeho řádek ze sudoers")"
  else
    case "${shell}" in
      */nologin|*/false) pass system.service_user "$(L "service user ${SVC_USER}: no login shell, no sudo" "uživatel služby ${SVC_USER}: bez přihlašovacího shellu, bez sudo")" ;;
      *) warn system.service_user "$(L "service user ${SVC_USER} has a login shell (${shell})" "uživatel služby ${SVC_USER} má přihlašovací shell (${shell})")" "usermod -s /usr/sbin/nologin ${SVC_USER}" ;;
    esac
  fi
}

check_system() {
  sec system "Systém" "System"
  sys_os
  sys_resources
  sys_disk
  sys_mac
  if [ "${MANAGER}" = "systemd" ] && have systemctl && [ -z "${UNIT_RESTRICT_NS}" ]; then
    UNIT_RESTRICT_NS="$(systemctl show "${SERVICE}.service" -p RestrictNamespaces 2>/dev/null | sed -n 's/^RestrictNamespaces=//p')"
    UNIT_RAF="$(systemctl show "${SERVICE}.service" -p RestrictAddressFamilies 2>/dev/null | sed -n 's/^RestrictAddressFamilies=//p')"
  fi
  sys_bwrap
  sys_speech
  sys_redis
  sys_backups
  sys_updates
  sys_user
}

# ===========================================================================
# docker
# ===========================================================================
check_docker() {
  sec docker "Docker" "Docker"
  if [ "${MODE}" != "docker" ]; then skip docker.mode "$(L "not a docker install (INSTALL_MODE=${MODE:-?})" "nejde o instalaci v dockeru (INSTALL_MODE=${MODE:-?})")"; return 0; fi
  if ! have docker; then fail docker.daemon "$(L 'docker missing' 'chybí docker')" "${ROOT}/update.sh --repair"; return 0; fi
  local info=""
  if ! info="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then
    case "${info}" in *ermission*) need_root docker.daemon "docker info" ;; *) fail docker.daemon "$(L 'the docker daemon is not reachable' 'docker daemon není dostupný')" "systemctl start docker" ;; esac
    return 0
  fi
  pass docker.daemon "Docker ${info}"
  local name=""
  for name in "${SERVICE}" "${SERVICE}-admin"; do
    [ "${name}" = "${SERVICE}-admin" ] && [ "${ADMIN_ON}" = "0" ] && continue
    docker_container "${name}"
  done
  if [ -f "${ROOT}/Dockerfile" ]; then
    if grep -E '^[[:space:]]*FROM[[:space:]]' "${ROOT}/Dockerfile" | grep -vq '@sha256:'; then warn docker.base_image "$(L 'Dockerfile base image not pinned by digest' 'základní image v Dockerfile není připnutý digestem')" "FROM node:24-slim@sha256:…"
    else pass docker.base_image "$(L 'base image pinned by digest' 'základní image připnutý digestem')"; fi
  fi
  if [ -f "${ROOT}/.dockerignore" ] && grep -qxE '\.env\*?' "${ROOT}/.dockerignore"; then pass docker.dockerignore "$(L '.dockerignore keeps .env* out of the build' '.dockerignore drží .env* mimo build')"
  else fail docker.dockerignore "$(L '.dockerignore does not exclude .env* — secrets can enter image layers' '.dockerignore nevylučuje .env* — tajemství se mohou dostat do vrstev image')" "$(L 'add the line .env* to .dockerignore and rebuild' 'přidejte řádek .env* do .dockerignore a přestavte')"; fi
}

docker_container() {
  local n="$1" fmt="" out="" st="" health="" priv="" ro="" user="" logt="" logsz="" caps="" sopt="" image="" ports="" bad="" secrets=""
  fmt='{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.HostConfig.Privileged}}|{{.HostConfig.ReadonlyRootfs}}|{{.Config.User}}|{{.HostConfig.LogConfig.Type}}|{{index .HostConfig.LogConfig.Config "max-size"}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.Config.Image}}'
  if ! out="$(docker inspect -f "${fmt}" "${n}" 2>/dev/null)"; then fail "docker.container" "$(L "container ${n} does not exist" "kontejner ${n} neexistuje")" "${ROOT}/update.sh --repair"; return 0; fi
  IFS='|' read -r st health priv ro user logt logsz caps sopt image <<EOF_D
${out}
EOF_D
  if [ "${st}" != "running" ]; then fail docker.container "$(L "${n} is ${st}" "${n} je ${st}")" "docker logs ${n}; ${ROOT}/install.sh --restart"
  else
    case "${health}" in
      healthy) pass docker.container "$(L "${n} running, healthy" "${n} běží, zdravý")" ;;
      unhealthy) fail docker.container "$(L "${n} running but UNHEALTHY" "${n} běží, ale je NEZDRAVÝ")" "docker inspect --format '{{json .State.Health}}' ${n}" ;;
      starting) warn docker.container "$(L "${n} starting" "${n} startuje")" "$(L 'check again in a minute' 'ověřte za minutu')" ;;
      *) pass docker.container "$(L "${n} running (no healthcheck)" "${n} běží (bez healthchecku)")" ;;
    esac
  fi
  [ "${priv}" = "true" ] && fail docker.privileged "$(L "${n} runs --privileged" "${n} běží s --privileged")" "$(L 'remove privileged from the compose file' 'odstraňte privileged z compose')"
  [ "${ro}" = "true" ] || bad="${bad} read_only"
  case "${caps}" in *ALL*) ;; *) bad="${bad} cap_drop:ALL" ;; esac
  case "${sopt}" in *no-new-privileges*) ;; *) bad="${bad} no-new-privileges" ;; esac
  case "${user}" in ""|root|0|0:0) fail docker.user "$(L "${n} runs as root" "${n} běží jako root")" "$(L 'USER node in the Dockerfile' 'USER node v Dockerfile')" ;; *) pass docker.user "$(L "${n} runs as ${user}" "${n} běží jako ${user}")" ;; esac
  if [ -n "${bad}" ]; then warn docker.hardening "$(L "${n} lacks:${bad}" "${n} postrádá:${bad}")" "$(L 'regenerate the compose file: update.sh --repair' 'znovu vygenerujte compose: update.sh --repair')"
  else pass docker.hardening "$(L "${n}: read-only root, cap_drop ALL, no-new-privileges" "${n}: root jen pro čtení, cap_drop ALL, no-new-privileges")"; fi
  case "${logt}" in
    json-file) if [ -n "${logsz}" ] && [ "${logsz}" != "<no value>" ]; then pass docker.logs "json-file, max-size ${logsz}"; else warn docker.logs "$(L "${n}: json-file logs without max-size grow without limit" "${n}: logy json-file bez max-size rostou bez omezení")" "logging: { driver: json-file, options: { max-size: 10m, max-file: '5' } }"; fi ;;
    *) pass docker.logs "$(L "log driver ${logt}" "log driver ${logt}")" ;;
  esac
  ports="$(docker port "${n}" 2>/dev/null)"
  local exp="127.0.0.1"; [ "${n}" = "${SERVICE}" ] && exp="$(cf BIND_ADDRESS)"
  if printf '%s\n' "${ports}" | grep -qE -- '-> (0\.0\.0\.0|\[?::\]?):' && is_loopback "${exp:-127.0.0.1}"; then
    fail docker.ports "$(L "${n} publishes on all interfaces: $(printf '%s' "${ports}" | tr '\n' ' ')" "${n} publikuje na všech rozhraních: $(printf '%s' "${ports}" | tr '\n' ' ')")" "$(L "publish on ${exp} (update.sh --repair regenerates compose)" "publikujte na ${exp} (update.sh --repair přegeneruje compose)")"
  elif [ -n "${ports}" ]; then pass docker.ports "$(L "${n}: $(printf '%s' "${ports}" | tr '\n' ' ')" "${n}: $(printf '%s' "${ports}" | tr '\n' ' ')")"; fi
  secrets="$(docker image inspect -f '{{json .Config.Env}}' "${image}" 2>/dev/null | tr ',' '\n' | sed -n 's/^\[\{0,1\}"\([A-Z0-9_]*\)=.*/\1/p' | grep -E 'TOKEN|SECRET|PRIVATE|PASSWORD|CREDENTIAL|_KEY$' | tr '\n' ' ')"
  if [ -n "${secrets}" ]; then fail docker.image_env "$(L "image ${image} carries secret variables in its ENV: ${secrets}" "image ${image} nese v ENV tajné proměnné: ${secrets}")" "$(L 'remove ENV secrets from the Dockerfile; pass them via env_file' 'odstraňte tajemství z ENV v Dockerfile; předávejte je přes env_file')"; fi
  local erc=0
  docker exec "${n}" node -e "process.exit(require('fs').existsSync('/app/.env')?1:0)" >/dev/null 2>&1 || erc=$?
  if [ "${erc}" = "1" ]; then fail docker.env_in_image "$(L "${n}: /app/.env exists inside the container" "${n}: /app/.env existuje uvnitř kontejneru")" "$(L 'rebuild with .env* in .dockerignore' 'přestavte s .env* v .dockerignore')"; fi
}

# ===========================================================================
# security — the app's own posture, summarised (informational)
# ===========================================================================
check_security() {
  sec security "Bezpečnost aplikace (souhrn)" "App security (summary)"
  if [ "${ENV_READABLE}" = "0" ]; then
    if [ -e "${ENV_FILE}" ]; then need_root security.summary "$(L 'reading .env' 'čtení .env')"; else skip security.summary "$(L 'no .env' 'chybí .env')"; fi
    return 0
  fi
  local v=""
  if is_on "$(ev HUB_REQUIRE_ROOM_PROOF)"; then v="$(L 'required' 'vyžadován')"; else v="$(L 'optional (clients < 6.12 allowed)' 'volitelný (povoleni klienti < 6.12)')"; fi
  pass security.protocol "$(L "protocol 4 (6.12): hub join proof ${v}" "protokol 4 (6.12): důkaz pro vstup do místnosti ${v}")"
  v="$(ev FUNCTIONS_SANDBOX_ISOLATION)"
  pass security.sandbox "$(L "Functions sandbox: node --permission + $( [ -n "${v}" ] && echo "isolation ${v}" || echo 'bubblewrap when present')" "sandbox funkcí: node --permission + $( [ -n "${v}" ] && echo "izolace ${v}" || echo 'bubblewrap, je-li k dispozici')")"
  if is_on "$(ev ENABLE_TELEPHONY)"; then
    if is_on "$(ev TELEPHONY_ALLOW_UNSIGNED)"; then v="$(L 'UNSIGNED accepted' 'přijímá i NEPODEPSANÉ')"; else v="$(L 'signature-checked' 'ověřované podpisem')"; fi
    pass security.telephony "$(L "telephony webhooks ${v}" "webhooky telefonie ${v}")"
  fi
  case "${SQLC_STATE}" in
    ok) v="$(L 'SQLCipher available — functions / telephony / storage databases encrypted' 'SQLCipher k dispozici — databáze funkcí / telefonie / úložiště šifrované')" ;;
    missing|broken) v="$(L 'SQLCipher NOT available — nothing is stored' 'SQLCipher NENÍ k dispozici — nic se neukládá')" ;;
    *) v="$(L 'SQLCipher not checked here' 'SQLCipher zde nekontrolován')" ;;
  esac
  if [ -n "$(ev STORAGE_MASTER_KEY)" ]; then v="${v}; $(L 'master key from the environment' 'hlavní klíč z prostředí')"
  elif [ -n "$(ev STORAGE_KEY_FILE)" ]; then v="${v}; $(L 'master key file' 'soubor hlavního klíče') $(ev STORAGE_KEY_FILE)"
  else v="${v}; $(L 'master key next to the databases (storage.key — back it up separately)' 'hlavní klíč vedle databází (storage.key — zálohujte zvlášť)')"; fi
  pass security.storage "${v}"
  if [ -n "$(ev TURN_SERVER_URL)" ]; then
    if [ -n "$(ev TURN_SECRET)" ]; then v="$(L 'short-lived TURN credentials' 'krátkodobé údaje TURN')"; else v="$(L 'static TURN credentials (F-28)' 'statické údaje TURN (F-28)')"; fi
    pass security.turn "${v}"
  fi
  if [ -f "${ROOT}/release.json.sig" ]; then v="$(L 'signed release (see package.signature)' 'podepsané vydání (viz package.signature)')"
  elif [ -f "${ROOT}/release.json" ]; then v="$(L 'unsigned release manifest' 'nepodepsaný manifest vydání')"
  else v="$(L 'no release manifest' 'bez manifestu vydání')"; fi
  pass security.release "${v}"
  v="LOG_EVENTS=$(ev_or LOG_EVENTS 0), ACCESS_LOG=$(ev_or ACCESS_LOG 1), ACCESS_LOG_FULL_IP=$(ev_or ACCESS_LOG_FULL_IP 0)"
  pass security.privacy "$(L "privacy: ${v}" "soukromí: ${v}")"
}

# ===========================================================================
# main
# ===========================================================================
TMPD=""
cleanup() { [ -n "${TMPD}" ] && rm -rf "${TMPD}"; }

main() {
  parse_args "$@"
  setup_colors
  TMPD="$(mktemp -d "${TMPDIR:-/tmp}/m5check.XXXXXX" 2>/dev/null)" || { printf 'check.sh: %s\n' "$(L 'cannot create a temporary directory' 'nelze vytvořit dočasný adresář')" >&2; exit 2; }
  trap cleanup EXIT
  pick_root
  [ -d "${ROOT}" ] || usage_err "--root ${ROOT}: $(L 'not a directory' 'není adresář')"
  init_context
  if [ "${JSON}" = "0" ]; then
    local head=""
    clean_text head "${ROOT}$( [ "${INSTALLED}" = "1" ] && printf ' (%s/%s%s)' "${MODE:-?}" "${MANAGER:-?}" "${DOMAIN:+, ${DOMAIN}}" )"
    printf '%sM5cet check.sh %s%s — %s%s\n' "${C_B}" "${CHECK_VERSION}" "${C_0}" "${head}" \
      "$(is_root || printf ' — %s' "$(L 'not root' 'bez roota')")"
  fi
  local s=""
  for s in ${SECTIONS_ALL}; do
    section_on "${s}" || continue
    "check_${s}"
  done
  local rc=0
  [ "${N_FAIL}" -gt 0 ] && rc=1
  if [ "${JSON}" = "1" ]; then json_report "${rc}"; else summary "${rc}"; fi
  if [ -n "${REPORT}" ]; then json_report "${rc}" > "${REPORT}" 2>/dev/null || true; fi
  return "${rc}"
}

main "$@"
exit $?
