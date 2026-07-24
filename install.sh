#!/usr/bin/env bash
# ============================================================================
# CipherRoom Secure Chat — Universal Linux installer (v1.1)
#
# Podporované distribuce:
#   • Debian, Ubuntu, Kali, Pop!_OS, Mint, Raspbian              (apt)
#   • Fedora, RHEL 9+, CentOS Stream, Rocky, AlmaLinux           (dnf)
#   • CentOS 7, Amazon Linux 2, Oracle Linux 7                    (yum)
#   • Arch Linux, Manjaro, Endeavour, Garuda, Artix               (pacman)
#   • openSUSE Leap/Tumbleweed, SLES                              (zypper)
#   • Alpine, Chimera, postmarketOS                               (apk)
#   • Fedora Atomic, RHEL Atomic, Silverblue                      (rpm-ostree)
#   • Void Linux                                                 (xbps-install)
#   • Clear Linux                                                (swupd)
#   • Sabayon                                                    (equo)
#   • Gentoo, Funtoo                                             (emerge)
#
# Detekce: /etc/os-release → fallback na /etc/lsb-release a package manager probe.
# Fallback: pokud nic nefunguje, skript vypíše přesné příkazy pro ruční install.
#
# Flags:
#   --install              (default) Install/upgrade + start
#   --status               Compose status + health probe
#   --logs                 Follow container logs
#   --restart              Restart service
#   --stop                 Stop service
#   --uninstall            Stop a odstraň stack (ponechá projektové soubory)
#   --purge                Stop + odstraní všechno (compose stack, nginx, app)
#   --no-docker            Přeskoč Docker install (pro non-systemd / rootless)
#   --no-nginx             Přeskoč Nginx install
#   --no-tls               Přeskoč Let's Encrypt
#   --no-firewall          Přeskoč ufw/firewalld
#   --skip-base            Přeskoč base packages (git/curl/ca-certs)
#   --help                 Zobraz nápovědu
#
# Environment vars: HOST_PORT, APP_PORT, DOMAIN, ENABLE_NGINX, ENABLE_TLS,
#                   SKIP_DOCKER_INSTALL, FORCE_RECLONE, FIREWALL_OPEN,
#                   DATABASE_URL, LOG_EVENTS, VAPID_*, MAX_* a další.
# Viz úplný seznam v bloku `usage`.
# ============================================================================

set -Eeuo pipefail
IFS=$'\n\t'

# -- Color helpers ------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_GREEN=$'\033[1;32m'
  C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[1;31m'
  C_BLUE=$'\033[1;34m'
  C_GRAY=$'\033[0;90m'
else
  C_RESET="" C_GREEN="" C_YELLOW="" C_RED="" C_BLUE="" C_GRAY=""
fi

log()    { printf '%s[+]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info()   { printf '%s[*]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
warn()   { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()    { printf '%s[x]%s %s\n' "$C_RED" "$C_RESET"   "$*" >&2; }
die()    { err "$*"; exit 1; }
debug()  { [[ "${DEBUG:-0}" == "1" ]] && printf '%s[dbg]%s %s\n' "$C_GRAY" "$C_RESET" "$*" >&2 || true; }

# -- Configuration ------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/m5ike/cipherroom-secure-chat.git}"
BRANCH="${BRANCH:-master}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cipherroom-secure-chat}"
SERVICE_NAME="${SERVICE_NAME:-cipherroom}"
APP_PORT="${APP_PORT:-5000}"
HOST_PORT="${HOST_PORT:-5000}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
DOMAIN="${DOMAIN:-}"

# Nginx/TLS
ENABLE_NGINX="${ENABLE_NGINX:-auto}"
ENABLE_TLS="${ENABLE_TLS:-0}"
ACME_EMAIL="${ACME_EMAIL:-}"
FORCE_NGINX="${FORCE_NGINX:-0}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-${DOMAIN}}"

# Docker
SKIP_DOCKER_INSTALL="${SKIP_DOCKER_INSTALL:-0}"
FORCE_RECLONE="${FORCE_RECLONE:-0}"
FIREWALL_OPEN="${FIREWALL_OPEN:-0}"

# CipherRoom runtime
DATABASE_URL="${DATABASE_URL:-}"
LOG_EVENTS="${LOG_EVENTS:-0}"
VAPID_PUBLIC_KEY="${VAPID_PUBLIC_KEY:-}"
VAPID_PRIVATE_KEY="${VAPID_PRIVATE_KEY:-}"
MAX_PEERS_PER_ROOM="${MAX_PEERS_PER_ROOM:-16}"
FRAME_BUDGET_PER_SEC="${FRAME_BUDGET_PER_SEC:-20}"
MAX_FRAME_BYTES="${MAX_FRAME_BYTES:-131072}"
MAX_ATTACHMENT_BYTES="${MAX_ATTACHMENT_BYTES:-2147483648}" # 2 GB

# Staff flags (settable via CLI flags)
FLAG_NO_DOCKER=0
FLAG_NO_NGINX=0
FLAG_NO_TLS=0
FLAG_NO_FIREWALL=0
FLAG_SKIP_BASE=0
FLAG_PURGE=0

# Paths
MANAGED_MARKER="# Managed by CipherRoom install.sh"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"

# -- OS / package manager detection -------------------------------------
OS_ID=""
OS_LIKE=""
OS_VERSION_ID=""
PKG_MGR=""
PKG_FAMILY=""
INIT_SYSTEM=""

detect_os() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
    OS_VERSION_ID="${VERSION_ID:-}"
  elif [[ -r /etc/lsb-release ]]; then
    # shellcheck disable=SC1091
    . /etc/lsb-release
    OS_ID="${DISTRIB_ID:-unknown}"
    OS_LIKE=""
    OS_VERSION_ID="${DISTRIB_RELEASE:-}"
  elif [[ -r /etc/redhat-release ]]; then
    OS_ID="rhel"
    OS_VERSION_ID="$(cat /etc/redhat-release)"
  elif [[ -r /etc/alpine-release ]]; then
    OS_ID="alpine"
    OS_VERSION_ID="$(cat /etc/alpine-release)"
  else
    OS_ID="unknown"
    OS_LIKE=""
    OS_VERSION_ID=""
  fi

  OS_ID="$(printf '%s' "$OS_ID" | tr '[:upper:]' '[:lower:]')"
  OS_LIKE="$(printf '%s' "$OS_LIKE" | tr '[:upper:]' '[:lower:]')"
}

# Determines the (manager, family) pair by probing real binaries on PATH.
# Each branch is independent — runtime invokes pkg_install via the function.
detect_package_manager() {
  if   command -v apt-get     >/dev/null 2>&1; then PKG_MGR="apt";      PKG_FAMILY="debian"
  elif command -v dnf         >/dev/null 2>&1; then PKG_MGR="dnf";      PKG_FAMILY="rhel"
  elif command -v microdnf    >/dev/null 2>&1; then PKG_MGR="microdnf"; PKG_FAMILY="rhel"
  elif command -v yum         >/dev/null 2>&1; then PKG_MGR="yum";      PKG_FAMILY="rhel"
  elif command -v pacman      >/dev/null 2>&1; then PKG_MGR="pacman";   PKG_FAMILY="arch"
  elif command -v zypper      >/dev/null 2>&1; then PKG_MGR="zypper";   PKG_FAMILY="suse"
  elif command -v apk         >/dev/null 2>&1; then PKG_MGR="apk";      PKG_FAMILY="alpine"
  elif command -v xbps-install >/dev/null 2>&1; then PKG_MGR="xbps";   PKG_FAMILY="void"
  elif command -v swupd       >/dev/null 2>&1; then PKG_MGR="swupd";    PKG_FAMILY="clear"
  elif command -v emerge      >/dev/null 2>&1; then PKG_MGR="emerge";   PKG_FAMILY="gentoo"
  elif command -v equo        >/dev/null 2>&1; then PKG_MGR="equo";     PKG_FAMILY="sabayon"
  elif command -v rpm-ostree  >/dev/null 2>&1; then PKG_MGR="rpm-ostree"; PKG_FAMILY="atomic"
  else PKG_MGR=""; PKG_FAMILY=""
  fi
}

detect_init_system() {
  if [[ -d /run/systemd/system ]]; then INIT_SYSTEM="systemd"
  elif command -v rc-service >/dev/null 2>&1; then INIT_SYSTEM="openrc"
  elif command -v runit      >/dev/null 2>&1; then INIT_SYSTEM="runit"
  elif command -v dinit      >/dev/null 2>&1; then INIT_SYSTEM="dinit"
  elif command -v s6-rc      >/dev/null 2>&1; then INIT_SYSTEM="s6"
  else INIT_SYSTEM="unknown"
  fi
}

# -- Init helpers -------------------------------------------------------
service_enable_start() {
  local svc="$1"
  case "$INIT_SYSTEM" in
    systemd) systemctl enable --now "$svc" 2>/dev/null || true ;;
    openrc)  rc-update add "$svc" default 2>/dev/null || true
             service "$svc" start 2>/dev/null || true ;;
    runit)   sv enable "$svc" 2>/dev/null || true
             sv start "$svc" 2>/dev/null || true ;;
    dinit)   dinit-enable --now "$svc" 2>/dev/null || true ;;
    *)       warn "Unknown init system; start ${svc} manually if needed." ;;
  esac
}

# -- Package install per manager ---------------------------------------
# Each branch must:
#   • be non-interactive
#   • not require TTY
#   • print the exact failure if — after a fallback attempt — it still fails

pkg_install() {
  local packages=("$@")
  if [[ ${#packages[@]} -eq 0 ]]; then return 0; fi

  case "$PKG_MGR" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      # Sudo fix na Ubuntu: --fix-missing vyřeší transientní selhání
      apt-get install -y --no-install-recommends --fix-missing "${packages[@]}"
      return
      ;;
    dnf)
      dnf -y install --setopt=install_weak_deps=False "${packages[@]}"
      return
      ;;
    microdnf)
      microdnf install -y "${packages[@]}"
      return
      ;;
    yum)
      yum -y install "${packages[@]}"
      return
      ;;
    pacman)
      pacman -Sy --noconfirm --needed "${packages[@]}"
      return
      ;;
    zypper)
      # openSUSE — `--no-gpg-checks` je unsafe; ponecháme strict mode,
      # ale nabídneme --allow-vendor-change pro self-hosted base.
      zypper --non-interactive refresh
      zypper --non-interactive install --type package --no-confirm "${packages[@]}"
      return
      ;;
    apk)
      apk add --no-cache "${packages[@]}"
      return
      ;;
    xbps)
      xbps-install -S -y "${packages[@]}"
      return
      ;;
    swupd)
      swupd bundle-add "${packages[@]}"
      return
      ;;
    emerge)
      # Gentoo: vyžaduje sudo + USE flags; velmi pomalé.
      for p in "${packages[@]}"; do
        EMERGE_DEFAULT_OPTS="--quiet-build=y --ask=n" emerge --oneshot "$p"
      done
      return
      ;;
    equo)
      equo install "${packages[@]}"
      return
      ;;
    rpm-ostree)
      # rpm-ostree install potřebuje reboot; proto doporučíme vrátit se k --skip-base.
      rpmostree_isolate=$(mktemp -d)
      rpm-ostree install --apply-live "${packages[@]}" || {
        warn "rpm-ostree install failed. On atomic Fedora/Red Hat, packages live in a new layer."
        warn "Either reboot to apply, or set SKIP_BASE=1 and docker manually."
        return 1
      }
      return
      ;;
    "")
      # Detailní fallback message — pomůže uživateli ručně.
      cat >&2 <<EOF
[!] No supported package manager found automatically on this system.

Distribution detected:
  • OS_ID         = ${OS_ID:-unknown}
  • OS_LIKE       = ${OS_LIKE:-}
  • OS_VERSION_ID = ${OS_VERSION_ID:-}

Supported package managers:
  apt-get|apt  (Debian, Ubuntu, Pop!_OS, Mint, Kali, Raspbian, Elementary)
  dnf          (Fedora 22+, RHEL 9+, CentOS Stream, Rocky, Alma, Nobara)
  yum          (CentOS 7, Amazon Linux 2, Oracle Linux 7, RHEL 7)
  microdnf     (RHEL/CentOS Stream container base images)
  pacman       (Arch, Manjaro, Endeavour, Garuda, Artix)
  zypper       (openSUSE Leap/Tumbleweed, SLES)
  apk          (Alpine, Chimera, postmarketOS)
  xbps-install (Void)
  swupd        (Clear Linux)
  emerge       (Gentoo, Funtoo — slow)
  equo         (Sabayon)
  rpm-ostree   (Fedora Atomic, Silverblue, RHEL Atomic — requires reboot)

To install Docker manually, run one of these:

  Debian/Ubuntu:    sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 ca-certificates curl git
  Fedora/RHEL:      sudo dnf install -y docker docker-compose ca-certificates curl git
  Arch:             sudo pacman -S --noconfirm docker docker-compose ca-certificates curl git
  openSUSE:         sudo zypper install -y docker docker-compose ca-certificates curl git
  Alpine:           sudo apk add --no-cache docker docker-compose ca-certificates curl git
  Void:             sudo xbps-install -y docker docker-compose ca-certificates curl git

Then re-run with SKIP_DOCKER_INSTALL=1 to proceed:

  curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh \\
    | sudo -E SKIP_DOCKER_INSTALL=1 bash
EOF
      return 1
      ;;
  esac
}

# Wrapper that logs what we're doing.
pkg_install_logged() {
  local packages=("$@")
  detect_package_manager
  info "Package manager: ${PKG_MGR:-<none>} (family=${PKG_FAMILY:-?})"
  info "Installing: ${packages[*]}"
  pkg_install "${packages[@]}"
}

ensure_base_packages() {
  [[ "$FLAG_SKIP_BASE" == "1" ]] && { log "Skipping base packages (--skip-base)."; return; }

  detect_os
  detect_package_manager

  local missing=()
  for bin in git curl; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      missing+=("$bin")
    fi
  done

  # ca-certificates is a meta-package on Debian (not a binary), but OpenSSL
  # is what we actually need. Validate via /etc/ssl/certs path or openssl binary.
  if ! command -v openssl >/dev/null 2>&1 \
     && [[ ! -d /etc/ssl/certs ]]; then
    case "$PKG_FAMILY" in
      debian|ubuntu|pop|mint|kali|raspbian) missing+=("ca-certificates") ;;
      rhel|fedora|centos|rocky|alma|nobara) missing+=("ca-certificates") ;;
      arch|manjaro|endeavour|garuda)        missing+=("ca-certificates") ;;
      suse|opensuse|sles)                  missing+=("ca-certificates") ;;
      alpine|chimera|postmarketos)         missing+=("ca-certificates") ;;
      void)                                missing+=("ca-certificates") ;;
      clear)                               missing+=("ca-certificates") ;;
      *)                                   missing+=("ca-certificates") ;;
    esac
  fi

  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    command -v systemctl >/dev/null 2>&1 || missing+=("systemd")
  fi

  if (( ${#missing[@]} )); then
    pkg_install_logged "${missing[@]}" || die "Failed to install base packages: ${missing[*]}"
  fi
}

# -- Docker install -----------------------------------------------------
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
  if [[ "$FLAG_NO_DOCKER" == "1" || "${SKIP_DOCKER_INSTALL}" == "1" ]]; then
    log "Skipping Docker install (--no-docker / SKIP_DOCKER_INSTALL=1)."
    command -v docker >/dev/null 2>&1 || die "Docker missing and SKIP_DOCKER_INSTALL=1."
    docker_compose_cmd >/dev/null || die "Docker Compose plugin missing and SKIP_DOCKER_INSTALL=1."
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker_compose_cmd >/dev/null; then
    log "Docker and Docker Compose already installed."
    return
  fi

  detect_os
  detect_package_manager
  detect_init_system

  log "Installing Docker Engine + Compose plugin via ${PKG_MGR:-script}."
  case "$PKG_FAMILY" in
    debian)
      pkg_install_logged docker.io docker-compose-v2 ca-certificates curl gnupg
      ;;
    rhel)
      case "$OS_ID" in
        fedora|nobara|rosa)
          pkg_install_logged docker docker-compose ca-certificates curl
          ;;
        *)
          pkg_install_logged docker docker-compose ca-certificates curl
          # RHEL vyžaduje docker-ce repo; pokud selžou GPG, fallback na get.docker.com.
          ;;
      esac
      ;;
    arch)
      pkg_install_logged docker docker-compose ca-certificates curl
      ;;
    suse)
      pkg_install_logged docker docker-compose ca-certificates curl
      ;;
    alpine)
      pkg_install_logged docker docker-cli-compose ca-certificates curl openrc
      ;;
    void)
      pkg_install_logged docker docker-compose ca-certificates curl
      ;;
    clear)
      pkg_install_logged docker docker-compose ca-certificates curl
      ;;
    gentoo|sabayon)
      pkg_install_logged app-containers/docker docker-compose ca-certificates curl
      ;;
    atomic)
      warn "Atomic distro detected (rpm-ostree). Please install Docker manually:"
      warn "  rpm-ostree install docker docker-compose"
      warn "Reboot, then re-run with SKIP_DOCKER_INSTALL=1."
      return 1
      ;;
    *)
      warn "Unknown distro family '$PKG_FAMILY'. Falling back to get.docker.com."
      curl -fsSL --max-time 60 https://get.docker.com | sh -s -- --channel stable
      ;;
  esac

  # Docker service start (init-system aware)
  service_enable_start docker

  command -v docker >/dev/null 2>&1 || die "Docker installation failed; please install manually."
  docker_compose_cmd >/dev/null || {
    warn "Docker Compose plugin is missing — installing separately."
    case "$PKG_FAMILY" in
      debian|alpine) pkg_install_logged docker-compose-v2 ;;
      *)             pkg_install_logged docker-compose   ;;
    esac
  }
}

# -- Repo clone / update ------------------------------------------------
ensure_repo() {
  detect_os
  detect_package_manager

  if [[ "${FORCE_RECLONE}" == "1" && -d "${INSTALL_DIR}" ]]; then
    warn "FORCE_RECLONE=1 → removing ${INSTALL_DIR}"
    rm -rf "${INSTALL_DIR}"
  fi

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating existing repository in ${INSTALL_DIR}"
    pushd "${INSTALL_DIR}" >/dev/null
    git fetch --depth=1 origin "${BRANCH}" || git fetch --depth=1 origin
    git checkout -f "${BRANCH}" 2>/dev/null || git checkout -f FETCH_HEAD
    git reset --hard "origin/${BRANCH}" 2>/dev/null || git reset --hard FETCH_HEAD
    popd >/dev/null
  elif [[ -e "${INSTALL_DIR}" ]]; then
    die "${INSTALL_DIR} exists but is not a git repo. Set FORCE_RECLONE=1 to replace it."
  else
    log "Cloning ${REPO_URL} (branch=${BRANCH}) into ${INSTALL_DIR}"
    mkdir -p "$(dirname "${INSTALL_DIR}")"
    git clone --depth=1 --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}" || {
      warn "Branch clone failed; retrying default branch."
      git clone --depth=1 "${REPO_URL}" "${INSTALL_DIR}"
    }
  fi

  # Always copy our installer to the install dir so --logs etc. work later
  install -m 0755 "$0" "${INSTALL_DIR}/install.sh" 2>/dev/null || cp "$0" "${INSTALL_DIR}/install.sh" 2>/dev/null || true
}

# -- docker-compose.yml -------------------------------------------------
write_compose_file() {
  if [[ -f "${COMPOSE_FILE}" ]] && ! grep -qF "${MANAGED_MARKER}" "${COMPOSE_FILE}"; then
    warn "Existing docker-compose.yml is not managed; preserving it."
    return
  fi

  local compose_log_max_size="10m" compose_log_max_file="5"
  log "Writing managed docker-compose.yml at ${COMPOSE_FILE}"
  cat > "${COMPOSE_FILE}" <<EOF
${MANAGED_MARKER}
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
      MAX_PEERS_PER_ROOM: "${MAX_PEERS_PER_ROOM}"
      FRAME_BUDGET_PER_SEC: "${FRAME_BUDGET_PER_SEC}"
      MAX_FRAME_BYTES: "${MAX_FRAME_BYTES}"
      MAX_ATTACHMENT_BYTES: "${MAX_ATTACHMENT_BYTES}"
    ports:
      - "${BIND_ADDRESS}:${HOST_PORT}:${APP_PORT}"
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${APP_PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "${compose_log_max_size}"
        max-file: "${compose_log_max_file}"
EOF

  # Volume pro SQLite database
  if [[ -n "${DATABASE_URL}" && "${DATABASE_URL}" == sqlite:* ]]; then
    cat >> "${COMPOSE_FILE}" <<EOF
    volumes:
      - ${INSTALL_DIR}/data:/app/data:rw
EOF
    mkdir -p "${INSTALL_DIR}/data"
  fi
}

compose() {
  local cmd
  cmd="$(docker_compose_cmd)"
  # shellcheck disable=SC2086
  ${cmd} -p "${SERVICE_NAME}" -f "${COMPOSE_FILE}" "$@"
}

start_app() {
  pushd "${INSTALL_DIR}" >/dev/null
  log "Building Docker image."
  compose build --pull
  log "Starting ${SERVICE_NAME}."
  compose up -d
  # Počkej krátce a zkontroluj běh
  sleep 3
  if compose ps --format json 2>/dev/null | grep -q '"State":"running"'; then
    log "Container ${SERVICE_NAME} is running."
  else
    warn "Container ${SERVICE_NAME} may not be running. Run: cd ${INSTALL_DIR} && $(docker_compose_cmd) -p ${SERVICE_NAME} -f ${COMPOSE_FILE} ps"
  fi
  popd >/dev/null
}

stop_app() {
  pushd "${INSTALL_DIR}" >/dev/null
  compose stop || true
  popd >/dev/null
}

restart_app() {
  pushd "${INSTALL_DIR}" >/dev/null
  compose restart || true
  popd >/dev/null
}

logs_app() {
  pushd "${INSTALL_DIR}" >/dev/null
  compose logs -f --tail=200
  popd >/dev/null
}

status_app() {
  pushd "${INSTALL_DIR}" >/dev/null
  compose ps
  echo
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null; then
    echo
  else
    warn "Health probe unreachable at http://127.0.0.1:${HOST_PORT}/api/health"
  fi
  popd >/dev/null
}

uninstall_app() {
  pushd "${INSTALL_DIR}" >/dev/null
  compose down || true
  popd >/dev/null
}

purge_all() {
  uninstall_app
  if [[ -d "${INSTALL_DIR}" ]]; then
    warn "Removing ${INSTALL_DIR}"
    rm -rf "${INSTALL_DIR}"
  fi
  remove_nginx_site
  log "Purge complete."
}

# -- Firewall -----------------------------------------------------------
open_firewall() {
  [[ "$FLAG_NO_FIREWALL" == "1" || "${FIREWALL_OPEN}" != "1" ]] && return 0
  detect_init_system
  if command -v ufw >/dev/null 2>&1; then
    log "Opening TCP ${HOST_PORT} via ufw."
    ufw allow "${HOST_PORT}/tcp" || true
    if should_enable_nginx; then
      ufw allow 80/tcp || true
      ufw allow 443/tcp || true
    fi
  elif command -v firewall-cmd >/dev/null 2>&1; then
    log "Opening TCP ${HOST_PORT} via firewalld."
    firewall-cmd --add-port="${HOST_PORT}/tcp" --permanent || true
    if should_enable_nginx; then
      firewall-cmd --add-service=http --permanent || true
      firewall-cmd --add-service=https --permanent || true
    fi
    firewall-cmd --reload || true
  else
    warn "No ufw/firewalld found; open TCP ${HOST_PORT} manually if needed."
  fi
}

# -- Nginx --------------------------------------------------------------
should_enable_nginx() {
  [[ "$FLAG_NO_NGINX" == "1" ]] && return 1
  if [[ "${ENABLE_NGINX}" == "1" ]]; then return 0; fi
  if [[ "${ENABLE_NGINX}" == "auto" && -n "${DOMAIN}" ]]; then return 0; fi
  return 1
}

ensure_nginx_packages() {
  should_enable_nginx || return 0
  [[ -n "${NGINX_SERVER_NAME}" ]] || die "DOMAIN or NGINX_SERVER_NAME is required when ENABLE_NGINX=1."

  detect_os
  detect_package_manager
  if [[ "$PKG_FAMILY" != "debian" && "$PKG_FAMILY" != "rhel" && "$PKG_FAMILY" != "arch" && "$PKG_FAMILY" != "suse" && "$PKG_FAMILY" != "alpine" ]]; then
    warn "Auto-install Nginx on family '$PKG_FAMILY' is not officially supported."
    warn "Install nginx manually, then re-run with Nginx pre-installed."
    [[ "$FLAG_NO_NGINX" == "1" ]] && return 0
    return 0
  fi

  local packages=(nginx)
  if [[ -z "$FLAG_NO_TLS" && "${ENABLE_TLS}" == "1" ]]; then
    case "$PKG_FAMILY" in
      debian) packages+=(certbot python3-certbot-nginx) ;;
      rhel)   packages+=(certbot python3-certbot-nginx)     ;;
      arch)   packages+=(certbot certbot-nginx)              ;;
      suse)   packages+=(certbot)                            ;;
      alpine) packages+=(certbot)                            ;;
    esac
  fi

  log "Installing Nginx packages: ${packages[*]}"
  pkg_install_logged "${packages[@]}" || warn "Nginx install via package manager failed; you'll need to install it manually."
  service_enable_start nginx
}

write_nginx_site() {
  should_enable_nginx || return 0
  [[ -n "${NGINX_SERVER_NAME}" ]] || die "DOMAIN or NGINX_SERVER_NAME is required for Nginx."

  if [[ -f "${NGINX_SITE_AVAILABLE}" ]] && ! grep -qF "${MANAGED_MARKER}" "${NGINX_SITE_AVAILABLE}" && [[ "${FORCE_NGINX}" != "1" ]]; then
    die "${NGINX_SITE_AVAILABLE} exists and is not managed. Set FORCE_NGINX=1 to overwrite."
  fi
  if [[ -f "${NGINX_SITE_AVAILABLE}" ]]; then
    cp "${NGINX_SITE_AVAILABLE}" "${NGINX_SITE_AVAILABLE}.bak.$(date +%Y%m%d%H%M%S)"
  fi

  # 2 GB attachment limit v Nginx (musí být >= serveru)
  local client_max_body=2147483648

  log "Writing Nginx reverse proxy site for ${NGINX_SERVER_NAME}."
  cat > "${NGINX_SITE_AVAILABLE}" <<EOF
${MANAGED_MARKER}
server {
    listen 80;
    listen [::]:80;
    server_name ${NGINX_SERVER_NAME};

    access_log /var/log/nginx/${SERVICE_NAME}.access.log;
    error_log  /var/log/nginx/${SERVICE_NAME}.error.log;

    client_max_body_size ${client_max_body};

    # WebSocket upgrade map
    map \$http_upgrade \$connection_upgrade {
        default upgrade;
        ''      close;
    }

    location / {
        proxy_pass http://127.0.0.1:${HOST_PORT};
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;

        proxy_read_timeout    3600s;
        proxy_send_timeout    3600s;
        proxy_connect_timeout 60s;
        proxy_buffering       off;
        proxy_request_buffering off;

        # Bezpečnost
        add_header X-Frame-Options          "DENY" always;
        add_header X-Content-Type-Options   "nosniff" always;
        add_header Referrer-Policy          "no-referrer" always;
        add_header Permissions-Policy       "camera=(), microphone=(), geolocation=(), interest-cohort=()" always;

        # No-cache (zero-persistence slib projektu)
        add_header Cache-Control   "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma          "no-cache" always;
        add_header Expires         "0" always;
        add_header X-Robots-Tag    "noindex, nofollow" always;
    }
}
EOF

  # Detekce: sites-available/sites-enabled = Debian-style, httpd.d = OpenSUSE etc.
  case "$PKG_FAMILY" in
    suse)
      # OpenSUSE nemá sites-available/sites-enabled; vloží do httpd.conf include
      if [[ -f /etc/nginx/nginx.conf ]] && ! grep -q "${NGINX_SITE_AVAILABLE}" /etc/nginx/nginx.conf; then
        echo "include ${NGINX_SITE_AVAILABLE};" >> /etc/nginx/nginx.conf
      fi
      ;;
    alpine)
      # Alpine obvykle nemá sites-enabled; link do conf.d
      mkdir -p /etc/nginx/conf.d
      ln -sfn "${NGINX_SITE_AVAILABLE}" /etc/nginx/conf.d/${SERVICE_NAME}.conf
      ;;
    *)
      mkdir -p "$(dirname "${NGINX_SITE_ENABLED}")"
      ln -sfn "${NGINX_SITE_AVAILABLE}" "${NGINX_SITE_ENABLED}"
      ;;
  esac

  if nginx -t 2>/dev/null; then
    service_enable_start nginx
    if [[ -f /etc/init.d/nginx ]]; then
      /etc/init.d/nginx reload 2>/dev/null || true
    fi
  else
    warn "nginx -t failed; please validate ${NGINX_SITE_AVAILABLE} manually."
  fi
}

enable_tls() {
  should_enable_nginx || return 0
  [[ -z "$FLAG_NO_TLS" && "${ENABLE_TLS}" == "1" ]] || return 0
  [[ -n "${NGINX_SERVER_NAME}" ]] || die "DOMAIN or NGINX_SERVER_NAME is required for TLS."

  command -v certbot >/dev/null 2>&1 || {
    warn "certbot not installed; skipping TLS. Install certbot manually, then re-run."
    return 0
  }

  local -a email_args
  if [[ -n "${ACME_EMAIL}" ]]; then
    email_args=(--email "${ACME_EMAIL}")
  else
    email_args=(--register-unsafely-without-email)
  fi

  log "Requesting Let's Encrypt certificate for ${NGINX_SERVER_NAME}."
  certbot --nginx \
    --non-interactive \
    --agree-tos \
    --redirect \
    "${email_args[@]}" \
    -d "${NGINX_SERVER_NAME}" || warn "Let's Encrypt failed; configure TLS manually."

  systemctl reload nginx 2>/dev/null || /etc/init.d/nginx reload 2>/dev/null || true
}

remove_nginx_site() {
  if [[ -f "${NGINX_SITE_AVAILABLE}" ]] && grep -qF "${MANAGED_MARKER}" "${NGINX_SITE_AVAILABLE}"; then
    rm -f "${NGINX_SITE_ENABLED}" "${NGINX_SITE_AVAILABLE}"
    nginx -t && (systemctl reload nginx 2>/dev/null || /etc/init.d/nginx reload 2>/dev/null) || true
    log "Removed managed Nginx site ${SERVICE_NAME}."
  fi
}

# -- Reverse proxy hint -------------------------------------------------
print_reverse_proxy_hint() {
  cat <<EOF

Status:
  cd ${INSTALL_DIR}
  $(docker_compose_cmd) -p ${SERVICE_NAME} -f ${COMPOSE_FILE} ps

Logs (live):
  sudo -E ${INSTALL_DIR}/install.sh --logs

Local URL:
  http://${BIND_ADDRESS}:${HOST_PORT}

Healthcheck:
  curl -fsS http://127.0.0.1:${HOST_PORT}/api/health

File transfer limit:
  • Server enforces MAX_ATTACHMENT_BYTES=${MAX_ATTACHMENT_BYTES} bytes (default 2 GB).
  • nginx client_max_body_size matched.
  • Files travel browser-to-browser over WebRTC DataChannel (server is signalling only).
EOF

  if should_enable_nginx; then
    cat <<EOF

Nginx:
  site: ${NGINX_SITE_AVAILABLE}
  enabled: ${NGINX_SITE_ENABLED}
  ws endpoint: ws://${NGINX_SERVER_NAME}/ws
  wss after TLS: wss://${NGINX_SERVER_NAME}/ws

WebRTC:
  Nginx proxies only the signalling endpoint /ws. Browser-to-browser media/data use WebRTC ICE.
  HTTPS/WSS is required outside localhost; add a TURN server for restrictive NAT.
EOF
  fi
}

# -- Discovery of installed components ----------------------------------
installed() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1
}

# -- Pre-flight checks -------------------------------------------------
preflight_check() {
  warn "Pre-flight environment check"
  warn "  Kernel: $(uname -srmo 2>/dev/null || uname -s)"
  warn "  /etc/os-release: $([[ -r /etc/os-release ]] && echo 'present' || echo 'missing')"
  detect_os
  warn "  Detected OS: id=${OS_ID:-?} like=${OS_LIKE:-?} version=${OS_VERSION_ID:-?}"
  detect_package_manager
  warn "  Package manager: ${PKG_MGR:-<none>} (family=${PKG_FAMILY:-?})"
  detect_init_system
  warn "  Init system: ${INIT_SYSTEM:-unknown}"
  warn "  Memory: $(awk '/MemTotal/{printf "%.0f MB\n", $2/1024}' /proc/meminfo 2>/dev/null || echo '?')"
  warn "  Disk (/${INSTALL_DIR}): $(df -P "${INSTALL_DIR}" 2>/dev/null | tail -1 | awk '{print $4 " KB free"}')"
  info "Proceeding."
}

# -- Root check + CLI flags ---------------------------------------------
require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      info "Re-executing with sudo -E"
      exec sudo -E bash "$0" "$@"
    fi
    die "Run as root or install sudo."
  fi
}

parse_flags() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-docker)    FLAG_NO_DOCKER=1 ;;
      --no-nginx)     FLAG_NO_NGINX=1 ;;
      --no-tls)       FLAG_NO_TLS=1 ;;
      --no-firewall)  FLAG_NO_FIREWALL=1 ;;
      --skip-base)    FLAG_SKIP_BASE=1 ;;
      --purge)        FLAG_PURGE=1 ;;
      --debug|DEBUG=1) export DEBUG=1 ;;
      *)              break ;;
    esac
    shift
  done
  # Posun zbylých pozičních arg na začátek
  set -- "${@:-}"
  COMMAND="${1:-}"
  case "${COMMAND:-}" in
    ""|--install) ACTION="install" ;;
    --status)      ACTION="status" ;;
    --logs)        ACTION="logs" ;;
    --restart)     ACTION="restart" ;;
    --stop)        ACTION="stop" ;;
    --uninstall)   ACTION="uninstall" ;;
    --purge|---purge)   ACTION="purge"   ;;
    --help|-h)     ACTION="help"     ;;
    *)             ACTION="custom";   ;;
  esac
}

# -- Usage --------------------------------------------------------------
usage() {
  cat <<EOF
CipherRoom Linux/Docker installer (v1.1)

Usage:
  curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo -E bash

Or with custom domain/port:
  curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh \\
    | sudo env DOMAIN=chat.example.com HOST_PORT=5000 bash

Environment variables:
  REPO_URL              Git repository URL.                    default: ${REPO_URL}
  BRANCH                Branch/tag to install.                 default: ${BRANCH}
  INSTALL_DIR           Project directory.                     default: ${INSTALL_DIR}
  SERVICE_NAME          Compose project name.                  default: ${SERVICE_NAME}
  APP_PORT              Container app port (internal).         default: ${APP_PORT}
  HOST_PORT             Exposed host port.                     default: ${HOST_PORT}
  BIND_ADDRESS          Bind address (127.0.0.1 / 0.0.0.0).    default: ${BIND_ADDRESS}
  DOMAIN                Domain for Nginx reverse proxy and TLS.

  ENABLE_NGINX          auto|1|0. auto=on when DOMAIN set.     default: ${ENABLE_NGINX}
  ENABLE_TLS            1 to enable Let's Encrypt via certbot. default: ${ENABLE_TLS}
  ACME_EMAIL            Let's Encrypt registration email.
  FORCE_NGINX           1 to overwrite non-managed Nginx site. default: ${FORCE_NGINX}
  NGINX_SERVER_NAME     Override server_name (default = DOMAIN).

  SKIP_DOCKER_INSTALL   1 to skip Docker install.              default: ${SKIP_DOCKER_INSTALL}
  FORCE_RECLONE         1 to remove INSTALL_DIR and reclone.   default: ${FORCE_RECLONE}
  FIREWALL_OPEN         1 to open ports in ufw/firewalld.      default: ${FIREWALL_OPEN}

  DATABASE_URL          sqlite:./data/events.db (LOG_EVENTS=1).
  LOG_EVENTS            1 to enable opaque event metadata log. default: ${LOG_EVENTS}
  MAX_PEERS_PER_ROOM    Max peers per room.                    default: ${MAX_PEERS_PER_ROOM}
  FRAME_BUDGET_PER_SEC  WS frames per second per peer.         default: ${FRAME_BUDGET_PER_SEC}
  MAX_FRAME_BYTES       Max WS signaling frame size.           default: ${MAX_FRAME_BYTES}
  MAX_ATTACHMENT_BYTES  Max client attachment size (2 GB).      default: ${MAX_ATTACHMENT_BYTES}

  VAPID_PUBLIC_KEY      Optional VAPID public key for web push.
  VAPID_PRIVATE_KEY     Optional VAPID private key.

Notes:
  • If your distro's package manager is not detected, install Docker manually
    (one line of apt/dnf/pacman/zypper/apk) and re-run with SKIP_DOCKER_INSTALL=1.
  • The installer writes /etc/nginx/sites-available/${SERVICE_NAME}.conf under
    a managed marker; existing site configs are preserved unless FORCE_NGINX=1.
  • CipherRoom files NEVER traverse the server. WebRTC DataChannel only.

Commands (CLI flags):
  --install              Install or update + start (default).
  --status               Compose status + health probe.
  --logs                 Stream container logs.
  --restart              Restart service.
  --stop                 Stop service.
  --uninstall            Stop + remove compose stack (keep project files).
  --purge                Stop + remove compose stack + project + nginx site.
  --no-docker            Skip Docker install (for rootless/pre-installed Docker).
  --no-nginx             Skip Nginx install + config.
  --no-tls               Skip Let's Encrypt.
  --no-firewall          Skip ufw/firewalld rules.
  --skip-base            Skip base packages (git/curl/ca-certificates).
  --help                 Show this help.
EOF
}

# -- Main dispatcher ----------------------------------------------------
main() {
  require_root "$@"
  parse_flags "$@"

  if [[ "$ACTION" == "help" ]]; then
    usage
    exit 0
  fi

  detect_os
  detect_package_manager
  detect_init_system

  case "$ACTION" in
    install)
      preflight_check
      ensure_base_packages
      ensure_docker
      ensure_repo
      write_compose_file
      start_app
      ensure_nginx_packages
      write_nginx_site
      enable_tls
      open_firewall
      print_reverse_proxy_hint
      ;;
    status)
      status_app
      ;;
    logs)
      logs_app
      ;;
    restart)
      restart_app
      ;;
    stop)
      stop_app
      ;;
    uninstall)
      uninstall_app
      ;;
    purge)
      uninstall_app
      remove_nginx_site
      rm -rf "${INSTALL_DIR}"
      log "Purge complete."
      ;;
    custom)
      usage; die "Unknown command: ${COMMAND}"
      ;;
  esac
}

main "$@"
