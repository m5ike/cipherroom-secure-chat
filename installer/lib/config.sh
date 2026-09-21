# shellcheck shell=bash
# M5cet installer — parameters, validation and persistence.
#
# Two files, both under the install directory:
#
#   .m5cet/install.conf   every installer choice (mode, paths, ports, flags)
#                         plus state (version, commit, timestamps). No secrets.
#   .env                  the application's runtime environment, including
#                         secrets (admin token, VAPID private key, TURN
#                         credential). Read by systemd (EnvironmentFile), by
#                         docker compose (env_file) and by the app itself.
#
# Neither file is ever `source`d: both are parsed line by line against a key
# whitelist, so a tampered config cannot execute code as root.

# --- installer choices ------------------------------------------------------
CONF_KEYS="INSTALL_MODE SCOPE INSTALL_DIR SERVICE_NAME SERVICE_MANAGER SERVICE_USER \
SOURCE REPO_URL BRANCH SOURCE_PATH APP_PORT BIND_ADDRESS DOMAIN ENABLE_NGINX ENABLE_TLS \
ACME_EMAIL FIREWALL_OPEN ENABLE_ADMIN ADMIN_PORT ENABLE_PUSH \
KEEP_NODE_MODULES BACKUP_ROOT BACKUP_KEEP"

# --- state written by the scripts, never asked for --------------------------
STATE_KEYS="INSTALLER_VERSION INSTALL_STATUS INSTALLED_VERSION INSTALLED_COMMIT \
PREVIOUS_COMMIT INSTALLED_AT UPDATED_AT NGINX_SITE_PATH NGINX_SITE_LINK UNIT_FILES \
FIREWALL_RULES DEPS_INSTALLED SERVICE_USER_CREATED"

# --- application environment (.env) managed by the installer ----------------
# HOST / PORT / NODE_ENV / ENABLE_ADMIN / ADMIN_PORT / ADMIN_BIND are derived
# from the choices above on every write; the rest are operator-settable.
ENV_KEYS="LOG_EVENTS DATABASE_URL VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT \
TURN_SERVER_URL TURN_USERNAME TURN_CREDENTIAL ADMIN_API_TOKEN \
DATA_RETENTION_DAYS AUDIT_RETENTION_DAYS PUSH_RETENTION_DAYS EVENT_RETENTION_DAYS \
SETTINGS_RETENTION_DAYS"
ENV_DERIVED_KEYS="NODE_ENV HOST PORT ENABLE_ADMIN ADMIN_PORT ADMIN_BIND"
ENV_SECRET_KEYS="VAPID_PRIVATE_KEY TURN_CREDENTIAL ADMIN_API_TOKEN DATABASE_URL"

# Lines of .env we do not manage are preserved verbatim across rewrites.
ENV_PASSTHROUGH=""

_in_list() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
is_conf_key()  { _in_list "$1" "${CONF_KEYS}"; }
is_state_key() { _in_list "$1" "${STATE_KEYS}"; }
is_env_key()   { _in_list "$1" "${ENV_KEYS}"; }

conf_default() {
  case "$1" in
    INSTALL_MODE)      echo "docker" ;;
    SCOPE)             if is_root; then echo "system"; else echo "user"; fi ;;
    INSTALL_DIR)       if is_root; then echo "/opt/m5cet"; else echo "${HOME}/.local/share/m5cet"; fi ;;
    SERVICE_NAME)      echo "m5cet" ;;
    SERVICE_MANAGER)   echo "auto" ;;
    SERVICE_USER)      echo "m5cet" ;;
    SOURCE)            echo "git" ;;
    REPO_URL)          echo "https://github.com/m5ike/cipherroom-secure-chat.git" ;;
    BRANCH)            echo "master" ;;
    SOURCE_PATH)       echo "" ;;
    APP_PORT)          echo "5000" ;;
    BIND_ADDRESS)      echo "127.0.0.1" ;;
    DOMAIN)            echo "" ;;
    ENABLE_NGINX)      echo "auto" ;;
    ENABLE_TLS)        echo "0" ;;
    ACME_EMAIL)        echo "" ;;
    FIREWALL_OPEN)     echo "0" ;;
    ENABLE_ADMIN)      echo "0" ;;
    ADMIN_PORT)        echo "5050" ;;
    ENABLE_PUSH)       echo "0" ;;
    KEEP_NODE_MODULES) echo "0" ;;
    BACKUP_ROOT)       if is_root; then echo "/var/backups/m5cet"; else echo ""; fi ;;
    BACKUP_KEEP)       echo "5" ;;
    LOG_EVENTS)        echo "0" ;;
    VAPID_SUBJECT)     echo "mailto:admin@example.org" ;;
    *)                 echo "" ;;
  esac
}

_is_bool()  { [ "$1" = "0" ] || [ "$1" = "1" ]; }
_is_port()  { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
_is_uint()  { case "$1" in ''|*[!0-9]*) return 1 ;; esac; return 0; }

# conf_validate KEY VALUE — prints a reason and returns 1 when invalid.
conf_validate() {
  local k="$1" v="$2"
  case "${v}" in *$'\n'*|*$'\r'*) echo "value must be a single line"; return 1 ;; esac
  case "${k}" in
    INSTALL_MODE)    case "${v}" in native|docker) ;; *) echo "must be 'native' or 'docker'"; return 1 ;; esac ;;
    SCOPE)           case "${v}" in system|user) ;; *) echo "must be 'system' or 'user'"; return 1 ;; esac ;;
    SERVICE_MANAGER) case "${v}" in auto|systemd|process|compose) ;; *) echo "must be auto, systemd, process or compose"; return 1 ;; esac ;;
    SOURCE)          case "${v}" in git|local) ;; *) echo "must be 'git' or 'local'"; return 1 ;; esac ;;
    ENABLE_NGINX)    case "${v}" in 0|1|auto) ;; *) echo "must be 0, 1 or auto"; return 1 ;; esac ;;
    INSTALL_DIR)     is_safe_install_dir "${v}" || { echo "must be an absolute path at least two levels deep, not a system directory"; return 1; } ;;
    SERVICE_NAME|SERVICE_USER)
                     printf '%s' "${v}" | grep -Eq '^[a-z_][a-z0-9_-]{0,30}$' || { echo "lowercase letters, digits, - and _ (max 31 chars)"; return 1; } ;;
    APP_PORT|ADMIN_PORT)
                     _is_port "${v}" || { echo "must be a TCP port 1-65535"; return 1; } ;;
    BIND_ADDRESS)    printf '%s' "${v}" | grep -Eq '^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9a-fA-F:]+)$' || { echo "must be an IP address (e.g. 127.0.0.1 or 0.0.0.0)"; return 1; } ;;
    DOMAIN)          [ -z "${v}" ] || printf '%s' "${v}" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' || { echo "not a valid host name"; return 1; } ;;
    ACME_EMAIL)      [ -z "${v}" ] || printf '%s' "${v}" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || { echo "not a valid e-mail address"; return 1; } ;;
    ENABLE_TLS|FIREWALL_OPEN|ENABLE_ADMIN|ENABLE_PUSH|KEEP_NODE_MODULES|LOG_EVENTS)
                     _is_bool "${v}" || { echo "must be 0 or 1"; return 1; } ;;
    BACKUP_KEEP|DATA_RETENTION_DAYS|AUDIT_RETENTION_DAYS|PUSH_RETENTION_DAYS|EVENT_RETENTION_DAYS|SETTINGS_RETENTION_DAYS)
                     [ -z "${v}" ] || _is_uint "${v}" || { echo "must be a non-negative integer"; return 1; } ;;
    BRANCH)          printf '%s' "${v}" | grep -Eq '^[A-Za-z0-9._/-]{1,200}$' || { echo "not a valid git ref name"; return 1; } ;;
    REPO_URL)        printf '%s' "${v}" | grep -Eq '^(https://|git@|ssh://|file://|/)' || { echo "must be an https/ssh/file URL or an absolute path"; return 1; } ;;
    SOURCE_PATH|BACKUP_ROOT)
                     [ -z "${v}" ] || case "${v}" in /*) ;; *) echo "must be an absolute path"; return 1 ;; esac ;;
    ADMIN_API_TOKEN) [ -z "${v}" ] || [ "${#v}" -ge 24 ] || { echo "must be at least 24 characters"; return 1; } ;;
  esac
  return 0
}

# conf_set KEY VALUE — validated assignment to an installer choice or a
# managed .env key. Unknown keys are rejected so typos do not pass silently.
conf_set() {
  local k="$1" v="$2" why
  if ! is_conf_key "${k}" && ! is_env_key "${k}"; then
    die "$(L "Unknown parameter '${k}'. See --list-params." "Neznámý parametr '${k}'. Viz --list-params.")"
  fi
  case "${k}" in INSTALL_DIR|SOURCE_PATH|BACKUP_ROOT) [ -n "${v}" ] && v="$(abs_path "${v}")" ;; esac
  if ! why="$(conf_validate "${k}" "${v}")"; then
    # Never echo a secret back, not even a rejected one.
    local shown="${v}"; _in_list "${k}" "${ENV_SECRET_KEYS}" && shown="***"
    die "$(L "Invalid ${k}='${shown}': ${why}" "Neplatná hodnota ${k}='${shown}': ${why}")"
  fi
  printf -v "${k}" '%s' "${v}"
}

# Fill every unset choice / env key with its default. Values already present
# in the environment (flags, exported vars, a loaded file) win.
conf_apply_defaults() {
  local k
  for k in ${CONF_KEYS} ${ENV_KEYS}; do
    if [ -z "${!k+x}" ]; then printf -v "${k}" '%s' "$(conf_default "${k}")"; fi
  done
  for k in ${STATE_KEYS}; do
    if [ -z "${!k+x}" ]; then printf -v "${k}" '%s' ""; fi
  done
}

conf_validate_all() {
  local k why bad=0
  for k in ${CONF_KEYS} ${ENV_KEYS}; do
    if ! why="$(conf_validate "${k}" "${!k}")"; then
      warn "${k}='${!k}': ${why}"; bad=1
    fi
  done
  [ "${ENABLE_ADMIN}" = "1" ] && [ "${ADMIN_PORT}" = "${APP_PORT}" ] && { warn "ADMIN_PORT must differ from APP_PORT"; bad=1; }
  [ "${ENABLE_TLS}" = "1" ] && [ -z "${DOMAIN}" ] && { warn "ENABLE_TLS=1 requires DOMAIN"; bad=1; }
  [ "${ENABLE_NGINX}" = "1" ] && [ -z "${DOMAIN}" ] && { warn "ENABLE_NGINX=1 requires DOMAIN"; bad=1; }
  [ "${SOURCE}" = "local" ] && [ -z "${SOURCE_PATH}" ] && { warn "SOURCE=local requires SOURCE_PATH"; bad=1; }
  [ "${bad}" = "0" ] || die "$(L 'Configuration is invalid — see the warnings above.' 'Konfigurace je neplatná — viz varování výše.')"
}

# --- (de)serialisation ------------------------------------------------------

# Values made only of these characters are written bare; anything else is
# double-quoted with \ and " escaped. That form is read identically by
# systemd EnvironmentFile, docker compose env_file and Node's loadEnvFile.
_kv_line() {
  local k="$1" v="$2"
  if printf '%s' "${v}" | grep -Eq '^[A-Za-z0-9_@%+=:,./-]*$'; then
    printf '%s=%s\n' "${k}" "${v}"
  else
    v="${v//\\/\\\\}"; v="${v//\"/\\\"}"
    printf '%s="%s"\n' "${k}" "${v}"
  fi
}

# _kv_parse LINE — sets KV_KEY / KV_VALUE, returns 1 for blanks / comments /
# anything that is not KEY=VALUE.
KV_KEY=""; KV_VALUE=""
_kv_parse() {
  local line="$1" v
  line="${line#"${line%%[![:space:]]*}"}"          # ltrim
  case "${line}" in ''|'#'*) return 1 ;; esac
  line="${line#export }"
  case "${line}" in *=*) ;; *) return 1 ;; esac
  KV_KEY="${line%%=*}"
  printf '%s' "${KV_KEY}" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$' || return 1
  v="${line#*=}"
  v="${v%"${v##*[![:space:]]}"}"                   # rtrim
  case "${v}" in
    \"*\") v="${v#\"}"; v="${v%\"}"; v="${v//\\\"/\"}"; v="${v//\\\\/\\}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  KV_VALUE="${v}"
  return 0
}

conf_file()  { printf '%s/.m5cet/install.conf' "${1:-${INSTALL_DIR}}"; }
env_file()   { printf '%s/.env' "${1:-${INSTALL_DIR}}"; }
state_dir()  { printf '%s/.m5cet' "${1:-${INSTALL_DIR}}"; }

# conf_load FILE [override]
#   override=1  file values replace current ones (update / uninstall)
#   override=0  file values only fill what is still unset (--config answers
#               file: explicit flags keep priority)
conf_load() {
  local file="$1" override="${2:-1}" line why
  [ -r "${file}" ] || die "$(L "Cannot read ${file}" "Nelze číst ${file}")"
  while IFS= read -r line || [ -n "${line}" ]; do
    _kv_parse "${line}" || continue
    if is_conf_key "${KV_KEY}" || is_state_key "${KV_KEY}" || is_env_key "${KV_KEY}"; then
      if [ "${override}" = "0" ] && [ -n "${!KV_KEY+x}" ]; then continue; fi
      if ! why="$(conf_validate "${KV_KEY}" "${KV_VALUE}")"; then
        warn "${file}: ${KV_KEY}: ${why} — $(L 'ignored' 'ignorováno')"; continue
      fi
      printf -v "${KV_KEY}" '%s' "${KV_VALUE}"
    else
      debug "${file}: unknown key ${KV_KEY} ignored"
    fi
  done < "${file}"
}

conf_save() {
  local file k
  file="$(conf_file)"
  {
    printf '# M5cet install configuration — written by the installer (v%s).\n' "${M5_INSTALLER_VERSION}"
    printf '# update.sh and uninstall.sh read this file. Change values with:\n'
    printf '#   %s/update.sh --set KEY=VALUE\n' "${INSTALL_DIR}"
    printf '# Secrets live in %s, not here.\n\n' "$(env_file)"
    printf '# --- choices ---\n'
    for k in ${CONF_KEYS}; do _kv_line "${k}" "${!k}"; done
    printf '\n# --- state ---\n'
    for k in ${STATE_KEYS}; do _kv_line "${k}" "${!k}"; done
  } | write_file "${file}" 0600
}

# env_load FILE — managed keys into variables; unmanaged lines are kept in
# ENV_PASSTHROUGH so operator additions survive a rewrite.
env_load() {
  local file="$1" override="${2:-1}" line
  ENV_PASSTHROUGH=""
  [ -r "${file}" ] || return 0
  while IFS= read -r line || [ -n "${line}" ]; do
    if _kv_parse "${line}"; then
      if is_env_key "${KV_KEY}"; then
        if [ "${override}" = "0" ] && [ -n "${!KV_KEY+x}" ] && [ -n "${!KV_KEY}" ]; then continue; fi
        printf -v "${KV_KEY}" '%s' "${KV_VALUE}"
        continue
      fi
      _in_list "${KV_KEY}" "${ENV_DERIVED_KEYS}" && continue
      ENV_PASSTHROUGH="${ENV_PASSTHROUGH}${line}"$'\n'
    fi
  done < "${file}"
}

# The HOST/PORT the application binds to. In docker mode the container always
# listens on 0.0.0.0:5000 and the published port carries BIND_ADDRESS/APP_PORT.
CONTAINER_PORT=5000
env_save() {
  local file k host port mode="0600"
  file="$(env_file)"
  if [ "${INSTALL_MODE}" = "docker" ]; then host="0.0.0.0"; port="${CONTAINER_PORT}"
  else host="${BIND_ADDRESS}"; port="${APP_PORT}"; fi
  # systemd reads the file as root, but the app also loads ./.env itself as
  # the unprivileged service user, so that group needs read access.
  [ "${SERVICE_MANAGER}" = "systemd" ] && mode="0640"
  {
    printf '# M5cet runtime environment — managed by the installer. Mode %s: contains secrets.\n' "${mode}"
    printf '# Edit with: %s/update.sh --set KEY=VALUE   (manual additions below are preserved)\n\n' "${INSTALL_DIR}"
    _kv_line NODE_ENV production
    _kv_line HOST "${host}"
    _kv_line PORT "${port}"
    _kv_line ENABLE_ADMIN "${ENABLE_ADMIN}"
    _kv_line ADMIN_PORT "${ADMIN_PORT}"
    if [ "${INSTALL_MODE}" = "docker" ]; then _kv_line ADMIN_BIND "0.0.0.0"; else _kv_line ADMIN_BIND "127.0.0.1"; fi
    printf '\n'
    for k in ${ENV_KEYS}; do
      [ -n "${!k}" ] && _kv_line "${k}" "${!k}"
    done
    if [ -n "${ENV_PASSTHROUGH}" ]; then
      printf '\n# --- not managed by the installer (preserved) ---\n%s' "${ENV_PASSTHROUGH}"
    fi
  } | write_file "${file}" "${mode}"
  if [ "${SERVICE_MANAGER}" = "systemd" ] && [ "${DRY_RUN}" != "1" ] && is_root; then
    chown "root:$(id -gn "${SERVICE_USER}" 2>/dev/null || echo root)" "${file}" 2>/dev/null || true
  fi
}

# Resolve "auto" values once the mode and the system are known.
conf_resolve_auto() {
  if [ "${SERVICE_MANAGER}" = "auto" ]; then
    if [ "${INSTALL_MODE}" = "docker" ]; then SERVICE_MANAGER="compose"
    elif [ "${SCOPE}" = "system" ] && [ "${SYS_INIT}" = "systemd" ]; then SERVICE_MANAGER="systemd"
    else SERVICE_MANAGER="process"; fi
  fi
  [ "${INSTALL_MODE}" = "docker" ] && SERVICE_MANAGER="compose"
  if [ "${INSTALL_MODE}" = "native" ] && [ "${SERVICE_MANAGER}" = "compose" ]; then SERVICE_MANAGER="process"; fi
  if [ "${SERVICE_MANAGER}" = "systemd" ] && { [ "${SYS_INIT}" != "systemd" ] || [ "${SCOPE}" != "system" ]; }; then
    warn "$(L 'systemd is not available for this install — using the plain process manager.' \
             'systemd pro tuto instalaci není k dispozici — použiji prostý správce procesu.')"
    SERVICE_MANAGER="process"
  fi
  if [ -z "${BACKUP_ROOT}" ]; then BACKUP_ROOT="$(state_dir)/backups"; fi
  return 0
}

nginx_wanted() {
  case "${ENABLE_NGINX}" in
    1) return 0 ;;
    auto) [ -n "${DOMAIN}" ] && [ "${SCOPE}" = "system" ] ;;
    *) return 1 ;;
  esac
}

# --- locating an existing install -------------------------------------------
pointer_file() {
  if is_root; then echo "/etc/m5cet/install-dir"; else echo "${XDG_CONFIG_HOME:-${HOME}/.config}/m5cet/install-dir"; fi
}

pointer_write() {
  local p; p="$(pointer_file)"
  printf '%s\n' "${INSTALL_DIR}" | write_file "${p}" 0644
}

pointer_remove() {
  local p; p="$(pointer_file)"
  [ -f "${p}" ] && run rm -f "${p}"
  run_sh "rmdir '$(dirname "${p}")' 2>/dev/null || true"
}

# locate_install [DIR] — explicit dir, else the directory the script lives in,
# else the pointer file, else the default. Prints the path or returns 1.
locate_install() {
  local explicit="${1:-}" cand
  for cand in "${explicit}" "${M5_SCRIPT_DIR:-}" "$( [ -r "$(pointer_file)" ] && head -n1 "$(pointer_file)" )" "$(conf_default INSTALL_DIR)"; do
    [ -n "${cand}" ] || continue
    if [ -f "${cand}/.m5cet/install.conf" ]; then printf '%s' "${cand%/}"; return 0; fi
    [ -n "${explicit}" ] && break
  done
  return 1
}

print_params() {
  local k
  printf '%s\n' "$(L 'Installer choices (stored in .m5cet/install.conf):' 'Volby instalátoru (ukládají se do .m5cet/install.conf):')"
  for k in ${CONF_KEYS}; do printf '  %-20s %s\n' "${k}" "$(conf_default "${k}")"; done
  printf '\n%s\n' "$(L 'Application environment (stored in .env):' 'Prostředí aplikace (ukládá se do .env):')"
  for k in ${ENV_KEYS}; do printf '  %-26s %s\n' "${k}" "$(conf_default "${k}")"; done
}

print_config_summary() {
  local k v
  for k in ${CONF_KEYS}; do
    v="${!k}"
    [ -n "${v}" ] || v="-"
    printf '  %-20s %s\n' "${k}" "${v}"
  done
  for k in ${ENV_KEYS}; do
    v="${!k}"
    [ -n "${v}" ] || continue
    _in_list "${k}" "${ENV_SECRET_KEYS}" && v="$(L '(set, hidden)' '(nastaveno, skryto)')"
    printf '  %-20s %s\n' "${k}" "${v}"
  done
}
