# shellcheck shell=bash
# M5cet installer — system detection and dependency installation.

NODE_MIN_MAJOR=22          # package.json "engines": ">=22"
NODE_INSTALL_MAJOR=24      # LTS line installed when Node is missing/too old
MIN_MEM_MB=900             # the Vite build needs roughly this much
MIN_DISK_MB=1500

SYS_KERNEL=""; SYS_OS_ID=""; SYS_OS_VERSION=""; SYS_OS_PRETTY=""
SYS_ARCH=""; SYS_KERNEL_VER=""; SYS_CPUS=""; SYS_MEM_MB=""; SYS_INIT=""
SYS_PKG=""; SYS_IN_CONTAINER="0"; SYS_IS_WSL="0"
SYS_NODE=""; SYS_NPM=""; SYS_GIT=""; SYS_DOCKER=""; SYS_DOCKER_RUNNING="0"
SYS_COMPOSE=""; SYS_NGINX=""; SYS_TUI=""

detect_system() {
  SYS_KERNEL="$(uname -s 2>/dev/null || echo unknown)"
  SYS_ARCH="$(uname -m 2>/dev/null || echo unknown)"
  SYS_KERNEL_VER="$(uname -r 2>/dev/null || echo unknown)"

  case "${SYS_KERNEL}" in
    Linux)
      if [ -r /etc/os-release ]; then
        SYS_OS_ID="$(. /etc/os-release 2>/dev/null; printf '%s' "${ID:-linux}")"
        SYS_OS_VERSION="$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_ID:-}")"
        SYS_OS_PRETTY="$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-Linux}")"
      else
        SYS_OS_ID="linux"; SYS_OS_PRETTY="Linux"
      fi
      SYS_CPUS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
      SYS_MEM_MB="$(awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
      grep -qi microsoft /proc/version 2>/dev/null && SYS_IS_WSL="1"
      if [ -f /.dockerenv ] || grep -qE '(docker|containerd|kubepods|lxc)' /proc/1/cgroup 2>/dev/null; then
        SYS_IN_CONTAINER="1"
      fi
      ;;
    Darwin)
      SYS_OS_ID="macos"
      SYS_OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo '')"
      SYS_OS_PRETTY="macOS ${SYS_OS_VERSION}"
      SYS_CPUS="$(sysctl -n hw.ncpu 2>/dev/null || echo 1)"
      SYS_MEM_MB="$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 ))"
      ;;
    *)
      SYS_OS_ID="unknown"; SYS_OS_PRETTY="${SYS_KERNEL}"; SYS_CPUS=1; SYS_MEM_MB=0
      ;;
  esac

  # init system: only "systemd" and "none/process" change what we do.
  if [ "${SYS_KERNEL}" = "Linux" ] && have systemctl && [ -d /run/systemd/system ]; then
    SYS_INIT="systemd"
  elif [ "${SYS_KERNEL}" = "Darwin" ]; then
    SYS_INIT="launchd"
  elif have rc-service; then
    SYS_INIT="openrc"
  else
    SYS_INIT="none"
  fi

  SYS_PKG="none"
  for pm in apt-get dnf yum pacman zypper apk brew; do
    if have "${pm}"; then SYS_PKG="${pm}"; break; fi
  done

  SYS_NODE="";  have node   && SYS_NODE="$(node --version 2>/dev/null || true)"
  SYS_NPM="";   have npm    && SYS_NPM="$(npm --version 2>/dev/null || true)"
  SYS_GIT="";   have git    && SYS_GIT="$(git --version 2>/dev/null | awk '{print $3}')"
  SYS_NGINX=""; have nginx  && SYS_NGINX="$(nginx -v 2>&1 | sed 's/.*nginx\///')"
  SYS_TUI="";   if have whiptail; then SYS_TUI="whiptail"; elif have dialog; then SYS_TUI="dialog"; fi

  SYS_DOCKER=""; SYS_DOCKER_RUNNING="0"; SYS_COMPOSE=""
  if have docker; then
    SYS_DOCKER="$(docker --version 2>/dev/null | sed -E 's/^Docker version ([^,]+).*/\1/')"
    docker info >/dev/null 2>&1 && SYS_DOCKER_RUNNING="1"
    if docker compose version >/dev/null 2>&1; then SYS_COMPOSE="docker compose"
    elif have docker-compose; then SYS_COMPOSE="docker-compose"; fi
  fi
}

# disk_free_mb PATH — free space on the filesystem that will hold PATH.
disk_free_mb() {
  local p="$1"
  while [ ! -d "${p}" ] && [ "${p}" != "/" ]; do p="$(dirname "${p}")"; done
  df -Pk "${p}" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024}'
}

print_system_report() {
  step "$(L 'System information' 'Informace o systému')"
  printf '  %-18s %s (%s)\n'  "OS"            "${SYS_OS_PRETTY}" "${SYS_OS_ID}"
  printf '  %-18s %s / %s\n'  "Kernel / arch" "${SYS_KERNEL_VER}" "${SYS_ARCH}"
  printf '  %-18s %s CPU, %s MB RAM\n' "Hardware" "${SYS_CPUS}" "${SYS_MEM_MB}"
  printf '  %-18s %s\n' "Init system"     "${SYS_INIT}"
  printf '  %-18s %s\n' "Package manager" "${SYS_PKG}"
  printf '  %-18s %s\n' "User"            "$(id -un) (uid $(id -u))$(is_root && printf ' — root')"
  [ "${SYS_IN_CONTAINER}" = "1" ] && printf '  %-18s %s\n' "Environment" "inside a container"
  [ "${SYS_IS_WSL}" = "1" ]       && printf '  %-18s %s\n' "Environment" "WSL"
  printf '  %-18s %s\n' "git"     "${SYS_GIT:-$(L 'missing' 'chybí')}"
  printf '  %-18s %s\n' "node"    "${SYS_NODE:-$(L 'missing' 'chybí')}$( [ -n "${SYS_NPM}" ] && printf ' (npm %s)' "${SYS_NPM}")"
  if [ -n "${SYS_DOCKER}" ]; then
    printf '  %-18s %s — daemon %s, compose: %s\n' "docker" "${SYS_DOCKER}" \
      "$( [ "${SYS_DOCKER_RUNNING}" = "1" ] && L 'running' 'běží' || L 'NOT running' 'NEBĚŽÍ')" "${SYS_COMPOSE:-$(L 'missing' 'chybí')}"
  else
    printf '  %-18s %s\n' "docker" "$(L 'missing' 'chybí')"
  fi
  printf '  %-18s %s\n' "nginx"   "${SYS_NGINX:-$(L 'missing' 'chybí')}"
  printf '  %-18s %s\n' "TUI tool" "${SYS_TUI:-$(L 'none (text wizard)' 'žádný (textový průvodce)')}"
}

# Warn (never block) about resources that commonly make the build fail.
check_resources() {
  local dir="$1" free
  if [ "${SYS_MEM_MB:-0}" -gt 0 ] && [ "${SYS_MEM_MB}" -lt "${MIN_MEM_MB}" ]; then
    warn "$(L "Only ${SYS_MEM_MB} MB RAM — the build may run out of memory (add swap)." \
             "Jen ${SYS_MEM_MB} MB RAM — build může spadnout na nedostatek paměti (přidejte swap).")"
  fi
  free="$(disk_free_mb "${dir}")"
  if [ -n "${free}" ] && [ "${free}" -lt "${MIN_DISK_MB}" ]; then
    warn "$(L "Only ${free} MB free for ${dir} (recommended ${MIN_DISK_MB} MB)." \
             "Pro ${dir} je volných jen ${free} MB (doporučeno ${MIN_DISK_MB} MB).")"
  fi
}

# ---------------------------------------------------------------------------
# Package installation
# ---------------------------------------------------------------------------

# Names of packages this run installed, recorded in install.conf so that
# uninstall can tell the operator what it left behind.
DEPS_INSTALLED=""
_note_installed() { DEPS_INSTALLED="$(printf '%s %s' "${DEPS_INSTALLED}" "$*" | sed 's/^ *//')"; }

_APT_UPDATED="0"
pkg_install() {
  [ $# -gt 0 ] || return 0
  if [ "${SCOPE:-system}" = "user" ] && [ "${SYS_PKG}" != "brew" ]; then
    die "$(L "Missing packages: $*. A user-scope install cannot install system packages — install them first or run as root." \
            "Chybí balíčky: $*. Uživatelská instalace neumí instalovat systémové balíčky — doinstalujte je, nebo spusťte jako root.")"
  fi
  log "$(L 'Installing packages:' 'Instaluji balíčky:') $*"
  case "${SYS_PKG}" in
    apt-get)
      export DEBIAN_FRONTEND=noninteractive
      if [ "${_APT_UPDATED}" = "0" ]; then run apt-get update -qq; _APT_UPDATED="1"; fi
      run apt-get install -y -qq --no-install-recommends "$@" >/dev/null ;;
    dnf)     run dnf install -y "$@" ;;
    yum)     run yum install -y "$@" ;;
    pacman)  run pacman -Sy --noconfirm --needed "$@" ;;
    zypper)  run zypper --non-interactive install "$@" ;;
    apk)     run apk add --no-cache "$@" ;;
    brew)    run brew install "$@" ;;
    *) die "$(L "No supported package manager. Install manually: $*" "Nepodporovaný správce balíčků. Nainstalujte ručně: $*")" ;;
  esac
  _note_installed "$@"
}

ensure_base_packages() {
  local -a missing
  local n=0 bin
  for bin in git curl tar; do
    have "${bin}" || { missing[n]="${bin}"; n=$((n+1)); }
  done
  if [ "${SYS_KERNEL}" = "Linux" ] && [ ! -d /etc/ssl/certs ] ; then
    missing[n]="ca-certificates"; n=$((n+1))
  fi
  [ "${n}" -gt 0 ] && pkg_install "${missing[@]}"
  return 0
}

# Optional: a TUI tool, only when the operator asked for --ui dialog.
ensure_tui_tool() {
  [ "${UI}" = "dialog" ] || return 0
  have whiptail && return 0
  have dialog && return 0
  [ "${SCOPE:-system}" = "user" ] && [ "${SYS_PKG}" != "brew" ] && return 0
  case "${SYS_PKG}" in
    apt-get)          pkg_install whiptail || true ;;
    dnf|yum|zypper|apk|brew) pkg_install newt || true ;;
    pacman)           pkg_install libnewt || true ;;
  esac
  return 0
}

node_ok() {
  have node || return 1
  local major; major="$(version_major "$(node --version 2>/dev/null)")"
  [ -n "${major}" ] && [ "${major}" -ge "${NODE_MIN_MAJOR}" ]
}

ensure_node() {
  if node_ok && have npm; then
    log "Node $(node --version) $(L 'is sufficient' 'vyhovuje') (>= ${NODE_MIN_MAJOR})."
    return 0
  fi
  if have node; then
    warn "$(L "Node $(node --version) is older than ${NODE_MIN_MAJOR}." "Node $(node --version) je starší než ${NODE_MIN_MAJOR}.")"
  fi
  log "$(L "Installing Node.js ${NODE_INSTALL_MAJOR}.x" "Instaluji Node.js ${NODE_INSTALL_MAJOR}.x")"
  case "${SYS_PKG}" in
    apt-get)
      run_sh "curl -fsSL https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x | bash -"
      _APT_UPDATED="1"; pkg_install nodejs ;;
    dnf|yum)
      run_sh "curl -fsSL https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x | bash -"
      pkg_install nodejs ;;
    apk)     pkg_install nodejs npm ;;
    pacman)  pkg_install nodejs npm ;;
    zypper)  pkg_install "nodejs${NODE_INSTALL_MAJOR}" "npm${NODE_INSTALL_MAJOR}" || pkg_install nodejs npm ;;
    brew)    pkg_install "node@${NODE_INSTALL_MAJOR}"; run brew link --overwrite --force "node@${NODE_INSTALL_MAJOR}" || true ;;
    *) die "$(L "Install Node.js >= ${NODE_MIN_MAJOR} manually, then re-run." "Nainstalujte ručně Node.js >= ${NODE_MIN_MAJOR} a spusťte znovu.")" ;;
  esac
  [ "${DRY_RUN}" = "1" ] && return 0
  hash -r 2>/dev/null || true
  node_ok || die "$(L "Node.js >= ${NODE_MIN_MAJOR} is still not available (found: $(node --version 2>/dev/null || echo none)). Your distribution packages an older release; install it from nodejs.org or NodeSource." \
                     "Node.js >= ${NODE_MIN_MAJOR} stále není k dispozici (nalezeno: $(node --version 2>/dev/null || echo nic)). Distribuce balí starší verzi; nainstalujte ji z nodejs.org nebo NodeSource.")"
  have npm || die "npm $(L 'is missing after installing Node.js.' 'po instalaci Node.js chybí.')"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then echo "docker compose"
  elif have docker-compose; then echo "docker-compose"
  else return 1; fi
}

ensure_docker() {
  if have docker && compose_cmd >/dev/null; then
    if docker info >/dev/null 2>&1; then
      log "Docker + Compose $(L 'ready' 'připraveny')."
      return 0
    fi
    if [ "${SYS_KERNEL}" = "Darwin" ]; then
      die "$(L 'Docker is installed but the daemon is not running. Start Docker Desktop and re-run.' \
              'Docker je nainstalovaný, ale daemon neběží. Spusťte Docker Desktop a zkuste to znovu.')"
    fi
    if [ "${SYS_INIT}" = "systemd" ] && is_root; then
      run systemctl enable --now docker || true
    fi
    [ "${DRY_RUN}" = "1" ] && return 0
    docker info >/dev/null 2>&1 || die "$(L 'Docker daemon is not reachable (is the service running / are you in the docker group?).' \
                                           'Docker daemon není dostupný (běží služba / jste ve skupině docker?).')"
    return 0
  fi

  if [ "${SYS_KERNEL}" = "Darwin" ]; then
    die "$(L 'Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and re-run, or choose the native mode.' \
            'Nainstalujte Docker Desktop (https://www.docker.com/products/docker-desktop/) a spusťte znovu, nebo zvolte nativní režim.')"
  fi
  [ "${SCOPE:-system}" = "user" ] && die "$(L 'Docker is missing and a user-scope install cannot install it.' 'Docker chybí a uživatelská instalace ho nainstalovat neumí.')"

  log "$(L 'Installing Docker Engine + Compose plugin' 'Instaluji Docker Engine + Compose plugin')"
  case "${SYS_PKG}" in
    pacman) pkg_install docker docker-compose ;;
    apk)    pkg_install docker docker-cli-compose
            run rc-update add docker default || true
            run service docker start || true ;;
    *)      run_sh "curl -fsSL https://get.docker.com | sh"; _note_installed docker-ce ;;
  esac
  [ "${SYS_INIT}" = "systemd" ] && { run systemctl enable --now docker || true; }
  [ "${DRY_RUN}" = "1" ] && return 0
  have docker || die "$(L 'Docker installation failed.' 'Instalace Dockeru selhala.')"
  compose_cmd >/dev/null || die "$(L 'Docker Compose is missing after install.' 'Po instalaci chybí Docker Compose.')"
}

ensure_nginx() {
  local -a pkgs
  local n=0
  have nginx || { pkgs[n]="nginx"; n=$((n+1)); }
  if [ "${ENABLE_TLS}" = "1" ] && ! have certbot; then
    case "${SYS_PKG}" in
      apt-get)  pkgs[n]="certbot"; n=$((n+1)); pkgs[n]="python3-certbot-nginx"; n=$((n+1)) ;;
      dnf|yum)  pkgs[n]="certbot"; n=$((n+1)); pkgs[n]="python3-certbot-nginx"; n=$((n+1)) ;;
      pacman)   pkgs[n]="certbot"; n=$((n+1)); pkgs[n]="certbot-nginx"; n=$((n+1)) ;;
      zypper)   pkgs[n]="certbot"; n=$((n+1)); pkgs[n]="python3-certbot-nginx"; n=$((n+1)) ;;
      apk)      pkgs[n]="certbot"; n=$((n+1)); pkgs[n]="certbot-nginx"; n=$((n+1)) ;;
      *) warn "$(L 'Install certbot manually for TLS.' 'Pro TLS nainstalujte certbot ručně.')" ;;
    esac
  fi
  [ "${n}" -gt 0 ] && pkg_install "${pkgs[@]}"
  if [ "${SYS_INIT}" = "systemd" ]; then
    run systemctl enable --now nginx || true
  elif [ "${SYS_INIT}" = "openrc" ]; then
    run rc-update add nginx default || true
    run rc-service nginx start || true
  fi
  return 0
}
