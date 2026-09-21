#!/usr/bin/env bash
# =============================================================================
# M5cet — uninstall
# -----------------------------------------------------------------------------
# Reads <dir>/.m5cet/install.conf, so it removes exactly what install.sh
# created: the service (systemd units / process / containers + images), the
# managed Nginx site, the firewall rule for the app port, and the files.
#
#   ./uninstall.sh                 stop + remove the service and the files;
#                                  a final backup of .env/install.conf is kept
#   ./uninstall.sh --keep-files    remove the service only, leave the directory
#   ./uninstall.sh --purge         also remove backups, the service user and
#                                  docker images — nothing is left behind
#
# Safety: only a directory that carries the installer's own marker
# (.m5cet/install.conf) is ever deleted, and never /, \$HOME or a system path.
# Packages installed as dependencies (Docker, Node.js, Nginx) are NOT removed;
# they are listed at the end.
# =============================================================================
set -Eeuo pipefail

M5_SCRIPT_NAME="uninstall.sh"
M5_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for _lib in core ui system config deploy health; do
  # shellcheck disable=SC1090
  . "${M5_SCRIPT_DIR}/installer/lib/${_lib}.sh"
done
trap 'on_error "${LINENO}"' ERR

DIR_ARG=""
KEEP_FILES="0"
PURGE="0"
ORIG_ARGS=("$@")

usage() {
  cat <<EOF
M5cet uninstall v${M5_INSTALLER_VERSION}

$(L 'Usage' 'Použití'): ./uninstall.sh [options]

  --keep-files         $(L 'remove the service, keep the install directory' 'odstraní službu, instalační adresář ponechá')
  --purge              $(L 'also remove backups, service user and docker images' 'odstraní i zálohy, uživatele služby a docker image')
  --dir PATH           $(L 'installation to remove (default: auto-detect)' 'instalace k odstranění (výchozí: autodetekce)')
  --ui auto|text|dialog   --lang cs|en
  -n, --non-interactive   -y, --yes   --dry-run   --verbose
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep-files)   KEEP_FILES="1" ;;
      --purge)        PURGE="1" ;;
      --dir)          [ $# -ge 2 ] || die "--dir $(L 'needs a value' 'vyžaduje hodnotu')"; DIR_ARG="$(abs_path "$2")"; shift ;;
      --ui)           [ $# -ge 2 ] || die "--ui $(L 'needs a value' 'vyžaduje hodnotu')"; UI="$2"; shift ;;
      --lang)         [ $# -ge 2 ] || die "--lang $(L 'needs a value' 'vyžaduje hodnotu')"; M5_LANG="$2"; shift ;;
      -n|--non-interactive) NON_INTERACTIVE="1" ;;
      -y|--yes)       ASSUME_YES="1" ;;
      --dry-run)      DRY_RUN="1" ;;
      --verbose)      VERBOSE="1" ;;
      -h|--help)      usage; exit 0 ;;
      --version)      echo "${M5_INSTALLER_VERSION}"; exit 0 ;;
      *) usage >&2; die "$(L 'Unknown option:' 'Neznámá volba:') $1" ;;
    esac
    shift
  done
  [ "${KEEP_FILES}" = "1" ] && [ "${PURGE}" = "1" ] && die "--keep-files $(L 'and' 'a') --purge $(L 'exclude each other.' 'se vylučují.')"
  return 0
}

main() {
  local dir final_backup=""
  parse_args "$@"
  detect_system
  dir="$(locate_install "${DIR_ARG}")" || die "$(L 'No M5cet installation found (use --dir).' 'Instalace M5cet nenalezena (použijte --dir).')"
  conf_load "${dir}/.m5cet/install.conf" 1
  INSTALL_DIR="${dir}"
  env_load "$(env_file)" 1
  conf_apply_defaults

  if [ "${SCOPE}" = "system" ] && ! is_root && [ "${DRY_RUN}" != "1" ]; then
    have sudo || die "$(L 'This installation is system-wide: run as root.' 'Tato instalace je systémová: spusťte jako root.')"
    info "$(L 'Re-running under sudo…' 'Spouštím znovu přes sudo…')"
    exec sudo -E bash "${M5_SCRIPT_DIR}/uninstall.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  fi
  ui_init

  step "M5cet uninstall v${M5_INSTALLER_VERSION}"
  cat <<EOF
  $(L 'Installation' 'Instalace'):   ${INSTALL_DIR}  (v${INSTALLED_VERSION:-?}, ${INSTALL_MODE}/${SERVICE_MANAGER}/${SCOPE})
  $(L 'Will remove' 'Odstraní se'):
    - $(L 'service' 'služba') (${SERVICE_MANAGER})$( [ -n "${UNIT_FILES}" ] && printf ': %s' "${UNIT_FILES}" )
$( [ -n "${NGINX_SITE_PATH}" ] && printf '    - Nginx: %s\n' "${NGINX_SITE_PATH}" )$( [ -n "${FIREWALL_RULES}" ] && printf '    - firewall: %s\n' "${FIREWALL_RULES}" )$( [ "${KEEP_FILES}" = "1" ] || printf '    - %s: %s\n' "$(L 'directory' 'adresář')" "${INSTALL_DIR}" )$( [ "${PURGE}" = "1" ] && printf '    - %s: %s\n' "$(L 'backups' 'zálohy')" "${BACKUP_ROOT}" )
EOF
  # Destructive: the default answer is "no", --yes is the explicit consent.
  ui_yesno "$(L 'Really uninstall M5cet?' 'Opravdu odinstalovat M5cet?')" 0 || die "$(L 'Aborted — nothing was changed.' 'Přerušeno — nic se nezměnilo.')"

  step "$(L 'Stopping and removing the service' 'Zastavuji a odstraňuji službu')"
  service_ctl stop || true
  if [ "${SERVICE_MANAGER}" = "compose" ] && [ -f "$(compose_file)" ]; then
    if [ "${PURGE}" = "1" ]; then _compose down --remove-orphans --rmi local --volumes || true
    else _compose down --remove-orphans || true; fi
    if [ "${PURGE}" = "1" ] && [ "${DRY_RUN}" != "1" ]; then
      docker image rm "${SERVICE_NAME}:rollback" >/dev/null 2>&1 || true
    fi
  else
    teardown_service "${SERVICE_MANAGER}"
  fi

  remove_nginx_site
  close_firewall

  if [ "${KEEP_FILES}" = "1" ]; then
    INSTALL_STATUS="uninstalled-files-kept"; UNIT_FILES=""
    conf_save
    log "$(L 'Service removed. Files kept in' 'Služba odstraněna. Soubory ponechány v') ${INSTALL_DIR}"
    info "$(L 'Reinstall with:' 'Znovu nainstalujete přes:') ${INSTALL_DIR}/install.sh --force --config $(conf_file)"
  else
    if [ "${PURGE}" != "1" ]; then
      # Keep the settings: a later reinstall can replay them with --config.
      case "${BACKUP_ROOT}" in
        "${INSTALL_DIR}"/*) final_backup="$(dirname "${INSTALL_DIR}")/m5cet-uninstall-$(now_stamp)" ;;
        *)                  final_backup="${BACKUP_ROOT}/$(now_stamp)-uninstall" ;;
      esac
      step "$(L 'Final backup' 'Závěrečná záloha') → ${final_backup}"
      if [ "${DRY_RUN}" != "1" ]; then
        ( umask 077; mkdir -p "${final_backup}" )
        cp -p "$(conf_file)" "${final_backup}/install.conf"
        [ -f "$(env_file)" ] && cp -p "$(env_file)" "${final_backup}/.env" && chmod 0600 "${final_backup}/.env"
      fi
    fi
    step "$(L 'Removing' 'Odstraňuji') ${INSTALL_DIR}"
    # This script usually lives inside the directory it is about to delete.
    cd "${HOME:-/}" 2>/dev/null || cd /
    safe_rm_install_dir "${INSTALL_DIR}"
    if [ "${PURGE}" = "1" ] && [ -n "${BACKUP_ROOT}" ] && [ -d "${BACKUP_ROOT}" ]; then
      case "${BACKUP_ROOT}" in
        */m5cet|*/m5cet/*|*/.m5cet/*) run rm -rf -- "${BACKUP_ROOT}" ;;
        *) warn "$(L "Not removing ${BACKUP_ROOT}: it does not look like an M5cet backup directory." "Neodstraňuji ${BACKUP_ROOT}: nevypadá jako adresář záloh M5cet.")" ;;
      esac
    fi
    pointer_remove
  fi

  if [ "${PURGE}" = "1" ] && [ "${SERVICE_USER_CREATED}" = "1" ] && id "${SERVICE_USER}" >/dev/null 2>&1; then
    log "$(L 'Removing system user' 'Odstraňuji systémového uživatele') ${SERVICE_USER}"
    if have userdel; then run userdel "${SERVICE_USER}" || true
    elif have deluser; then run deluser "${SERVICE_USER}" || true; fi
  fi

  printf '\n%s%s%s\n' "${C_GRN}" "$(L 'M5cet was uninstalled.' 'M5cet byl odinstalován.')" "${C_RST}"
  [ -n "${final_backup}" ] && info "$(L 'Settings kept in' 'Nastavení uloženo v') ${final_backup} $(L '(contains secrets; delete it when no longer needed)' '(obsahuje tajemství; až nebude potřeba, smažte ji)')"
  [ -n "${DEPS_INSTALLED}" ] && info "$(L 'Packages installed as dependencies were left in place:' 'Balíčky nainstalované jako závislosti zůstaly:') ${DEPS_INSTALLED}"
  if [ -n "${DOMAIN}" ] && [ "${ENABLE_TLS}" = "1" ]; then
    info "$(L 'The TLS certificate was kept. Remove it with:' 'TLS certifikát zůstal. Odstraníte ho přes:') certbot delete --cert-name ${DOMAIN}"
  fi
  return 0
}

main "$@"
