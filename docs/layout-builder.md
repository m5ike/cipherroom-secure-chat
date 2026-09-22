# M5cet — Layout / template builder (administrace)

Administrátor může z admin rozhraní tvarovat vzhled chatu pro **všechny
klienty**: barvy, rámečky, písmo a další vlastnosti jednotlivých komponent, a
krátké **textové šablony** se zástupnými parametry a includes. Změny se ukládají
na serveru a klienti si je stáhnou při načtení (a pak každých 5 minut).

## Komponenty

| id | Co ovlivňuje |
|---|---|
| `chat` | hlavní okno chatu (plocha konverzace) |
| `in` | příchozí zpráva |
| `sys` | příchozí **systémová** zpráva |
| `out` | odchozí zpráva |
| `widget` | widget příjemců |
| `menu` | menu (speed‑dial panel) |
| `composer` | odesílací panel |

U každé: pozadí, barva textu, barva/typ/šířka rámečku, zaoblení, velikost
písma, průhlednost, vnitřní odsazení, stín. Hodnoty se stanou CSS proměnnými
`--c-<id>-<vlastnost>` na `<html>`; [index.css](../client/src/index.css) je čte
s výchozí hodnotou ze šablony jako fallbackem — nevyplněné = vzhled šablony.

## Šablony a zástupné parametry

Krátké textové šablony (max 400 znaků). Vykreslují se **jen jako text** —
markup ani skript se k ostatním uživatelům nedostane.

| Šablona | Kde | Parametry | Výchozí |
|---|---|---|---|
| `systemHeader` | hlavička systémové zprávy | `appName`, `date`, `time`, `room` | `{{appName}} · {{date}}` |
| `incomingMeta` | meta řádek příchozí zprávy (za jménem) | `sender`, `time`, `date`, `room` | `{{time}}` |
| `outgoingMeta` | meta řádek odchozí zprávy | `sender`, `time`, `date`, `room` | `{{time}}` |
| `composerPlaceholder` | placeholder pole zprávy | `placeholder`, `room`, `peerCount` | `{{placeholder}}` |
| `widgetTitle` | titulek widgetu příjemců | `title`, `peerCount`, `room` | `{{title}}` |
| `chatEmptyTitle` / `chatEmptyBody` | prázdný stav chatu | `title` / `body`, `appName` | `{{title}}` / `{{body}}` |

**Includes:** pojmenované části (partials) vložíš přes `{{> jmeno}}`; partial
může používat parametry i další includes (hloubka max 3). Neznámý parametr se
vykreslí prázdný.

## Chování (flags)

- avatary, čas, ikona zámku, tlačítka Odpovědět/Přeposlat — zapnout/vypnout,
- **logo** (monochromatické) a **plné datum** (den, měsíc slovy, rok, čas) u
  systémových zpráv,
- systémová zpráva se po `systemCollapseAfterSec` (výchozí 60 s) **sbalí na
  první řádek**; najetí myší / klik ji rozbalí na `systemExpandForSec`
  (výchozí 20 s) a pak se zase sbalí (plynulý fade). `0` = nesbalovat.

## Testování a správa

V sekci *Layout / template builder*: **Load** (aktuální stav), živý **náhled**
všech komponent i vykreslených šablon při každé změně, **Save** (uloží a
rozešle klientům), **Reset to defaults**, **Export/Import JSON** (zálohování,
přenos mezi instalacemi).

## Uložení a API

Soubor `LAYOUT_DATA_FILE` | `$DATA_DIR/layout.json` | `./.m5cet/layout.json`
(atomický zápis, `0600`; v Dockeru volume `m5cet-data`). Admin zapisuje, appka
po změně mtime znovu načte.

- `GET /api/layout` — veřejné, pro klienty (bez tajemství).
- `GET /admin/layout` · `PUT /admin/layout {layout}` · `POST /admin/layout/reset` — Bearer `ADMIN_API_TOKEN`.

Validace je sdílený čistý modul [client/src/lib/layout-config.ts](../client/src/lib/layout-config.ts)
(server i klient): jen hex barvy, ohraničená čísla, krátké texty, max 24
partials. Testy: `test/layout-config.test.ts`, `test/format.test.ts`.
