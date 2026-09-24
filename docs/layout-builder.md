# M5cet — Layout builder (GUI designer, 4.0.5)

Konzole › *Layout builder*. Správce navrhuje vzhled a rozvržení aplikace pro
**všechny klienty**: lištu nahoře, okno chatu, příchozí / odchozí / systémové
zprávy, pole pro psaní a widget příjemců. Od 4.0.5 jsou tyto části aplikace
**stromy prvků** (data) — výchozí stromy vykreslují přesně to, co dřív
vykresloval kód (ověřeno porovnáním DOM starých a nových komponent ve
~250 situacích a hlídáno snímky v `test/layout-snapshots.test.tsx`). Menu má
svůj vlastní [Menu builder](site/index.html#menu-builder).

## Rozvržení (layouts)

| id | Co to je | Živé části (sloty) |
|---|---|---|
| `header` | lišta nahoře: logo, stav spojení, přepínač připojení, účet, menu, celá obrazovka | `signedIn`, `menu` |
| `chat` | okno pod lištou: informační pruh, konverzace, prázdný stav | `transfer`, `message`, `composer` |
| `message.in` | zpráva od někoho jiného | `badge` (odznak odesílatele) |
| `message.out` | moje zpráva | — |
| `message.sys` | systémové oznámení | — |
| `composer` | psaní a odeslání | `recorder`, `sendOptions` |
| `widget` | plovoucí panel příjemců | — |
| `widget.fab` | minimalizovaný widget (tlačítko) | — |

Každé rozvržení má **kontrakt** (`client/src/lib/layouts/contracts.ts`):
hodnoty, které mu komponenta dává (`$message`…, `$peers`, `$room`…), akce,
které smí spustit (`reply`, `toggleEmoji`, `togglePeer`…), živé části a refy.
Builder nabízí přesně tyto položky.

## Paleta prvků

| Skupina | Prvky |
|---|---|
| Rozložení | Panel (`div`, `section`, `header`, `footer`, `nav`, `aside`, `article`…), Area (`span`, `strong`, `em`, `small`, `code`…), Row (flex řádek), Column (flex sloupec), Grid, List (`ul`/`ol`), List item, Group (bez vlastního prvku — pro podmínku nebo opakování) |
| Text a média | Text (šablona bez prvku; formát `links` udělá z adres odkazy), Heading `h1`–`h6`, Paragraph, Label, Link, Icon (207 ikon lucide, název může být šablona), Image, Audio, Logo, Avatar, HTML (bezpečné HTML), Separator |
| Ovládání | Button, Input (typy text, password, email, number, search, tel, url, date, time, color, range, checkbox, radio, file…), Text area, Select + Option, Form |
| Logika | App part (slot — živá část, kterou kreslí aplikace), Template (znovupoužitelná šablona prvků) |

Panel, Area, Row, Column, Grid, List, Button, Link, Label, Form… mohou
obsahovat další prvky — libovolně vnořené.

## Nastavení prvku

- **Tag** (našeptává povolené tagy prvku), **ID**, **jméno ve stromu**, skrytí.
- **Text** — šablona jazyka menu: `{$room}`, `{_'menu.room'}`,
  `{if $connected}…{else}…{/if}`, `{$name|upper}`, `{$state|t:'msginfo.state.'}`.
- **Třídy** — našeptávač tříd, které **opravdu existují** ve stylech aplikace
  (Tailwind generuje jen použité třídy; seznam se čte z `dist/public/assets/*.css`).
- **Atributy** — názvy podle tagu (`type`, `placeholder`, `aria-*`,
  `data-testid`…) a jejich hodnoty (`input.type`: text, password, number…;
  `role`, `target`, `autocomplete`, `inputmode`…). Hodnota je šablona, nebo
  výraz po `=`: `=$openPeerCount == 0`, `=$private ? '1' : null`
  (`null` atribut vynechá).
- **CSS** — 114 vlastností s hodnotami (a vlastní proměnné `--jméno`) (`display`: block, flex, grid,
  contents…; `position`, `justify-content`, `align-items`, barvy šablony…);
  hodnota může obsahovat `{$proměnnou}`. Zakázáno: `url()`, `expression()`,
  `@import`, `javascript:`.
- **Styl a stavy** — stejný editor jako v Menu builderu: písmo, barvy,
  zarovnání, obtékání, odsazení, rámeček, stín… a totéž pro **hover, click,
  focus, current**.
- **Logika** — *zobrazit jen když* (výraz), *opakovat pro každou položku*
  (`$peers` jako `$p`, klíč `$p.id`, `$iterator.counter`), *CSS z dat*
  (objekt, který spočítá aplikace — barvy bubliny, poloha widgetu), *ref*,
  **události → akce** (`click` → `reply`, `change` → `input`…, s argumentem).

Každé pole **našeptává během psaní** (šipky, Enter / Tab, Esc). Tlačítko
*? Help* je plovoucí okno s hodnotami, akcemi, částmi, filtry, makry,
výrazy a popisem prvků; klepnutí vloží ukázku do pole, ze kterého bylo
otevřeno.

## Práce se stromem

Přetažení z palety do stromu (dovnitř / před / za prvek), přesouvání ve
stromu, *Alt+↑/↓*, duplikace, zabalení do panelu, rozbalení, skrytí,
smazání, kopírovat / vložit (i mezi rozvrženími), zpět / znovu
(*Ctrl+Z*), export / import JSON. Klepnutí v náhledu vybere prvek; režim
*click tries it* náhled ovládá (otevře emoji, přepne příjemce…).

**Šablony** (*Save as template*): vybraný prvek se uloží jako šablona;
z palety (*My templates*) se vkládá propojeně (změna šablony se projeví
všude) nebo jako kopie. Šablona dostane argument jako `$arg`.

## Náhled

Náhled je **aplikace sama**: `layout-preview.html` (druhý vstup buildu) se
skutečnými komponentami, CSS a šablonami, s ukázkovými lidmi a zprávami.
Konzole mu posílá rozpracovanou konfiguraci (`postMessage`, jen stejný
původ), náhled vrací výběr prvku a chyby výrazů. Situace (varianty) podle
rozvržení, šablona vzhledu (13), tón, jazyk, šířka (desktop / tablet /
telefon). Admin služba podává `layout-preview.html` s
`frame-ancestors 'self'` a `/assets` z `dist/public`.

## Texty a chování

Záložka *Texts & behaviour* drží dřívější nastavení: krátké texty
(`systemHeader`, `incomingMeta`, `outgoingMeta`, `composerPlaceholder`,
`widgetTitle`, `chatEmptyTitle`, `chatEmptyBody` — zástupné parametry
`{{jméno}}`, includes `{{> jméno}}`), co zprávy ukazují (avatary, čas, zámek,
odpovědět / přeposlat, logo, datum, sbalování systémových zpráv) a rychlé
barvy komponent (CSS proměnné `--c-<komponenta>-…`). Rozvržení tyto texty
používají jako hodnoty (`$headerText`, `$timeLabel`, `$placeholder`,
`$title`, `$emptyTitle`, `$emptyBody`).

## Uložení a API

`LAYOUT_DATA_FILE` | `$DATA_DIR/layout.json` | `./.m5cet/layout.json`
(atomický zápis, `0600`). Uloží se jen rozvržení, která se liší od
výchozích (`layouts.<id> = { tree, rev }`), a šablony (`blocks`). `rev` je
otisk výchozího stromu, ze kterého návrh vznikl — když aktualizace aplikace
výchozí strom změní, builder to u rozvržení ukáže.

- `GET /api/layout` — veřejné, pro klienty (bez tajemství); klienti si ho
  berou při startu a každých 5 minut.
- `GET /admin/layout` — konfigurace, výchozí hodnoty a **katalog** (paleta,
  atributy a jejich hodnoty, CSS, třídy aplikace, ikony, rozvržení s
  výchozími stromy, kontrakty a variantami náhledu).
- `PUT /admin/layout {layout}` (operátor; tělo do 4 MB) · `POST /admin/layout/reset`.

Validace je sdílený čistý modul `client/src/lib/layout-tree.ts` (server i
klient): známé prvky a tagy, bezpečné atributy (žádné `on*`, `style`,
`srcdoc`, `formaction`), adresy (`https:`, cesty webu, `#`, `mailto:`,
`tel:`, `data:image/…`; při vykreslení i `data:`/`blob:` z dat aplikace,
nikdy `javascript:`), CSS bez `url()` a výrazů, limity (2 500 prvků,
hloubka 40, 60 šablon). Vykreslení (`LayoutView.tsx`) nikdy nepoužívá
`innerHTML`; prvek HTML jde přes bezpečný parser.

Testy: `test/layout-tree.test.ts`, `test/layout-view.test.tsx`,
`test/layout-snapshots.test.tsx`, `test/layout-config.test.ts`, E2E
`test/e2e/admin-console.test.ts` (paleta, našeptávání, náhled, šablony,
uložení a vykreslení v aplikaci).
