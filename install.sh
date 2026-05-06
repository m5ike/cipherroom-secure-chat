#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "[ERROR] line $LINENO: command failed" >&2' ERR

REPO_URL="${REPO_URL:-https://github.com/m5ike/cipherroom-secure-chat.git}"
BRANCH="${BRANCH:-master}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cipherroom-secure-chat}"
SERVICE_NAME="${SERVICE_NAME:-cipherroom}"
APP_PORT="${APP_PORT:-5000}"
HOST_PORT="${HOST_PORT:-5000}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
DOMAIN="${DOMAIN:-}"
SKIP_DOCKER_INSTALL="${SKIP_DOCKER_INSTALL:-0}"
FORCE_RECLONE="${FORCE_RECLONE:-0}"
FIREWALL_OPEN="${FIREWALL_OPEN:-0}"

COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
MANAGED_MARKER="# Managed by CipherRoom install.sh"

log() { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
CipherRoom Linux/Docker installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo -E bash

Environment variables:
  REPO_URL              Git repository URL. Default: ${REPO_URL}
  BRANCH                Git branch/tag. Default: ${BRANCH}
  INSTALL_DIR           Install directory. Default: ${INSTALL_DIR}
  SERVICE_NAME          Docker Compose project name. Default: ${SERVICE_NAME}
  APP_PORT              Container app port. Default: ${APP_PORT}
  HOST_PORT             Host port. Default: ${HOST_PORT}
  BIND_ADDRESS          Host bind address. Default: ${BIND_ADDRESS}
  DOMAIN                Optional domain for Nginx reverse proxy instructions.
  SKIP_DOCKER_INSTALL   Set 1 to skip Docker installation.
  FORCE_RECLONE         Set 1 to remove INSTALL_DIR and clone fresh.
  FIREWALL_OPEN         Set 1 to open HOST_PORT in ufw/firewalld when available.

Commands:
  --install             Install or update and start. Default.
  --status              Show service status.
  --logs                Follow container logs.
  --restart             Restart service.
  --stop                Stop service.
  --uninstall           Stop and remove generated compose stack, keep project files.
  --help                Show this help.

Examples:
  DOMAIN=chat.example.com HOST_PORT=5000 sudo -E ./install.sh
  INSTALL_DIR=/srv/chat BRANCH=main FIREWALL_OPEN=1 BIND_ADDRESS=0.0.0.0 sudo -E ./install.sh
  curl -fsSL https://raw.githubusercontent.com/m5ike/cipherroom-secure-chat/master/install.sh | sudo env DOMAIN=chat.example.com HOST_PORT=5000 bash
  sudo -E ./install.sh --logs
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  die "Run as root or install sudo."
fi

detect_os() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
  else
    OS_ID="unknown"
    OS_LIKE=""
  fi
}

pkg_update_and_install() {
  local packages=("$@")
  detect_os

  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "${packages[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm "${packages[@]}"
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install "${packages[@]}"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "${packages[@]}"
  else
    die "Unsupported Linux package manager. Install dependencies manually: ${packages[*]}"
  fi
}

ensure_base_packages() {
  local missing=()
  for bin in git curl ca-certificates; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      case "$bin" in
        ca-certificates) missing+=("ca-certificates") ;;
        *) missing+=("$bin") ;;
      esac
    fi
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
    log "Skipping Docker install because SKIP_DOCKER_INSTALL=1"
    command -v docker >/dev/null 2>&1 || die "Docker missing and SKIP_DOCKER_INSTALL=1."
    docker_compose_cmd >/dev/null || die "Docker Compose missing and SKIP_DOCKER_INSTALL=1."
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker_compose_cmd >/dev/null; then
    log "Docker and Docker Compose are already installed."
  else
    detect_os
    log "Installing Docker Engine and Compose plugin."
    if command -v pacman >/dev/null 2>&1; then
      pkg_update_and_install docker docker-compose
      systemctl enable --now docker || true
    elif command -v apk >/dev/null 2>&1; then
      pkg_update_and_install docker docker-cli-compose
      rc-update add docker default || true
      service docker start || true
    else
      curl -fsSL https://get.docker.com | sh
      systemctl enable --now docker || true
    fi
  fi

  command -v docker >/dev/null 2>&1 || die "Docker installation failed."
  docker_compose_cmd >/dev/null || die "Docker Compose plugin is missing."
}

clone_or_update_repo() {
  if [[ "${FORCE_RECLONE}" == "1" && -d "${INSTALL_DIR}" ]]; then
    warn "FORCE_RECLONE=1, removing ${INSTALL_DIR}"
    rm -rf "${INSTALL_DIR}"
  fi

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating existing repository in ${INSTALL_DIR}"
    git -C "${INSTALL_DIR}" fetch --depth=1 origin "${BRANCH}"
    git -C "${INSTALL_DIR}" checkout -f "${BRANCH}" 2>/dev/null || git -C "${INSTALL_DIR}" checkout -f FETCH_HEAD
    git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}" 2>/dev/null || git -C "${INSTALL_DIR}" reset --hard FETCH_HEAD
  elif [[ -e "${INSTALL_DIR}" ]]; then
    die "${INSTALL_DIR} exists but is not a git repository. Set FORCE_RECLONE=1 to replace it."
  else
    log "Cloning ${REPO_URL} (${BRANCH}) into ${INSTALL_DIR}"
    mkdir -p "$(dirname "${INSTALL_DIR}")"
    git clone --depth=1 --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}" || {
      warn "Branch ${BRANCH} clone failed, retrying default branch."
      git clone --depth=1 "${REPO_URL}" "${INSTALL_DIR}"
    }
  fi
}

write_compose_file() {
  if [[ -f "${COMPOSE_FILE}" ]] && ! grep -qF "${MANAGED_MARKER}" "${COMPOSE_FILE}"; then
    warn "Existing docker-compose.yml is not managed by this installer; preserving it."
    return
  fi

  log "Writing managed docker-compose.yml"
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
}

compose() {
  local cmd
  cmd="$(docker_compose_cmd)"
  # shellcheck disable=SC2086
  ${cmd} -p "${SERVICE_NAME}" -f "${COMPOSE_FILE}" "$@"
}

start_app() {
  log "Building Docker image."
  compose build --pull
  log "Starting ${SERVICE_NAME}."
  compose up -d
}

open_firewall() {
  [[ "${FIREWALL_OPEN}" == "1" ]] || return 0
  if command -v ufw >/dev/null 2>&1; then
    log "Opening TCP ${HOST_PORT} via ufw."
    ufw allow "${HOST_PORT}/tcp" || true
  elif command -v firewall-cmd >/dev/null 2>&1; then
    log "Opening TCP ${HOST_PORT} via firewalld."
    firewall-cmd --add-port="${HOST_PORT}/tcp" --permanent || true
    firewall-cmd --reload || true
  else
    warn "No ufw/firewalld found. Open TCP ${HOST_PORT} manually if needed."
  fi
}

print_reverse_proxy_hint() {
  cat <<EOF

Status:
  cd ${INSTALL_DIR}
  $(docker_compose_cmd) -p ${SERVICE_NAME} -f ${COMPOSE_FILE} ps

Logs:
  sudo -E ${INSTALL_DIR}/install.sh --logs

Local URL:
  http://${BIND_ADDRESS}:${HOST_PORT}

Healthcheck:
  curl -fsS http://127.0.0.1:${HOST_PORT}/api/health
EOF

  if [[ -n "${DOMAIN}" ]]; then
    cat <<EOF

Nginx reverse proxy for ${DOMAIN}:

server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${HOST_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
    }
}

Then enable TLS, for example:
  certbot --nginx -d ${DOMAIN}
EOF
  fi
}

status_cmd() {
  [[ -f "${COMPOSE_FILE}" ]] || die "Compose file not found: ${COMPOSE_FILE}"
  compose ps
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
  [[ -f "${COMPOSE_FILE}" ]] || die "Compose file not found: ${COMPOSE_FILE}"
  compose down
  log "Stopped Docker stack. Project files remain in ${INSTALL_DIR}."
}

install_cmd() {
  ensure_base_packages
  ensure_docker
  clone_or_update_repo
  cp "$0" "${INSTALL_DIR}/install.sh" 2>/dev/null || true
  chmod +x "${INSTALL_DIR}/install.sh" || true
  write_compose_file
  start_app
  open_firewall
  print_reverse_proxy_hint
}

case "${1:---install}" in
  --install) install_cmd ;;
  --status) status_cmd ;;
  --logs) logs_cmd ;;
  --restart) restart_cmd ;;
  --stop) stop_cmd ;;
  --uninstall) uninstall_cmd ;;
  *) usage; die "Unknown command: ${1:-}" ;;
esac
