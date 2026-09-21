#!/usr/bin/env bash
# =============================================================================
# M5cet — update / reconfigure / repair
# -----------------------------------------------------------------------------
# Reads <dir>/.m5cet/install.conf and <dir>/.env written by install.sh, so no
# flag has to be repeated. Every run backs the configuration (and, for native
# installs, dist/) up first and rolls back automatically when the health
# checks fail afterwards.
#
#   ./update.sh                         new sources, rebuild, restart
#   ./update.sh --check                 is there anything to update? (exit 0 = yes)
#   ./update.sh --set APP_PORT=8080     change parameters, then redeploy
#   ./update.sh --set INSTALL_MODE=docker   switch native <-> docker
#   ./update.sh --reconfigure           walk through the settings again
#   ./update.sh --repair                reinstall deps, regenerate service /
#                                       compose / nginx files, clean rebuild
#   ./update.sh --config-only --set …   apply settings without fetching sources
#   ./update.sh --rollback              return to the most recent backup
# =============================================================================
set -Eeuo pipefail

M5_SCRIPT_NAME="update.sh"
M5_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for _lib in core ui system config deploy health; do
  # shellcheck disable=SC1090
  . "${M5_SCRIPT_DIR}/installer/lib/${_lib}.sh"
done
trap 'on_error "${LINENO}"' ERR

ACTION="update"
DIR_ARG=""
NO_FETCH="0"
NO_ROLLBACK="0"
SKIP_TESTS="0"
SET_KEYS=""          # names changed on the command line (values live in SET_<n>)
SET_COUNT=0
ORIG_ARGS=("$@")

usage() {
  cat <<EOF
M5cet update v${M5_INSTALLER_VERSION}

$(L 'Usage' 'Použití'): ./update.sh [action] [options]

$(L 'Actions' 'Akce'):
  ($(L 'none' 'žádná'))            $(L 'fetch new sources, rebuild, restart' 'stáhne nové zdrojáky, přestaví, restartuje')
  --check              $(L 'only report whether an update is available' 'jen oznámí, zda je k dispozici aktualizace')
  --reconfigure        $(L 'run the settings wizard with the saved values' 'projde nastavení znovu s uloženými hodnotami')
  --repair             $(L 'fix a broken install (deps, permissions, generated files, clean rebuild)' 'opraví rozbitou instalaci (závislosti, práva, generované soubory, čistý rebuild)')
  --rollback           $(L 'restore the latest backup' 'obnoví poslední zálohu')
  --show               $(L 'print the saved configuration' 'vypíše uloženou konfiguraci')

$(L 'Options' 'Volby'):
  --set KEY=VALUE      $(L 'change a parameter (repeatable); see install.sh --list-params' 'změní parametr (lze opakovat); viz install.sh --list-params')
  --branch NAME        $(L 'switch the tracked branch' 'přepne sledovanou větev')
  --config-only        $(L 'do not fetch sources, only apply settings' 'nestahuje zdrojáky, jen použije nastavení')
  --no-rollback        $(L 'keep the new version even if checks fail' 'ponechá novou verzi i při neúspěšné kontrole')
  --dir PATH           $(L 'installation to act on (default: auto-detect)' 'instalace, se kterou pracovat (výchozí: autodetekce)')
  --ui auto|text|dialog   --lang cs|en
  -n, --non-interactive   -y, --yes   --dry-run   --verbose   --skip-tests
EOF
}

_need_val() { [ $# -ge 2 ] || die "$(L "Option $1 needs a value." "Volba $1 vyžaduje hodnotu.")"; }

# Requested changes are queued and applied *after* the saved configuration is
# loaded, otherwise the file would overwrite them.
queue_set() {
  local pair="$1"
  case "${pair}" in *=*) ;; *) die "--set $(L 'expects KEY=VALUE' 'očekává KEY=VALUE')" ;; esac
  printf -v "SET_K_${SET_COUNT}" '%s' "${pair%%=*}"
  printf -v "SET_V_${SET_COUNT}" '%s' "${pair#*=}"
  SET_COUNT=$((SET_COUNT+1))
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check)        ACTION="check" ;;
      --reconfigure)  ACTION="reconfigure" ;;
      --repair)       ACTION="repair" ;;
      --rollback)     ACTION="rollback" ;;
      --show)         ACTION="show" ;;
      --set)          _need_val "$@"; queue_set "$2"; shift ;;
      --branch)       _need_val "$@"; queue_set "BRANCH=$2"; shift ;;
      --config-only)  NO_FETCH="1" ;;
      --no-rollback)  NO_ROLLBACK="1" ;;
      --dir)          _need_val "$@"; DIR_ARG="$(abs_path "$2")"; shift ;;
      --ui)           _need_val "$@"; UI="$2"; shift ;;
      --lang)         _need_val "$@"; M5_LANG="$2"; shift ;;
      -n|--non-interactive) NON_INTERACTIVE="1" ;;
      -y|--yes)       ASSUME_YES="1" ;;
      --dry-run)      DRY_RUN="1" ;;
      --verbose)      VERBOSE="1" ;;
      --skip-tests)   SKIP_TESTS="1" ;;
      -h|--help)      usage; exit 0 ;;
      --version)      echo "${M5_INSTALLER_VERSION}"; exit 0 ;;
      *) usage >&2; die "$(L 'Unknown option:' 'Neznámá volba:') $1" ;;
    esac
    shift
  done
}

load_install() {
  local dir
  dir="$(locate_install "${DIR_ARG}")" || die "$(L 'No M5cet installation found. Pass --dir, or run install.sh first.' \
                                                   'Instalace M5cet nenalezena. Zadejte --dir, nebo nejdřív spusťte install.sh.')"
  conf_load "${dir}/.m5cet/install.conf" 1
  INSTALL_DIR="${dir}"
  env_load "$(env_file)" 1
  conf_apply_defaults
  # Remember how things were deployed, to tear the old form down on a switch.
  OLD_MODE="${INSTALL_MODE}"; OLD_MANAGER="${SERVICE_MANAGER}"
  OLD_NGINX_WANTED="0"; nginx_wanted && OLD_NGINX_WANTED="1"
  return 0
}

apply_sets() {
  local i=0 k v
  while [ "${i}" -lt "${SET_COUNT}" ]; do
    k="SET_K_${i}"; v="SET_V_${i}"
    case "${!k}" in
      INSTALL_DIR|SCOPE) die "$(L "${!k} cannot be changed by an update — uninstall and install again." "${!k} nelze změnit aktualizací — odinstalujte a nainstalujte znovu.")" ;;
    esac
    conf_set "${!k}" "${!v}"
    SET_KEYS="${SET_KEYS} ${!k}"
    # a mode switch invalidates the derived service manager
    [ "${!k}" = "INSTALL_MODE" ] && SERVICE_MANAGER="auto"
    i=$((i+1))
  done
  [ -n "${SET_KEYS}" ] && log "$(L 'Changed:' 'Změněno:')${SET_KEYS}"
  return 0
}

ensure_privileges() {
  [ "${SCOPE}" = "system" ] || return 0
  is_root && return 0
  [ "${DRY_RUN}" = "1" ] && return 0
  case "${ACTION}" in check|show) return 0 ;; esac
  have sudo || die "$(L 'This installation is system-wide: run as root.' 'Tato instalace je systémová: spusťte jako root.')"
  info "$(L 'Re-running under sudo…' 'Spouštím znovu přes sudo…')"
  exec sudo -E bash "${M5_SCRIPT_DIR}/update.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
}

# The subset of install.sh's wizard that makes sense after installation.
reconfigure_wizard() {
  [ "${NON_INTERACTIVE}" = "1" ] && return 0
  local T value why key
  T="$(L 'M5cet settings' 'Nastavení M5cet')"
  step "$(L 'Settings' 'Nastavení') (${UI_BACKEND})"
  ui_menu INSTALL_MODE "${T}" "$(L 'Run mode' 'Režim běhu')" "${INSTALL_MODE}" \
    native "$(L 'on this host' 'přímo na tomto stroji')" \
    docker "$(L 'in containers' 'v kontejnerech')"
  [ "${INSTALL_MODE}" != "${OLD_MODE}" ] && SERVICE_MANAGER="auto"
  for key in BRANCH APP_PORT BIND_ADDRESS DOMAIN ACME_EMAIL ADMIN_PORT VAPID_SUBJECT TURN_SERVER_URL TURN_USERNAME BACKUP_KEEP; do
    [ "${key}" = "BRANCH" ] && [ "${SOURCE}" != "git" ] && continue
    while :; do
      ui_input value "${T}" "${key}" "${!key}"
      if why="$(conf_validate "${key}" "${value}")"; then printf -v "${key}" '%s' "${value}"; break; fi
      warn "${key}: ${why}"
    done
  done
  for key in ENABLE_TLS FIREWALL_OPEN ENABLE_ADMIN ENABLE_PUSH LOG_EVENTS KEEP_NODE_MODULES; do
    if ui_yesno "${key}?" "${!key}"; then printf -v "${key}" '%s' 1; else printf -v "${key}" '%s' 0; fi
  done
  if [ -n "${DOMAIN}" ] && [ "${SCOPE}" = "system" ]; then ENABLE_NGINX="1"; else ENABLE_NGINX="0"; ENABLE_TLS="0"; fi
  return 0
}

check_cmd() {
  local rc=0
  update_available || rc=$?
  case "${rc}" in
    0) log "$(L 'Update available:' 'K dispozici je aktualizace:') ${INSTALLED_COMMIT:0:12} → ${REMOTE_COMMIT:0:12} (${BRANCH})"; return 0 ;;
    1) log "$(L 'Up to date' 'Aktuální') (${INSTALLED_COMMIT:0:12}, ${BRANCH})"; return 1 ;;
    *) warn "$(L 'Cannot tell: SOURCE is not git, or the remote is unreachable.' 'Nelze zjistit: SOURCE není git, nebo je vzdálený repozitář nedostupný.')"; return 2 ;;
  esac
}

repair_prepare() {
  step "$(L 'Repair' 'Oprava')"
  [ "${DRY_RUN}" = "1" ] || { chmod 0700 "$(state_dir)" 2>/dev/null || true; }
  # A clean rebuild: stale build output and modules are the usual culprits.
  if [ "${INSTALL_MODE}" = "native" ]; then
    run rm -rf "${INSTALL_DIR}/node_modules" "${INSTALL_DIR}/dist"
  fi
  if [ "${SOURCE}" = "git" ] && [ -d "${INSTALL_DIR}/.git" ] && [ "${DRY_RUN}" != "1" ]; then
    # Discard local edits to tracked files; untracked .env/.m5cet are untouched.
    _git reset -q --hard HEAD 2>/dev/null || true
  fi
  return 0
}

update_cmd() {
  local mode_changed="0"
  apply_sets
  [ "${ACTION}" = "reconfigure" ] && reconfigure_wizard
  conf_resolve_auto
  conf_validate_all
  if [ "${INSTALL_MODE}" != "${OLD_MODE}" ] || [ "${SERVICE_MANAGER}" != "${OLD_MANAGER}" ]; then mode_changed="1"; fi

  step "$(L 'Configuration' 'Konfigurace')"
  print_config_summary
  if [ "${mode_changed}" = "1" ]; then
    warn "$(L "Deployment changes: ${OLD_MODE}/${OLD_MANAGER} → ${INSTALL_MODE}/${SERVICE_MANAGER}" "Mění se způsob nasazení: ${OLD_MODE}/${OLD_MANAGER} → ${INSTALL_MODE}/${SERVICE_MANAGER}")"
  fi
  ui_yesno "$(L 'Proceed?' 'Pokračovat?')" 1 || die "$(L 'Aborted.' 'Přerušeno.')"

  backup_create "pre-${ACTION}"

  step "$(L 'Dependencies' 'Závislosti')"
  ensure_base_packages
  if [ "${INSTALL_MODE}" = "docker" ]; then ensure_docker; else ensure_node; fi

  [ "${ACTION}" = "repair" ] && repair_prepare

  if [ "${mode_changed}" = "1" ]; then
    step "$(L 'Removing the previous deployment' 'Odstraňuji předchozí nasazení') (${OLD_MANAGER})"
    ( SERVICE_MANAGER="${OLD_MANAGER}"; INSTALL_MODE="${OLD_MODE}"; teardown_service "${OLD_MANAGER}" )
    UNIT_FILES=""
  elif [ "${OLD_MANAGER}" = "process" ]; then
    # The port may change: stop the old process before starting the new one.
    service_ctl stop
  fi

  if [ "${NO_FETCH}" = "1" ] && [ "${ACTION}" != "repair" ]; then
    info "$(L 'Skipping the source fetch (--config-only).' 'Přeskakuji stažení zdrojáků (--config-only).')"
  else
    fetch_sources
  fi

  ensure_admin_token
  # Settings-only change on an unchanged deployment: no need to rebuild.
  if [ "${NO_FETCH}" = "1" ] && [ "${ACTION}" != "repair" ] && [ "${mode_changed}" = "0" ]; then deploy_app 1
  else deploy_app; fi

  if nginx_wanted; then
    write_nginx_site; enable_tls
  elif [ "${OLD_NGINX_WANTED}" = "1" ]; then
    remove_nginx_site
  fi
  open_firewall

  INSTALLER_VERSION="${M5_INSTALLER_VERSION}"
  INSTALL_STATUS="installed"
  UPDATED_AT="$(now_iso)"
  conf_save

  if [ "${SKIP_TESTS}" != "1" ] && ! run_health_checks 40; then
    if [ "${NO_ROLLBACK}" = "1" ] || [ "${DRY_RUN}" = "1" ]; then
      warn "$(L 'Checks failed; keeping the new version (--no-rollback).' 'Kontroly selhaly; nová verze ponechána (--no-rollback).')"
      return 1
    fi
    warn "$(L 'Checks failed — rolling back.' 'Kontroly selhaly — vracím předchozí stav.')"
    if [ "${mode_changed}" = "1" ]; then teardown_service "${SERVICE_MANAGER}"; fi
    rollback
    if [ "${mode_changed}" = "1" ]; then
      # Back on the old manager: its unit / compose files were removed above.
      if [ "${INSTALL_MODE}" = "native" ]; then native_install_service; service_ctl restart
      else write_compose_file; _compose up -d --remove-orphans; fi
    fi
    run_health_checks 20 || true
    die "$(L "Update failed and was rolled back. Backup: ${LAST_BACKUP}" "Aktualizace selhala a byla vrácena. Záloha: ${LAST_BACKUP}")"
  fi

  printf '\n%s%s%s  v%s (%s)\n' "${C_GRN}" "$(L 'M5cet is up to date.' 'M5cet je aktuální.')" "${C_RST}" "${INSTALLED_VERSION:-?}" "${INSTALLED_COMMIT:0:12}"
  info "$(L 'Backup of the previous state:' 'Záloha předchozího stavu:') ${LAST_BACKUP}"
}

rollback_cmd() {
  local latest
  latest="$(ls -1d "${BACKUP_ROOT}"/[0-9]*-* 2>/dev/null | sort -r | head -n1 || true)"
  [ -n "${latest}" ] || die "$(L "No backups in ${BACKUP_ROOT}." "V ${BACKUP_ROOT} nejsou žádné zálohy.")"
  LAST_BACKUP="${latest}"
  ui_yesno "$(L "Restore ${latest}?" "Obnovit ${latest}?")" 1 || die "$(L 'Aborted.' 'Přerušeno.')"
  [ "${DRY_RUN}" = "1" ] && { info "[dry-run] rollback → ${latest}"; return 0; }
  rollback
  run_health_checks 20 || die "$(L 'Health checks still fail after the rollback.' 'Kontroly selhávají i po návratu.')"
}

main() {
  parse_args "$@"
  detect_system
  load_install
  ensure_privileges
  ui_init
  step "M5cet update v${M5_INSTALLER_VERSION} — ${INSTALL_DIR} (v${INSTALLED_VERSION:-?}, ${INSTALL_MODE}/${SERVICE_MANAGER})"
  case "${ACTION}" in
    check)    check_cmd || exit $? ;;
    show)     print_config_summary ;;
    rollback) rollback_cmd ;;
    *)        update_cmd ;;
  esac
}

main "$@"
