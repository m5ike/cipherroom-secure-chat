#!/usr/bin/env bash
# =============================================================================
# M5cet — installer
# -----------------------------------------------------------------------------
# Detects the system, installs what is missing, asks how you want the app
# deployed (text wizard or whiptail/dialog TUI), saves every answer, installs.
#
#   native  build on the host, run under systemd (or as a plain process where
#           there is no systemd: macOS, containers, non-root installs)
#   docker  build an image, run it with docker compose
#
# Answers are stored in <dir>/.m5cet/install.conf (choices + state) and
# <dir>/.env (runtime environment incl. secrets, mode 0600/0640). update.sh
# and uninstall.sh read them, so they never need the flags repeated.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo -E bash -s -- --install
# Unattended:
#   sudo ./install.sh --non-interactive --mode docker --domain chat.example.com --enable-tls --email you@example.com
# Replay saved answers on another host:
#   sudo ./install.sh --non-interactive --config ./install.conf
# =============================================================================
set -Eeuo pipefail

M5_SCRIPT_NAME="install.sh"
_self="${BASH_SOURCE[0]:-}"
if [ -n "${_self}" ] && [ -f "${_self}" ]; then
  M5_SCRIPT_DIR="$(cd "$(dirname "${_self}")" && pwd)"
else
  M5_SCRIPT_DIR=""
fi

# --- bootstrap: piped from curl, the library is not on disk yet --------------
if [ -z "${M5_SCRIPT_DIR}" ] || [ ! -f "${M5_SCRIPT_DIR}/installer/lib/core.sh" ]; then
  _repo="${REPO_URL:-https://github.com/m5ike/cipherroom-secure-chat.git}"
  _branch="${BRANCH:-master}"
  _prev=""
  for _a in "$@"; do
    case "${_prev}" in --branch) _branch="${_a}" ;; --repo) _repo="${_a}" ;; esac
    _prev="${_a}"
  done
  command -v git >/dev/null 2>&1 || {
    echo "[+] installing git (needed to fetch the installer)" >&2
    if   command -v apt-get >/dev/null 2>&1; then apt-get update -y >/dev/null && apt-get install -y git ca-certificates >/dev/null
    elif command -v dnf     >/dev/null 2>&1; then dnf install -y git >/dev/null
    elif command -v yum     >/dev/null 2>&1; then yum install -y git >/dev/null
    elif command -v apk     >/dev/null 2>&1; then apk add --no-cache git >/dev/null
    elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm git >/dev/null
    elif command -v zypper  >/dev/null 2>&1; then zypper --non-interactive install git >/dev/null
    else echo "[x] git is required. Install it and re-run." >&2; exit 1; fi
  }
  _tmp="$(mktemp -d "${TMPDIR:-/tmp}/m5cet-bootstrap.XXXXXX")"
  echo "[+] fetching installer: ${_repo} @ ${_branch}" >&2
  git clone --quiet --depth=1 --branch "${_branch}" "${_repo}" "${_tmp}/src" || {
    echo "[x] cannot clone ${_repo} (branch ${_branch})" >&2; rm -rf "${_tmp}"; exit 1; }
  export M5_BOOTSTRAP_TMP="${_tmp}" REPO_URL="${_repo}" BRANCH="${_branch}"
  # stdin is the rest of this script when piped: never let the wizard read it.
  if { : </dev/tty; } 2>/dev/null; then
    exec bash "${_tmp}/src/install.sh" "$@" </dev/tty
  else
    exec bash "${_tmp}/src/install.sh" --non-interactive "$@" </dev/null
  fi
fi

# shellcheck source=installer/lib/core.sh
. "${M5_SCRIPT_DIR}/installer/lib/core.sh"
# shellcheck source=installer/lib/ui.sh
. "${M5_SCRIPT_DIR}/installer/lib/ui.sh"
# shellcheck source=installer/lib/system.sh
. "${M5_SCRIPT_DIR}/installer/lib/system.sh"
# shellcheck source=installer/lib/config.sh
. "${M5_SCRIPT_DIR}/installer/lib/config.sh"
# shellcheck source=installer/lib/deploy.sh
. "${M5_SCRIPT_DIR}/installer/lib/deploy.sh"
# shellcheck source=installer/lib/health.sh
. "${M5_SCRIPT_DIR}/installer/lib/health.sh"

trap 'on_error "${LINENO}"' ERR
_cleanup() {
  case "${M5_BOOTSTRAP_TMP:-}" in */m5cet-bootstrap.*) rm -rf "${M5_BOOTSTRAP_TMP}" ;; esac
}
trap _cleanup EXIT

COMMAND="install"
CONFIG_FILE=""
FORCE="0"
SKIP_DEPS="0"
SKIP_TESTS="0"
ORIG_ARGS=("$@")

usage() {
  cat <<EOF
M5cet installer v${M5_INSTALLER_VERSION}

$(L 'Usage' 'Použití'): ./install.sh [command] [options]

$(L 'Commands' 'Příkazy'):
  --install            $(L 'install (default)' 'instalace (výchozí)')
  --menu               $(L 'interactive main menu' 'interaktivní hlavní menu')
  --gui                $(L 'same, forcing the whiptail/dialog TUI' 'totéž, vynutí TUI whiptail/dialog')
  --doctor | --test    $(L 'read-only diagnosis of the system and the install' 'diagnostika systému a instalace (jen čtení)')
  --status | --logs | --start | --stop | --restart
  --update [...]       $(L 'run update.sh (arguments are passed on)' 'spustí update.sh (argumenty se předají)')
  --uninstall [...]    $(L 'run uninstall.sh' 'spustí uninstall.sh')
  --list-params        $(L 'every parameter with its default' 'všechny parametry s výchozími hodnotami')
  --version | --help

$(L 'Options' 'Volby'):
  --mode native|docker        $(L 'on the host / in containers' 'na hostiteli / v kontejnerech')
  --dir PATH                  $(L 'install directory' 'instalační adresář')
  --port N   --bind ADDR      $(L 'listen port and address' 'port a adresa, na které služba naslouchá')
  --domain NAME               $(L 'public host name (enables the Nginx proxy)' 'veřejné jméno (zapne proxy Nginx)')
  --enable-nginx | --disable-nginx
  --enable-tls --email ADDR   $(L "Let's Encrypt certificate" "certifikát Let's Encrypt")
  --open-firewall             $(L 'open the needed ports in ufw/firewalld' 'otevře potřebné porty v ufw/firewalld')
  --enable-admin              $(L 'also run the admin API (token is generated)' 'spustí i admin API (token se vygeneruje)')
  --enable-push               $(L 'Web Push (VAPID keys are generated)' 'Web Push (VAPID klíče se vygenerují)')
  --source git|local          --repo URL  --branch NAME  --source-path PATH
  --user-scope | --system-scope
  --set KEY=VALUE             $(L 'any parameter, repeatable' 'libovolný parametr, lze opakovat')
  --config FILE               $(L 'answers file (a saved install.conf)' 'soubor odpovědí (uložený install.conf)')
  --ui auto|text|dialog       --lang cs|en
  -n, --non-interactive       -y, --yes       --dry-run       --verbose
  --force                     $(L 'install over an existing installation' 'instalovat přes existující instalaci')
  --skip-deps  --skip-tests

$(L 'Every choice is saved to' 'Všechny volby se ukládají do') <dir>/.m5cet/install.conf, $(L 'secrets to' 'tajemství do') <dir>/.env.
EOF
}

_need_val() { [ $# -ge 2 ] || die "$(L "Option $1 needs a value." "Volba $1 vyžaduje hodnotu.")"; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --install)        COMMAND="install" ;;
      --menu)           COMMAND="menu" ;;
      --gui)            COMMAND="menu"; UI="dialog" ;;
      --doctor|--test)  COMMAND="doctor" ;;
      --status|--logs|--start|--stop|--restart) COMMAND="${1#--}" ;;
      --update)         shift; exec bash "${M5_SCRIPT_DIR}/update.sh" "$@" ;;
      --uninstall)      shift; exec bash "${M5_SCRIPT_DIR}/uninstall.sh" "$@" ;;
      --list-params)    COMMAND="list-params" ;;
      --version)        echo "${M5_INSTALLER_VERSION}"; exit 0 ;;
      -h|--help)        usage; exit 0 ;;
      --mode)           _need_val "$@"; conf_set INSTALL_MODE "$2"; shift ;;
      --dir)            _need_val "$@"; conf_set INSTALL_DIR "$2"; shift ;;
      --port)           _need_val "$@"; conf_set APP_PORT "$2"; shift ;;
      --bind)           _need_val "$@"; conf_set BIND_ADDRESS "$2"; shift ;;
      --domain)         _need_val "$@"; conf_set DOMAIN "$2"; shift ;;
      --email)          _need_val "$@"; conf_set ACME_EMAIL "$2"; shift ;;
      --branch)         _need_val "$@"; conf_set BRANCH "$2"; shift ;;
      --repo)           _need_val "$@"; conf_set REPO_URL "$2"; shift ;;
      --source)         _need_val "$@"; conf_set SOURCE "$2"; shift ;;
      --source-path)    _need_val "$@"; conf_set SOURCE_PATH "$2"; conf_set SOURCE local; shift ;;
      --enable-nginx)   conf_set ENABLE_NGINX 1 ;;
      --disable-nginx)  conf_set ENABLE_NGINX 0 ;;
      --enable-tls)     conf_set ENABLE_TLS 1 ;;
      --open-firewall)  conf_set FIREWALL_OPEN 1 ;;
      --enable-admin)   conf_set ENABLE_ADMIN 1 ;;
      --enable-push)    conf_set ENABLE_PUSH 1 ;;
      --user-scope)     conf_set SCOPE user ;;
      --system-scope)   conf_set SCOPE system ;;
      --set)            _need_val "$@"
                        case "$2" in *=*) conf_set "${2%%=*}" "${2#*=}" ;; *) die "--set $(L 'expects KEY=VALUE' 'očekává KEY=VALUE')" ;; esac
                        shift ;;
      --config)         _need_val "$@"; CONFIG_FILE="$2"; shift ;;
      --ui)             _need_val "$@"; UI="$2"; shift ;;
      --lang)           _need_val "$@"; M5_LANG="$2"; shift ;;
      -n|--non-interactive) NON_INTERACTIVE="1" ;;
      -y|--yes)         ASSUME_YES="1" ;;
      --dry-run)        DRY_RUN="1" ;;
      --verbose)        VERBOSE="1" ;;
      --force)          FORCE="1" ;;
      --skip-deps)      SKIP_DEPS="1" ;;
      --skip-tests)     SKIP_TESTS="1" ;;
      *) usage >&2; die "$(L 'Unknown option:' 'Neznámá volba:') $1" ;;
    esac
    shift
  done
}

# System scope needs root. Re-exec under sudo before asking anything, so the
# answers are not lost to a privilege change half-way through.
ensure_privileges() {
  if [ "${SYS_KERNEL}" = "Darwin" ]; then
    # Homebrew refuses to run as root and there is no systemd: user scope only.
    [ "${SCOPE:-}" = "system" ] && warn "$(L 'macOS supports user-scope installs only.' 'macOS podporuje jen uživatelskou instalaci.')"
    SCOPE="user"; return 0
  fi
  if [ -z "${SCOPE+x}" ] || [ -z "${SCOPE}" ]; then
    if is_root; then SCOPE="system"
    elif have sudo && [ "${DRY_RUN}" != "1" ] && [ "${NON_INTERACTIVE}" != "1" ] \
         && ui_yesno "$(L 'Install system-wide (needs root via sudo)? "No" installs for the current user only.' \
                          'Instalovat pro celý systém (vyžaduje root přes sudo)? „Ne" = jen pro aktuálního uživatele.')" 1; then
      SCOPE="system"
    else SCOPE="user"; fi
  fi
  if [ "${SCOPE}" = "system" ] && ! is_root && [ "${DRY_RUN}" != "1" ]; then
    have sudo || die "$(L 'System scope needs root. Run as root, install sudo, or pass --user-scope.' \
                         'Systémová instalace vyžaduje root. Spusťte jako root, nainstalujte sudo, nebo použijte --user-scope.')"
    info "$(L 'Re-running under sudo…' 'Spouštím znovu přes sudo…')"
    exec sudo -E bash "${M5_SCRIPT_DIR}/install.sh" --system-scope ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  fi
  return 0
}

# ask KEY "Title" "Prompt" — prompt until the value validates.
ask() {
  local key="$1" title="$2" prompt="$3" value why
  while :; do
    ui_input value "${title}" "${prompt}" "${!key}"
    case "${key}" in INSTALL_DIR|SOURCE_PATH) [ -n "${value}" ] && value="$(abs_path "${value}")" ;; esac
    if why="$(conf_validate "${key}" "${value}")"; then
      printf -v "${key}" '%s' "${value}"; return 0
    fi
    warn "${key}: ${why}"
    [ "${NON_INTERACTIVE}" = "1" ] && die "$(L 'Invalid value in non-interactive mode.' 'Neplatná hodnota v bezobslužném režimu.')"
  done
}

ask_bool() {
  local key="$1" prompt="$2" def
  def="${!key}"; [ "${def}" = "1" ] || def="0"
  if ui_yesno "${prompt}" "${def}"; then printf -v "${key}" '%s' "1"; else printf -v "${key}" '%s' "0"; fi
}

run_wizard() {
  [ "${NON_INTERACTIVE}" = "1" ] && return 0
  local T bind_choice
  T="$(L 'M5cet setup' 'Instalace M5cet')"
  step "$(L 'Setup wizard' 'Průvodce instalací') (${UI_BACKEND})"

  ui_menu INSTALL_MODE "${T}" "$(L 'How should M5cet run?' 'Jak má M5cet běžet?')" "${INSTALL_MODE}" \
    native "$(L 'on this host (Node.js + systemd / plain process)' 'přímo na tomto stroji (Node.js + systemd / proces)')" \
    docker "$(L 'in containers (Docker Compose)' 'v kontejnerech (Docker Compose)')"

  ask INSTALL_DIR "${T}" "$(L 'Install directory' 'Instalační adresář')"

  ui_menu SOURCE "${T}" "$(L 'Where do the sources come from?' 'Odkud vzít zdrojové kódy?')" "${SOURCE}" \
    git   "$(L 'git repository (enables one-command updates)' 'git repozitář (umožní aktualizace jedním příkazem)')" \
    local "$(L 'a directory on this machine' 'adresář na tomto stroji')"
  if [ "${SOURCE}" = "git" ]; then
    ask REPO_URL "${T}" "$(L 'Repository URL' 'URL repozitáře')"
    ask BRANCH   "${T}" "$(L 'Branch' 'Větev')"
  else
    [ -n "${SOURCE_PATH}" ] || SOURCE_PATH="${M5_SCRIPT_DIR}"
    ask SOURCE_PATH "${T}" "$(L 'Path to the source tree' 'Cesta ke zdrojovému stromu')"
  fi

  ask APP_PORT "${T}" "$(L 'Port' 'Port')"
  if [ "${DRY_RUN}" != "1" ] && port_in_use "${APP_PORT}"; then
    warn "$(L "Port ${APP_PORT} is already in use on this machine." "Port ${APP_PORT} je na tomto stroji už obsazený.")"
    [ "${SYS_KERNEL}" = "Darwin" ] && [ "${APP_PORT}" = "5000" ] && info "$(L 'On macOS port 5000 belongs to AirPlay Receiver.' 'Na macOS port 5000 drží AirPlay Receiver.')"
    ask APP_PORT "${T}" "$(L 'Choose another port' 'Zvolte jiný port')"
  fi

  case "${BIND_ADDRESS}" in 127.0.0.1) bind_choice="local" ;; 0.0.0.0) bind_choice="all" ;; *) bind_choice="custom" ;; esac
  ui_menu bind_choice "${T}" "$(L 'Who may connect to the port directly?' 'Kdo se smí na port připojit přímo?')" "${bind_choice}" \
    local  "$(L '127.0.0.1 — only this machine (behind a reverse proxy)' '127.0.0.1 — jen tento stroj (za reverzní proxy)')" \
    all    "$(L '0.0.0.0 — every interface' '0.0.0.0 — všechna rozhraní')" \
    custom "$(L 'a specific address' 'konkrétní adresa')"
  case "${bind_choice}" in
    local) BIND_ADDRESS="127.0.0.1" ;;
    all)   BIND_ADDRESS="0.0.0.0" ;;
    *)     ask BIND_ADDRESS "${T}" "$(L 'Bind address' 'Adresa')" ;;
  esac

  if [ "${SCOPE}" = "system" ]; then
    ask DOMAIN "${T}" "$(L 'Public domain (empty = no reverse proxy)' 'Veřejná doména (prázdné = bez reverzní proxy)')"
    if [ -n "${DOMAIN}" ]; then
      ENABLE_NGINX="1"
      ui_yesno "$(L "Put Nginx in front of M5cet for ${DOMAIN}?" "Předřadit před M5cet Nginx pro ${DOMAIN}?")" 1 || ENABLE_NGINX="0"
      if [ "${ENABLE_NGINX}" = "1" ]; then
        ask_bool ENABLE_TLS "$(L "Get a Let's Encrypt certificate (WebRTC needs HTTPS)?" "Získat certifikát Let's Encrypt (WebRTC vyžaduje HTTPS)?")"
        [ "${ENABLE_TLS}" = "1" ] && ask ACME_EMAIL "${T}" "$(L 'E-mail for certificate notices' 'E-mail pro upozornění k certifikátu')"
      fi
    else
      ENABLE_NGINX="0"; ENABLE_TLS="0"
    fi
    ask_bool FIREWALL_OPEN "$(L 'Open the needed ports in the firewall (ufw/firewalld)?' 'Otevřít potřebné porty ve firewallu (ufw/firewalld)?')"
  else
    DOMAIN=""; ENABLE_NGINX="0"; ENABLE_TLS="0"; FIREWALL_OPEN="0"
  fi

  ask_bool ENABLE_ADMIN "$(L 'Run the admin API too (loopback only, random token)?' 'Spustit i admin API (jen loopback, náhodný token)?')"
  [ "${ENABLE_ADMIN}" = "1" ] && ask ADMIN_PORT "${T}" "$(L 'Admin port' 'Port admin API')"
  ask_bool ENABLE_PUSH "$(L 'Enable Web Push (a VAPID key pair is generated)?' 'Zapnout Web Push (vygeneruje se pár VAPID klíčů)?')"
  [ "${ENABLE_PUSH}" = "1" ] && ask VAPID_SUBJECT "${T}" "$(L 'VAPID subject (mailto: or https: URL)' 'VAPID subject (mailto: nebo https: URL)')"
  ask_bool LOG_EVENTS "$(L 'Log connection metadata (never message content)?' 'Logovat metadata spojení (nikdy obsah zpráv)?')"

  if ui_yesno "$(L 'Configure a TURN server (needed behind symmetric NAT)?' 'Nastavit TURN server (nutný za symetrickým NAT)?')" "$( [ -n "${TURN_SERVER_URL}" ] && echo 1 || echo 0 )"; then
    ask TURN_SERVER_URL "${T}" "TURN URL (turn:host:3478)"
    ask TURN_USERNAME   "${T}" "$(L 'TURN user name' 'TURN uživatel')"
    local cred=""
    ui_secret cred "${T}" "$(L 'TURN credential (hidden; empty keeps the current one)' 'TURN heslo (skryté; prázdné ponechá stávající)')"
    [ -n "${cred}" ] && TURN_CREDENTIAL="${cred}"
  fi

  if [ "${INSTALL_MODE}" = "native" ]; then
    ask_bool KEEP_NODE_MODULES "$(L 'Keep node_modules after the build (faster rebuilds, ~300 MB)?' 'Ponechat node_modules po buildu (rychlejší rebuild, ~300 MB)?')"
  fi
  return 0
}

# A pre-3.0 install: checkout directly in the directory, no .m5cet state.
handle_legacy() {
  local dir="${INSTALL_DIR}" legacy_compose
  [ -f "$(conf_file)" ] && return 0
  [ -d "${dir}/.git" ] || [ -f "${dir}/docker-compose.yml" ] || return 0
  legacy_compose="${dir}/docker-compose.yml"
  if [ -f "${legacy_compose}" ] && grep -Eq "${LEGACY_MARKER_RE}" "${legacy_compose}" 2>/dev/null; then
    step "$(L 'Older M5cet/CipherRoom install detected in' 'Nalezena starší instalace M5cet/CipherRoom v') ${dir}"
    info "$(L 'Its .env values are imported, its containers are stopped, then it is upgraded in place.' \
             'Hodnoty z .env se převezmou, kontejnery se zastaví a instalace se povýší na místě.')"
    ui_yesno "$(L 'Continue?' 'Pokračovat?')" 1 || die "$(L 'Aborted.' 'Přerušeno.')"
    env_load "${dir}/.env" 0
    LEGACY_UPGRADE="1"
  fi
  return 0
}

stop_legacy_stack() {
  [ "${LEGACY_UPGRADE:-0}" = "1" ] || return 0
  local cc
  cc="$(compose_cmd 2>/dev/null || true)"
  [ -n "${cc}" ] || return 0
  log "$(L 'Stopping the old compose project' 'Zastavuji starý compose projekt')"
  run_sh "${cc} -p '${SERVICE_NAME}' -f '${INSTALL_DIR}/docker-compose.yml' down --remove-orphans 2>/dev/null || true"
}

print_summary() {
  local url
  url="http://$(probe_host):${APP_PORT}"
  [ -n "${DOMAIN}" ] && nginx_wanted && url="$( [ "${ENABLE_TLS}" = "1" ] && echo https || echo http )://${DOMAIN}"
  if [ "${DRY_RUN}" = "1" ]; then
    printf '\n%s%s%s\n' "${C_YEL}" "$(L 'Dry run finished — nothing was changed.' 'Zkušební běh dokončen — nic se nezměnilo.')" "${C_RST}"
    return 0
  fi
  cat <<EOF

${C_GRN}$(L 'M5cet is installed.' 'M5cet je nainstalován.')${C_RST}
  $(L 'Version' 'Verze'):        ${INSTALLED_VERSION:-?}  (${INSTALLED_COMMIT:-?})
  $(L 'Mode' 'Režim'):         ${INSTALL_MODE} / ${SERVICE_MANAGER} / ${SCOPE}
  $(L 'Directory' 'Adresář'):      ${INSTALL_DIR}
  URL:           ${url}
  $(L 'Settings' 'Nastavení'):     $(conf_file)
  $(L 'Secrets' 'Tajemství'):     $(env_file)

$(L 'Manage' 'Správa'):
  ${INSTALL_DIR}/install.sh --status | --logs | --restart | --doctor
  ${INSTALL_DIR}/update.sh                      $(L '# new sources + rebuild' '# nové zdrojáky + rebuild')
  ${INSTALL_DIR}/update.sh --set KEY=VALUE      $(L '# change a parameter' '# změna parametru')
  ${INSTALL_DIR}/update.sh --repair             $(L '# fix a broken install' '# oprava rozbité instalace')
  ${INSTALL_DIR}/uninstall.sh                   $(L '# remove' '# odstranění')
EOF
  if [ "${ENABLE_ADMIN}" = "1" ]; then
    printf '\n%s http://127.0.0.1:%s/  —  %s: grep ADMIN_API_TOKEN %s\n' "Admin:" "${ADMIN_PORT}" "$(L 'token' 'token')" "$(env_file)"
  fi
  if [ -z "${DOMAIN}" ] && [ "${BIND_ADDRESS}" != "127.0.0.1" ]; then
    warn "$(L 'WebRTC needs a secure context: outside localhost, serve M5cet over HTTPS.' \
             'WebRTC vyžaduje secure context: mimo localhost musí M5cet běžet přes HTTPS.')"
  fi
}

install_cmd() {
  step "M5cet installer v${M5_INSTALLER_VERSION}"
  detect_system
  ui_init                       # before any question, incl. the sudo one
  ensure_privileges
  print_system_report

  # Precedence: flags / environment  >  --config answers file  >  defaults.
  if [ -n "${CONFIG_FILE}" ]; then
    conf_load "${CONFIG_FILE}" 0
    # An answers file may be another host's install.conf: keep its choices,
    # never its state (commit, unit paths, nginx site…).
    local sk; for sk in ${STATE_KEYS}; do printf -v "${sk}" '%s' ""; done
    log "$(L 'Answers loaded from' 'Odpovědi načteny z') ${CONFIG_FILE}"
  fi
  conf_apply_defaults

  if [ -f "$(conf_file)" ] && [ "${FORCE}" != "1" ]; then
    die "$(L "Already installed in ${INSTALL_DIR}. Use update.sh (or update.sh --reconfigure), or pass --force to reinstall." \
            "V ${INSTALL_DIR} už instalace je. Použijte update.sh (nebo update.sh --reconfigure), případně --force pro reinstalaci.")"
  fi

  handle_legacy
  run_wizard
  conf_resolve_auto
  conf_validate_all
  check_resources "${INSTALL_DIR}"
  if [ "${DRY_RUN}" != "1" ] && port_in_use "${APP_PORT}" && [ "${LEGACY_UPGRADE:-0}" != "1" ] && [ "${FORCE}" != "1" ]; then
    die "$(L "Port ${APP_PORT} is in use. Pick another with --port." "Port ${APP_PORT} je obsazený. Zvolte jiný přes --port.")"
  fi

  step "$(L 'Configuration' 'Konfigurace')"
  print_config_summary
  ui_yesno "$(L 'Install with this configuration?' 'Instalovat s touto konfigurací?')" 1 || die "$(L 'Aborted.' 'Přerušeno.')"

  if [ "${SKIP_DEPS}" != "1" ]; then
    step "$(L 'Dependencies' 'Závislosti')"
    ensure_base_packages
    ensure_tui_tool
    if [ "${INSTALL_MODE}" = "docker" ]; then ensure_docker; else ensure_node; fi
  fi

  stop_legacy_stack
  run mkdir -p "${INSTALL_DIR}" "$(state_dir)"
  [ "${DRY_RUN}" = "1" ] || chmod 0700 "$(state_dir)"

  fetch_sources
  ensure_admin_token

  # Persist early: a failed build can then be repaired or uninstalled cleanly.
  INSTALLER_VERSION="${M5_INSTALLER_VERSION}"
  INSTALL_STATUS="installing"
  INSTALLED_AT="$(now_iso)"; UPDATED_AT="${INSTALLED_AT}"
  conf_save
  pointer_write

  deploy_app
  write_nginx_site
  enable_tls
  open_firewall

  INSTALL_STATUS="installed"
  conf_save

  if [ "${SKIP_TESTS}" != "1" ]; then
    run_health_checks 40 || warn "$(L "Some checks failed — see: ${INSTALL_DIR}/install.sh --logs" "Některé kontroly selhaly — viz: ${INSTALL_DIR}/install.sh --logs")"
  fi
  print_summary
}

# Commands that act on an existing install.
with_install() {
  local dir
  detect_system
  dir="$(locate_install "${INSTALL_DIR:-}")" || {
    if [ "$1" = "doctor" ]; then conf_apply_defaults; doctor ""; return $?; fi
    die "$(L 'No M5cet installation found (use --dir).' 'Instalace M5cet nenalezena (použijte --dir).')"
  }
  conf_load "${dir}/.m5cet/install.conf" 1
  INSTALL_DIR="${dir}"
  env_load "$(env_file)" 1
  conf_apply_defaults
  case "$1" in
    doctor) doctor "${dir}" ;;
    status) service_ctl status; run_health_checks 3 || true ;;
    *)      service_ctl "$1" ;;
  esac
}

menu_cmd() {
  local choice=""
  detect_system
  ui_init
  while :; do
    ui_menu choice "M5cet" "$(L 'What would you like to do?' 'Co chcete udělat?')" "status" \
      install   "$(L 'Install' 'Instalovat')" \
      update    "$(L 'Update (new sources, rebuild)' 'Aktualizovat (nové zdrojáky, rebuild)')" \
      reconf    "$(L 'Change settings' 'Změnit nastavení')" \
      repair    "$(L 'Repair the installation' 'Opravit instalaci')" \
      status    "$(L 'Status + health checks' 'Stav + kontrola funkčnosti')" \
      doctor    "$(L 'Doctor (diagnosis)' 'Diagnostika')" \
      restart   "$(L 'Restart' 'Restartovat')" \
      stop      "$(L 'Stop' 'Zastavit')" \
      logs      "$(L 'Follow logs' 'Sledovat logy')" \
      uninstall "$(L 'Uninstall' 'Odinstalovat')" \
      quit      "$(L 'Quit' 'Konec')"
    case "${choice}" in
      install)   install_cmd ;;
      update)    bash "${M5_SCRIPT_DIR}/update.sh" --ui "${UI}" || true ;;
      reconf)    bash "${M5_SCRIPT_DIR}/update.sh" --reconfigure --ui "${UI}" || true ;;
      repair)    bash "${M5_SCRIPT_DIR}/update.sh" --repair --ui "${UI}" || true ;;
      uninstall) bash "${M5_SCRIPT_DIR}/uninstall.sh" --ui "${UI}" || true ;;
      quit)      return 0 ;;
      *)         ( with_install "${choice}" ) || true ;;
    esac
    [ "${NON_INTERACTIVE}" = "1" ] && return 0
  done
}

main() {
  parse_args "$@"
  case "${COMMAND}" in
    install)     install_cmd ;;
    menu)        menu_cmd ;;
    list-params) print_params ;;
    doctor|status|logs|start|stop|restart) with_install "${COMMAND}" ;;
    *)           usage; die "Unknown command ${COMMAND}" ;;
  esac
}

main "$@"
