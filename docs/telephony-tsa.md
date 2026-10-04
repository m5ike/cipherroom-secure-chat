# M5cet — Telephony & SIP Applications (TSA)

Od verze 6.9 může příchozí i odchozí hovor místo pevné hlášky projít
**TSA** — *Telephony & SIP Application*: graf nástrojů, který operátor
nakreslí ve vizuálním editoru konzole (*Telephony & SIP › TSA*) a server ho
na živém hovoru krok za krokem provádí. Co volající uslyší, co má zadat nebo
říct, kam se hovor přepojí, komu se pošle zpráva.

Routing (pravidla příchozích a odchozích hovorů, dokumentace modulu
`docs/telephony.md`) posílá hovor buď do TSA (její **publikované** verze),
nebo ho rovnou ukončí stavem (*busy*, *congestion*, *hangup*, *rejected*).

Tento dokument popisuje TSA samotné: pojmy, každý nástroj palety, vzorce a
textové šablony, jak běh funguje (tahy, čekání, limity), startovní šablony,
simulátor, API konzole a poctivá omezení.

---

## 1. Pojmy

**Uzel** je jeden nástroj z palety (Text to speech, Read DTMF, Condition…) s
parametry. Každý uzel má id (`a-z`, pak `a-z 0-9 _`, nejvýš 32 znaků), polohu
na plátně, volitelný popisek a poznámku.

**Porty** jsou dvojího druhu:

| Port | Kde | Co nese | Pravidlo |
|---|---|---|---|
| řídicí vstup `in` | vlevo | „teď běž ty" | může přijít libovolně hran (menu, které se opakuje) |
| řídicí výstupy | dole | `next`, `on_true`/`on_false`, `on_timeout`, `on_success`/`on_code_error`/`on_failed`, `body`/`done`, `case_<n>`/`default`… | z každého **nejvýš jedna** hrana |
| datové vstupy | nahoře | hodnota: dynamické `IN1 … IN<n>` (počet si uzel nastaví, 0–100) nebo pevné (`KEY` u Route audio) | do každého **nejvýš jedna** hrana |
| datové výstupy | vpravo | co uzel vyrobil (`digits`, `text`, `value`, `from`…) | libovolně hran |

Datový vstup se čte ve chvíli, kdy uzel běží: je to **poslední** hodnota, kterou
zdrojový uzel vyrobil (`null`, pokud ještě neběžel).

**Proměnné** `$jmeno` nastavuje uzel *Set variable*; platí do konce hovoru a
vidí je vzorce (`$attempts + 1`) i texty (`{$attempts}`).

**Hovor** je ve vzorcích a textech `call.from`, `call.to`, `call.did` (číslo,
na které se volalo), `call.direction` (`inbound`/`outbound`), `call.provider`,
`call.id`.

**Koncept a publikace.** Editor ukládá *koncept*. Hovory běží jen na
*publikované* verzi: publikace zkopíruje koncept (nesmí mít chyby), zvýší
`version` a tuto kopii zmrazí. Běžící hovor si drží graf, se kterým začal —
nová publikace uprostřed hovoru ten hovor nezmění.

---

## 2. Paleta nástrojů

Paleta je jedna tabulka (`server/telephony/tsa/catalog.ts`), ze které kreslí
editor, kontroluje validátor a kterou provádí runtime. `{IN1}` v textu = šablona
(kap. 4).

### Hovor

| Nástroj | Výstupy | Parametry | Co dělá |
|---|---|---|---|
| **Start** | `next`; data `from`, `to`, `did`, `direction`, `provider`, `call_id` | *Answer the call* (ano), *Default language* (cs-CZ…), *Longest call* (min., 1–240) | Kde hovor vstupuje. Právě jeden v TSA. Jazyk platí pro TTS, STT a omluvu při chybě. Bez přijetí mohou další uzly hovor ještě odmítnout stavem. |
| **Hang up / state** | — | *End as*: hangup, busy, congestion, rejected | `hangup` ukončí hovor. Stav odmítne **nepřijatý** příchozí hovor (`reject`); po přijetí už jen zavěsí. |
| **Dial / transfer** | `on_answered`, `on_busy`, `on_no_answer`, `on_failed`; data `status`, `duration` | *Destination* (číslo / SIP URI), *To* (šablona), *Route through* (odchozí pravidla / aplikace poskytovatele / SIP trunk), *SIP trunk*, *Caller ID number/name*, *Ring for* (5–120 s), *Record* | Přepojí volajícího. Přes **pravidla**: zeptá se odchozích pravidel (`telHooks.decide`, zdroj `tsa`) — stav = `on_failed`, služba SIP = vytáčí se přes trunk s jeho caller ID. Číslo musí projít oprávněními (blokované prefixy, povolené země). Caller ID bez nastavení = volané DID. Po skončení přepojeného hovoru tok pokračuje podle výsledku. |
| **Pause** | `next` | *Seconds* (0,5–60) | Ticho. |
| **Send DTMF** | `next`, `on_failed` | *Digits* (`0-9 * # A-D`, `w` = 0,5 s pauza, šablona), *Type* (RFC 2833, in-band, SIP INFO), *Tone length* | Pošle tóny do hovoru (pobočka za ústřednou, PIN). |

### Zvuk

| Nástroj | Výstupy | Parametry | Co dělá |
|---|---|---|---|
| **Text to speech** | `next`, `on_failed` | *Text to speak* (šablona), *Language*, *Speech provider* (hlas poskytovatele / AI & speech), *Voice*, *Speed*, *Pitch*, *Volume (dB)*, *Repeat*, *A key press stops it* | Řekne text. Hlas poskytovatele = akce `say`. **AI & speech** = server text nasyntetizuje (modul AI & speech, WAV), uloží na 2 hodiny do `telephony.db` a poskytovateli dá adresu `/wh/tsa/audio/<token>` (akce `play`). Prázdný text nebo selhání syntézy = `on_failed`. S *A key press stops it* a **Read DTMF hned za ním** se text stane výzvou toho sběru číslic — volající může psát, zatímco se mluví. |
| **Play audio** | `next`, `on_failed` | *Source* (URL / soubor / stream), *URL* (https, šablona), *File*, *Play for* (stream, s), *Repeat* | `url`: https adresa MP3/WAV, kterou si poskytovatel stáhne. `file`: soubor nahraný v konzoli (kap. 8), servíruje ho hlavní služba z `/wh/tsa/file/<id>`. `stream`: živý stream; po zadaném počtu sekund server hovor přesměruje dál. |
| **Record** | `next`, `on_timeout`, `on_failed`; data `url`, `recording_id`, `duration`, `digit`, `transcript` | *Longest* (1–3600 s), *End key* (# * none any), *Stop after silence*, *Beep*, *Trim*, *Transcribe*, *Transcription language* | Nahraje volajícího. Nic nenamluvil = `on_timeout`. *Transcribe*: server si nahrávku stáhne (SSRF-bezpečně; přihlášení poskytovatele dostane jen jeho vlastní doména — Twilio, Vonage) a přepíše ji přes AI & speech. Když volající zavěsí dřív, než nahrávka dorazí, zbytek toku, který volajícího nepotřebuje (zpráva do místnosti, log, HTTP), proběhne, až dorazí. |
| **Speech to text** | `next`, `on_timeout`, `on_failed`; data `text`, `confidence` | *Language*, *Recognition* (poskytovatel / AI & speech), *Longest*, *End of speech after*, *Wait for speech*, *Expected words* | Poskytovatel: `gather` s `input: ["speech"]` a nápovědou slov. AI & speech: jedna promluva se nahraje (do ticha) a přepíše. |
| **Route audio** | `on_success`, `on_code_error`, `on_failed`; data `type`, `target`; vstup **KEY** | *One use only*, *Say when connected* (šablona), *When nobody can take audio* (on_failed / textový režim) | KEY = kód 4–6 číslic. Hledá se v tabulce inroute (`telHooks.inroute.lookup`). Špatný formát, neznámý nebo prošlý kód = `on_code_error` (počítá se). Platný kód → média (`telHooks.routeAudio`) vrátí akce, které zvuk propojí oběma směry do místnosti nebo k členovi; `on_success` následuje, až propojený zvuk skončí. Nejde propojit (nikdo připojený, poskytovatel neumí stream, chybí mediální část) = `on_failed`. |

**Počítání špatných kódů.** V jednom hovoru nejvýš
`permissions.inroute.maxAttemptsPerCall` (výchozí 3) — pak už Route audio kódy
nebere (rovnou `on_code_error`). Za hodinu z jednoho čísla volajícího nejvýš
`maxFailuresPerCallerPerHour` (10), pak je číslo na zbytek hodiny odmítáno.
*One use only* si použitý kód pamatuje (do jeho vypršení) a podruhé ho odmítne.
Kód je v logu vždy maskovaný (`••••56`).

### Vstup

| Nástroj | Výstupy | Parametry | Co dělá |
|---|---|---|---|
| **Read DTMF** | `next`, `on_timeout`; data `digits` | *Max digits* (1–32), *Termination key* (# * none any), *Timeout* (s, na první i mezi číslicemi), *Prompt* (šablona), *Ask again on timeout* (0–5) | Čeká na číslice. Ukončovací znak do výsledku nepatří. Bez číslice se zeptá znovu (stejná výzva) tolikrát, kolik je nastaveno, pak `on_timeout`. |

### Logika

| Nástroj | Výstupy | Parametry | Co dělá |
|---|---|---|---|
| **Condition** | `on_true`, `on_false` | *Formula* | Dlouhý obdélník; vstupy `IN1 … IN<n>` na horní hraně. Vzorec rozhodne (`IN1 == IN2`, `IN1 == 0 and IN2 > 2`, `contains(IN1, "ano")`). |
| **Switch** | `case_1 … case_<n>`, `default`; vstup `IN1` | *Cases* (řádek = případ), *Match* (equals / contains / starts with), *Ignore case and accents* | IVR menu: první shodný případ. Čísla se porovnávají číselně (`"01"` = `1`). |
| **For** | `body`, `done`; data `index` | *From*, *To*, *Step* (vzorce nad vstupy) | `body` pro každé `index` od–do (včetně), krok může být záporný. |
| **While** | `body`, `done`; data `index` | *While* (vzorec), *Max rounds* (1–1000) | Vzorec se vyhodnotí před každým kolem (vstupy znovu načtené). |
| **Break** | — | — | Opustí nejvnitřnější smyčku přes její `done`. Mimo smyčku ukončí tok. |
| **Set variable** | `next`; data `value` | *Variable*, *Value* (vzorec) | `$jmeno = hodnota` do konce hovoru. |
| **Formula** | `next`; data `value` | *Formula* | Spočítá hodnotu. |
| **Text** | `next`; data `text` | *Template*, *Read numbers digit by digit* | Poskládá text; „po cifrách": `1234` → `1 2 3 4` (pro TTS). |
| **Opening hours** | `on_true` (open), `on_false` (closed) | *Time zone*, *Days* (`mon-fri`, `sat`, `mon,wed,fri`, i přes víkend `fri-mon`), *From*, *To* (i přes půlnoc 22:00–06:00), *Closed on* (`2026-12-24`, nebo `12-25` každý rok) | Otevřeno / zavřeno. |

**Smyčky.** Když cesta z `body` skončí (řídicí výstup bez hrany), řízení se
vrátí do nejvnitřnější běžící smyčky a ta pokračuje dalším kolem. Smyčka, do
které tok vstoupí znovu přes její `in`, začíná od začátku. Smyčky se mohou
vnořovat; čekání (Read DTMF, Record…) uvnitř smyčky je v pořádku — stav smyček
se ukládá se session.

### Integrace

| Nástroj | Výstupy | Parametry | Co dělá |
|---|---|---|---|
| **Send SMS** | `next`, `on_failed` | *To* (výchozí `{call.from}`), *Text*, *From* | SMS cestou enginu (`m5.telephony` — výchozí SMS poskytovatel). Číslo musí projít oprávněními; jedna TSA nejvýš `permissions.outbound.smsPerHour` SMS za hodinu. |
| **Message to a room** | `next`, `on_failed` | *Where* (místnost / místnost inroute kódu z `IN1`), *Room* (slepé id `r3.…`), *Only to member*, *Text* | Oznámení serveru do místnosti (jako zpráva operátora; není koncově šifrované). `on_failed`, když v místnosti nikdo není připojen (oznámení se neukládají) nebo když uzel běží mimo hlavní službu. Člen: `p-…` = id peeru, jinak jméno (`@` se ignoruje). |
| **HTTP request** | `on_success` (2xx), `on_failed`; data `status`, `body`, `json` | *Method*, *URL* (https, šablona — dosazené hodnoty se URL-kódují), *Headers* (`Jméno: hodnota`, `{secret:JMENO}`), *Body*, *Timeout* (1–15 s) | Jen https, jen hosté z `permissions.tsa.httpHosts` (přesně, nebo `*.example.com` = poddomény); prázdný seznam = nástroj vypnutý. Požadavek jde přes SSRF-bezpečného klienta Functions (žádné privátní adresy, připnutí DNS), přesměrování se odmítá, odpověď nejvýš 256 kB. JSON čte vzorec: `get(IN1, "customer.name")`. |
| **Run function** | `next`, `on_failed`; data `result` | *Model*, *Timeout* (1–60 s) | Spustí vstupní bod `execute` modelu Functions se vstupy `{ in1, in2, …, call }`; model vidí `m5.caller.kind = "telephony"` (není to osoba — platí granty modelu *Beyond the caller*). Vypíná `permissions.tsa.functions`. |
| **Number info** | `next`; data `country`, `type`, `national`, `e164`, `valid`; vstup `IN1` | — | Offline z vestavěných číslovacích plánů (bez placeného lookupu). Bez `IN1` = volající. |
| **Add route code** | `next`, `on_failed`; data `code`, `expires` | *Code* (prázdné = náhodný), *Digits*, *Route to* (místnost / člen), *Room*, *Member*, *Valid for* (s) | Jako `m5.telephony.inroute.add` (`telHooks.inroute.add`), `createdBy: { kind: "tsa" }`. TTL nejvýš `permissions.inroute.maxTtlSec`. |
| **Log** | `next` | *Level*, *Text* | Řádek do logu modulu (*Telephony › Log*, druh `tsa`). |

---

## 3. Vzorce

Bezpečný jazyk napsaný ručně (tokenizer, parser, vyhodnocovač) — nikdy `eval`,
žádné regulární výrazy ze vstupu, žádný přístup k prototypům.

```text
IN1 == IN2                       (IN1 == 0 and IN2 > 2)
$attempts + 1                    len(digits(IN1)) >= 4
contains(lower(IN1), "podpor")   startswith(call.from, "+420")
get(IN1, "customer.vip") == true round(IN1 / 60, 1)
hour() >= 8 and weekday() <= 5   substr(IN1, -4)
```

**Hodnoty:** čísla (`12`, `2.5`, `1e3`), texty (`"…"` nebo `'…'`, únik `\"`,
`\n`), `true`, `false`, `null`, vstupy `IN1 … IN100` (i `in1`), proměnné
`$jmeno`, hovor `call.from`… a objekty / seznamy z HTTP nebo funkce.

**Priorita** (od nejslabší): `or` (`||`) < `and` (`&&`) < `not` (`!`) <
porovnání `== != < <= > >=` < `+ -` < `* / %` < unární `- +`. Porovnání nelze
řetězit (`1 < x < 3` → chyba, napiš `1 < x and x < 3`). Pozor: `!` má stejnou
prioritu jako `not`, tedy `!a == b` je `not (a == b)`.

**Typy a převody:**

- porovnání je **číselné, když obě strany vypadají jako čísla** (`"007" == 7`
  platí, `"10" > "9"` platí), jinak textové;
- `null` se rovná `null` a `""` (vstup, jehož zdroj ještě neběžel, je `null`);
- `+` sčítá čísla (i číselné texty: `"5" + 1` = `6`), a spojuje, když je
  jedna strana nečíselný text (`"Kód " + IN1`); pro spojení číslic použij uzel
  *Text*;
- výsledek, který není konečné číslo (`1 / 0`, `"x" * 2`), je `null`;
- pravdivost: `false`, `null`, `0`, `""`, `"0"`, `"false"` a prázdný seznam
  jsou nepravdivé; `and`/`or`/`not` vracejí `true`/`false`.

**Funkce:**

| Funkce | Příklad | Výsledek |
|---|---|---|
| `len(x)` | `len("žluťoučký")` | 9 (znaky; u seznamu položky) |
| `int(x)` | `int("12abc")`, `int(12.7)` | 12 |
| `num(x)` | `num("1,5")` | 1.5 (nebo `null`) |
| `str(x)` | `str(12)` | `"12"` |
| `lower(x)`, `upper(x)`, `trim(x)` | `trim("  a ")` | `"a"` |
| `contains(t, část)` | `contains(IN1, "ano")` | i položka seznamu |
| `startswith(t, p)`, `endswith(t, s)` | `startswith(call.from, "+420")` | |
| `digits(x)` | `digits("+420 603-123")` | `"420603123"` |
| `substr(t, od, délka?)` | `substr("abcdef", 1, 3)`, `substr(t, -4)` | `"bcd"`, poslední 4 |
| `replace(t, co, čím)` | `replace("a-b", "-", " ")` | prostý text, všechny výskyty |
| `min(…)`, `max(…)` | `max(IN1, 3)` | |
| `abs(x)`, `round(x, míst?)` | `round(2.345, 2)` | 2.35 |
| `now()` | | Unix čas v sekundách |
| `hour(tz?)`, `weekday(tz?)` | `hour("UTC")`, `weekday()` | 0–23; 1 = pondělí … 7 = neděle (výchozí zóna `TSA_TIMEZONE`, jinak Europe/Prague) |
| `random()`, `random(n)`, `random(a, b)` | `random(1, 6)` | 0…1; 0…n-1; a…b |
| `get(obj, "a.b.0")` | `get(IN1, "customer.name")` | hodnota v JSON (i z textu JSON), jen vlastní vlastnosti |

**Chyby** hlásí editor s pozicí znaku: `IN1 = 2` → „use == to compare (at
character 5)". Vzorec smí používat jen vstupy, které uzel má (`IN3` u uzlu se
dvěma vstupy je chyba). Limity: 1000 znaků, zanoření 48, 400 částí; text, který
vzorec postaví, nejvýš 16 000 znaků.

---

## 4. Textové šablony

Texty (TTS, SMS, log, výzva, URL, číslo k vytočení…) jsou šablony:

| Zástupka | Co dosadí |
|---|---|
| `{IN1}` … `{IN100}` | vstup uzlu |
| `{$jmeno}` | proměnnou |
| `{call.from}`, `{call.to}`, `{call.did}`, `{call.direction}`, `{call.provider}`, `{call.id}` | hovor |
| `{secret:JMENO}` | jen v hlavičkách HTTP: hodnota proměnné prostředí `TSA_SECRET_JMENO` |

Chybějící hodnota = prázdný text; cokoli jiného ve složených závorkách zůstane
beze změny. Šablona nic nepočítá — na to je *Formula* / *Text*. Čísla se píší
bez „plovoucího šumu" (`0.1 + 0.2` → `0.3`). Výsledek nejvýš 4000 znaků.

```text
Váš kód je {IN1}.                        → Váš kód je 4711.
Volá {call.from}, pokus {$attempts}.      → Volá +420603123456, pokus 2.
https://crm.example.com/api?n={call.from} → …?n=%2B420603123456   (v URL HTTP uzlu)
```

---

## 5. Jak TSA běží

**Tahy.** Běh je posloupnost *tahů*. Tah začne, když hovor do TSA vstoupí
(`start`), nebo když poskytovatel ohlásí, co se stalo (`resume` s událostí:
číslice, řeč, nahrávka, výsledek vytáčení, konec propojeného zvuku, „dohráno").
Runtime pak prochází graf uzel po uzlu:

- čisté uzly (Condition, Switch, Set, Formula, Text, smyčky, Opening hours,
  Log, Number info…) spočítají a pokračují;
- `say` / `play` / pauza / DTMF přidají akci do tahu a pokračují — poskytovatel
  provede akce tahu po sobě, takže pozdrav a menu za ním jsou jedna odpověď;
- uzel, který potřebuje volajícího nebo poskytovatele (Read DTMF, Record,
  Speech to text, Dial, Route audio), přidá akci, po které poskytovatel zavolá
  zpět, a tah skončí: session **čeká**;
- Hang up — nebo slepý konec (řídicí výstup bez hrany a žádná smyčka, kam se
  vrátit) — hovor ukončí.

**Zpětné volání.** Akce `gather` / `record` / `dial` mají `action`:

```text
${PUBLIC_BASE_URL}/wh/tel/<token hovoru>/tsa?s=<session>&n=<uzel>
```

Tah, který se musí přerušit dřív, než potřebuje volajícího (vyčerpal kroky,
ale má co přehrát; stream po N sekundách), končí přesměrováním na stejnou
adresu s `&e=played` a pokračuje, až se poskytovatel vrátí. Opakovaný nebo
zastaralý webhook dostane stejnou odpověď jako posledně (bez nové akce).

**Session.** Stav běhu (kde je, na co čeká, proměnné, hodnoty uzlů, smyčky,
počty pokusů, posledních 300 kroků) je v `telephony.db` (tabulka
`tsa_sessions`, WAL) — webhook, který hovor obnoví, může přijít do kterékoli
služby (hlavní i admin). Graf, na kterém hovor běží, je uložen jednou
(`tsa_graphs`, podle obsahu). Hesla SIP trunků se v session neukládají.

**Zavěšení.** Událost `hangup` session ukončí; pokud TSA právě čekala na
nahrávku, počká na ni a zbytek toku bez volajícího doběhne (vzkaz do
místnosti).

**Limity** (`TSA_LIMITS`):

| Limit | Hodnota | Po překročení |
|---|---|---|
| uzlů / hran v grafu | 300 / 900 | graf nelze uložit |
| kroků v jednom tahu bez čehokoli pro volajícího | 200 | „cyklus, který nikdy nečeká" — omluva, zavěšení, log |
| kroků v tahu s audiem, akcí v tahu | 200 / 40 | tah se rozdělí přesměrováním `&e=played` |
| kroků za hovor | 2000 | omluva, zavěšení |
| kol jedné smyčky | 1000 (While: *Max rounds*) | `done` |
| délka hovoru | Start: *Longest call* (max. 4 h) | zavěšení |
| text / vzorec | 4000 / 1000 znaků | |

**Chyby** (nepublikovaná nebo neexistující TSA, vzorec, který se nedá
vyhodnotit, chybějící `PUBLIC_BASE_URL`…) končí hovor zdvořile: krátká omluva
v jazyce Startu („Omlouváme se, nastala chyba. Na shledanou.") a zavěšení —
nepřijatý příchozí hovor se odmítne stavem *congestion* — a řádek v logu.

**Log.** Každý krok je v trace session; důležité události (start, konec,
chyby, výsledky Dial, Route audio, SMS, HTTP, funkcí, uzly Log) jdou do logu
modulu jako `kind: "tsa"` s `tsaSession` a `callId`.

---

## 6. Startovní šablony

*New TSA › from a template* (texty česky, Start `cs-CZ`). Co musí operátor
rozhodnout (číslo operátora, místnost), je prázdné — editor to označí a
publikace počká.

| Šablona | Tok |
|---|---|
| `ivr-menu` | pozdrav (klávesa ho přeruší) → 1 číslice → Switch: 1 a 2 hláška, 3 Dial na operátora (obsazeno / nedostupný → hláška), jiná volba → menu znovu; bez volby se zeptá ještě dvakrát, pak „Na shledanou" |
| `route-code` | `$attempts = 0` → While `$attempts < 3`: Read DTMF 6 číslic + # → Route audio (KEY) → úspěch „Hovor skončil" / špatný kód `$attempts + 1` a znovu / nelze propojit; po třech pokusech „Na shledanou" |
| `voicemail` | pozdrav → Record s přepisem → zpráva do místnosti „📞 Vzkaz od {call.from} ({IN2} s): {IN1}" → poděkování; nedoručeno → Log s adresou nahrávky |
| `opening-hours` | Opening hours (po–pá 8–17, Praha, svátky) → menu „1 = operátor" (Condition `IN1 == 1` → Dial) / mimo dobu hláška a zavěšení jako *busy* |

---

## 7. Simulátor

Konzole spustí TSA — koncept, nebo publikovanou verzi (`draft: false`) — jako
příchozí hovor **bez poskytovatele a bez nákladů**, tah po tahu v prohlížeči.
Runtime je stejný jako na skutečném hovoru; jen „poskytovatel" je falešný:

- akce tahu se stanou tím, co by volající slyšel (`SimTurn.play`: mluvený text,
  u hlasů AI & speech nasyntetizovaný zvuk jako `data:` URL, nahrané soubory
  do 2 MB, tóny DTMF, pípnutí) a na co TSA čeká (`SimTurn.waiting`: číslice s
  max. počtem a ukončovacím znakem, řeč, nahrávka, výsledek vytáčení, konec
  propojeného zvuku);
- přesměrování `&e=played` simulátor následuje sám;
- konzole odpovídá událostmi: číslice z klávesnice, řeč jako text **nebo jako
  WAV** (`audio: "data:audio/wav;base64,…"` — přepíše se), nahrávka jako
  `data:` URL, `dial` se stavem (`busy`, `no-answer`…), `route` (`ok`), `hangup`;
- `SimTurn.steps` je nová část trace (který uzel, kterým výstupem, proč).

Simulátor **nikdy** nevytáčí, neposílá SMS, nevolá web, nespouští funkce,
nepíše do místností, nepropojuje zvuk a nepřidává skutečné inroute kódy —
tyto kroky jen řeknou, co **by** udělaly. Route audio kód skutečně vyhledá
(v tabulce inroute i mezi kódy, které přidala tatáž simulace) a čeká na událost
`route`. Simulace se smažou hodinu po poslední akci.

---

## 8. Zvukové soubory

Nástroj *Play* s `source: file` přehrává soubory nahrané v konzoli: MP3 nebo WAV
(poznají se podle obsahu), nejvýš 10 MB, 200 souborů. Leží v
`telephony-audio/` vedle `telephony.json` (soubory `0600`, adresář `0700`,
`TSA_AUDIO_DIR` ho přesune), zapisuje admin, poskytovatelům je servíruje hlavní
služba z `/wh/tsa/file/<id>` (id = 96 náhodných bitů).

---

## 9. API konzole

Na admin službě, za jejím ověřením a `consoleGuard("telephony", …)`. Odpověď
`{ ok: true, … }` nebo `{ ok: false, message, problems? }`.

| Metoda | Cesta | |
|---|---|---|
| GET | `/admin/telephony/tsa/catalog` | `{ tools, groups, limits, templates, formula }` |
| GET | `/admin/telephony/tsa` | `{ tsas: TsaListRow[], templates, store }` |
| POST | `/admin/telephony/tsa` | `{ id?, name, description?, template? }` → `{ tsa, problems }` |
| GET | `/admin/telephony/tsa/:id` | `{ tsa, usedBy, problems }` |
| PUT | `/admin/telephony/tsa/:id` | `{ name, description, graph, tags }` → `{ tsa, problems }` |
| DELETE | `/admin/telephony/tsa/:id` | odmítne (409), dokud TSA používá pravidlo |
| POST | `/admin/telephony/tsa/:id/validate` | `{ graph? }` → `{ problems }` |
| POST | `/admin/telephony/tsa/:id/publish` | koncept → verze + 1 (s chybou 422 a `problems`) |
| POST | `/admin/telephony/tsa/:id/duplicate` | `{ id?, name? }` |
| GET | `/admin/telephony/tsa/:id/export` | soubor JSON (`format: "m5cet-tsa"`) |
| POST | `/admin/telephony/tsa/import` | exportovaný soubor (nebo `{ file, id?, name? }`) → nový koncept |
| POST | `/admin/telephony/sim` | `{ tsa, draft?, from?, to?, vars? }` → `{ session, turn }` |
| POST | `/admin/telephony/sim/:session/event` | `TsaEvent` → `{ session, turn }` |
| GET | `/admin/telephony/sim/:session` | session simulace s trace (session skutečného hovoru tu není — drží, co volající zadal) |
| GET / POST | `/admin/telephony/tsa/files` | seznam / nahrání `{ name, data: "data:audio/…;base64,…" }` |
| GET / DELETE | `/admin/telephony/tsa/files/:id` | náhled / smazání |

**Uložení vs. publikace.** Uložení konceptu odmítne jen graf s rozbitým
*tvarem* (neplatná id, neznámé nástroje, hrany do neexistujících portů,
limity) — rozpracovaný koncept s chybějícími parametry uložit jde a odpověď
vrátí všechny problémy. Publikace odmítne **jakoukoli** chybu.

**Kde TSA leží.** `telephony-tsa.json` vedle `telephony.json`
(`TSA_DATA_FILE` ho přesune), atomický zápis `0600`; hlavní služba změnu pozná
podle obsahu souboru a načte ji bez restartu. „Používá" (`usedBy`) se čte z
dat pravidel modulu (soubory `telephony*.json`) a z výchozích cílů oprávnění.

**Hlavní služba** navíc servíruje `/wh/tsa/audio/<token>` (syntetizovaná řeč)
a `/wh/tsa/file/<id>`; zpětné volání `/wh/tel/<token>/tsa` obsluhuje vrstva
poskytovatelů (přeloží payload na `TsaEvent` a zavolá `telHooks.tsa.resume`).

---

## 10. Proměnné prostředí

| Proměnná | Význam |
|---|---|
| `PUBLIC_BASE_URL` | povinná: odsud poskytovatel volá zpět a stahuje zvuk |
| `TSA_DATA_FILE` | cesta k `telephony-tsa.json` |
| `TSA_AUDIO_DIR` | adresář zvukových souborů |
| `TSA_TIMEZONE` | výchozí zóna `hour()` / `weekday()` (Europe/Prague) |
| `TSA_SECRET_<JMENO>` | hodnota `{secret:JMENO}` v hlavičkách HTTP uzlu |

---

## 11. Poctivá omezení

- **Ověřeno testy, ne na skutečném hovoru.** Runtime, simulátor, úložiště a API
  pokrývají testy (`test/tsa-*.test.ts`) s falešnými hooky a závislostmi;
  překlad akcí na TwiML / NCCO / Call Control a webhook `/wh/tel/<token>/tsa`
  patří vrstvě poskytovatelů, propojení zvuku mediální vrstvě.
- **Rychlost, výška a hlasitost** TTS: hlas poskytovatele dostane jen hlas a
  jazyk (akce `say` je nenese); u AI & speech se uplatní jen hlasitost (zesílení
  WAV) — rychlost a výška se zatím nikam nepředávají.
- **Barge-in** funguje jen pro TTS hlasem poskytovatele hned před Read DTMF; u
  Play a hlasů AI & speech klávesa přehrávání nepřeruší.
- **Stream** se po zadaném čase zastaví přesměrováním hovoru z procesu, který
  tah zpracoval; po jeho restartu hraje stream, dokud volající nezavěsí.
- **Zpráva do místnosti** je oznámení serveru jen připojeným členům (neukládá
  se, není koncově šifrovaná) a pošle ji jen hlavní služba; kdo není připojen,
  ji nedostane (`on_failed`).
- **Secrets** `{secret:NAME}` čte z proměnných prostředí `TSA_SECRET_*` —
  úložiště *Functions › Secrets* zatím neexistuje.
- **Run function** po vypršení času přestane čekat, ale běh modelu se nezruší.
- **Odchozí pravidla v Dial** mohou jmenovat jiného poskytovatele; přepojení
  ale vždy provede poskytovatel tohoto hovoru (zapíše se poznámka).
- **Per-caller limit špatných kódů** počítá runtime sám (v `telephony.db`);
  tabulka inroute jen kód najde a započte použití.
- Session v paměti (bez ovladače SQLite) funguje jen v jednom procesu.
