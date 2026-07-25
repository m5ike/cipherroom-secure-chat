# Changelog

Všechny významné změny tohoto projektu jsou dokumentovány v tomto souboru.

Formát vychází z [Keep a Changelog](https://keepachangelog.com/cs/1.1.0/) a
projekt používá [Semantic Versioning](https://semver.org/lang/cs/).

## [2.1.0-rc.1] – 2026-05-08

Release-hardening kandidát na M5cet 2.1. Zaměřuje se na komentáře, dokumentaci
v češtině, robustnější instalátor a testovací smoke checks. Bez API breaking
změn vůči `2.0.x`.

### Přidáno
- `CHANGELOG.md` (tento soubor) s historií iterací M5cet.
- `INSTALL.md` — rozšířený průvodce instalací, aktualizací, testováním
  a odinstalací pro Linux / Docker / Debian-Ubuntu / generic.
- Rozšíření `install.sh`:
  - `--update` (alias pro upgrade z aktuální installace, vyvolá
    `clone_or_update_repo` a `start_app`),
  - `--test` (alias pro `--doctor`),
  - `--gui` (interaktivní textové menu, vhodné pro správce bez paměti všech flagů),
  - `--version`.
- Modulové hlavičky / JSDoc komentáře pro:
  - `client/src/App.tsx` (popis architektury + JSDoc nad
    `deriveRoomKey` / `encryptEnvelope` / `decryptEnvelope`),
  - `server/index.ts`, `server/routes.ts`, `server/static.ts`,
    `client/src/components/Modal.tsx`, `shared/schema.ts`.
- Plně český `README.md` s Mermaid diagramy (architektura,
  message flow, WebRTC signaling, admin API, install/update/test flow).
- Doplnění `docs/` o `security-model.md`, `troubleshooting.md`,
  `developer-guide.md`, `deployment.md`.

### Změněno
- `package.json` → verze `2.1.0-rc.1`, popis aktualizován na "M5cet …".
- `package-lock.json` synchronizován na `2.1.0-rc.1`.

### Bezpečnost
- Komentář u `deriveRoomKey` upozorňuje, že salt prefix `CipherRoom:v1:` je
  součástí formátu klíče a jeho změna je breaking migrace.
- Komentář u `encryptEnvelope` zdůrazňuje zákaz cachování IV.
- Admin příkazy zůstávají chráněné token autentizací (`ADMIN_API_TOKEN`)
  a allowlist (`ADMIN_COMMAND_ALLOWLIST`). Žádný path k arbitrary remote
  code execution nebyl přidán.

### Otestováno
- `npm ci` — 469 packages, ok.
- `npm run check` — `tsc` čistý, bez chyb.
- `npm run build` — Vite + esbuild, výstup `dist/index.cjs` ~851 kB,
  `dist/admin.cjs` ~796 kB.
- Smoke test hlavní služby: `GET /api/health` → `{ok:true,…}`, `GET /` → 200.
- Smoke test admin služby: `GET /admin/health`, `/admin/metrics` (s/bez tokenu),
  `/admin/clients`, `/admin/modules`, `/admin/commands/audit`,
  `/admin/plugins/debug`, `/admin/logs/recent`, enqueue safe + reject unsafe.
- `bash -n install.sh` — syntaktická kontrola ok.
- `docker compose config -q` — ok (vyžaduje docker, ověřeno v dry-run).

## [2.0.0] – 2025

### Přidáno
- Real-time / admin / media moduly: konekční keeper, push, audio+video volání,
  speech (TTS/STT/revoice), chunked šifrovaný file transfer, admin API + GUI,
  whitelisted klientské příkazy, mapy/lokace, Web NFC, dokumentace
  prohlížečových omezení.
- Interaktivní `install.sh` s plnou Linux/Docker podporou, doctor módem,
  detekcí starých instalací, zálohou `.env` / `data/` / `docker-compose.yml`
  a Nginx konfigurací.
- Rebrand CipherRoom → M5cet, full-screen layout, témata / i18n / TTL /
  privacy panely.

## [1.0.0] – dřívější

- Bezpečný E2E šifrovaný P2P chat na bázi WebRTC DataChannel a WebSocket
  signalingu. Žádná persistence zpráv na serveru.
- Browser-only Firebase WebRTC chat varianta.
- Production hosting konfigurace (DigitalOcean, Railway, Render, Fly.io,
  Nginx + TLS).

[2.1.0-rc.1]: https://github.com/m5ike/cipherroom-secure-chat/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v2.0.0
[1.0.0]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v1.0.0
