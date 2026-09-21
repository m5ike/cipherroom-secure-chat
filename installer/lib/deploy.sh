# shellcheck shell=bash
# M5cet installer — sources, build, service management, reverse proxy,
# firewall, backups and rollback.

MANAGED_MARKER="# Managed by M5cet installer"
LEGACY_MARKER_RE='^# Managed by (M5cet|CipherRoom) install'

_git() { git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" "$@"; }

compose_file() { printf '%s/docker-compose.yml' "$(state_dir)"; }

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

_pkg_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n1
}

_looks_like_m5cet() { grep -q '"name":[[:space:]]*"cipherroom-secure-chat"' "$1/package.json" 2>/dev/null; }

fetch_sources() {
  step "$(L 'Fetching application sources' 'Stahuji zdrojové kódy aplikace')"
  PREVIOUS_COMMIT="${INSTALLED_COMMIT}"
  run mkdir -p "${INSTALL_DIR}"
  if [ "${SOURCE}" = "local" ]; then
    _copy_local_sources
    INSTALLED_COMMIT="local-$(now_stamp)"
  else
    _fetch_git_sources
    if [ "${DRY_RUN}" != "1" ]; then INSTALLED_COMMIT="$(_git rev-parse HEAD 2>/dev/null || echo unknown)"; fi
  fi
  if [ "${DRY_RUN}" != "1" ]; then
    _looks_like_m5cet "${INSTALL_DIR}" || die "$(L "${INSTALL_DIR} does not contain the M5cet sources after fetch." "${INSTALL_DIR} po stažení neobsahuje zdrojáky M5cet.")"
    INSTALLED_VERSION="$(_pkg_version "${INSTALL_DIR}")"
    log "$(L 'Sources ready:' 'Zdrojáky připraveny:') v${INSTALLED_VERSION:-?} (${INSTALLED_COMMIT})"
  fi
}

# Works for a fresh directory, an existing checkout, and a directory that
# already holds our untracked .env / .m5cet (where `git clone` would refuse).
_fetch_git_sources() {
  have git || die "git $(L 'is required.' 'je nutný.')"
  log "git: ${REPO_URL} @ ${BRANCH}"
  if [ ! -d "${INSTALL_DIR}/.git" ]; then
    run git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" init -q
  fi
  if [ "${DRY_RUN}" = "1" ]; then
    run git -C "${INSTALL_DIR}" fetch --depth=1 "${REPO_URL}" "${BRANCH}"
    run git -C "${INSTALL_DIR}" checkout -f -B m5cet-deploy FETCH_HEAD
    return 0
  fi
  if _git remote get-url origin >/dev/null 2>&1; then _git remote set-url origin "${REPO_URL}"
  else _git remote add origin "${REPO_URL}"; fi
  _git fetch --depth=1 origin "${BRANCH}" || die "$(L "Cannot fetch branch '${BRANCH}' from ${REPO_URL}." "Nelze stáhnout větev '${BRANCH}' z ${REPO_URL}.")"
  # -f: tracked files win over stale local edits; untracked .env/.m5cet stay.
  _git checkout -q -f -B m5cet-deploy FETCH_HEAD
  _git reset -q --hard FETCH_HEAD
}

_copy_local_sources() {
  local src="${SOURCE_PATH%/}"
  [ -d "${src}" ] || die "SOURCE_PATH ${src} $(L 'does not exist.' 'neexistuje.')"
  _looks_like_m5cet "${src}" || die "$(L "${src} is not an M5cet source tree (package.json missing or different project)." "${src} není zdrojový strom M5cet (chybí package.json nebo jde o jiný projekt).")"
  if [ "${src}" = "${INSTALL_DIR%/}" ]; then
    log "$(L 'Installing in place — sources are already here.' 'Instalace na místě — zdrojáky už tu jsou.')"
    return 0
  fi
  log "$(L 'Copying sources from' 'Kopíruji zdrojáky z') ${src}"
  if have rsync; then
    # Excluded paths are also protected from --delete, so .env/.m5cet survive.
    run rsync -a --delete \
      --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
      --exclude '.env' --exclude '.env.*' --exclude '.m5cet/' --exclude '.DS_Store' \
      "${src}/" "${INSTALL_DIR}/"
  else
    run_sh "cd '${src}' && tar -cf - --exclude ./.git --exclude ./node_modules --exclude ./dist --exclude ./.env --exclude ./.m5cet . | tar -xf - -C '${INSTALL_DIR}'"
  fi
}

# update_available — 0 when the remote branch head differs from what is installed.
update_available() {
  [ "${SOURCE}" = "git" ] || return 2
  local remote
  remote="$(git ls-remote "${REPO_URL}" "refs/heads/${BRANCH}" 2>/dev/null | awk '{print $1}' | head -n1)"
  [ -n "${remote}" ] || return 2
  REMOTE_COMMIT="${remote}"
  [ "${remote}" != "${INSTALLED_COMMIT}" ]
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

ensure_admin_token() {
  [ "${ENABLE_ADMIN}" = "1" ] || return 0
  [ -n "${ADMIN_API_TOKEN}" ] && return 0
  ADMIN_API_TOKEN="$(random_hex 32)"
  log "$(L 'Generated a random ADMIN_API_TOKEN (stored in .env).' 'Vygenerován náhodný ADMIN_API_TOKEN (uložen v .env).')"
}

_VAPID_JS='const c=require("crypto"),e=c.createECDH("prime256v1");e.generateKeys();const b=x=>x.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");let k=e.getPrivateKey();k=Buffer.concat([Buffer.alloc(32-k.length),k]);console.log(b(e.getPublicKey())+" "+b(k));'

# ensure_vapid RUNNER... — RUNNER is the command prefix that runs `node`.
ensure_vapid() {
  [ "${ENABLE_PUSH}" = "1" ] || return 0
  if [ -n "${VAPID_PUBLIC_KEY}" ] && [ -n "${VAPID_PRIVATE_KEY}" ]; then return 0; fi
  if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] $(L 'would generate a VAPID key pair' 'vygeneroval bych pár VAPID klíčů')"; return 0; fi
  local out
  out="$("$@" node -e "${_VAPID_JS}" 2>/dev/null)" || out=""
  if [ -z "${out}" ]; then
    warn "$(L 'Could not generate VAPID keys — push stays disabled. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY later via update.sh --set.' \
             'VAPID klíče se nepodařilo vygenerovat — push zůstává vypnutý. Nastavte je později přes update.sh --set.')"
    return 0
  fi
  VAPID_PUBLIC_KEY="${out%% *}"
  VAPID_PRIVATE_KEY="${out##* }"
  log "$(L 'Generated a VAPID key pair for Web Push (private key stays in .env).' 'Vygenerován pár VAPID klíčů pro Web Push (privátní klíč zůstává v .env).')"
}

# ---------------------------------------------------------------------------
# Native mode
# ---------------------------------------------------------------------------

native_build() {
  step "$(L 'Building (npm ci + npm run build)' 'Sestavuji (npm ci + npm run build)')"
  # devDependencies are needed to build, so NODE_ENV must not be production.
  run_sh "cd '${INSTALL_DIR}' && env -u NODE_ENV npm ci --no-audit --no-fund"
  run_sh "cd '${INSTALL_DIR}' && env -u NODE_ENV npm run build"
  if [ "${DRY_RUN}" != "1" ]; then
    [ -f "${INSTALL_DIR}/dist/index.cjs" ] || die "$(L 'Build did not produce dist/index.cjs.' 'Build nevytvořil dist/index.cjs.')"
  fi
  if [ "${KEEP_NODE_MODULES}" != "1" ]; then
    # dist/*.cjs bundle every server dependency, so nothing at runtime needs it.
    log "$(L 'Removing node_modules (dist/ is self-contained).' 'Odstraňuji node_modules (dist/ je soběstačné).')"
    run rm -rf "${INSTALL_DIR}/node_modules"
  fi
}

ensure_service_user() {
  [ "${SERVICE_MANAGER}" = "systemd" ] || return 0
  if id "${SERVICE_USER}" >/dev/null 2>&1; then return 0; fi
  log "$(L 'Creating system user' 'Vytvářím systémového uživatele') ${SERVICE_USER}"
  if have useradd; then
    run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "${SERVICE_USER}"
  elif have adduser; then
    run adduser -S -D -H -s /sbin/nologin "${SERVICE_USER}"
  else
    die "$(L 'No useradd/adduser found.' 'Chybí useradd/adduser.')"
  fi
  SERVICE_USER_CREATED="1"
}

_unit_path() { printf '/etc/systemd/system/%s.service' "$1"; }

_write_unit() {
  local name="$1" desc="$2" script="$3" port="$4" node_bin caps="" protect_home="true"
  # ProtectHome=true would hide an install that lives under /home.
  case "${INSTALL_DIR}" in /home/*) protect_home="read-only" ;; esac
  node_bin="$(command -v node || echo /usr/bin/node)"
  # Binding a port below 1024 as an unprivileged user needs this one capability.
  if [ "${port}" -lt 1024 ]; then caps="AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
  else caps="CapabilityBoundingSet="; fi
  write_file "$(_unit_path "${name}")" 0644 <<EOF
${MANAGED_MARKER}
[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${node_bin} ${INSTALL_DIR}/dist/${script}
Restart=always
RestartSec=3
# Hardening: the service needs the network and read access to its own files.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=${protect_home}
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
${caps}

[Install]
WantedBy=multi-user.target
EOF
}

native_install_service() {
  step "$(L 'Installing the service' 'Instaluji službu') (${SERVICE_MANAGER})"
  UNIT_FILES=""
  if [ "${SERVICE_MANAGER}" = "systemd" ]; then
    ensure_service_user
    # Code is owned by root and only readable by the service user.
    run chown -R "root:${SERVICE_USER}" "${INSTALL_DIR}/dist" "${INSTALL_DIR}/admin-ui" 2>/dev/null || true
    run chmod 0750 "${INSTALL_DIR}" 2>/dev/null || true
    run chown "root:${SERVICE_USER}" "${INSTALL_DIR}" 2>/dev/null || true
    _write_unit "${SERVICE_NAME}" "M5cet signaling service" "index.cjs" "${APP_PORT}"
    UNIT_FILES="$(_unit_path "${SERVICE_NAME}")"
    if [ "${ENABLE_ADMIN}" = "1" ]; then
      _write_unit "${SERVICE_NAME}-admin" "M5cet admin API" "admin.cjs" "${ADMIN_PORT}"
      UNIT_FILES="${UNIT_FILES} $(_unit_path "${SERVICE_NAME}-admin")"
    else
      _remove_unit "${SERVICE_NAME}-admin"
    fi
    run systemctl daemon-reload
    run systemctl enable "${SERVICE_NAME}.service"
    [ "${ENABLE_ADMIN}" = "1" ] && run systemctl enable "${SERVICE_NAME}-admin.service"
  else
    run mkdir -p "$(state_dir)/run" "$(state_dir)/logs"
  fi
  return 0
}

_remove_unit() {
  local name="$1" unit
  unit="$(_unit_path "${name}")"
  [ -f "${unit}" ] || return 0
  if grep -q "^${MANAGED_MARKER}" "${unit}" 2>/dev/null; then
    run systemctl disable --now "${name}.service" 2>/dev/null || true
    run rm -f "${unit}"
  else
    warn "${unit} $(L 'is not managed by this installer — left in place.' 'není spravován tímto instalátorem — ponechán.')"
  fi
}

# --- plain process manager (no systemd: macOS, containers, user scope) ------
_pidfile() { printf '%s/run/%s.pid' "$(state_dir)" "$1"; }
_logfile() { printf '%s/logs/%s.log' "$(state_dir)" "$1"; }

_proc_running() {
  local pf pid
  pf="$(_pidfile "$1")"
  [ -f "${pf}" ] || return 1
  pid="$(cat "${pf}" 2>/dev/null)"
  [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null
}

_proc_start() {
  local name="$1" script="$2"
  if _proc_running "${name}"; then return 0; fi
  run mkdir -p "$(state_dir)/run" "$(state_dir)/logs"
  if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] start node dist/${script}"; return 0; fi
  (
    cd "${INSTALL_DIR}" || exit 1
    # The app loads ./.env itself (server/env.ts); a fully detached child
    # survives the installer and the terminal that ran it.
    NODE_ENV=production nohup node "dist/${script}" >>"$(_logfile "${name}")" 2>&1 </dev/null &
    echo $! > "$(_pidfile "${name}")"
  )
}

_proc_stop() {
  local name="$1" pf pid i
  pf="$(_pidfile "${name}")"
  [ -f "${pf}" ] || return 0
  pid="$(cat "${pf}" 2>/dev/null)"
  if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
    if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] kill ${pid}"; return 0; fi
    kill "${pid}" 2>/dev/null || true
    i=0
    while kill -0 "${pid}" 2>/dev/null && [ "${i}" -lt 20 ]; do sleep 0.5; i=$((i+1)); done
    kill -0 "${pid}" 2>/dev/null && kill -9 "${pid}" 2>/dev/null
  fi
  [ "${DRY_RUN}" = "1" ] || rm -f "${pf}"
  return 0
}

# ---------------------------------------------------------------------------
# Docker mode
# ---------------------------------------------------------------------------

_compose() {
  local cmd
  if ! cmd="$(compose_cmd)"; then
    [ "${DRY_RUN}" = "1" ] && { info "[dry-run] docker compose -p ${SERVICE_NAME} -f $(compose_file) $*"; return 0; }
    die "docker compose $(L 'is not available.' 'není k dispozici.')"
  fi
  if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] ${cmd} -p ${SERVICE_NAME} -f $(compose_file) $*"; return 0; fi
  # shellcheck disable=SC2086
  ${cmd} -p "${SERVICE_NAME}" -f "$(compose_file)" "$@"
}

write_compose_file() {
  log "$(L 'Writing' 'Zapisuji') $(compose_file)"
  {
    cat <<EOF
${MANAGED_MARKER} — regenerate with update.sh, do not edit by hand.
# Secrets are NOT in this file; they come from ../.env (mode 0600).
services:
  app:
    build:
      context: ..
      dockerfile: Dockerfile
    image: ${SERVICE_NAME}:local
    container_name: ${SERVICE_NAME}
    restart: unless-stopped
    env_file:
      - ../.env
    ports:
      - "${BIND_ADDRESS}:${APP_PORT}:${CONTAINER_PORT}"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
EOF
    if [ "${ENABLE_ADMIN}" = "1" ]; then
      cat <<EOF

  # Same image, different entry point. Published on loopback only: reach it
  # through an SSH tunnel or a reverse proxy with an IP allowlist.
  admin:
    image: ${SERVICE_NAME}:local
    container_name: ${SERVICE_NAME}-admin
    restart: unless-stopped
    depends_on:
      - app
    command: ["node", "dist/admin.cjs"]
    env_file:
      - ../.env
    ports:
      - "127.0.0.1:${ADMIN_PORT}:${ADMIN_PORT}"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${ADMIN_PORT}/admin/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
EOF
    fi
  } | write_file "$(compose_file)" 0644
}

docker_build() {
  step "$(L 'Building the container image' 'Sestavuji image kontejneru')"
  # Keep the running image so a failed update can fall back to it.
  if [ "${DRY_RUN}" != "1" ] && docker image inspect "${SERVICE_NAME}:local" >/dev/null 2>&1; then
    docker tag "${SERVICE_NAME}:local" "${SERVICE_NAME}:rollback" >/dev/null 2>&1 || true
  fi
  _compose build --pull app
}

# ---------------------------------------------------------------------------
# Service control (one interface for all three managers)
# ---------------------------------------------------------------------------

service_ctl() {
  local action="$1"
  case "${SERVICE_MANAGER}" in
    systemd)
      case "${action}" in
        start|stop|restart)
          run systemctl "${action}" "${SERVICE_NAME}.service"
          if [ "${ENABLE_ADMIN}" = "1" ] || [ "${action}" = "stop" ]; then
            run systemctl "${action}" "${SERVICE_NAME}-admin.service" 2>/dev/null || true
          fi ;;
        status) systemctl --no-pager --lines=0 status "${SERVICE_NAME}.service" || true
                [ "${ENABLE_ADMIN}" = "1" ] && { systemctl --no-pager --lines=0 status "${SERVICE_NAME}-admin.service" || true; } ;;
        logs)   journalctl -u "${SERVICE_NAME}.service" -u "${SERVICE_NAME}-admin.service" -n 200 -f ;;
      esac ;;
    process)
      case "${action}" in
        start)   _proc_start app index.cjs; [ "${ENABLE_ADMIN}" = "1" ] && _proc_start admin admin.cjs ;;
        stop)    _proc_stop admin; _proc_stop app ;;
        restart) _proc_stop admin; _proc_stop app
                 _proc_start app index.cjs; [ "${ENABLE_ADMIN}" = "1" ] && _proc_start admin admin.cjs ;;
        status)  if _proc_running app; then ok "app  pid $(cat "$(_pidfile app)")"; else fail "app  $(L 'not running' 'neběží')"; fi
                 if [ "${ENABLE_ADMIN}" = "1" ]; then
                   if _proc_running admin; then ok "admin pid $(cat "$(_pidfile admin)")"; else fail "admin $(L 'not running' 'neběží')"; fi
                 fi ;;
        logs)    tail -n 200 -f "$(_logfile app)" ;;
      esac ;;
    compose)
      case "${action}" in
        start|restart) _compose up -d --remove-orphans ;;
        stop)          _compose stop ;;
        status)        _compose ps ;;
        logs)          _compose logs -f --tail=200 ;;
      esac ;;
    *) die "Unknown SERVICE_MANAGER '${SERVICE_MANAGER}'" ;;
  esac
  return 0
}

# Remove whatever the *previous* configuration deployed. Called by update.sh
# when the mode or the service manager changed, and by uninstall.sh.
teardown_service() {
  local manager="${1:-${SERVICE_MANAGER}}"
  case "${manager}" in
    systemd)
      _remove_unit "${SERVICE_NAME}-admin"
      _remove_unit "${SERVICE_NAME}"
      run systemctl daemon-reload 2>/dev/null || true ;;
    process)
      _proc_stop admin; _proc_stop app ;;
    compose)
      if [ -f "$(compose_file)" ]; then _compose down --remove-orphans || true; fi ;;
  esac
  UNIT_FILES=""
  return 0
}

# deploy_app [skip_build] — build + (re)deploy according to the current
# configuration. skip_build=1 reuses the existing dist/ or image when only
# settings changed; it is ignored when there is nothing to reuse.
deploy_app() {
  local skip_build="${1:-0}"
  if [ "${INSTALL_MODE}" = "docker" ]; then
    write_compose_file
    env_save                        # compose validates env_file on build
    if [ "${skip_build}" = "1" ] && [ "${DRY_RUN}" != "1" ] && docker image inspect "${SERVICE_NAME}:local" >/dev/null 2>&1; then
      info "$(L 'Reusing the existing image (settings-only change).' 'Používám stávající image (mění se jen nastavení).')"
    else
      docker_build
    fi
    ensure_vapid docker run --rm "${SERVICE_NAME}:local"
    env_save
    step "$(L 'Starting containers' 'Spouštím kontejnery')"
    _compose up -d --remove-orphans
  else
    if [ "${skip_build}" = "1" ] && [ -f "${INSTALL_DIR}/dist/index.cjs" ]; then
      info "$(L 'Reusing the existing build (settings-only change).' 'Používám stávající build (mění se jen nastavení).')"
    else
      native_build
    fi
    ensure_vapid
    env_save
    native_install_service
    env_save                        # again: ownership needs the service user
    step "$(L 'Starting the service' 'Spouštím službu')"
    service_ctl restart
  fi
}

# ---------------------------------------------------------------------------
# Nginx, TLS, firewall
# ---------------------------------------------------------------------------

_nginx_paths() {
  if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
    NGINX_SITE_PATH="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
    NGINX_SITE_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  elif [ -d /etc/nginx/http.d ]; then
    NGINX_SITE_PATH="/etc/nginx/http.d/${SERVICE_NAME}.conf"; NGINX_SITE_LINK=""
  else
    NGINX_SITE_PATH="/etc/nginx/conf.d/${SERVICE_NAME}.conf"; NGINX_SITE_LINK=""
  fi
}

# Reload when Nginx runs, start it when it does not. A proxy hiccup must not
# abort an otherwise finished install, so failure is a warning.
_nginx_reload() {
  run_sh "systemctl reload nginx 2>/dev/null || rc-service nginx reload 2>/dev/null || nginx -s reload 2>/dev/null \\
          || systemctl start nginx 2>/dev/null || rc-service nginx start 2>/dev/null || nginx" \
    || warn "$(L 'Could not reload or start Nginx — check: nginx -t' 'Nginx se nepodařilo znovu načíst ani spustit — zkontrolujte: nginx -t')"
}

write_nginx_site() {
  nginx_wanted || return 0
  step "$(L 'Configuring the Nginx reverse proxy' 'Nastavuji reverzní proxy Nginx')"
  ensure_nginx
  _nginx_paths
  local upstream="${BIND_ADDRESS}" zone backup=""
  case "${upstream}" in 0.0.0.0|::) upstream="127.0.0.1" ;; esac
  zone="$(printf '%s' "${SERVICE_NAME}" | tr -c 'A-Za-z0-9' '_')"

  if [ -f "${NGINX_SITE_PATH}" ] && ! grep -Eq "${LEGACY_MARKER_RE}" "${NGINX_SITE_PATH}"; then
    ui_yesno "$(L "${NGINX_SITE_PATH} was not written by this installer. Overwrite it?" "${NGINX_SITE_PATH} nevytvořil tento instalátor. Přepsat?")" 0 \
      || { warn "$(L 'Keeping the existing Nginx site.' 'Ponechávám stávající konfiguraci Nginx.')"; return 0; }
  fi
  if [ -f "${NGINX_SITE_PATH}" ] && [ "${DRY_RUN}" != "1" ]; then
    backup="${NGINX_SITE_PATH}.bak.$(now_stamp)"; cp -p "${NGINX_SITE_PATH}" "${backup}"
  fi

  write_file "${NGINX_SITE_PATH}" 0644 <<EOF
${MANAGED_MARKER}
# The application's own WebSocket rate limit does not run on the upgrade
# path, so connection limiting for /ws is enforced here, per client address.
limit_req_zone  \$binary_remote_addr zone=${zone}_ws:10m  rate=30r/m;
limit_conn_zone \$binary_remote_addr zone=${zone}_conn:10m;

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    access_log /var/log/nginx/${SERVICE_NAME}.access.log;
    error_log  /var/log/nginx/${SERVICE_NAME}.error.log;

    client_max_body_size 2m;
    add_header X-Robots-Tag "noindex, nofollow" always;

    location /ws {
        limit_req  zone=${zone}_ws burst=20 nodelay;
        limit_conn ${zone}_conn 20;

        proxy_pass http://${upstream}:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://${upstream}:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
EOF
  [ -n "${NGINX_SITE_LINK}" ] && run ln -sfn "${NGINX_SITE_PATH}" "${NGINX_SITE_LINK}"

  if [ "${DRY_RUN}" != "1" ]; then
    if ! nginx -t >/dev/null 2>&1; then
      # Never leave the operator's web server with a broken configuration.
      nginx -t 2>&1 | sed 's/^/    /' >&2 || true
      if [ -n "${backup}" ]; then mv -f "${backup}" "${NGINX_SITE_PATH}"
      else rm -f "${NGINX_SITE_PATH}"; [ -n "${NGINX_SITE_LINK}" ] && rm -f "${NGINX_SITE_LINK}"; fi
      die "$(L 'nginx -t failed — the site was reverted.' 'nginx -t selhal — konfigurace byla vrácena.')"
    fi
  fi
  _nginx_reload
}

remove_nginx_site() {
  local f="${NGINX_SITE_PATH}"
  [ -n "${f}" ] || { _nginx_paths; f="${NGINX_SITE_PATH}"; }
  [ -f "${f}" ] || { NGINX_SITE_PATH=""; NGINX_SITE_LINK=""; return 0; }
  if grep -Eq "${LEGACY_MARKER_RE}" "${f}"; then
    [ -n "${NGINX_SITE_LINK}" ] && run rm -f "${NGINX_SITE_LINK}"
    run rm -f "${f}"
    run_sh "(nginx -t >/dev/null 2>&1 && (systemctl reload nginx 2>/dev/null || rc-service nginx reload 2>/dev/null || nginx -s reload)) || true"
    log "$(L 'Removed the managed Nginx site.' 'Odstraněna spravovaná konfigurace Nginx.')"
  else
    warn "${f} $(L 'is not managed by this installer — left in place.' 'není spravován tímto instalátorem — ponechán.')"
  fi
  NGINX_SITE_PATH=""; NGINX_SITE_LINK=""
}

enable_tls() {
  nginx_wanted || return 0
  [ "${ENABLE_TLS}" = "1" ] || return 0
  step "$(L "Requesting a Let's Encrypt certificate for" "Žádám o certifikát Let's Encrypt pro") ${DOMAIN}"
  have certbot || [ "${DRY_RUN}" = "1" ] || die "certbot $(L 'is missing.' 'chybí.')"
  if [ -n "${ACME_EMAIL}" ]; then
    run certbot --nginx --non-interactive --agree-tos --redirect --email "${ACME_EMAIL}" -d "${DOMAIN}"
  else
    run certbot --nginx --non-interactive --agree-tos --redirect --register-unsafely-without-email -d "${DOMAIN}"
  fi
  _nginx_reload
}

open_firewall() {
  [ "${FIREWALL_OPEN}" = "1" ] || return 0
  local -a ports
  local n=0 p
  case "${BIND_ADDRESS}" in 127.*|::1) ;; *) ports[n]="${APP_PORT}"; n=$((n+1)) ;; esac
  if nginx_wanted; then ports[n]="80"; n=$((n+1)); ports[n]="443"; n=$((n+1)); fi
  [ "${n}" -gt 0 ] || return 0
  step "$(L 'Opening firewall ports:' 'Otevírám porty ve firewallu:') ${ports[*]}"
  for p in "${ports[@]}"; do
    if have ufw; then
      run_sh "ufw allow '${p}/tcp' >/dev/null"; FIREWALL_RULES="${FIREWALL_RULES} ufw:${p}"
    elif have firewall-cmd; then
      run_sh "firewall-cmd --permanent --add-port='${p}/tcp' >/dev/null"; FIREWALL_RULES="${FIREWALL_RULES} firewalld:${p}"
    else
      warn "$(L "No ufw/firewalld — open TCP ${p} manually." "Chybí ufw/firewalld — otevřete TCP ${p} ručně.")"
    fi
  done
  have firewall-cmd && ! have ufw && run_sh "firewall-cmd --reload >/dev/null"
  FIREWALL_RULES="$(printf '%s' "${FIREWALL_RULES}" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^ *//;s/ *$//')"
  return 0
}

close_firewall() {
  local rule tool port
  [ -n "${FIREWALL_RULES}" ] || return 0
  for rule in ${FIREWALL_RULES}; do
    tool="${rule%%:*}"; port="${rule##*:}"
    case "${port}" in 80|443) continue ;; esac     # may serve other sites
    case "${tool}" in
      ufw)       have ufw && run_sh "ufw delete allow '${port}/tcp' >/dev/null || true" ;;
      firewalld) have firewall-cmd && run_sh "firewall-cmd --permanent --remove-port='${port}/tcp' >/dev/null && firewall-cmd --reload >/dev/null || true" ;;
    esac
  done
  FIREWALL_RULES=""
  return 0
}

# ---------------------------------------------------------------------------
# Backups and rollback
# ---------------------------------------------------------------------------

LAST_BACKUP=""

backup_create() {
  local label="${1:-manual}" dest f
  dest="${BACKUP_ROOT}/$(now_stamp)-${label}"
  step "$(L 'Backup' 'Záloha') → ${dest}"
  if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] $(L 'would back up configuration, .env and dist/' 'zálohoval bych konfiguraci, .env a dist/')"; LAST_BACKUP="${dest}"; return 0; fi
  ( umask 077; mkdir -p "${dest}" )
  chmod 0700 "${BACKUP_ROOT}" "${dest}" 2>/dev/null || true
  for f in "$(conf_file)" "$(env_file)" "$(compose_file)"; do
    [ -f "${f}" ] && cp -p "${f}" "${dest}/$(basename "${f}")"
  done
  # A pre-3.0 install kept its generated compose file in the checkout root.
  f="${INSTALL_DIR}/docker-compose.yml"
  if [ -f "${f}" ] && grep -Eq "${LEGACY_MARKER_RE}" "${f}" 2>/dev/null; then cp -p "${f}" "${dest}/docker-compose.yml.legacy"; fi
  [ -f "${dest}/.env" ] && chmod 0600 "${dest}/.env"
  [ -n "${NGINX_SITE_PATH}" ] && [ -f "${NGINX_SITE_PATH}" ] && cp -p "${NGINX_SITE_PATH}" "${dest}/nginx-site.conf"
  for f in ${UNIT_FILES}; do [ -f "${f}" ] && cp -p "${f}" "${dest}/"; done
  printf '%s\n' "${INSTALLED_COMMIT}" > "${dest}/commit"
  # dist/ is ~2.5 MB and self-contained: restoring it is a complete rollback
  # of a native install with no rebuild.
  if [ "${INSTALL_MODE}" = "native" ] && [ -d "${INSTALL_DIR}/dist" ]; then
    tar -czf "${dest}/dist.tar.gz" -C "${INSTALL_DIR}" dist
  fi
  LAST_BACKUP="${dest}"
  backup_prune
}

backup_prune() {
  local keep="${BACKUP_KEEP:-5}" count d
  [ -d "${BACKUP_ROOT}" ] || return 0
  [ "${keep}" -gt 0 ] || return 0
  count=0
  # newest first; names start with a sortable timestamp
  for d in $(ls -1d "${BACKUP_ROOT}"/[0-9]*-* 2>/dev/null | sort -r); do
    count=$((count+1))
    if [ "${count}" -gt "${keep}" ]; then rm -rf -- "${d}"; fi
  done
  return 0
}

# rollback — put the previous code and configuration back and restart.
rollback() {
  [ -n "${LAST_BACKUP}" ] && [ -d "${LAST_BACKUP}" ] || { warn "$(L 'No backup to roll back to.' 'Není k dispozici záloha pro návrat.')"; return 1; }
  step "$(L 'Rolling back to' 'Vracím se k') ${LAST_BACKUP}"
  [ -f "${LAST_BACKUP}/.env" ] && cp -p "${LAST_BACKUP}/.env" "$(env_file)"
  [ -f "${LAST_BACKUP}/install.conf" ] && cp -p "${LAST_BACKUP}/install.conf" "$(conf_file)"
  conf_load "$(conf_file)" 1
  env_load "$(env_file)" 1
  if [ "${INSTALL_MODE}" = "native" ]; then
    if [ -f "${LAST_BACKUP}/dist.tar.gz" ]; then
      rm -rf "${INSTALL_DIR}/dist"
      tar -xzf "${LAST_BACKUP}/dist.tar.gz" -C "${INSTALL_DIR}"
    fi
    service_ctl restart
  else
    if docker image inspect "${SERVICE_NAME}:rollback" >/dev/null 2>&1; then
      docker tag "${SERVICE_NAME}:rollback" "${SERVICE_NAME}:local"
    fi
    [ -f "${LAST_BACKUP}/docker-compose.yml" ] && cp -p "${LAST_BACKUP}/docker-compose.yml" "$(compose_file)"
    _compose up -d --remove-orphans
  fi
  if [ "${SOURCE}" = "git" ] && [ -s "${LAST_BACKUP}/commit" ]; then
    _git reset -q --hard "$(cat "${LAST_BACKUP}/commit")" 2>/dev/null || true
  fi
}
