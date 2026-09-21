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
