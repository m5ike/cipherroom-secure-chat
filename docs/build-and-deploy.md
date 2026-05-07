# M5cet — build & deploy

## Production build (minified)

```
npm install
npm run build          # spustí Vite build (klient) + esbuild --minify (server)
NODE_ENV=production npm start
```

Vite produkuje minifikované JS+CSS do `dist/public`. esbuild v `script/build.ts`
volá `minify: true` pro server bundle (`dist/index.cjs`). Žádný extra krok není potřeba.

## Dev

```
npm run dev            # tsx server/index.ts s vite middleware na /
```

## Sanity checks

- `npm run check` — `tsc --noEmit`
- `bash -n install.sh` — syntax-only validace instalátoru
- `npm run build` — kompletní build

## PWA

`client/public/manifest.webmanifest` se servíruje statickým middleware. Service worker
`client/public/sw.js` se registruje automaticky pouze v `Server-enhanced` módu (kvůli
Web Push). Ikony jsou SVG (`icon-192.svg`, `icon-512.svg`, `icon-maskable.svg`).

Safe-area inset třídy (`safe-px`, `safe-pt`, `safe-pb`) v `index.css` nastavují
horní/spodní odsazení pro iOS notch a Android gesture bar.

## Env vars

| Name                       | Effect                                                |
|----------------------------|-------------------------------------------------------|
| `PORT`                     | Default `5000`.                                       |
| `NODE_ENV`                 | `production` aktivuje `serveStatic`.                 |
| `VAPID_PUBLIC_KEY`         | Spolu s privátním klíčem zapne push (`/api/push/*`). |
| `VAPID_PRIVATE_KEY`        | Privátní klíč pro VAPID.                             |
| `LOG_EVENTS=1`             | Zapne `eventStore` (memory nebo `DATABASE_URL`).      |
| `DATABASE_URL`             | SQLite/Postgres pro events.                          |
| `VITE_SIGNALING_URL`       | Externí WSS pro signaling (split deploy).            |
