# M5cet — Layout builder (GUI designer, 4.0.5 · 4.13)

Konzole › *Layout builder*. Správce navrhuje vzhled a rozvržení aplikace pro
**všechny klienty**: lištu nahoře, okno chatu, příchozí / odchozí / systémové
zprávy, pole pro psaní a widget příjemců. Od 4.0.5 jsou tyto části aplikace
**stromy prvků** (data) — výchozí stromy vykreslují přesně to, co dřív
vykresloval kód (ověřeno porovnáním DOM starých a nových komponent ve
~250 situacích a hlídáno snímky v `test/layout-snapshots.test.tsx`). Menu má
svůj vlastní [Menu builder](site/index.html#menu-builder).

**4.13:** rozvržením je celá aplikace — i okno Místnost, okna, dialogy a
panely (44 rozvržení v pěti sekcích, od 4.14 i asistent AI — 45); k tomu varianty pro skupiny uživatelů a
šablony vzhledu, historie verzí s rozdíly a návratem, třícestné sloučení
vlastního rozvržení s novým výchozím po aktualizaci aplikace, vložení HTML
jako prvků a kontrola přístupnosti.

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

Od 4.13 dalších 36 rozvržení (`client/src/lib/layouts/{windows,room,dialogs,account,settings,tools,share,phone,connections}.ts`),
v builderu v sekcích (`LAYOUT_GROUP`):

| Sekce | id |
|---|---|
| Room window | `room.tabs` (záložky v záhlaví), `room` (obsah okna Místnost; slot `share`, `needSignIn`) |
| Windows | `window` (okno panelu, `SimpleModal`), `window.large` (velké okno / šuplík, `Modal`) |
| Dialogs & parts | `part.needSignIn`, `part.signedIn`, `dialog.userInfo`, `dialog.messageInfo`, `dialog.integrity`, `part.shareResult`, `panel.share`, `panel.shareConnection`, `part.invite` |
| Panels | `panel.ai` (asistent AI, 4.14), `dialog.account`, `panel.access`, `panel.retention`, `panel.profile`, `panel.settings`, `panel.privacy`, `panel.encryption`, `panel.notifications`, `panel.analytics`, `panel.roomSecurity`, `panel.trust`, `part.peers`, `part.audio`, `part.video`, `panel.files`, `panel.location`, `panel.speech`, `panel.connection`, `panel.phone`, `panel.connections`, `part.connectionEdit`, `part.connectionDetail`, `part.connectionSettings` |

Komponenty si strom berou z `LayoutProvider` (`useLayout(id)` /
`useLayoutBase(id, lang)`): varianta pro skupiny a šablonu diváka, jinak
rozvržení operátora, jinak výchozí. Stav a logika zůstávají v komponentách
(rozvržení dostane data a akce). Výchozí stromy se staví až při prvním
použití. Převod ověřilo porovnání DOM i volaných akcí starých a nových
komponent krok za krokem; jediný záměrný rozdíl je přístupný název šesti
polí.

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

4.13: okna, okno Místnost, dialogy a panely kreslí v náhledu jejich
skutečné komponenty s ukázkovými daty (`client/src/layout-preview-parts.tsx`,
`client/src/layout-samples.tsx`) v okně, kde je ukazuje aplikace; stav, do
kterého se komponenta dostane jen používáním, si náhled „doklikne“
(`PREVIEW_STEPS`) a tato klepnutí se neberou jako výběr prvku. Nic z toho
nevolá server (`loadStatus` / `loadServerStatus` telefonie a řeči dostanou
ukázková data). V náhledu lze zvolit, jako kdo se díváte (skupiny), a
upravovaná varianta je připnutá.

## Varianty (4.13)

`layout.json` → `variants.<id> = [{ id, label, groups, themes, tree, rev }]`.
Varianta platí, když divák patří do některé ze skupin a (jsou-li zadané) má
jednu ze šablon vzhledu; bez podmínky se nekreslí. Rozhoduje první
vyhovující (pořadí *Earlier* / *Later*); nejvýš 8 na rozvržení, 40 celkem.
Klient ji vybírá sám (`layoutTree(cfg, id, { groups, theme })`).

## Historie, rozdíly, návrat (4.13)

Každé uložení, reset i návrat zapíše verzi do `layout-history.json` vedle
`layout.json` (kdo, kdy, akce, poznámka, celá konfigurace; posledních 50,
nejvýš ~12 MB; první uložení zapíše i stav před ním). Rozdíly
(`client/src/lib/layout-diff.ts`) porovnají stromy podle id prvků: přidané,
odebrané (s počtem prvků uvnitř), přesunuté a změněné prvky a pole;
u konfigurace rozvržení, varianty, šablony a texty. Návrat je sám verzí.

## Aktualizace aplikace a sloučení (4.13)

Vlastní rozvržení (i varianta) nese `rev` výchozího stromu, ze kterého
vzniklo. Všechny vydané výchozí stromy jsou v `server/layout-archive.json`
(`npx tsx script/archive-layouts.ts` po každé změně výchozích; test hlídá,
že tam je každá dnešní revize). Když se `rev` liší od dnešního, server najde
základ v archivu a sloučí třícestně (`client/src/lib/layout-merge.ts`):
podle id prvků pole, atributy / CSS / události po jednom, rodič a pořadí,
přidání a odebrání (odebrání prvku, který druhá strana změnila, je konflikt).
Bez konfliktu se sloučí při načtení a konzole to oznámí (soubor se přepíše
až uložením); s konflikty zůstává operátorovo a builder nabídne *Merge with
the new default* se seznamem konfliktů (*Use the app's*).

## Vložení HTML (4.13)

*Paste HTML* (`client/src/lib/html-to-tree.ts`, do 200 000 znaků): tolerantní
tokenizér, tagy na prvky palety (panely, oblasti, nadpisy, odstavce, odkazy,
seznamy, tabulky, obrázky, video, audio, formuláře, pole, výběry; SVG ikona
lucide z katalogu se stane ikonou), třídy a
povolené atributy zůstanou; `<script>`, `<style>`, `on*`, `style`, nebezpečné
adresy a neznámé tagy se vynechají a builder vypíše, co a proč.

## Přístupnost (4.13)

`client/src/lib/layout-a11y.ts`: `checkTree` (návrh — `img-alt`,
`control-name`, `field-label`, `click-keyboard`, `tabindex-positive`,
`heading-order`, `duplicate-id`, `link-href`, `blank-noopener`) a `checkDom`
(vykreslený náhled — přístupný název, popisky polí, kontrast WCAG 4.5:1 /
3:1 proti skutečnému pozadí se skládáním průhledných vrstev). Výsledek pod
náhledem a jako čipy ve stromu; výchozí rozvržení kontrolou procházejí.

## Výkon (4.13)

Šablony a výrazy se překládají na funkce jednou (`compileTemplate`,
`compileExpression`), strom rozvržení také (`LayoutView`: pro každý uzel
připravené čtení dat, atributy, podmínky, opakování; neměnné části se
vytvoří jednou). Filtry nad výrazem v závorce:
`{=('acc.signedInAs'|t|replace:'{name}':$userName)}`.

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
- `PUT /admin/layout {layout}` (operátor; tělo do 4 MB; zapíše verzi do historie) · `POST /admin/layout/reset`.
- 4.13: `GET /admin/layout/history` · `GET /admin/layout/history/:id` ·
  `GET /admin/layout/history/:id/diff?against=current|previous` ·
  `POST /admin/layout/history/:id/restore` · `POST /admin/layout/merge`
  (`{ layout, tree, rev }` → sloučený strom, konflikty, nový `rev`) ·
  `POST /admin/layout/from-html` (`{ html }` → prvky a varování).

Validace je sdílený čistý modul `client/src/lib/layout-tree.ts` (server i
klient): známé prvky a tagy, bezpečné atributy (žádné `on*`, `style`,
`srcdoc`, `formaction`), adresy (`https:`, cesty webu, `#`, `mailto:`,
`tel:`, `data:image/…`; při vykreslení i `data:`/`blob:` z dat aplikace,
nikdy `javascript:`), CSS bez `url()` a výrazů, limity (2 500 prvků,
hloubka 40, 60 šablon). Vykreslení (`LayoutView.tsx`) nikdy nepoužívá
`innerHTML`; prvek HTML jde přes bezpečný parser.

Testy: `test/layout-tree.test.ts`, `test/layout-view.test.tsx`,
`test/layout-snapshots.test.tsx`, `test/layout-config.test.ts`, 4.13
`test/layout-parts.test.tsx` (každé rozvržení oken, dialogů a panelů v každé
situaci náhledu a jazyce: bez chyby, bez sítě, s přístupnými názvy),
`test/layout-merge.test.ts`, `test/layout-diff.test.ts`,
`test/layout-store.test.ts`, `test/html-to-tree.test.tsx`,
`test/layout-a11y.test.tsx`, `test/menu-template.test.ts`; E2E
`test/e2e/admin-console.test.ts` (paleta, našeptávání, náhled, šablony,
uložení a vykreslení v aplikaci; varianty, historie, sloučení, HTML,
přístupnost; sekce, okno Místnost a panely).
