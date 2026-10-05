# shellcheck shell=bash
# M5cet installer — the installation and host check (check.sh, 6.12).
#
# check.sh lives in the root of the source tree, so it arrives with the
# sources (git checkout, or the rsync / tar copy of a local tree) together
# with release.json when the tree carries one. These helpers make sure it is
# there and executable, pin the release-signing key on the first install,
# offer the full check after an install and run the package / config /
# runtime part after every update (docs/install-check.md).

# install_check_tool — check.sh present and executable in the install root;
# release.json(.sig) and release-signing.pub taken over from a local source
# tree when the copy did not bring them; the release key pinned once.
install_check_tool() {
  local tool="${INSTALL_DIR}/check.sh" f pinned
  if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] $(L 'install check.sh and pin the release key' 'nainstalovat check.sh a připnout klíč vydání')"; return 0; fi
  if [ ! -f "${tool}" ] && [ -f "${M5_SCRIPT_DIR}/check.sh" ] && [ "${M5_SCRIPT_DIR%/}" != "${INSTALL_DIR%/}" ]; then
    cp -p "${M5_SCRIPT_DIR}/check.sh" "${tool}" || true
  fi
  if [ -f "${tool}" ]; then chmod 0755 "${tool}" 2>/dev/null || true; fi
  if [ "${SOURCE}" = "local" ] && [ -n "${SOURCE_PATH}" ] && [ "${SOURCE_PATH%/}" != "${INSTALL_DIR%/}" ]; then
    for f in release.json release.json.sig release-signing.pub; do
      if [ -f "${SOURCE_PATH}/${f}" ] && [ ! -f "${INSTALL_DIR}/${f}" ]; then cp -p "${SOURCE_PATH}/${f}" "${INSTALL_DIR}/${f}" || true; fi
    done
  fi
  # Trust on first use: from now on check.sh compares the tree's key with this
  # copy, so a package re-signed with another key is noticed. A real key
  # change is accepted by replacing the pinned copy (docs/install-check.md).
  pinned="$(state_dir)/release-signing.pub"
  if [ -f "${INSTALL_DIR}/release-signing.pub" ] && [ ! -f "${pinned}" ]; then
    if cp "${INSTALL_DIR}/release-signing.pub" "${pinned}" 2>/dev/null; then
      chmod 0644 "${pinned}" 2>/dev/null || true
      log "$(L 'Release-signing key pinned:' 'Klíč pro podpis vydání připnut:') ${pinned}"
    fi
  fi
  return 0
}

# offer_install_check — after an install: ask to run the full check now
# (interactive), otherwise say how to run it.
offer_install_check() {
  local tool="${INSTALL_DIR}/check.sh"
  [ -f "${tool}" ] || return 0
  [ "${DRY_RUN}" = "1" ] && return 0
  if [ "${NON_INTERACTIVE}" != "1" ] && ui_yesno "$(L 'Run the full installation and host check now (check.sh, read-only)?' 'Spustit teď úplnou kontrolu instalace a hostitele (check.sh, jen čtení)?')" 1; then
    bash "${tool}" --root "${INSTALL_DIR}" --lang "${M5_LANG}" || true
  else
    info "$(L 'Full installation and host check (read-only):' 'Úplná kontrola instalace a hostitele (jen čtení):') ${tool}"
  fi
  return 0
}

# post_update_check — check.sh --quiet --only package,config,runtime after an
# update: prints its WARN / FAIL lines and the summary. Returns 1 only when the
# package integrity failed (files differ from release.json or git, an invalid
# signature or a changed key, changed web assets) — the caller stops then.
# Any other FAIL is reported and the update continues.
post_update_check() {
  local tool="${INSTALL_DIR}/check.sh" report rc=0
  if [ ! -f "${tool}" ]; then
    warn "$(L "${tool} is missing — skipping the installation check" "${tool} chybí — kontrolu instalace přeskakuji")"
    return 0
  fi
  step "$(L 'Installation check (check.sh: package, config, runtime)' 'Kontrola instalace (check.sh: balíček, konfigurace, běh)')"
  report="$(mktemp "${TMPDIR:-/tmp}/m5cet-check.XXXXXX" 2>/dev/null)" || return 0
  bash "${tool}" --root "${INSTALL_DIR}" --quiet --only package,config,runtime --lang "${M5_LANG}" --report "${report}" || rc=$?
  if [ "${rc}" = "2" ]; then
    warn "$(L 'check.sh could not run (usage error)' 'check.sh se nespustil (chybné použití)')"
    rm -f "${report}"
    return 0
  fi
  if grep -Eq '"id":"package\.(integrity|signature|web|web_signature)","status":"FAIL"' "${report}" 2>/dev/null; then
    rm -f "${report}"
    return 1
  fi
  rm -f "${report}"
  return 0
}
