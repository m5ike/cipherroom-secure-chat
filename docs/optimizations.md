# Optimalizace — co bylo změřeno a jak to zopakovat

> **Pravidlo tohoto souboru:** každé číslo zde má uvedenou metodu měření
> a dá se zreprodukovat. Odhady bez měření sem nepatří.
>
> Dřívější verze tohoto dokumentu uváděla zrychlení o 10–47 % pro osm „částí"
> projektu. Ta čísla **nebyla ničím podložena** — soubory, kterých se měla
> týkat (`file-transfer.ts`, `push.ts`, `rtc.ts`, `nfc.ts`, `install.sh`, …),
> byly bajt po bajtu shodné s větví `master`. Tvrzení byla odstraněna.

Stav k verzi **2.6.0** (2026-09-21), měřeno na macOS / Node 24.20.

## 1. Base64 kodek — horká cesta šifrovaného přenosu

Každá šifrovaná zpráva i každý 32 KiB chunk souboru prochází jednou
`toBase64` a jednou `fromBase64`. Původní implementace (3 kopie: `crypto.ts`,
`file-transfer.ts`, `nfc.ts`) skládala řetězec po bajtech přes callback;
dekódování `Uint8Array.from(atob(v), fn)` jde navíc přes iterátor po znacích.

Nově jediná implementace v `client/src/lib/crypto.ts`:
nativní `Uint8Array.prototype.toBase64` / `Uint8Array.fromBase64` (ES2026),
pokud je prohlížeč má, jinak blokový fallback (`String.fromCharCode.apply`
po 32 KiB, indexovaná smyčka při dekódování).

| Vstup                      | kódování: dříve → nyní  | dekódování: dříve → nyní  |
|----------------------------|-------------------------|---------------------------|
| zpráva ~300 B              | 0,0028 → 0,0009 ms (3,0×) | 0,0110 → 0,0005 ms (21×)  |
| chunk souboru 32 KiB       | 0,277 → 0,121 ms (2,3×)   | 1,279 → 0,040 ms (32×)    |
| inline příloha 512 KiB     | 5,82 → 1,83 ms (3,2×)     | 19,23 → 0,67 ms (29×)     |

Čísla jsou pro **fallback** (Node 24 nativní API nemá). Příjem 100 MB souboru
(~3 200 chunků) tak stráví v base64 dekódování zhruba 0,13 s místo ~4,1 s
času hlavního vlákna. Nativní cesta byla ověřena na správnost v prohlížeči
(bajtová shoda s referencí do 1 MiB), její rychlost změřena nebyla.

Správnost hlídá `test/crypto.test.ts` → `toBase64 / fromBase64`: bajtová shoda
s původním kodérem na hranicích bloků (0x7fff, 0x8000, 0x8001, …), round-trip
1 MiB, chybný vstup vyhazuje výjimku.

**Reprodukce** — benchmark je samostatný skript bez závislostí; stačí porovnat
původní `bytes.forEach(b => s += String.fromCharCode(b))` /
`Uint8Array.from(atob(v), c => c.charCodeAt(0))` s funkcemi z `crypto.ts`
přes `performance.now()` s ~20 zahřívacími iteracemi.

## 2. Produkční CSS: 78,2 → 39,7 kB (−49 %)

| Soubor        | dříve               | nyní               |
|---------------|---------------------|--------------------|
| `index.*.css` | 78,15 kB / gzip 13,94 | 39,74 kB / gzip 8,58 |

Příčina: Tailwind generuje utility podle výskytu názvů tříd v
`client/src/**`. 44 shadcn/ui komponent, které nikdo neimportoval, tak do
produkčního CSS přispívalo svými třídami, přestože se nikdy nevykreslily.
Po jejich odstranění CSS kleslo na polovinu.

**Reprodukce:** `npm run build` — Vite vypíše velikosti.

## 3. Závislosti: 68 → 8 runtime

Ve dvou krocích. Nejdřív statická analýza *importů*: živý kód používal 16
z 68 runtime závislostí → odebráno 58 balíčků (52 runtime + 6 dev), strom
v lockfile 562 → 349. Potom analýza *použití* (viz §4): dalších 9 balíčků
bylo importovaných, ale nevolaných → runtime 16 → **8**. Přínos: rychlejší
`npm ci` v CI a Dockeru, menší útočná plocha dodavatelského řetězce a žádné
vynucené major migrace (zod 4, recharts 3, …) pro kód, který nikdy neběží.
První krok JS bundle **nezměnil** (neimportovaný kód se do něj nedostával);
druhý ho zmenšil o čtvrtinu.

Ověřeno, že nic z odebraného se nenačítá dynamicky: jediný dynamický import
na serveru je `web-push` (používá se); SQLite backend v `server/events.ts` je
podle vlastního komentáře no-op stub.

## 4. Klientský JS: 468 → 495 → **373 kB**

| Krok                                          | JS (raw / gzip)        |
|-----------------------------------------------|------------------------|
| výchozí stav (2.4.2)                          | 468,36 / 148,06 kB     |
| po upgradu knihoven (React 19.3 aj.)          | 501,32 / 158,21 kB     |
| + minifikátor oxc místo esbuild               | 495,21 / 153,29 kB     |
| + odstranění nepoužitých obalů šablony (2.6.0) | **372,65 / 113,25 kB** |

Nárůst v druhém řádku je z upstreamu: `react-dom-client.production.js` narostl
mezi 19.2.8 a 19.3.0 z 536 016 na 625 168 B (nezminifikováno).

Největší úspora přišla z analýzy *použití*, ne importů: aplikace byla zabalená
do `QueryClientProvider` › `TooltipProvider` › `Toaster` › hash `Router`, ale
nikdo nevolal `useQuery`, `toast()`, žádný `<Tooltip>` a router měl jedinou
trasu. Statická analýza importů je hlásila jako „použité", protože je
`App.tsx` importoval. Po odstranění: −122 kB JS (−25 %), CSS 39,7 → 33,7 kB,
runtime závislosti 16 → 8.

Další krok (neprovedeno): `React.lazy` pro modální panely.

## 5. Build a image

- `script/build.ts`: oba server bundly jedním voláním esbuild (sdílené moduly
  se parsují jednou) a souběžně s Vite. Celý build 1,48 → ~1,1 s.
- `helmet` se nově přibaluje → `dist/*.cjs` nemají **žádnou** povinnou externí
  závislost. Ověřeno spuštěním obou bundlů v prázdném adresáři bez
  `node_modules` (health, statika, admin auth).
- Runtime Docker image proto už `node_modules` nekopíruje. Úspora velikosti
  image **nebyla změřena** (Docker daemon nebyl k dispozici).
- Typecheck s TypeScript 7 (nativní kompilátor): ~0,3 s na celý projekt.

## 6. Co jsme záměrně nedělali

- **Cache odvozených klíčů.** Dřívější pokus ji přidal s odůvodněním „aby se
  klíč neodvozoval pro každou zprávu". Klíč se ale odvozuje jednou za join
  (`App.tsx`, `keyRef`), ne za zprávu — cache by nic nezrychlila, držela by
  materiál odvozený z passphrase v paměti déle a v jedné variantě (klíč jen
  podle názvu místnosti) způsobovala, že se změna passphrase neprojevila.
- **Cachování statických assetů.** Server posílá `Cache-Control: no-store` na
  všechno včetně hashovaných `/assets/*`. `immutable` cache by ušetřila
  ~153 kB (gzip) při každé návštěvě, ale `no-store` je zdokumentované
  bezpečnostní rozhodnutí (žádné stopy v diskové cache). To je volba
  provozovatele, ne optimalizace „zadarmo".
