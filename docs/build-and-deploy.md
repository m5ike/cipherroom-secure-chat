# M5cet — build & deploy

## Production build (minified)

Požadavek: **Node.js ≥ 22** (CI a Docker používají 24 LTS).

```
npm ci
npm run build          # Vite (klient) + esbuild (dist/index.cjs, dist/admin.cjs), souběžně
NODE_ENV=production npm start
```

Vite 8 produkuje minifikované JS+CSS do `dist/public` (minifikátor oxc).
`script/build.ts` staví oba server bundly jedním voláním esbuild
(`minify: true`, `target: node22`). Bundly obsahují všechny serverové
závislosti (`express`, `ws`, `helmet`, `express-rate-limit`, `web-push`),
takže **`dist/` běží i bez `node_modules`** — runtime stage v `Dockerfile`
je proto nekopíruje.

Orientační velikosti (2.5.0): JS 495 kB (gzip 153 kB), CSS 39,7 kB
(gzip 8,6 kB), `index.cjs` 1 017 kB, `admin.cjs` 905 kB.

## Dev

```
npm run dev            # tsx server/index.ts s vite middleware na /
PORT=5173 npm run dev  # macOS: port 5000 drží AirPlay Receiver
```

## Sanity checks

- `npm run check` — `tsc --noEmit`
- `npm test` — vitest (10 souborů / 106 testů)
- `npm run test:e2e` — Playwright, 10 testů (UI smoke + dva peeři)
- `npm run check:menu` — guard invariantů MainMenu
- `bash -n install.sh` — syntax-only validace instalátoru
- `npm run build` — kompletní build

## PWA

`client/public/manifest.webmanifest` se servíruje statickým middleware. Service worker
`client/public/sw.js` se registruje automaticky pouze v `Server-enhanced` módu (kvůli
Web Push). Ikony jsou SVG (`icon-192.svg`, `icon-512.svg`, `icon-maskable.svg`).

Safe-area inset třídy (`safe-px`, `safe-pt`, `safe-pb`) v `index.css` nastavují
horní/spodní odsazení pro iOS notch a Android gesture bar.

## Env vars

`.env` v pracovním adresáři načítá `server/env.ts` vestavěným
`process.loadEnvFile()`. Chybějící soubor je v pořádku (kontejnery);
proměnné ze skutečného prostředí mají přednost. `.env` je v `.dockerignore`
— do image se tajemství dostávají výhradně přes prostředí kontejneru.

| Name                       | Effect                                                |
|----------------------------|-------------------------------------------------------|
| `PORT`                     | Default `5000`.                                       |
| `NODE_ENV`                 | `production` aktivuje `serveStatic`.                 |
| `VAPID_PUBLIC_KEY`         | Spolu s privátním klíčem zapne push (`/api/push/*`). |
| `VAPID_PRIVATE_KEY`        | Privátní klíč pro VAPID.                             |
| `LOG_EVENTS=1`             | Zapne `eventStore` (memory nebo `DATABASE_URL`).      |
| `DATABASE_URL`             | SQLite/Postgres pro events.                          |
| `VITE_SIGNALING_URL`       | Externí WSS pro signaling (split deploy).            |
| `PRESENCE_MAX_AWAY_DAYS`   | 6.7: dny, po které zůstane v místnosti člen bez spojení (7; `0` = navždy). |
| `ACCOUNTS_MAX`             | 6.7: strop účtů (5000).                              |
| `STORAGE_SESSION_BUDGET_MB`| 6.7: rozpočet anonymních databází relací (2048).     |
| `FUNCTIONS_NFC_RUN_HOURS`  | 6.7: retence běhů funkcí, které četly kartu (24 h).  |
| `FUNCTIONS_DNS_TIMEOUT_MS` | 6.11: limit jednoho `m5.dns.resolve` (4000; 250–15000). |
| `FUNCTIONS_DNS_SERVERS`    | 6.11: jmenné servery funkcí („1.1.1.1, 8.8.8.8:53“; jinak systémové). |
| `FUNCTIONS_SSE_PING_MS`    | 6.11: udržovací `: ping` streamu běhu (15000).       |
| `FUNCTIONS_WAIT_NOTICE_MS` | 6.11: po kolika ms čekání na hostitele běh ohlásí `progress` „Waiting for …“ (10000). |
| `FUNCTIONS_WAIT_EVERY_MS`  | 6.11: nejdelší ticho, než přijde další ohlášení (10000). |
| `VONAGE_ALLOW_UNSIGNED_SMS`| 6.7: `1` = přijmout Vonage SMS bez podpisu.          |
| `ANDROID_DESIGN_IMAGE_HOSTS`| 6.7: povolení hostitelé obrázků v designu Androidu (výchozí žádný). |
| `NOTIFY_DIR`               | 6.7: nastavení upozornění (`$DATA_DIR/notify`).      |

Úplný seznam proměnných je v [dokumentaci › Nasazení](site/index.html#promenne),
změny 6.7 v [`deployment.md`](deployment.md#přechod-na-67). `.dockerignore`
od 6.7 vynechává `.env*` (kromě `.env.example`) a zálohy `*.bak`; vývojový
server je navíc nepouští (`vite.config.ts`, `fs.deny`).
