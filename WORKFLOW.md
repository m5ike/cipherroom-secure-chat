# M5cet — vývojový workflow

Praktický postup pro každou změnu. Detaily struktury a konvencí jsou
v [`docs/developer-guide.md`](docs/developer-guide.md).

## 1. Příprava prostředí

```bash
node --version                       # >= 22 (CI a Docker běží na 24 LTS)
npm ci
git config core.hooksPath .githooks  # jednorázově: zapne pre-commit guard
```

Na macOS drží port 5000 *AirPlay Receiver* — používej `PORT=5173`.

## 2. Smyčka změny

```bash
PORT=5173 npm run dev     # server (tsx) + Vite middleware s HMR
npm run check             # tsc --noEmit (TypeScript 7, ~0,3 s)
npm test                  # vitest: unit + komponentové testy (happy-dom)
npm run check:menu        # guard invariantů MainMenu (= pre-commit hook)
npm run build             # produkční build do dist/
```

Před commitem musí projít všechny čtyři: `check`, `test`, `check:menu`,
`build`. Stejnou čtveřici spouští CI (`.github/workflows/ci.yml`) jako
samostatné joby + agregační bránu.

## 3. Pravidla, která se vyplatila

- **Tvrzení o výkonu jen s měřením.** Číslo bez metody do dokumentace
  nepatří — viz úvod [`CLIENT_OPTIMIZATIONS.md`](CLIENT_OPTIMIZATIONS.md).
- **Krypto kód se nepřepisuje „pro rychlost".** `lib/crypto.ts` má pevný
  kontrakt a testy wire formátu (`test/crypto.test.ts`). Změna salt prefixu
  nebo tvaru obálky je breaking migrace a musí být verzovaná.
- **Dokumentace se ověřuje proti kódu, ne naopak.** Ukázky kódu v `docs/`
  a `KNOWLEDGE_BASE.md` nejsou zdroj pravdy; zdrojem je `client/src` a `server`.
- **Zelené testy nestačí, když se nespouští.** `.tsx` testy dlouho tiše
  padaly už při transformaci. Sleduj v reportu *počet* souborů a testů
  (aktuálně 9 / 95), ne jen „passed".
- **Nová závislost = odůvodnění.** Projekt má 16 runtime závislostí záměrně.
  shadcn komponentu přidej až ve chvíli, kdy ji něco importuje
  (`npx shadcn add <název>`); Tailwind jinak její třídy přibalí do CSS.

## 4. Smoke test produkčního buildu

```bash
npm run build
PORT=5099 NODE_ENV=production node dist/index.cjs &
curl -fsS http://127.0.0.1:5099/api/health
kill %1

ADMIN_API_TOKEN=test ENABLE_ADMIN=1 ADMIN_PORT=5098 node dist/admin.cjs &
curl -fsS http://127.0.0.1:5098/admin/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5098/admin/metrics   # 401
curl -fsS -H 'Authorization: Bearer test' http://127.0.0.1:5098/admin/metrics
kill %1
```

Bundly v `dist/` jsou soběstačné — běží i bez `node_modules`.

## 5. Release

```bash
git checkout master && git pull --ff-only origin master
npm ci && npm run check && npm test && npm run check:menu && npm run build
npm version <x.y.z> --no-git-tag-version     # package.json + lockfile
# doplnit CHANGELOG.md (Keep a Changelog, česky)
git add -A && git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin master vX.Y.Z
```

Větve: `master` = stabilní; `feature/*` = vývoj; `release/*` = RC / freeze.
