#!/usr/bin/env bash
# M5cet (rebrand of CipherRoom) — interactive Linux/Docker installer.
# One self-contained file. Detects an old CipherRoom install, backs it up,
# upgrades it to M5cet, regenerates managed configs, and runs post-install
# health tests. Supports interactive, non-interactive, dry-run, and doctor modes.
set -Eeuo pipefail

trap 'rc=$?; printf "\033[1;31m[x] line %s exited %s\033[0m\n" "$LINENO" "$rc" >&2' ERR

VERSION="2.1.0-rc.1"

# ---------------------------------------------------------------------------
# Configuration (env-overridable)
# ---------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/m5ike/cipherroom-secure-chat.git}"
BRANCH="${BRANCH:-release/m5cet-v-next-hardening}"
INSTALL_DIR="${INSTALL_DIR:-/opt/m5cet}"
LEGACY_INSTALL_DIRS_DEFAULT="/opt/cipherroom-secure-chat /opt/cipherroom /srv/cipherroom"
LEGACY_INSTALL_DIRS="${LEGACY_INSTALL_DIRS:-${LEGACY_INSTALL_DIRS_DEFAULT}}"
SERVICE_NAME="${SERVICE_NAME:-m5cet}"
LEGACY_SERVICE_NAMES="${LEGACY_SERVICE_NAMES:-cipherroom cipherroom-secure-chat}"
APP_PORT="${APP_PORT:-5000}"
HOST_PORT="${HOST_PORT:-5000}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
DOMAIN="${DOMAIN:-}"
ENABLE_NGINX="${ENABLE_NGINX:-auto}"
ENABLE_TLS="${ENABLE_TLS:-0}"
ACME_EMAIL="${ACME_EMAIL:-}"
FORCE_NGINX="${FORCE_NGINX:-0}"
FORCE_COMPOSE="${FORCE_COMPOSE:-0}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-${DOMAIN}}"
SKIP_DOCKER_INSTALL="${SKIP_DOCKER_INSTALL:-0}"
FORCE_RECLONE="${FORCE_RECLONE:-0}"
FIREWALL_OPEN="${FIREWALL_OPEN:-0}"
DATABASE_URL="${DATABASE_URL:-}"
LOG_EVENTS="${LOG_EVENTS:-0}"
VAPID_PUBLIC_KEY="${VAPID_PUBLIC_KEY:-}"
VAPID_PRIVATE_KEY="${VAPID_PRIVATE_KEY:-}"
VAPID_SUBJECT="${VAPID_SUBJECT:-mailto:admin@example.org}"
ENABLE_ADMIN="${ENABLE_ADMIN:-0}"
ADMIN_PORT="${ADMIN_PORT:-5050}"
ADMIN_UI_PORT="${ADMIN_UI_PORT:-5051}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/m5cet}"
SKIP_TESTS="${SKIP_TESTS:-0}"
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
DRY_RUN="${DRY_RUN:-0}"
DOCTOR="${DOCTOR:-0}"
INSTALL_MODE_ARG=""

COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
MANAGED_MARKER_NEW="# Managed by M5cet install.sh"
MANAGED_MARKER_OLD="# Managed by CipherRoom install.sh"
NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log()    { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn()   { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()    { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
info()   { printf '\033[1;36m[i]\033[0m %s\n' "$*"; }
step()   { printf '\n\033[1;35m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()     { printf '\033[1;32m  OK \033[0m %s\n' "$*"; }
fail()   { printf '\033[1;31m FAIL\033[0m %s\n' "$*"; }
skipln() { printf '\033[1;33m SKIP\033[0m %s\n' "$*"; }

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '\033[1;34m[dry-run]\033[0m %s\n' "$*"
    return 0
  fi
  "$@"
}

run_sh() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '\033[1;34m[dry-run]\033[0m %s\n' "$*"
    return 0
  fi
  bash -c "$*"
}

confirm() {
  local prompt="$1" default_yes="${2:-1}"
  if [[ "${ASSUME_YES}" == "1" || "${NON_INTERACTIVE}" == "1" ]]; then
    return 0
  fi
  local hint="[Y/n]" ans
  [[ "${default_yes}" == "1" ]] || hint="[y/N]"
  read -r -p "${prompt} ${hint} " ans || true
  if [[ -z "${ans}" ]]; then
    [[ "${default_yes}" == "1" ]]
  else
    [[ "${ans}" =~ ^[Yy]([Ee][Ss])?$ ]]
  fi
}

prompt_value() {
  local label="$1" default_val="${2:-}" varname="$3" ans
  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    printf -v "${varname}" '%s' "${default_val}"
    return
  fi
  if [[ -n "${default_val}" ]]; then
    read -r -p "${label} [${default_val}]: " ans || true
  else
    read -r -p "${label}: " ans || true
  fi
  printf -v "${varname}" '%s' "${ans:-${default_val}}"
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
M5cet installer (v${VERSION}) — interactive Linux/Docker installer
  Repo: ${REPO_URL}
  Branch: ${BRANCH}
  Default install dir: ${INSTALL_DIR}

USAGE
  curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/${BRANCH}/install.sh \\
    | sudo -E bash -s -- --install
  sudo -E ./install.sh [command] [flags]

COMMANDS
  --install              Install or upgrade and start (default).
  --update, --upgrade    Pull new code, regenerate managed compose, redeploy.
                         Keeps existing .env / data / nginx site untouched.
  --status               Show service status and health.
  --logs                 Follow container logs.
  --restart              Restart the service.
  --stop                 Stop the service.
  --uninstall            Stop and remove the managed Docker stack and Nginx site (project files kept).
  --doctor, --self-test  Read-only environment + post-install health checks. Never modifies state.
  --test, --health       Alias for --doctor (read-only health probes).
  --gui, --menu          Interactive numeric menu — wraps the commands above.
  --version, -V          Print installer version and exit.
  --help, -h             Show this help.

FLAGS
  --yes, -y              Assume "yes" to all prompts (still allows interactive value entry).
  --non-interactive      Fully non-interactive: never prompt, use defaults / env vars.
  --dry-run              Print what would happen, change nothing on disk.
  --branch <name>        Override BRANCH (e.g. master, feature/m5cet-fullscreen-secure-workspace).
  --domain <host>        Override DOMAIN.
  --install-dir <path>   Override INSTALL_DIR.
  --enable-nginx         Same as ENABLE_NGINX=1.
  --enable-tls           Same as ENABLE_TLS=1.
  --skip-tests           Skip post-install health tests.

ENVIRONMENT
  REPO_URL, BRANCH, INSTALL_DIR, SERVICE_NAME
  APP_PORT, HOST_PORT, BIND_ADDRESS
  DOMAIN, NGINX_SERVER_NAME
  ENABLE_NGINX (auto|1|0), ENABLE_TLS (0|1), ACME_EMAIL
  FORCE_NGINX, FORCE_COMPOSE, FORCE_RECLONE
  SKIP_DOCKER_INSTALL, FIREWALL_OPEN
  DATABASE_URL, LOG_EVENTS
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
  BACKUP_ROOT (default: /var/backups/m5cet)
  LEGACY_INSTALL_DIRS  Space-separated paths that may contain an old CipherRoom install.
  ASSUME_YES, NON_INTERACTIVE, DRY_RUN

OLD VERSION HANDLING
  The installer auto-detects legacy CipherRoom installs in:
    ${LEGACY_INSTALL_DIRS}
  When found, it stops the legacy compose stack, snapshots .env / data /
  docker-compose.yml / nginx site under ${BACKUP_ROOT}/<timestamp>/,
  then either migrates the directory in-place (preferred) or stages a fresh
  ${INSTALL_DIR}. Non-managed configs are preserved unless FORCE_NGINX=1 or
  FORCE_COMPOSE=1 is set, or you confirm at the prompt.

POST-INSTALL TESTS
  After "up -d" the installer probes:
    - docker compose ps
    - GET /api/health
    - GET /api/modules
    - GET /api/push/status
    - GET /api/events/recent  (when LOG_EVENTS=1)
    - WebSocket handshake on /ws  (when curl supports --include over Upgrade)

EXAMPLES
  Interactive upgrade from old CipherRoom:
    sudo -E ./install.sh

  Non-interactive install on Debian, public Docker port:
    sudo -E ./install.sh --non-interactive --yes BIND_ADDRESS=0.0.0.0 FIREWALL_OPEN=1

  With Nginx + TLS:
    DOMAIN=chat.example.com ENABLE_NGINX=1 ENABLE_TLS=1 ACME_EMAIL=admin@example.com \\
      sudo -E ./install.sh --yes

  Dry run a fresh upgrade:
    sudo -E ./install.sh --dry-run --yes

  Doctor / self-test only:
    sudo -E ./install.sh --doctor

EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --install|--status|--logs|--restart|--stop|--uninstall)
        INSTALL_MODE_ARG="${1#--}"
        ;;
      # --update is an alias for install: clone_or_update + restart compose,
      # preserving the existing .env / data / nginx site untouched.
      --update|--upgrade) INSTALL_MODE_ARG="update" ;;
      # --test is a friendly alias for the read-only doctor probes.
      --test|--health|--self-test|--doctor) DOCTOR=1; INSTALL_MODE_ARG="doctor" ;;
      # --gui drops into a numeric menu so admins do not have to memorise
      # every flag. It still ends up calling the same install/status/...
      # commands underneath.
      --gui|--menu) INSTALL_MODE_ARG="gui" ;;
      --version|-V) printf 'M5cet installer v%s\n' "${VERSION}"; exit 0 ;;
      --help|-h) usage; exit 0 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --non-interactive) NON_INTERACTIVE=1; ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --skip-tests) SKIP_TESTS=1 ;;
      --enable-nginx) ENABLE_NGINX=1 ;;
      --enable-tls) ENABLE_TLS=1 ;;
      --branch) BRANCH="$2"; shift ;;
      --domain) DOMAIN="$2"; NGINX_SERVER_NAME="$2"; shift ;;
      --install-dir) INSTALL_DIR="$2"; COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"; shift ;;
      *=*) export "$1" ;;
      *) warn "Unknown argument: $1" ;;
    esac
    shift
  done
  if [[ -z "${INSTALL_MODE_ARG}" ]]; then
    INSTALL_MODE_ARG="install"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Privilege handling
# ---------------------------------------------------------------------------
require_root() {
  if [[ "${DRY_RUN}" == "1" || "${DOCTOR}" == "1" ]]; then
    return 0
  fi
  if [[ "${EUID}" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      info "Re-executing under sudo to gain root."
      exec sudo -E bash "$0" "$@"
    fi
    die "Run as root or install sudo."
  fi
}

# ---------------------------------------------------------------------------
# OS detection
# ---------------------------------------------------------------------------
detect_os() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
    OS_PRETTY="${PRETTY_NAME:-${OS_ID}}"
  else
    OS_ID="unknown"; OS_LIKE=""; OS_PRETTY="unknown"
  fi
}

pkg_update_and_install() {
  local packages=("$@")
  detect_os
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    run apt-get update -y
    run apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    run dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    run yum install -y "${packages[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    run pacman -Sy --noconfirm "${packages[@]}"
  elif command -v zypper >/dev/null 2>&1; then
    run zypper --non-interactive install "${packages[@]}"
  elif command -v apk >/dev/null 2>&1; then
    run apk add --no-cache "${packages[@]}"
  else
    die "Unsupported Linux package manager. Install manually: ${packages[*]}"
  fi
}

ensure_base_packages() {
  local missing=()
  for bin in git curl ca-certificates tar; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
  done
  if (( ${#missing[@]} )); then
    log "Installing base packages: ${missing[*]}"
    pkg_update_and_install "${missing[@]}"
  fi
}

docker_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
  else
    return 1
  fi
}

ensure_docker() {
  if [[ "${SKIP_DOCKER_INSTALL}" == "1" ]]; then
    log "SKIP_DOCKER_INSTALL=1 — assuming Docker present."
    command -v docker >/dev/null 2>&1 || die "Docker missing."
    docker_compose_cmd >/dev/null || die "Docker Compose missing."
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker_compose_cmd >/dev/null; then
    log "Docker + Compose already installed."
    return
  fi
  detect_os
  log "Installing Docker Engine + Compose plugin (${OS_PRETTY})."
  if command -v pacman >/dev/null 2>&1; then
    pkg_update_and_install docker docker-compose
    run systemctl enable --now docker || true
  elif command -v apk >/dev/null 2>&1; then
    pkg_update_and_install docker docker-cli-compose
    run rc-update add docker default || true
    run service docker start || true
  else
    if [[ "${DRY_RUN}" != "1" ]]; then
      curl -fsSL https://get.docker.com | sh
    else
      info "[dry-run] curl -fsSL https://get.docker.com | sh"
    fi
    run systemctl enable --now docker || true
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] skipping post-install Docker verification."
    return 0
  fi
  command -v docker >/dev/null 2>&1 || die "Docker installation failed."
  docker_compose_cmd >/dev/null || die "Docker Compose plugin missing after install."
}

# ---------------------------------------------------------------------------
# Legacy CipherRoom detection + backup
# ---------------------------------------------------------------------------
detect_legacy_install() {
  LEGACY_FOUND=""
  for d in ${LEGACY_INSTALL_DIRS}; do
    if [[ -d "${d}/.git" || -f "${d}/docker-compose.yml" ]]; then
      LEGACY_FOUND="${d}"
      break
    fi
  done
  if [[ -d "${INSTALL_DIR}/.git" || -f "${COMPOSE_FILE}" ]]; then
    if [[ -z "${LEGACY_FOUND}" ]]; then
      LEGACY_FOUND="${INSTALL_DIR}"
    fi
  fi
}

stop_legacy_stack() {
  local dir="$1"
  local compose="${dir}/docker-compose.yml"
  [[ -f "${compose}" ]] || return 0
  local cc; cc="$(docker_compose_cmd 2>/dev/null || true)"
  [[ -n "${cc}" ]] || return 0
  local proj
  for proj in ${LEGACY_SERVICE_NAMES} "${SERVICE_NAME}"; do
    log "Stopping legacy compose project: ${proj}"
    # shellcheck disable=SC2086
    run_sh "${cc} -p ${proj} -f ${compose} down --remove-orphans 2>/dev/null || true"
  done
}

backup_dir() {
  local src="$1"
  [[ -d "${src}" ]] || return 0
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local dest="${BACKUP_ROOT}/${stamp}"
  log "Backing up ${src} → ${dest}"
  run mkdir -p "${dest}"
  if [[ -f "${src}/.env" ]]; then
    run cp -a "${src}/.env" "${dest}/env"
  fi
  if [[ -f "${src}/docker-compose.yml" ]]; then
    run cp -a "${src}/docker-compose.yml" "${dest}/docker-compose.yml"
  fi
  if [[ -d "${src}/data" ]]; then
    run cp -a "${src}/data" "${dest}/data"
  fi
  if [[ -f "${NGINX_SITE_AVAILABLE}" ]]; then
    run cp -a "${NGINX_SITE_AVAILABLE}" "${dest}/$(basename "${NGINX_SITE_AVAILABLE}")"
  fi
  for legacy in /etc/nginx/sites-available/cipherroom.conf /etc/nginx/sites-available/cipherroom-secure-chat.conf; do
    [[ -f "${legacy}" ]] && run cp -a "${legacy}" "${dest}/$(basename "${legacy}")"
  done
  printf '%s\n' "${dest}" > /tmp/m5cet-last-backup.txt 2>/dev/null || true
}

migrate_legacy_dir() {
  local src="$1"
  [[ -n "${src}" ]] || return 0
  if [[ "${src}" == "${INSTALL_DIR}" ]]; then
    return 0
  fi
  if [[ -e "${INSTALL_DIR}" && ! -d "${INSTALL_DIR}/.git" ]]; then
    warn "${INSTALL_DIR} exists and is not a git checkout."
    if confirm "Move ${INSTALL_DIR} aside to ${INSTALL_DIR}.preupgrade.$(date +%s) ?"; then
      run mv "${INSTALL_DIR}" "${INSTALL_DIR}.preupgrade.$(date +%s)"
    else
      die "Cannot continue with non-empty ${INSTALL_DIR}."
    fi
  fi
  if [[ ! -e "${INSTALL_DIR}" ]]; then
    log "Migrating ${src} → ${INSTALL_DIR}"
    run mkdir -p "$(dirname "${INSTALL_DIR}")"
    run mv "${src}" "${INSTALL_DIR}"
  fi
}

handle_legacy() {
  detect_legacy_install
  if [[ -z "${LEGACY_FOUND}" ]]; then
    log "No previous install detected."
    return 0
  fi
  step "Existing install detected at ${LEGACY_FOUND}"
  if [[ "${LEGACY_FOUND}" != "${INSTALL_DIR}" ]]; then
    info "This looks like a legacy CipherRoom path."
    info "It will be stopped, backed up to ${BACKUP_ROOT}/<ts>/, then moved to ${INSTALL_DIR}."
    if ! confirm "Proceed with upgrade from ${LEGACY_FOUND} to ${INSTALL_DIR}?"; then
      die "Aborted by user."
    fi
  else
    info "Upgrading in-place. Existing files will be backed up first."
    if ! confirm "Proceed with in-place upgrade of ${INSTALL_DIR}?"; then
      die "Aborted by user."
    fi
  fi
  stop_legacy_stack "${LEGACY_FOUND}"
  backup_dir "${LEGACY_FOUND}"
  migrate_legacy_dir "${LEGACY_FOUND}"
}

# ---------------------------------------------------------------------------
# Repo clone / update
# ---------------------------------------------------------------------------
clone_or_update_repo() {
  if [[ "${FORCE_RECLONE}" == "1" && -d "${INSTALL_DIR}" ]]; then
    warn "FORCE_RECLONE=1 — removing ${INSTALL_DIR}"
    backup_dir "${INSTALL_DIR}"
    run rm -rf "${INSTALL_DIR}"
  fi

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating existing checkout in ${INSTALL_DIR} (branch ${BRANCH})"
    run_sh "git -C '${INSTALL_DIR}' fetch --depth=1 origin '${BRANCH}'"
    if ! run_sh "git -C '${INSTALL_DIR}' checkout -f '${BRANCH}'"; then
      run_sh "git -C '${INSTALL_DIR}' checkout -f FETCH_HEAD"
    fi
    run_sh "git -C '${INSTALL_DIR}' reset --hard 'origin/${BRANCH}' 2>/dev/null || git -C '${INSTALL_DIR}' reset --hard FETCH_HEAD"
  elif [[ -e "${INSTALL_DIR}" ]]; then
    if confirm "${INSTALL_DIR} exists but is not a git checkout. Remove and clone fresh?"; then
      backup_dir "${INSTALL_DIR}"
      run rm -rf "${INSTALL_DIR}"
      run mkdir -p "$(dirname "${INSTALL_DIR}")"
      run_sh "git clone --depth=1 --branch '${BRANCH}' '${REPO_URL}' '${INSTALL_DIR}'"
    else
      die "${INSTALL_DIR} is not a git checkout. Set FORCE_RECLONE=1 or remove it."
    fi
  else
    log "Cloning ${REPO_URL} (${BRANCH}) → ${INSTALL_DIR}"
    run mkdir -p "$(dirname "${INSTALL_DIR}")"
    if ! run_sh "git clone --depth=1 --branch '${BRANCH}' '${REPO_URL}' '${INSTALL_DIR}'"; then
      warn "Branch ${BRANCH} clone failed, retrying default branch."
      run_sh "git clone --depth=1 '${REPO_URL}' '${INSTALL_DIR}'"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Compose / nginx config writing
# ---------------------------------------------------------------------------
compose_is_managed() {
  [[ -f "${COMPOSE_FILE}" ]] || return 1
  grep -qE "^# Managed by (M5cet|CipherRoom) install\\.sh" "${COMPOSE_FILE}"
}

write_compose_file() {
  if [[ -f "${COMPOSE_FILE}" ]] && ! compose_is_managed && [[ "${FORCE_COMPOSE}" != "1" ]]; then
    if ! confirm "${COMPOSE_FILE} is not managed by this installer. Overwrite (a backup is in ${BACKUP_ROOT})?"; then
      warn "Keeping existing ${COMPOSE_FILE}."
      return
    fi
  fi
  log "Writing managed docker-compose.yml"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would write ${COMPOSE_FILE}"
    return
  fi
  cat > "${COMPOSE_FILE}" <<EOF
${MANAGED_MARKER_NEW}
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
services:
  ${SERVICE_NAME}:
    build:
      context: .
      dockerfile: Dockerfile
    image: ${SERVICE_NAME}:local
    container_name: ${SERVICE_NAME}
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "${APP_PORT}"
      DATABASE_URL: "${DATABASE_URL}"
      LOG_EVENTS: "${LOG_EVENTS}"
      VAPID_PUBLIC_KEY: "${VAPID_PUBLIC_KEY}"
      VAPID_PRIVATE_KEY: "${VAPID_PRIVATE_KEY}"
      VAPID_SUBJECT: "${VAPID_SUBJECT}"
    ports:
      - "${BIND_ADDRESS}:${HOST_PORT}:${APP_PORT}"
    healthcheck:
      test: ["CMD-SHELL", "node -e \\"fetch('http://127.0.0.1:${APP_PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\\""]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
EOF

  if [[ "${ENABLE_ADMIN}" == "1" ]]; then
    # Defensive guard: the admin service builds from Dockerfile.admin, which
    # was added on release/m5cet-v-next-hardening. Older feature branches do
    # not ship it. Refuse to write a compose file that references a missing
    # Dockerfile so the build error surfaces here with a useful hint, not as
    # a confusing BuildKit failure later.
    if [[ ! -f "${INSTALL_DIR}/Dockerfile.admin" ]]; then
      die "ENABLE_ADMIN=1 but ${INSTALL_DIR}/Dockerfile.admin is missing. Re-run with BRANCH=release/m5cet-v-next-hardening (the default) or set ENABLE_ADMIN=0."
    fi
    cat >> "${COMPOSE_FILE}" <<EOF

  ${SERVICE_NAME}-admin:
    build:
      context: .
      dockerfile: Dockerfile.admin
    image: ${SERVICE_NAME}-admin:local
    container_name: ${SERVICE_NAME}-admin
    restart: unless-stopped
    environment:
      NODE_ENV: production
      ENABLE_ADMIN: "1"
      ADMIN_PORT: "${ADMIN_PORT}"
      ADMIN_API_TOKEN: "${ADMIN_API_TOKEN}"
      VAPID_PUBLIC_KEY: "${VAPID_PUBLIC_KEY}"
      VAPID_PRIVATE_KEY: "${VAPID_PRIVATE_KEY}"
      VAPID_SUBJECT: "${VAPID_SUBJECT}"
    ports:
      - "${BIND_ADDRESS}:${ADMIN_PORT}:${ADMIN_PORT}"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

  ${SERVICE_NAME}-admin-ui:
    image: nginx:alpine
    container_name: ${SERVICE_NAME}-admin-ui
    restart: unless-stopped
    volumes:
      - ./admin-ui/public:/usr/share/nginx/html:ro
    ports:
      - "${BIND_ADDRESS}:${ADMIN_UI_PORT}:80"
EOF
  fi
}

compose() {
  local cmd
  if ! cmd="$(docker_compose_cmd)"; then
    if [[ "${DRY_RUN}" == "1" ]]; then
      info "[dry-run] (no docker compose installed) would run: docker compose -p ${SERVICE_NAME} -f ${COMPOSE_FILE} $*"
      return 0
    fi
    die "docker compose not available"
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] ${cmd} -p ${SERVICE_NAME} -f ${COMPOSE_FILE} $*"
    return 0
  fi
  # shellcheck disable=SC2086
  ${cmd} -p "${SERVICE_NAME}" -f "${COMPOSE_FILE}" "$@"
}

start_app() {
  log "Building Docker image."
  compose build --pull
  log "Starting ${SERVICE_NAME}."
  compose up -d
}

# ---------------------------------------------------------------------------
# Nginx
# ---------------------------------------------------------------------------
should_enable_nginx() {
  case "${ENABLE_NGINX}" in
    1) return 0 ;;
    auto) [[ -n "${DOMAIN}" ]] && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}

ensure_nginx_packages() {
  should_enable_nginx || return 0
  [[ -n "${NGINX_SERVER_NAME}" ]] || die "DOMAIN or NGINX_SERVER_NAME required when ENABLE_NGINX=1."
  if ! command -v apt-get >/dev/null 2>&1; then
    die "Automatic Nginx/TLS is supported on apt systems. Install Nginx manually or set ENABLE_NGINX=0."
  fi
  local packages=(nginx)
  [[ "${ENABLE_TLS}" == "1" ]] && packages+=(certbot python3-certbot-nginx)
  log "Installing Nginx packages: ${packages[*]}"
  pkg_update_and_install "${packages[@]}"
  run_sh "systemctl enable --now nginx 2>/dev/null || service nginx start"
}

write_nginx_site() {
  should_enable_nginx || return 0
  [[ -n "${NGINX_SERVER_NAME}" ]] || die "DOMAIN or NGINX_SERVER_NAME required."

  local existing_managed=0
  if [[ -f "${NGINX_SITE_AVAILABLE}" ]]; then
    if grep -qE "^# Managed by (M5cet|CipherRoom) install\\.sh" "${NGINX_SITE_AVAILABLE}"; then
      existing_managed=1
    fi
  fi
  if [[ -f "${NGINX_SITE_AVAILABLE}" && "${existing_managed}" == "0" && "${FORCE_NGINX}" != "1" ]]; then
    if ! confirm "${NGINX_SITE_AVAILABLE} is not managed by this installer. Overwrite?"; then
      warn "Keeping existing ${NGINX_SITE_AVAILABLE}."
      return
    fi
  fi
  if [[ -f "${NGINX_SITE_AVAILABLE}" ]]; then
    run cp "${NGINX_SITE_AVAILABLE}" "${NGINX_SITE_AVAILABLE}.bak.$(date +%Y%m%d%H%M%S)"
  fi

  log "Writing Nginx reverse proxy site for ${NGINX_SERVER_NAME}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would write ${NGINX_SITE_AVAILABLE}"
  else
    cat > "${NGINX_SITE_AVAILABLE}" <<EOF
${MANAGED_MARKER_NEW}
server {
    listen 80;
    listen [::]:80;
    server_name ${NGINX_SERVER_NAME};

    access_log /var/log/nginx/${SERVICE_NAME}.access.log;
    error_log  /var/log/nginx/${SERVICE_NAME}.error.log;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:${HOST_PORT};
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;
        proxy_buffering off;
        proxy_request_buffering off;

        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }
}
EOF
  fi

  run ln -sfn "${NGINX_SITE_AVAILABLE}" "${NGINX_SITE_ENABLED}"
  if [[ "${DRY_RUN}" != "1" ]]; then
    nginx -t
    run_sh "systemctl reload nginx 2>/dev/null || service nginx reload"
  fi
}

enable_tls() {
  should_enable_nginx || return 0
  [[ "${ENABLE_TLS}" == "1" ]] || return 0
  [[ -n "${NGINX_SERVER_NAME}" ]] || die "DOMAIN or NGINX_SERVER_NAME required for TLS."
  local -a email_args
  if [[ -n "${ACME_EMAIL}" ]]; then
    email_args=(--email "${ACME_EMAIL}")
  else
    email_args=(--register-unsafely-without-email)
  fi
  log "Requesting Let's Encrypt cert for ${NGINX_SERVER_NAME}"
  run certbot --nginx --non-interactive --agree-tos --redirect "${email_args[@]}" -d "${NGINX_SERVER_NAME}"
  run_sh "systemctl reload nginx 2>/dev/null || service nginx reload"
}

remove_nginx_site() {
  if [[ -f "${NGINX_SITE_AVAILABLE}" ]] && grep -qE "^# Managed by (M5cet|CipherRoom) install\\.sh" "${NGINX_SITE_AVAILABLE}"; then
    run rm -f "${NGINX_SITE_ENABLED}" "${NGINX_SITE_AVAILABLE}"
    run_sh "(nginx -t && (systemctl reload nginx 2>/dev/null || service nginx reload)) || true"
    log "Removed managed Nginx site ${SERVICE_NAME}."
  fi
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
open_firewall() {
  [[ "${FIREWALL_OPEN}" == "1" ]] || return 0
  if command -v ufw >/dev/null 2>&1; then
    log "Opening TCP ${HOST_PORT} via ufw."
    run_sh "ufw allow '${HOST_PORT}/tcp' || true"
    if should_enable_nginx; then
      run_sh "ufw allow 80/tcp || true"
      run_sh "ufw allow 443/tcp || true"
    fi
  elif command -v firewall-cmd >/dev/null 2>&1; then
    log "Opening TCP ${HOST_PORT} via firewalld."
    run_sh "firewall-cmd --add-port='${HOST_PORT}/tcp' --permanent || true"
    if should_enable_nginx; then
      run_sh "firewall-cmd --add-service=http --permanent || true"
      run_sh "firewall-cmd --add-service=https --permanent || true"
    fi
    run_sh "firewall-cmd --reload || true"
  else
    warn "No ufw/firewalld found. Open TCP ${HOST_PORT} manually if needed."
  fi
}

# ---------------------------------------------------------------------------
# Post-install / doctor tests
# ---------------------------------------------------------------------------
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

probe_http() {
  local label="$1" url="$2" want="${3:-200}" tries="${4:-30}" out body code
  local i
  for ((i=1; i<=tries; i++)); do
    code="$(curl -fsS -o /tmp/m5cet-probe.body -w '%{http_code}' --max-time 4 "$url" 2>/dev/null || true)"
    if [[ "${code}" == "${want}" ]]; then
      body="$(head -c 240 /tmp/m5cet-probe.body 2>/dev/null || true)"
      ok "${label}  (HTTP ${code}) ${body}"
      TESTS_PASSED=$((TESTS_PASSED+1))
      return 0
    fi
    sleep 1
  done
  fail "${label}  (last HTTP ${code:-n/a})"
  TESTS_FAILED=$((TESTS_FAILED+1))
  return 1
}

probe_ws() {
  local label="$1" url="$2"
  if ! command -v curl >/dev/null 2>&1; then
    skipln "${label}  (no curl)"; TESTS_SKIPPED=$((TESTS_SKIPPED+1)); return 0
  fi
  local hdrs
  hdrs="$(curl -sS -i --max-time 4 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "${url}" 2>/dev/null | head -n 1 || true)"
  if [[ "${hdrs}" =~ 101 ]]; then
    ok "${label}  (HTTP 101 Switching Protocols)"
    TESTS_PASSED=$((TESTS_PASSED+1))
  else
    fail "${label}  (got: ${hdrs:-no response})"
    TESTS_FAILED=$((TESTS_FAILED+1))
  fi
}

run_post_install_tests() {
  [[ "${SKIP_TESTS}" == "1" ]] && { warn "SKIP_TESTS=1 — skipping post-install tests."; return 0; }
  step "Post-install tests"

  if [[ "${DRY_RUN}" == "1" ]]; then
    skipln "All probes skipped (dry-run)"
    TESTS_SKIPPED=$((TESTS_SKIPPED+5))
    return 0
  fi

  local cc
  cc="$(docker_compose_cmd 2>/dev/null || true)"
  if [[ -n "${cc}" && -f "${COMPOSE_FILE}" ]]; then
    local ps_out
    ps_out="$(${cc} -p "${SERVICE_NAME}" -f "${COMPOSE_FILE}" ps 2>&1 || true)"
    if echo "${ps_out}" | grep -qE 'Up|running'; then
      ok "docker compose ps reports the service as up"
      TESTS_PASSED=$((TESTS_PASSED+1))
    else
      fail "docker compose ps did not show a running service"
      printf '%s\n' "${ps_out}" | sed 's/^/    /'
      TESTS_FAILED=$((TESTS_FAILED+1))
    fi
  fi

  local base="http://127.0.0.1:${HOST_PORT}"
  probe_http "GET /api/health"        "${base}/api/health"        200 30 || true
  probe_http "GET /api/modules"       "${base}/api/modules"       200 10 || true
  probe_http "GET /api/push/status"   "${base}/api/push/status"   200 10 || true
  if [[ "${LOG_EVENTS}" == "1" ]]; then
    probe_http "GET /api/events/recent" "${base}/api/events/recent" 200 10 || true
  else
    skipln "GET /api/events/recent  (LOG_EVENTS=0)"
    TESTS_SKIPPED=$((TESTS_SKIPPED+1))
  fi
  probe_ws "WebSocket handshake /ws"   "${base}/ws"

  echo
  printf 'Tests: \033[1;32m%d passed\033[0m, \033[1;31m%d failed\033[0m, \033[1;33m%d skipped\033[0m\n' \
    "${TESTS_PASSED}" "${TESTS_FAILED}" "${TESTS_SKIPPED}"
  if (( TESTS_FAILED > 0 )); then
    warn "One or more tests failed. Run: sudo -E ${INSTALL_DIR}/install.sh --logs"
    return 1
  fi
}

doctor_cmd() {
  step "Doctor / self-test (read-only)"
  detect_os
  info "OS: ${OS_PRETTY}  (id=${OS_ID})"

  for bin in bash git curl tar; do
    if command -v "$bin" >/dev/null 2>&1; then
      ok "${bin} present"
      TESTS_PASSED=$((TESTS_PASSED+1))
    else
      fail "${bin} missing"; TESTS_FAILED=$((TESTS_FAILED+1))
    fi
  done

  if command -v docker >/dev/null 2>&1; then
    ok "docker: $(docker --version 2>/dev/null)"
    TESTS_PASSED=$((TESTS_PASSED+1))
  else
    fail "docker missing"; TESTS_FAILED=$((TESTS_FAILED+1))
  fi
  if cc="$(docker_compose_cmd 2>/dev/null)"; then
    ok "compose: ${cc} ($(${cc} version --short 2>/dev/null || echo '?'))"
    TESTS_PASSED=$((TESTS_PASSED+1))
  else
    fail "docker compose not found"; TESTS_FAILED=$((TESTS_FAILED+1))
  fi

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    ok "Install dir present: ${INSTALL_DIR}"
    TESTS_PASSED=$((TESTS_PASSED+1))
    if [[ -f "${COMPOSE_FILE}" ]]; then
      if compose_is_managed; then
        ok "compose file is managed"; TESTS_PASSED=$((TESTS_PASSED+1))
      else
        warn "compose file present but not managed by this installer"
        TESTS_SKIPPED=$((TESTS_SKIPPED+1))
      fi
    fi
  else
    skipln "no install at ${INSTALL_DIR}"
    TESTS_SKIPPED=$((TESTS_SKIPPED+1))
  fi

  detect_legacy_install
  if [[ -n "${LEGACY_FOUND}" && "${LEGACY_FOUND}" != "${INSTALL_DIR}" ]]; then
    warn "Legacy install detected at ${LEGACY_FOUND}. Run --install to migrate."
  fi

  if [[ -f "${COMPOSE_FILE}" ]] && command -v docker >/dev/null 2>&1; then
    local base="http://127.0.0.1:${HOST_PORT}"
    probe_http "GET /api/health"      "${base}/api/health"      200 3 || true
    probe_http "GET /api/modules"     "${base}/api/modules"     200 3 || true
    probe_http "GET /api/push/status" "${base}/api/push/status" 200 3 || true
    probe_ws   "WebSocket /ws"        "${base}/ws"              || true
  else
    skipln "skipping HTTP probes (no install or no docker)"
    TESTS_SKIPPED=$((TESTS_SKIPPED+4))
  fi

  echo
  printf 'Doctor: \033[1;32m%d passed\033[0m, \033[1;31m%d failed\033[0m, \033[1;33m%d skipped\033[0m\n' \
    "${TESTS_PASSED}" "${TESTS_FAILED}" "${TESTS_SKIPPED}"
  if (( TESTS_FAILED > 0 )); then exit 1; fi
}

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
print_summary() {
  local cc; cc="$(docker_compose_cmd 2>/dev/null || echo 'docker compose')"
  cat <<EOF

Done.
  Install dir:   ${INSTALL_DIR}
  Branch:        ${BRANCH}
  Service:       ${SERVICE_NAME}
  Local URL:     http://${BIND_ADDRESS}:${HOST_PORT}
  Health probe:  curl -fsS http://127.0.0.1:${HOST_PORT}/api/health

Manage:
  sudo -E ${INSTALL_DIR}/install.sh --status
  sudo -E ${INSTALL_DIR}/install.sh --logs
  sudo -E ${INSTALL_DIR}/install.sh --restart
  sudo -E ${INSTALL_DIR}/install.sh --doctor
  sudo -E ${INSTALL_DIR}/install.sh --uninstall

Compose:
  cd ${INSTALL_DIR}
  ${cc} -p ${SERVICE_NAME} -f ${COMPOSE_FILE} ps
EOF

  if should_enable_nginx; then
    cat <<EOF

Nginx site:
  config:    ${NGINX_SITE_AVAILABLE}
  enabled:   ${NGINX_SITE_ENABLED}
  ws:        ws://${NGINX_SERVER_NAME}/ws
  wss:       wss://${NGINX_SERVER_NAME}/ws  (after TLS)
EOF
  fi

  if [[ -f /tmp/m5cet-last-backup.txt ]]; then
    info "Last backup: $(cat /tmp/m5cet-last-backup.txt 2>/dev/null)"
  fi
}

# ---------------------------------------------------------------------------
# Interactive review of values
# ---------------------------------------------------------------------------
interactive_review() {
  if [[ "${NON_INTERACTIVE}" == "1" || "${ASSUME_YES}" == "1" ]]; then
    return 0
  fi
  step "Review configuration"
  prompt_value "Install directory" "${INSTALL_DIR}" INSTALL_DIR
  COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
  prompt_value "Git branch"        "${BRANCH}"      BRANCH
  prompt_value "Service name"      "${SERVICE_NAME}" SERVICE_NAME
  prompt_value "Host port"         "${HOST_PORT}"   HOST_PORT
  prompt_value "Bind address"      "${BIND_ADDRESS}" BIND_ADDRESS
  prompt_value "Domain (blank to skip Nginx)" "${DOMAIN}" DOMAIN
  if [[ -n "${DOMAIN}" ]]; then
    NGINX_SERVER_NAME="${DOMAIN}"
    if confirm "Enable Nginx reverse proxy for ${DOMAIN}?"; then
      ENABLE_NGINX=1
      if confirm "Enable Let's Encrypt TLS for ${DOMAIN}?" 0; then
        ENABLE_TLS=1
        prompt_value "ACME email" "${ACME_EMAIL}" ACME_EMAIL
      fi
    fi
  fi
  if [[ "${BIND_ADDRESS}" == "0.0.0.0" ]]; then
    confirm "Open ${HOST_PORT}/tcp in the host firewall?" && FIREWALL_OPEN=1
  fi
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
status_cmd() {
  [[ -f "${COMPOSE_FILE}" ]] || die "Compose file not found: ${COMPOSE_FILE}"
  compose ps || true
  echo
  curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" || true
  echo
}

logs_cmd() {
  [[ -f "${COMPOSE_FILE}" ]] || die "Compose file not found: ${COMPOSE_FILE}"
  compose logs -f --tail=200
}

restart_cmd() {
  [[ -f "${COMPOSE_FILE}" ]] || die "Compose file not found: ${COMPOSE_FILE}"
  compose restart
}

stop_cmd() {
  [[ -f "${COMPOSE_FILE}" ]] || die "Compose file not found: ${COMPOSE_FILE}"
  compose stop
}

uninstall_cmd() {
  if [[ -f "${COMPOSE_FILE}" ]]; then
    compose down || true
  fi
  remove_nginx_site
  log "Stopped Docker stack and removed managed Nginx site. Project files remain in ${INSTALL_DIR}."
}

install_cmd() {
  step "M5cet installer v${VERSION}"
  detect_os
  info "Target OS: ${OS_PRETTY}"
  info "Repo: ${REPO_URL}  branch=${BRANCH}"
  info "Install dir: ${INSTALL_DIR}"

  interactive_review

  ensure_base_packages
  ensure_docker
  handle_legacy
  clone_or_update_repo
  if [[ "${DRY_RUN}" != "1" ]]; then
    cp "$0" "${INSTALL_DIR}/install.sh" 2>/dev/null || true
    chmod +x "${INSTALL_DIR}/install.sh" 2>/dev/null || true
  fi
  write_compose_file
  start_app
  ensure_nginx_packages
  write_nginx_site
  enable_tls
  open_firewall
  if ! run_post_install_tests; then
    warn "Post-install tests reported failures."
  fi
  print_summary
}

# Update path: keep existing .env / data / nginx config, only refresh code
# and bounce the stack. Falls back to the full install_cmd when no install
# is detected at INSTALL_DIR.
update_cmd() {
  step "M5cet update v${VERSION}"
  detect_os
  if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
    warn "No existing install at ${INSTALL_DIR} — falling back to fresh install."
    install_cmd
    return
  fi
  ensure_base_packages
  ensure_docker
  clone_or_update_repo
  if [[ "${DRY_RUN}" != "1" ]]; then
    cp "$0" "${INSTALL_DIR}/install.sh" 2>/dev/null || true
    chmod +x "${INSTALL_DIR}/install.sh" 2>/dev/null || true
  fi
  # Only rewrite compose if the existing one is managed by us; never clobber
  # an operator-customised file unless FORCE_COMPOSE=1.
  write_compose_file
  start_app
  if ! run_post_install_tests; then
    warn "Post-update tests reported failures."
  fi
  print_summary
}

# Friendly numeric menu for admins who do not want to memorise every flag.
# Each option dispatches to the same *_cmd functions used by direct flags,
# so behaviour is identical.
gui_cmd() {
  while true; do
    cat <<MENU

  ┌─────────────────────────────────────────────┐
  │      M5cet installer (v${VERSION})           │
  ├─────────────────────────────────────────────┤
  │  1) Install / first-time setup              │
  │  2) Update (pull new code, redeploy)        │
  │  3) Test / doctor (read-only health probes) │
  │  4) Status                                  │
  │  5) Logs (follow)                           │
  │  6) Restart                                 │
  │  7) Stop                                    │
  │  8) Uninstall (keep project files)          │
  │  9) Help                                    │
  │  0) Quit                                    │
  └─────────────────────────────────────────────┘
MENU
    local choice
    read -r -p "Select [0-9]: " choice || { echo; return 0; }
    case "${choice}" in
      1) require_root "$@"; install_cmd ;;
      2) require_root "$@"; update_cmd ;;
      3) doctor_cmd ;;
      4) status_cmd ;;
      5) logs_cmd ;;
      6) require_root "$@"; restart_cmd ;;
      7) require_root "$@"; stop_cmd ;;
      8) require_root "$@"; uninstall_cmd ;;
      9) usage ;;
      0|q|Q) return 0 ;;
      *) warn "Unknown choice: ${choice}" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  case "${INSTALL_MODE_ARG}" in
    install)   require_root "$@"; install_cmd ;;
    update)    require_root "$@"; update_cmd ;;
    status)    status_cmd ;;
    logs)      logs_cmd ;;
    restart)   require_root "$@"; restart_cmd ;;
    stop)      require_root "$@"; stop_cmd ;;
    uninstall) require_root "$@"; uninstall_cmd ;;
    doctor)    doctor_cmd ;;
    gui)       gui_cmd ;;
    *) usage; die "Unknown command: ${INSTALL_MODE_ARG}" ;;
  esac
}

main "$@"
