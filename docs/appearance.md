# Vzhled, mobilní layout a Edit Mode

Vše vizuální je na **jedné obrazovce** *Menu → Vzhled* (dřív rozděleno mezi
*Nastavení* a *Šablony*). **Rychlý přístup:** hned první řádek menu ☰ má
tlačítko **Vzhled** a přepínač **Edit Mode ✓/✗** (bez rolování); v režimu
ikon v liště je přepínač ikonou s tužkou. Změny se projeví okamžitě a ukládají se jen do
zařízení (`localStorage`); styly z Edit Mode zvlášť pod
`m5cet:style-overrides:v1`.

| Záložka | Co nastavuje |
|---|---|
| **Šablona** | 6 šablon (náhled barev), rozvržení (klasické / široké / kompaktní / soustředěné), šířka chatu, zobrazení menu, efekty |
| **Písmo** | písmo rozhraní, písmo zpráv, neproporcionální písmo; velikost textu (12–22 px), velikost textu zpráv, tloušťka, řádkování, prostrkání; živý náhled |
| **Barvy** | akcent (předvolby šablony + paleta 116 barev + vlastní barva/hex, kontrast WCAG), barva mých a cizích bublin, zaoblení bublin a rozhraní, pozadí chatu (barva, obrázek, sytost, vzor mřížka/tečky/šikmé/hladké) |
| **Zobrazení** | rozpoznané zařízení a prohlížeč, vynucení layoutu telefon / tablet / počítač, celá obrazovka, instalace aplikace |
| **Editor** | Edit Mode, uložené úpravy prvků (zapnout/vypnout/smazat/otevřít), vlastní CSS, export / import JSON, vrácení posledního uložení |

## Písma

- **7 systémových** sad (nulový síťový požadavek) + **71 Google Fonts** v kategoriích
  bezpatková / patková / display / ručně psaná / neproporcionální.
- Váhy u každého písma odpovídají tomu, co css2 API opravdu servíruje (ověřeno —
  neexistující váha by shodila celý požadavek na HTTP 400). Všechna kromě
  *Orbitron* mají českou diakritiku (latin-ext); Orbitron je v seznamu označený.
- **Soukromí:** Google Fonts se stahují až po souhlasu (tlačítko *Povolit Google
  Fonts*) — Google při tom vidí IP adresu. Náhledy se načítají líně (jen řádky
  v zorném poli). *Zakázat Google Fonts* odebere všechny načtené styly.
- CSP to povoluje (`style-src https://fonts.googleapis.com`, `font-src
  https://fonts.gstatic.com`) v `server/index.ts` i v
  [`deploy/nginx/m5cet.conf`](../deploy/nginx/m5cet.conf).

## Mobilní zařízení (iPhone, Android) přes celou obrazovku

`client/src/lib/device.ts` ještě před prvním vykreslením rozpozná zařízení
(UA + detekce vlastností: iPadOS 13+ se hlásí jako Mac, dotyk se měří) a zapíše
na `<html>`:

```
data-os="ios|ipados|android|windows|macos|linux|chromeos"
data-browser="safari|chrome|firefox|edge|samsung|opera|webview"
data-engine="webkit|blink|gecko"   data-form="phone|tablet|desktop"
data-input="touch|mouse"   data-standalone="yes|no"   data-fullscreen="yes|no"
data-keyboard="open|closed"   + --app-h / --app-top / --kb (visualViewport)
```

Na tom staví [`client/src/mobile.css`](../client/src/mobile.css):

- **iOS klávesnice:** Safari při otevřené klávesnici nezmenší layout viewport a
  `100dvh` ji ignoruje → aplikace je přišpendlená na *visual viewport*
  (`--app-h`, `--app-top`), pole pro psaní zůstává nad klávesnicí. Android Chrome
  to řeší sám (`interactive-widget=resizes-content` ve viewport meta).
- **Výřez a home indikátor:** opravena chyba, kdy záložní `.safe-*` pravidla
  přebíjela `env(safe-area-inset-*)` — vložky se na iPhonu nikdy neuplatnily.
- **Bez zoomu při psaní** (iOS: pole ≥ 16 px), bez rubber-bandu / pull-to-refresh,
  cíle dotyku 44 px, akce zpráv viditelné i bez hoveru.
- **Dialogy jako spodní panely** na telefonu (úchyt, bezpečné okraje, velikost
  podle visual viewportu); při psaní na telefonu se schová informační lišta.
- **Celá obrazovka:** tlačítko v liště (Android, iPad, dotykové počítače) přes
  Fullscreen API; iPhone ho nemá — tam *Sdílet → Přidat na plochu* (manifest
  `display: standalone`, průhledný status bar). Chromium nabídne i *Nainstalovat
  aplikaci*.
- `theme-color` sleduje šablonu (lišta prohlížeče), `color-scheme: only …` brání
  vynucenému tmavému režimu Samsung Internet / Chrome.

## Edit Mode — úprava libovolného prvku

Zapíná se přepínačem **Edit Mode** (zelená fajfka ON / červený křížek OFF)
v hlavičce obrazovky Vzhled nebo v záložce Editor. Výběr prvku:

| Ovládání | Gesto |
|---|---|
| myš | **Ctrl + pravé tlačítko** na prvek (se stisknutým Ctrl se prvek pod kurzorem zvýrazní) |
| dotyk | **dlouhý stisk** (≈0,5 s; posun prstu ruší — scroll funguje dál; následný „klik" se nevykoná) |
| obojí | **⌖** v inspektoru a pak klepnout na prvek |

Inspektor (vpravo/vlevo ukotvený panel, na telefonu spodní panel s úchytem):

- **Styly** — rozsah: *jen tento prvek* (stabilní selektor ukotvený na
  test-id / id / sémantickou třídu, nikdy holá značka), *podle test-id*, *třída*,
  *kombinace tříd*, *všechny prvky značky* nebo vlastní selektor s počtem shod;
  **stav**: normal, `:hover`, `:active` (klik), `:focus`, `:focus-visible`,
  `:focus-within`, `:visited`, `:link`, `:checked`, `:disabled`, `::before`,
  `::after`, `::placeholder`, `::selection` … i vlastní pseudotřída; **platí
  pro**: všechna zařízení / telefon / tablet / počítač / dotyk / myš;
  `!important`. Deklarace jako řádky (validace `CSS.supports`, šipky ↑/↓
  mění čísla, výběr barvy) nebo jako **zdroj** s čísly řádků. Rychlé úpravy
  (barvy, velikost, tloušťka, písmo, zaoblení, odsazení, průhlednost, skrýt).
  **CSS pravidla prvku** = zdrojový kód jeho tříd (včetně `:hover` apod.
  variant a `@media`), každé lze *Upravit zdroj* — vznikne přepis stejného
  selektoru, který se načítá jako poslední, takže vyhraje.
- **Třídy** — odebrat / vrátit třídu, vyhledat libovolnou třídu definovanou
  v aplikaci (s náhledem jejího CSS) a přidat ji, nebo vytvořit novou.
- **Box** — box model (margin / border / padding / obsah) a vypočtené hodnoty;
  kteroukoli lze přidat do pravidla.
- **Změny** — neuložené i uložené úpravy, vypnutí, smazání, vrácení.

Úpravy mají **živý náhled**; *Uložit* (Ctrl/⌘+S) je zapíše natrvalo, *Zahodit*
vrátí uložený stav, *Ukončit* vypne Edit Mode (s dotazem na neuložené změny).

**Bezpečnost:** inspektor běží ve vlastním Shadow DOM — žádné uživatelské CSS
ho nerozbije. Ukládané CSS se čistí: žádný `@import`, žádné `url()` mimo
`data:`, žádné `</style>`, omezené velikosti. **Nouzové vypnutí** všech úprav
pro jedno načtení: přidejte `?nostyles` do adresy.

## Verze a nasazení

Patička menu ☰ i *Vzhled → Zobrazení* ukazují `M5cet <verze> · build <commit>`
(`-dirty` = sestaveno s necommitnutými změnami). Server totéž vrací
v `/api/health` (`version`, `build`, `builtAt`) a build zapisuje do
`dist/public/build.json`. Karta otevřená před nasazením nové verze to pozná
(při návratu do karty, focusu a každých 10 min) a nabídne **Obnovit**.

```bash
curl -s https://chat.example.org/api/health    # která verze na serveru opravdu běží
```

## Soubory

| Soubor | Účel |
|---|---|
| `client/src/components/AppearancePanel.tsx` | obrazovka Vzhled (líně načítaná) |
| `client/src/components/FontPicker.tsx`, `ColorField.tsx` | výběr písma, barevná paleta |
| `client/src/components/StyleInspector.tsx` + `inspector.css` | inspektor Edit Mode (Shadow DOM, líně načítaný) |
| `client/src/lib/style-overrides.ts` | model úprav: parsování, čištění, generování CSS, export/import |
| `client/src/lib/style-editor.ts` | běh: vložení stylopisu, úpravy tříd, výběr prvku, dohledání pravidel |
| `client/src/lib/device.ts`, `client/src/mobile.css` | detekce zařízení, visual viewport, celá obrazovka, mobilní layout |
| `client/src/lib/fonts.ts`, `color.ts`, `themes.ts` | katalog písem, barvy a paleta, aplikace typografie/barev |
