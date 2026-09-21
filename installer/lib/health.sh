# shellcheck shell=bash
# M5cet installer — health probes and the read-only "doctor".

TESTS_PASSED=0; TESTS_FAILED=0; TESTS_SKIPPED=0
_pass() { ok "$*";     TESTS_PASSED=$((TESTS_PASSED+1)); }
_fail() { fail "$*";   TESTS_FAILED=$((TESTS_FAILED+1)); }
_skip() { skipln "$*"; TESTS_SKIPPED=$((TESTS_SKIPPED+1)); }

# The address to probe locally, whatever the service is bound to.
probe_host() {
  case "${BIND_ADDRESS}" in 0.0.0.0|::|"") echo "127.0.0.1" ;; *) echo "${BIND_ADDRESS}" ;; esac
}

# probe_http LABEL URL [WANT=200] [TRIES=30] — retries once a second.
probe_http() {
  local label="$1" url="$2" want="${3:-200}" tries="${4:-30}" code="" body i=1 tmp
  tmp="$(mktemp 2>/dev/null || echo "/tmp/m5cet-probe.$$")"
  while [ "${i}" -le "${tries}" ]; do
    code="$(curl -sS -o "${tmp}" -w '%{http_code}' --max-time 4 "${url}" 2>/dev/null || true)"
    if [ "${code}" = "${want}" ]; then
      body="$(head -c 160 "${tmp}" 2>/dev/null | tr -d '\n' || true)"
      rm -f "${tmp}"
      _pass "${label}  (HTTP ${code}) ${body}"
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  rm -f "${tmp}"
  _fail "${label}  (HTTP ${code:-n/a}, $(L 'expected' 'očekáváno') ${want})"
  return 1
}

probe_ws() {
  local label="$1" url="$2" first
  first="$(curl -sS -i --max-time 4 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "${url}" 2>/dev/null | head -n 1 || true)"
  case "${first}" in
    *" 101"*) _pass "${label}  (101 Switching Protocols)" ;;
    *)        _fail "${label}  ($(L 'got' 'odpověď'): ${first:-$(L 'no response' 'žádná')})"; return 1 ;;
  esac
}

# run_health_checks [TRIES] — returns 1 when any probe failed.
run_health_checks() {
  local tries="${1:-30}" base
  step "$(L 'Health checks' 'Kontrola funkčnosti')"
  TESTS_PASSED=0; TESTS_FAILED=0; TESTS_SKIPPED=0
  if [ "${DRY_RUN}" = "1" ]; then _skip "$(L 'all probes (dry-run)' 'všechny sondy (dry-run)')"; return 0; fi
  have curl || { _skip "curl $(L 'missing — cannot probe' 'chybí — nelze testovat')"; return 0; }
  base="http://$(probe_host):${APP_PORT}"
  probe_http "GET /api/health"      "${base}/api/health"      200 "${tries}" || true
  probe_http "GET /api/modules"     "${base}/api/modules"     200 5 || true
  probe_http "GET / (client)"       "${base}/"                200 5 || true
  probe_ws   "WebSocket /ws"        "${base}/ws" || true
  if [ "${ENABLE_ADMIN}" = "1" ]; then
    probe_http "GET /admin/health"          "http://127.0.0.1:${ADMIN_PORT}/admin/health"  200 15 || true
    probe_http "GET /admin/metrics (no token → 401)" "http://127.0.0.1:${ADMIN_PORT}/admin/metrics" 401 3 || true
  fi
  if [ "${ENABLE_PUSH}" = "1" ]; then
    if curl -fsS --max-time 4 "${base}/api/push/status" 2>/dev/null | grep -q '"enabled":true'; then
      _pass "Web Push $(L 'enabled (VAPID keys loaded)' 'zapnutý (VAPID klíče načteny)')"
    else
      _fail "Web Push $(L 'is not enabled although ENABLE_PUSH=1' 'není zapnutý, přestože ENABLE_PUSH=1')"
    fi
  fi
  printf '\n%s: %s%d %s%s, %s%d %s%s, %s%d %s%s\n' "$(L 'Result' 'Výsledek')" \
    "${C_GRN}" "${TESTS_PASSED}" "$(L 'passed' 'OK')" "${C_RST}" \
    "${C_RED}" "${TESTS_FAILED}" "$(L 'failed' 'selhalo')" "${C_RST}" \
    "${C_YEL}" "${TESTS_SKIPPED}" "$(L 'skipped' 'přeskočeno')" "${C_RST}"
  [ "${TESTS_FAILED}" -eq 0 ]
}

# doctor — read-only diagnosis of the system and of an existing install.
doctor() {
  local dir="${1:-}" bin
  print_system_report
  step "$(L 'Doctor' 'Diagnostika')"
  TESTS_PASSED=0; TESTS_FAILED=0; TESTS_SKIPPED=0
  for bin in bash curl tar git; do
    if have "${bin}"; then _pass "${bin}"; else _fail "${bin} $(L 'missing' 'chybí')"; fi
  done
  if [ -z "${dir}" ]; then
    _skip "$(L 'no installation found — nothing more to check' 'instalace nenalezena — není co dál kontrolovat')"
  else
    _pass "$(L 'install found at' 'instalace nalezena v') ${dir} (${INSTALL_MODE}/${SERVICE_MANAGER}, v${INSTALLED_VERSION:-?})"
    if [ -f "$(env_file)" ]; then
      case "$(ls -l "$(env_file)" | cut -c8-10)" in
        "---") _pass ".env $(L 'is not world-readable' 'není čitelný pro ostatní')" ;;
        *)     _fail ".env $(L 'is readable by others — run update.sh --repair' 'je čitelný pro ostatní — spusťte update.sh --repair')" ;;
      esac
    else
      _fail ".env $(L 'missing' 'chybí')"
    fi
    if [ "${INSTALL_MODE}" = "native" ]; then
      if node_ok; then _pass "node $(node --version)"; else _fail "node >= ${NODE_MIN_MAJOR} $(L 'missing' 'chybí')"; fi
      if [ -f "${INSTALL_DIR}/dist/index.cjs" ]; then _pass "dist/index.cjs"; else _fail "dist/index.cjs $(L 'missing — run update.sh --repair' 'chybí — spusťte update.sh --repair')"; fi
    else
      if [ "${SYS_DOCKER_RUNNING}" = "1" ]; then _pass "docker daemon"; else _fail "docker daemon $(L 'not reachable' 'není dostupný')"; fi
      if [ -f "$(compose_file)" ]; then _pass "$(compose_file)"; else _fail "$(compose_file) $(L 'missing' 'chybí')"; fi
    fi
    local base
    base="http://$(probe_host):${APP_PORT}"
    probe_http "GET /api/health"  "${base}/api/health"  200 3 || true
    probe_http "GET /api/modules" "${base}/api/modules" 200 2 || true
    probe_ws   "WebSocket /ws"    "${base}/ws" || true
    if [ "${ENABLE_ADMIN}" = "1" ]; then
      probe_http "GET /admin/health" "http://127.0.0.1:${ADMIN_PORT}/admin/health" 200 3 || true
    fi
    if [ "${SOURCE}" = "git" ]; then
      if update_available; then info "$(L 'Update available:' 'K dispozici je aktualizace:') ${REMOTE_COMMIT}"
      else info "$(L 'Sources are up to date (or the remote is unreachable).' 'Zdrojáky jsou aktuální (nebo je vzdálený repozitář nedostupný).')"; fi
    fi
  fi
  printf '\n%s: %d OK, %d FAIL, %d SKIP\n' "$(L 'Doctor' 'Diagnostika')" "${TESTS_PASSED}" "${TESTS_FAILED}" "${TESTS_SKIPPED}"
  [ "${TESTS_FAILED}" -eq 0 ]
}
