# M5cet — Editor TSA (Telephony & SIP Applications, 6.9)

Konzole › *Telephony & SIP* › *TSA* › **Upravit**. TSA (Telephony & SIP
Application) je průběh hovoru nakreslený jako graf nástrojů — co volající
slyší, co na klávesnici napíše nebo řekne a kam hovor pokračuje. Editor je
celoobrazovkové okno nad konzolí (`admin-ui/public/tsa-editor.js` +
`tsa-editor.css`, ikony `tsa-editor-icons.js`), které stránka telefonie otevírá
voláním `window.M5TsaEditor.open(id, { onClose })`.

Paletu nástrojů editor nikdy nemá „natvrdo“: bere ji z
`GET /admin/telephony/tsa/catalog` (zdroj je `server/telephony/tsa/catalog.ts`),
takže nový nástroj na serveru se v editoru objeví sám — se svou ikonou,
tvarem, barvou, porty i parametry.

## Rozložení okna

| Část | Co tam je |
|---|---|
| **Horní lišta** | zpět (zavřít), název a popis TSA (píše se přímo do lišty), id, stav *Uložený / Neuložený koncept* a *Publikováno vN* (s poznámkou „draft differs“, když se koncept od publikované verze liší), Zpět / Znovu, **Save draft**, **Validate**, **Publish**, **Simulate**, Export, skrýt paletu / inspektor, klávesové zkratky |
| **Paleta** (vlevo) | skupiny katalogu (Call, Audio, Input, Logic, Integration), hledání, u každého nástroje krátký popis; po najetí myší nápověda s porty |
| **Plátno** (uprostřed) | mřížka s přichytáváním, posun, zoom, výběr obdélníkem, minimapa, rozmístění (*Arrange*) |
| **Problémy** (pod plátnem) | výsledek kontroly — počet chyb a varování, seznam; klik vybere uzel nebo drát |
| **Inspektor / Simulátor** (vpravo) | nastavení vybraného nástroje, drátu, víc nástrojů nebo celé TSA; druhá záložka je simulátor hovoru |

## Nástroje a porty

Každý nástroj je uzel s hlavičkou (ikona, popisek, typ) a řádkem s tím
nejdůležitějším z parametrů (vzorec, text, počet číslic…). Barva a tvar
pocházejí z katalogu: **Condition** je dlouhý obdélník, **Start**, **Hang up**
a **Break** jsou „pilulky“.

| Port | Kde | Pravidlo |
|---|---|---|
| tok dovnitř `in` | levý okraj | může do něj vést libovolný počet drátů (menu, které se ptá znovu, konec těla smyčky) |
| výstupy toku | spodní okraj (`next`, `on_true` / `on_false`, `on_success` / `on_code_error` / `on_failed`, `on_timeout`, `body` / `done`, `case_<n>` / `default`…) | z každého vede **nejvýš jeden** drát |
| datové vstupy | horní okraj — dynamické `IN1 … IN<n>` a pevné (`KEY` u Route audio) | do každého vede **nejvýš jeden** drát |
| datové výstupy | pravý okraj (`digits`, `text`, `value`, `from`…) | libovolný počet drátů |

Dráty toku jsou plné (barva podle výstupu: zelená pro úspěch / `on_true`,
oranžová pro `on_false` / `on_timeout` / `on_code_error`, červená pro
`on_failed`), datové dráty jsou fialové čárkované. Editor nepustí nic, co
kontrakt (`server/telephony/tsa/types.ts`) zakazuje — výstup toku do datového
vstupu, data do `in`, dva výstupy nebo dva vstupy spolu, vlastní výstup do
vlastního vstupu — a řekne proč. Když táhnete z portu, svítí jen porty, kam
drát smí; nový drát do obsazeného datového vstupu (nebo z obsazeného výstupu
toku) **nahradí** ten starý (oznámí to a Ctrl/⌘+Z ho vrátí).

### Dynamické vstupy (IN1 … IN100)

Nástroje s dynamickými vstupy (Condition, TTS, Formula, Text, Set, While,
SMS, HTTP, Function…) mají nad uzlem ovládání **− IN n +** (objeví se po najetí
nebo výběru) a stejné tlačítka v inspektoru. Meze (min / max, počáteční počet)
jsou z katalogu, strop 100. Odebráním vstupu zmizí i jeho drát.

Vstupy se používají jako `IN1`, `IN2`… ve **vzorcích** (Condition: `(IN1 == IN2)`,
`(IN1 == 0 and IN2 > 2)`, `contains(IN1, "ano")`, `len(IN1) >= 4`) a jako
`{IN1}`, `{IN2}`… v **textech** (TTS: „Váš kód je {IN1}.“). K tomu `$proměnná`
(z nástroje Set) a `{call.from}`, `{call.to}`, `{call.did}`.

### Switch

Řádky parametru *Cases* jsou výstupy `case_1`, `case_2`… (a `default`). Dráty
jdou s řádky: přejmenovaný řádek si drát nechá, smazaný ho odebere, posunutý
(šipky) ho vezme s sebou.

## Inspektor

* **Nic nevybráno** — název, popis, štítky TSA, stav konceptu a publikace,
  počty nástrojů / drátů proti limitům, krátký návod.
* **Nástroj** — popisek na plátně, id (přejmenování — dráty jdou s ním),
  poznámka; datové vstupy s tím, odkud jsou napojené (× drát odebere,
  *Wire…* ho začne kreslit), **parametry** a výstupy.
* **Drát** — odkud kam a co znamená; smazání.
* **Víc nástrojů** — seznam, zarovnání vlevo / nahoru, duplikace, kopie, smazání.

Parametry podle druhu (`kind` v katalogu):

| Druh | Ovládání |
|---|---|
| `text`, `digits` | řádek; u šablon tlačítka pro vložení `{IN1}`…; `digits` hlídá znaky klávesnice (0–9 * # A–D, `w` = půl vteřiny pauzy) |
| `textarea` | víceřádkový text s nápovědou dostupných `{IN<n>}`, počítadlem znaků a varováním, když text odkazuje na vstup, který nástroj nemá |
| `number` | číslo s mezemi z katalogu; hodnota mimo meze se neuloží a pole zčervená |
| `bool` | přepínač |
| `select`, `key` | výběr (`key`: `#`, `*`, `none`, `any`) |
| `formula` | vzorec s okamžitou kontrolou (závorky, uvozovky, `=` místo `==`, neexistující `IN<n>`) a s odpovědí serveru z `/validate`; tlačítka pro vstupy, proměnné a funkce |
| `list` | seznam řádků: přidat, upravit, posunout, odebrat |
| `voice` | hlas: u poskytovatele „AI & speech“ nabídne hlasy modelů převodu textu na řeč z `GET /admin/ai`, jinak běžná jména hlasů operátora (lze psát cokoli) |
| `tsa`, `trunk`, `model` | výběr z `GET /admin/telephony/tsa`, `GET /admin/telephony/sip/trunks`, `GET /admin/functions` (když seznam nepřijde, napíše se id) |

Parametr s podmínkou `when` se zobrazí jen tehdy, když jiný parametr má danou
hodnotu (např. *SIP trunk* jen při *Route through = a SIP trunk*, *Pitch* jen
u AI hlasu, *File* jen u zdroje *file*).

## Kontrola a problémy

Po každé změně (s krátkým zpožděním) editor pošle koncept na
`POST /admin/telephony/tsa/:id/validate` a ukáže odpověď: odznak s počtem
chyb / varování na uzlu, červený drát, zvýrazněný port, seznam pod plátnem a
hlášku přímo u parametru. Když server neodpoví, proběhne základní kontrola v
prohlížeči (jeden Start, povinné parametry, vzorce, nenapojený `KEY`, nástroje,
kam nic nevede) — a seznam to přizná („checked in the browser“).

**Publish** nejdřív uloží koncept, znovu zkontroluje a s chybou nepustí dál;
po potvrzení zavolá `POST …/publish` — hovory od té chvíle běží novou verzí.

## Ukládání a místní kopie

* **Save draft** (Ctrl/⌘+S) — `PUT /admin/telephony/tsa/:id` s `{ name,
  description, graph, tags }`; graf je přesně tvar kontraktu (`TsaGraph`:
  uzly `id, type, x, y, w?, label?, note?, inputs?, params`, dráty `id, from,
  to, kind`), nic z editoru navíc.
* **Místní kopie** — neuložený koncept se průběžně ukládá do úložiště prohlížeče
  (`m5cet:tsa-draft:<id>`). Při dalším otevření editor nabídne *Restore* /
  *Discard* (a upozorní, když se mezitím změnil koncept na serveru).
  6.10 (G-15): kopie i schránka (C / V) jsou v `sessionStorage` — jen v této kartě,
  zmizí jejím zavřením a **odhlášením z konzole** — a bez hodnot hlaviček nástroje
  HTTP, které vypadají jako tajemství (zůstane `Authorization: `; banner to řekne).
  Kopie, které 6.9 nechala v `localStorage`, editor při otevření převezme a odtud smaže.
* **Tajemství v hlavičkách** — pole *Headers* hned upozorní na doslovné tajemství
  (JWT, `Bearer/Basic …`, hodnota hlavičky typu `Authorization`, `Cookie`, `*-Key`,
  `*-Token`); server to hlásí jako chybu a TSA nepublikuje. Patří do prostředí
  serveru jako `TSA_SECRET_<JMÉNO>`, do hlavičky `{secret:JMÉNO}`.
* **Zavření s neuloženými změnami** se zeptá: *Keep editing*, *Discard*,
  *Save draft*. I zavření prohlížeče se zeptá.
* **Export** stáhne uložený koncept (`GET …/export`) jako JSON.

Bez práva *tsa* (Modules & groups › Telephony & SIP) je editor jen pro čtení:
dá se prohlížet a simulovat, ne ukládat ani publikovat. Simulátor potřebuje
právo *test*.

## Simulátor

Záložka **Simulator** (nebo *Simulate* v liště) je telefon v prohlížeči —
bez operátora a bez poplatků. *Call* uloží případné změny konceptu a zavolá
`POST /admin/telephony/sim` (`{ tsa, draft: true, from, to }`); každá odpověď je
jeden tah hovoru (`SimTurn`):

* **Co volající slyší** — bubliny s textem; text se přečte hlasem prohlížeče
  (speechSynthesis, v jazyce tahu), zvuk v `data:` URL nebo adresa se přehraje,
  pípnutí / tón se vygeneruje. Tlačítkem ▶ se dá přehrát znovu, reproduktor
  simulátor ztlumí.
* **Na co TSA čeká** — stav nahoře (např. *Waiting for up to 4 digits · # ends*)
  a k tomu ovládání:
  * **klávesnice 0–9 * #** (i z klávesnice počítače) — číslice se sbírají do
    počtu nebo do ukončovací klávesy, pak odejdou jako `{ kind: "digits" }`;
    stisk během hlášení ho přeruší,
  * **řeč** — napsat větu (Enter) → `{ kind: "speech", text }`, nebo nahrát z
    mikrofonu (WAV 16 kHz mono jako `data:` URL), nebo bez mikrofonu poslat
    testovací tón,
  * **nahrávání** — mikrofon; ukončovací klávesa nahrávání ukončí,
  * **vytáčení / směrování** — tlačítka výsledku (*answered*, *busy*, …;
    *Routed*, *Wrong code*, *Cannot route*),
  * **timeout** — tlačítko, nebo zapnuté *real timeouts* (odpočet podle TSA),
  * **Hang up** — `{ kind: "hangup" }`.
* **Plátno** — běžící uzel svítí zeleně, prošlé uzly mají ✓ a prošlé dráty se
  „hýbou“ (z `GET /admin/telephony/sim/:session` — stopa sezení).
* **Trace** — kroky tahu a akce volajícího s časem; *Session trace* ukazuje
  stopu ze serveru a klik na položku vybere uzel.

## Klávesové zkratky

| Klávesa | Co dělá |
|---|---|
| Delete / Backspace | smaže vybrané nástroje nebo drát |
| Ctrl/⌘+Z, Ctrl/⌘+Y (i Ctrl/⌘+Shift+Z) | zpět, znovu |
| C, V | kopírovat, vložit (i do jiné TSA v téže kartě prohlížeče) |
| D | duplikovat výběr |
| Ctrl/⌘+X | vyjmout |
| A | ukázat vše |
| Ctrl/⌘+A | vybrat vše |
| šipky | posun výběru o 10 px (Shift: 50 px); bez výběru posun plátna |
| + / − / 0 | přiblížit, oddálit, 100 % |
| Ctrl/⌘ + kolečko | zoom k ukazateli (samotné kolečko posouvá) |
| mezerník + tažení | posun plátna |
| Shift + tažení | výběr obdélníkem (nebo přepnout tažení pozadí v rohu plátna) |
| Shift / Ctrl / ⌘ + klik | přidat do výběru / odebrat z výběru |
| Enter na portu | vybrat port, pak Enter na druhém portu je propojí |
| Esc | zrušit kreslený drát, zavřít hledání, zrušit výběr |
| Ctrl/⌘+S | uložit koncept |
| 0–9 * # | vytáčení v simulátoru, když TSA čeká na číslice |
| dvojklik na plátno | přidat nástroj na to místo |
| ? | přehled zkratek |

Přetažení drátu do prázdna nabídne nástroj, který se na to místo přidá už
napojený. Táhnutím napojeného datového vstupu se jeho drát přesune; puštěním
do prázdna se smaže.

## Pro vývojáře

`window.M5TsaEditor.open(id, { onClose })` vrací (Promise) ovladač otevřeného
editoru: `graph()`, `isDirty()`, `addNode(type, x, y)`, `connect(from, to)`,
`setInputs(id, n)`, `setParam(id, key, value)`, `select(ids)`, `undo()`,
`redo()`, `save()`, `publish()`, `validate()`, `problems()`, `simulate()`,
`sim()`, `press(key)`, `say(text)`, `close(force)`. `onClose` dostane
`{ id, saved, published, tsa }`. `M5TsaEditor.current()` vrací ovladač
otevřeného editoru, `M5TsaEditor.close(force)` ho zavře.

Prvky se staví v kódu (DOM a SVG uzly, `textContent`), nikdy z HTML řetězců;
CSP konzole (`script-src 'self'`) platí. Rozměry uzlů a polohy portů se
počítají (neměří), takže dráty, minimapa i testy (`test/tsa-editor.test.ts`,
happy-dom) fungují bez rozvržení stránky. Ikony nástrojů generuje
`node script/gen-tsa-editor-icons.mjs` z lucide-react — po přidání nástroje s
novou ikonou ho spusťte znovu.
