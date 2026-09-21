# M5cet — stav projektu

**Verze:** 2.5.0 · **Větev:** `empero-ai-updates` · **Aktualizováno:** 2026-09-21

> Předchozí verze tohoto souboru hlásila „8/8 částí dokončeno" s procentuálním
> zrychlením u každé části. Ověřením proti gitu se ukázalo, že z uvedených
> souborů se oproti `master` změnily jen tři (`crypto.ts`,
> `connection-keeper.ts`, `cipherroom-api.ts`) a ty projekt rozbily:
> 15 chyb `tsc`, 17 padajících testů, nefunkční odvození klíče místnosti.
> Tento soubor nyní popisuje jen to, co je ověřené.

## Aktuální stav (ověřeno 2026-09-21)

| Kontrola                     | Výsledek                                   |
|------------------------------|--------------------------------------------|
| `npm run check` (TS 7)       | čisté                                      |
| `npm test` (Vitest 5)        | 9 souborů, **95 testů**, vše prochází      |
| `npm run check:menu`         | 8/8 kontrol (nově funguje i na macOS)      |
| `npm run build`              | OK — JS 495 kB, CSS 39,7 kB, server 1017 kB |
| Smoke `dist/index.cjs`       | health, statika, hlavičky, WS round-trip   |
| Smoke `dist/admin.cjs`       | 401 bez tokenu / 200 s tokenem / 400 mimo allowlist |

## Hotovo ve 2.5.0

Podrobně v [`CHANGELOG.md`](CHANGELOG.md); měření v
[`CLIENT_OPTIMIZATIONS.md`](CLIENT_OPTIMIZATIONS.md).

- Obnoveno funkční šifrovací jádro a connection-keeper z `master`.
- Opravena `Permissions-Policy` (blokovala hovory, STT a polohu).
- Opraven start serveru na macOS (`reusePort`).
- Zprovozněny `.tsx` testy; opraveny dvě chyby přístupnosti v `MainMenu`.
- Opraven pre-commit guard (BSD awk) a e2e testovací server (Express 5).
- Toolchain: Node ≥ 22 / 24 LTS, TypeScript 7, Vite 8.3, Vitest 5, React 19.3.
- Závislosti 68 → 16; odstraněno 44 nepoužitých UI komponent; CSS −49 %.
- `dotenv` → `process.loadEnvFile()`; base64 kodek sjednocen a zrychlen.
- Docker runtime bez `node_modules`, `USER node`, `.env` mimo build kontext.
- Dokumentace uvedena do souladu s kódem.

## Neověřeno — je potřeba udělat ručně

- [ ] **Docker build** obou image (`docker compose --profile admin build`).
      Dockerfily se změnily a daemon nebyl při úpravách k dispozici.
- [ ] **Playwright e2e**: `npx playwright install chromium && npm run test:e2e`.
- [ ] **Reálný hovor a sdílení polohy** mezi dvěma zařízeními přes HTTPS —
      oprava `Permissions-Policy` je ověřena jen na úrovni policy
      (`allowsFeature()`), ne úplným `getUserMedia`.
- [ ] CI na GitHubu po pushi (Node 24, ubuntu-22.04).

## Otevřené body / doporučení

0. **`install.sh` nasazuje zastaralou větev.** Výchozí
   `BRANCH=feature/m5cet-fullscreen-secure-workspace` je 19 commitů za
   `master`. Rozhodnout, zda přepnout výchozí hodnotu na `master` (pozor:
   `--update` dělá `git reset --hard`). Interní `VERSION` instalátoru je stále
   `2.1.0-rc.1`.
   Bezpečnostní a funkční mezery zjištěné revizí jsou v
   [`docs/security-model.md`](docs/security-model.md) → „Známé mezery".

1. **Tailwind 3.4 → 4** + `tailwind-merge` 3 — odloženo; vyžaduje vizuální
   kontrolu tří témat. Jediné zbývající „outdated" balíčky.
2. **Code-splitting panelů** (`React.lazy`) — JS bundle překročil 495 kB
   kvůli růstu React 19.3.
3. **Cachování `/assets/*`** — viz rozhodnutí v `CLIENT_OPTIMIZATIONS.md` §6.
4. **`App.tsx` má ~2 600 řádků** — kandidát na rozdělení (signaling, mesh,
   zprávy, panely). Změna bez testů App vrstvy je riziková; nejdřív testy.
5. `scripts/merge-and-tag-v2.4.1.sh` je jednorázový runbook pro už vydanou
   verzi — lze archivovat.
6. Stuby přetrvávají: settings sync, audit log, analytics consent a push
   subskripce jsou jen v paměti procesu; DB backend event logu je no-op.
