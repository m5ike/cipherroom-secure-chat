# M5cet — Telephony & SIP: oprávnění, směrování hovorů a tabulka inroute (6.9)

Řídicí vrstva modulu Telephony & SIP: **kdo smí co** (oprávnění a limity),
**kudy jde hovor** (pravidla pro příchozí a odchozí hovory) a **kam se
dostane volající, který zadá kód** (tabulka inroute a SDK
`m5.telephony.inroute`). Konzole: *Admin › Tools › Telephony & SIP*.
Poskytovatelé, webhooky a SIP trunky jsou v [`telephony.md`](telephony.md).

Kód: `server/telephony/control/` — `types.ts` (kontrakt), `store.ts`
(uložení, validace), `match.ts` (vzory čísel, časová okna), `rules.ts`
(rozhodování), `enforce.ts` (vynucení u odchozích hovorů a SMS),
`inroute.ts` (tabulka kódů), `routes.ts` (API konzole), `guard.ts` (práva
konzole).

## 1. Kde to je uložené

| Co | Kde | Kdo zapisuje |
|---|---|---|
| Oprávnění (`TelPermissions`) a pravidla | datový soubor telefonie (`$DATA_DIR/telephony.json`, `TELEPHONY_DATA_FILE`) — oddíly `permissions` a `rules` vedle SIP trunků | admin služba (konzole); hlavní služba soubor znovu načte, jakmile se změní jeho obsah — bez restartu |
| Tabulka inroute | `telephony.db` (SQLite, `TELEPHONY_DB_FILE`), tabulky `inroute` a `inroute_failures` | obě služby (funkce v hlavní, konzole v admin) |

Soubor se zapisuje atomicky s právy `0600`; každý zapisovatel (SIP trunky,
výchozí poskytovatelé, oprávnění, pravidla) přečte celý soubor, změní svůj
oddíl a zbytek zapíše beze změny. Ručně upravený soubor se čte shovívavě:
pravidlo s chybou se **vypne** (ne smaže), vadný limit se vrátí na výchozí
hodnotu a důvod jde jednou do logu (kind `config`).

## 2. Oprávnění (Telephony › Permissions)

Kdo smí modul vůbec používat a které jeho části, rozhoduje dál *Modules &
groups* (práva níže). `TelPermissions` jsou limity a výchozí chování, které
platí pro všechny a žádné pravidlo je nepřebije.

| Pole | Výchozí | Rozsah | Význam |
|---|---|---|---|
| `outbound.countries` | `[]` (kamkoli; **TSA jen vlastní země**) | ISO 3166 alpha-2 (`CZ`, `SK`…, `001` = negeografická), `*` = kamkoli | kam smějí hovory **i** zprávy. 6.10 (G-06): prázdný seznam pustí funkce, aplikaci a konzoli kamkoli, ale SMS a přepojení **TSA** jen do zemí čísel provozovatele (`TWILIO_FROM`, `TELNYX_FROM`, `VONAGE_FROM`, `TELEPHONY_DID_POOL`, DID a caller ID trunků) a volaného čísla; `*` = celý svět pro všechny |
| `outbound.blocked` | `+1900*`, `+1976*`, `+44870–3*`, `+4290*`, `+42097*`, `+881–3*` | vzory | nikdy nevytočit (prémiová, satelitní…) |
| `outbound.maxConcurrentCalls` | 5 | 1–1000 | souběžné odchozí hovory celého modulu |
| `outbound.callsPerHour` | 30 | 1–10 000 | hovory **jednoho volajícího** za hodinu |
| `outbound.smsPerHour` | 60 | 1–10 000 | SMS jednoho volajícího za hodinu |
| `outbound.maxMinutes` | 30 | 1–1440 | nejdelší hovor (předá se poskytovateli jako časový limit) |
| `inbound.maxConcurrentCalls` | 10 | 1–1000 | souběžné příchozí hovory |
| `inbound.perCallerPerHour` | 20 | 1–10 000 | hovory z jednoho čísla za hodinu (pak „busy“) |
| `inroute.maxTtlSec` | 86 400 | 60–604 800 | nejdelší platnost kódu |
| `inroute.maxActivePerOwner` | 50 | 1–10 000 | živé kódy jednoho modelu / administrátora / TSA |
| `inroute.maxAttemptsPerCall` | 3 | 1–10 | špatné kódy v jednom hovoru — ten, který limitu dosáhne, hovor ukončí (6.10) |
| `inroute.maxFailuresPerCallerPerHour` | 10 | 1–1000 | špatné kódy z jednoho čísla za hodinu, pak odmítnuto (číslo volajícího jde podvrhnout — proto další tři) |
| `inroute.maxFailuresPerDidPerHour` | 30 | 1–10 000 | 6.10: špatné kódy na jedno **volané** číslo za hodinu, pak se kódy na něm pozastaví (1 min, opakovaně až 60 min) |
| `inroute.maxFailuresPerMinute` | 10 | 1–1000 | 6.10: špatné kódy za minutu v celém modulu, pak pauza kódů všude |
| `inroute.maxFailuresPerHour` | 100 | 1–10 000 | 6.10: totéž za hodinu |
| `tsa.httpHosts` | `[]` (nástroj HTTP vypnutý) | `api.example.com`, `*.example.com` | kam smí nástroj HTTP v TSA |
| `tsa.functions` | ano | | smí TSA spouštět modely |
| `tsa.recordingDays` | 30 | 1–3650 | jak dlouho držet nahrávky |
| `log.days`, `log.keepRaw` | 30, ano | 1–3650 | retence logu, zda držet surová data webhooků |
| `defaults.inbound` | `busy` | TSA nebo stav | když žádné příchozí pravidlo nesedí |
| `defaults.outbound` | `pass` | `pass`, TSA nebo stav | když žádné odchozí pravidlo nesedí |

„Volající“ pro hodinové limity je uložený model (`model:<id>`), u konceptu
osoba, která ho spustila (`admin:<jméno>`, `user:<účet>`), u aplikace účet,
jinak adresa (`ip:<adresa>`). Čísla mimo rozsah se **ořežou** a odpověď
řekne co (`outbound.maxMinutes: 100000 → 1440`); chybné seznamy (vzor,
země, host) uložení odmítnou se seznamem všech problémů.

`GET /admin/telephony/permissions` vrací i **přístup podle skupin** z Modules
& groups (jen ke čtení): hlavní skupina `mod-telephony` má vše, přístupové
skupiny `*` nebo nic, granty skupin `allow` / `deny` (bez „-“), „`*`“ jako
skupina = všichni ostatní (výchozí přístup).

## 3. Vzory čísel

| Vzor | Sedí na |
|---|---|
| `+420123456789` | přesně toto číslo — v hodnotě nevadí mezery, pomlčky, závorky, `00` místo `+` ani chybějící `+` (Vonage posílá číslice) |
| `+4202*` | předvolbu |
| `*` | cokoli, i skryté číslo |
| `sip:*@pbx.example.com` | SIP URI (glob: `*` cokoli, `?` jeden znak; bez ohledu na velikost písmen) |
| `-+1900*` | **ne** tohle — vyloučení vždy vyhrává |

Seznam vzorů: prázdný = cokoli; jinak musí sedět aspoň jeden kladný a
žádný záporný. Číselný vzor sedí i na uživatelskou část SIP URI
(`sip:+420222111000@trunk.example.com` ↔ `+4202*`).

## 4. Časová okna

`{ timezone, days, from, to }` — pásmo IANA (`Europe/Prague`), dny
`mon-fri`, `sat,sun`, `fri-mon` (přes víkend), `*` / `weekdays` /
`weekend`, časy `HH:MM` (`24:00` = konec dne). `from > to` je noční okno —
`22:00-06:00` patří dni, kdy začíná (pátek 22:00 až sobota 06:00 pro
`fri`); `from = to` je celý den. Čas se počítá v pásmu okna (letní čas
podle `Intl`).

## 5. Pravidla

Pravidla se vyhodnocují **podle pořadí** (priorita 10, 20, 30… = pořadí v
seznamu; uložení seznam přečísluje). Vyhraje první zapnuté pravidlo, které
sedí; když žádné, platí výchozí cíl z oprávnění. Každé rozhodnutí má
**důvody** — u každého přeskočeného pravidla proč, u vybraného kam.

### Příchozí (`InboundRule`)

Sedí na volané číslo (DID) nebo vytočenou SIP URI (`numbers`), volajícího
(`from`), poskytovatele, službu (`app` = aplikace poskytovatele, `sip` = SIP
trunk / doména) a časové okno. Cíl: **TSA** (hovor ji spustí) nebo **stav**
`busy`, `congestion`, `hangup`, `rejected`. `record: true` nahrává celý
hovor. Cíl `pass` u příchozích není.

```json
[
  { "id": "vip", "label": "VIP linka", "match": { "numbers": ["+420222111000"], "from": ["+420777*", "-+420777000000"] },
    "target": { "kind": "tsa", "tsa": "vip-line" } },
  { "id": "office", "label": "Pracovní doba", "match": { "numbers": ["+420222111000"],
      "hours": { "timezone": "Europe/Prague", "days": "mon-fri", "from": "08:00", "to": "17:00" } },
    "target": { "kind": "tsa", "tsa": "office-ivr" }, "record": true },
  { "id": "closed", "label": "Mimo pracovní dobu", "match": { "numbers": ["+420222111000"] },
    "target": { "kind": "tsa", "tsa": "voicemail" } }
]
```

### Odchozí (`OutboundRule`)

Sedí na cíl (`to`), skupiny volajícího (Modules & groups), zdroj
(`function`, `tsa`, `console`, `api`) a časové okno. Říká **čím** hovor jde
(`service`) a **co** se stane po přijetí (`target`):

- `service: { kind: "app", provider }` — **aplikace poskytovatele**,
  autentizovaná jeho API klíčem a tajemstvím z `.env` (Twilio Account SID +
  Auth Token, Telnyx API key, Vonage aplikace + privátní klíč). Klíče se
  nikdy neukládají do pravidel.
- `service: { kind: "sip", provider, trunk, callerId }` — **SIP trunk**
  (Telephony › SIP trunks) vytočený přes poskytovatele (`sip:<číslo>@<host
  trunku>`): poskytovatel dostane host, port, přihlašovací jméno a heslo
  trunku (`PlaceCallInput.via` — heslo jde jen poskytovateli, nikdy do logu
  ani zpět klientovi) a **vlastní caller ID** pravidla: `number` (E.164,
  číslo, které smíte prezentovat; prázdné = caller ID trunku), `name`
  (zobrazované jméno, kde ho síť nese — uvozovky a `<>` se odstraní) a
  `presentation` (`allowed` / `restricted` = skryté).
- `target`: `pass` (hovor jde, jak ho volající popsal — `say`, `actions`,
  obsluha), **TSA** (po přijetí běží aplikace; zadaná logika se ignoruje),
  nebo **stav** — hovor se odmítne s názvem pravidla.

```json
[
  { "id": "no-premium", "label": "Žádné 900", "match": { "to": ["+420900*", "+420906*"] },
    "service": { "kind": "app", "provider": "twilio" }, "target": { "kind": "state", "state": "rejected" } },
  { "id": "sales-cz", "label": "Obchod přes trunk", "match": { "to": ["+420*"], "groups": ["sales"] },
    "service": { "kind": "sip", "provider": "telnyx", "trunk": "prague1",
                 "callerId": { "number": "+420222111000", "name": "M5cet", "presentation": "allowed" } },
    "target": { "kind": "pass" } },
  { "id": "survey", "label": "Průzkum po hovoru", "match": { "to": ["*"], "sources": ["tsa"] },
    "service": { "kind": "app", "provider": "vonage" }, "target": { "kind": "tsa", "tsa": "survey" } }
]
```

**Aplikace vs. SIP trunk**: aplikace je nejjednodušší — čísla koupená u
poskytovatele, jeho webhooky a jeho caller ID. SIP trunk se hodí, když
čísla a tarify máte u vlastního operátora (PBX, ústředna): poskytovatel
hovor jen „převede“ na váš trunk a vy určujete caller ID. Příchozí hovory
z trunku jdou na SIP doménu / spojení poskytovatele, který je pošle na
stejný webhook jako aplikace — v pravidle je rozliší `service: "sip"`.

### Co se děje s odchozím hovorem (`enforce.ts`)

Každý odchozí hovor a SMS — `m5.telephony.call` / `sms` / `whatsapp`…,
aplikační `POST /api/telephony/call|sms`, testy konzole a od 6.10 (G-06) i
**SMS a Dial / transfer v TSA** (rozpočet `tsa:<id>`; simulátor kontroluje
bez počítání) — projde v tomto pořadí:

1. **země a blokovaná čísla** (`outbound.countries`, `outbound.blocked`) —
   odmítne `route-refused` dřív, než se zeptá poskytovatele;
2. **hodinový rozpočet volajícího** (`callsPerHour`, `smsPerHour`) —
   `telephony-limit`;
3. hovory: **souběžné hovory** modulu (`maxConcurrentCalls`) —
   `telephony-busy`;
4. hovory: **odchozí pravidla** — stav odmítne (`route-refused`: *the
   outbound rule "Žádné 900" refuses it (rejected)*), služba vybere
   poskytovatele (pravidlo má přednost před `provider` v požadavku), SIP
   trunk předá `via` a caller ID, TSA se spustí po přijetí;
5. hovory: **nejdelší hovor** (`maxMinutes`) → časový limit u poskytovatele.

U TSA navíc: přepojení podléhá pravidlům i při *Route through: application /
SIP trunk* (stav odmítne; službu pravidla použije jen volba *the outbound
rules*), přepojení dostane časový limit (`maxMinutes`, nejvýš zbytek
*Longest call* TSA — Twilio `<Dial timeLimit>`, Vonage `connect.limit`,
Telnyx `transfer.time_limit_secs`) a jedna TSA přepojí za hodinu nejvýš
`callsPerHour` (přepojení není hovor, který zapisuje `tel-store`, proto ho
počítá runtime TSA v `tsa_marks`).

Každé rozhodnutí jde do logu (kind `route`) s důvody. Aplikační route vrací
403 (pravidlo, blokované číslo, země), 429 (limity), 503 (chybí trunk).
Hovor s cílem TSA po přijetí spustí `telHooks.tsa.start`; číslice, řeč a
nahrávky z jeho webhooků TSA obnoví (`resume`), konec hovoru jí řekne
`hangup`. Když v procesu runtime TSA není, hovor pokračuje vlastní logikou a
log řekne proč.

### Zkouška nanečisto

`POST /admin/telephony/rules/test` s `RouteQuestion` (`direction`, `from`,
`to`, `provider`, `service`, `groups`, `source`, `at`) vrátí `RouteDecision`
s důvody — nad uloženými pravidly, nebo nad konceptem
(`{ question, draft: { inbound?, outbound?, permissions? } }`), který editor
ještě neuložil:

```
#10 "VIP linka" — skipped: the caller +420608000000 is not in [+420777*]
#20 "Pracovní doba" — skipped: outside mon-fri 08:00-17:00 Europe/Prague (it is mon 19:12 there)
#30 "Mimo pracovní dobu" — matched → TSA voicemail
```

## 6. Tabulka inroute (kódy pro směrování zvuku)

Kód (4–6 číslic) říká, **kam jde zvuk volajícího**: do celé místnosti
(`room` — každý člen připojený se zvukem) nebo k jednomu členovi (`user` —
jméno v místnosti nebo účet `@alice`), po dobu platnosti (TTL, výchozí 600
s). Volající zavolá na příchozí číslo, TSA ho nechá zadat kód (*Read
DTMF*) a nástroj **Route audio** kód najde v tabulce a — je-li živý —
propojí zvuk oběma směry.

| Pole | Význam |
|---|---|
| `code` | 4–6 číslic, jedinečný mezi živými kódy (prošlý se dá znovu použít); 6.10: s platností nad 10 min 6 číslic, snadno uhodnutelný zvolený kód se odmítne, živých kódů jedné délky nejvýš 10 / 100 / 1000 |
| `type`, `room`, `user` | kam; `room` je slepé ID místnosti (`r3.…`), nikdy její jméno |
| `ttlSec`, `createdAt`, `expiresAt` | platnost: 30 s … `inroute.maxTtlSec` |
| `uses`, `maxUses` | kolikrát kód hovor propojil; po `maxUses` zmizí (0 = až do vypršení) |
| `createdBy` | model (`m5.telephony.inroute.add`), TSA (*Add route code*), konzole |

Kódy vytvářejí **funkce** (právo `inroute`), **TSA** (nástroj *Add route
code*) a **konzole** (Telephony › testy, `POST /admin/telephony/inroute`).
Konzole vidí celou tabulku s kódy (`GET /admin/telephony/inroute`), model
jen své.

### SDK — `m5.telephony.inroute`

```js
// JavaScript
const e = await m5.telephony.inroute.add("", "room", 600, { label: "Recepce" }); // náhodný kód pro místnost běhu
await m5.caller.send(m5.out.markdown(`Zavolejte na +420 222 111 000 a zadejte **${e.code}**.`));
const mine = await m5.telephony.inroute.list();       // živé kódy tohoto modelu
await m5.telephony.inroute.del(e.code);                // odstranit (vrací true/false)
await m5.telephony.inroute.add({ code: "48213", type: "user", user: "Eva", ttl: 300, maxUses: 1 });
```

```python
# Python — del je klíčové slovo: delete (také del_ a getattr(…, "del"))
e = await m5.telephony.inroute.add(None, "user", 120, room=m5.caller.room, user="@alice", max_uses=1)
await m5.telephony.inroute.delete(e["code"])
codes = await m5.telephony.inroute.list()
```

`add(code, type = "room", ttl = 600, { room, user, label, maxUses })` —
`code` `""` / `null` = náhodný (6 číslic, `digits: 4|5` kratší); `room`
výchozí = místnost, ze které běh přišel (`m5.caller.room`; konzole a
webhook ji nemají → `room` je povinné); `user` u typu `user` výchozí =
volající (`@účet`). Vrací záznam (`InrouteEntry`) s kódem — model ho potřebuje
sdělit členovi. Chyby: `bad-argument`, `code-taken`, `inroute-limit`,
`telephony-denied` (chybí právo `inroute`).

Ve **vizuálním tvůrci**: *Telephony › inroute.add / inroute.del /
inroute.list*. V **tutoriálu** konzole Functions lekce 20 a 21.

Pro media část (Route audio) jsou k dispozici `telHooks.inroute.lookup /
used / add / guard / failure` a funkce `inrouteGuard({ caller, did })`,
`inrouteFailure({ caller, did }, detail)`, `inrouteBlocked(volající, did?)`
a `inrouteLockouts()` z `control/inroute.ts`.

## 7. Bezpečnost

- **Hádání kódů**: náhodné kódy z `crypto.randomInt`, bez snadno uhodnutelných
  (`0000`, `1234`, `9876`, `1212`, `123123`, roky `19xx`/`20xx`); 6.10 (G-05):
  zvolený takový kód se **odmítne**, kód s platností nad 10 minut má 6 číslic
  a živých kódů jedné délky je nejvýš 1 z 1000 (10 / 100 / 1000), aby
  náhodný pokus skoro nikdy nic netrefil. Číslo volajícího jde podvrhnout
  (CLI spoofing, libovolné SIP `From`), proto se špatné kódy počítají třikrát:
  na volající číslo a hodinu (`maxFailuresPerCallerPerHour` — pak je číslo
  odmítnuto), **na volané číslo (DID)** a hodinu (`maxFailuresPerDidPerHour`)
  a **za celý modul** za minutu a hodinu (`maxFailuresPerMinute`,
  `maxFailuresPerHour`). Po vyčerpání rozpočtu DID nebo modulu se kódy
  **pozastaví** — 1 min, při opakování do hodiny dvojnásobek až 60 min; během
  pauzy se kód ani nehledá (i správný dostane `on_code_error`) a pauza je
  varování v logu i bezpečnostní událost auditu `telephony.inroute.lockout`
  (alert konzole *security-warnings*). Úmyslně vyvolaná pauza je cena za
  limit, který caller ID neobejde. V jednom hovoru nejvýš `maxAttemptsPerCall`
  pokusů — ten poslední hovor ukončí. Skrytá čísla sdílejí jeden čítač
  („anonymous“). Čím delší kód a kratší TTL, tím líp: 6 číslic, minuty, ne
  dny; jednorázové kódy `maxUses: 1`.
- **TTL** je vždy omezené (`maxTtlSec`), prošlé kódy se mažou (průběžně a při
  čtení), jeden vlastník má nejvýš `maxActivePerOwner` živých kódů.
- **Log** kódy maskuje (`•••••7`): přidání, použití, odstranění i špatný
  pokus jdou do logu (kind `inroute`) bez kódu; celý kód ukazuje jen tabulka
  konzole a model, který ho vytvořil.
- **Slepé ID místnosti**: kód míří na slepé ID (`r3.…`), které zná jen člen
  místnosti — model nebo člověk s právem `inroute` tak nemůže směrovat do
  místnosti, kterou nezná. Hovor po telefonní síti **není koncově
  šifrovaný**.
- **Odchozí podvody** (toll fraud): blokovaná prémiová a satelitní čísla,
  země, hodinový rozpočet na volajícího a souběžné hovory platí pro všechny
  cesty (funkce, aplikace, konzole, od 6.10 i SMS a přepojení TSA) a žádné
  pravidlo je nepřebije. TSA s prázdným seznamem zemí smí jen do vlastních
  zemí — SMS na číslo volajícího (`{call.from}`) tak nejde poslat na
  podvržené drahé zahraniční číslo („SMS pumping“).
- **Tajemství**: hesla SIP trunků zůstávají v datovém souboru (0600), do
  pravidel se ukládá jen ID trunku; heslo jde výhradně poskytovateli.

## 8. Práva (Modules & groups › Telephony & SIP)

| Právo | Na co |
|---|---|
| `call`, `sms`, `message`, `lookup`, `hlr`, `did`, `number:+420*` | jako dosud (funkce, aplikace) |
| `inroute` | `m5.telephony.inroute.*` (funkce; běh bez osoby = grant modelu) |
| `settings` | konzole: poskytovatelé, SIP trunky, webhooky, **oprávnění**, kódy inroute |
| `routing` | konzole: příchozí a odchozí pravidla |
| `tsa` | konzole: editor TSA, publikování |
| `log` | konzole: celý záznam logu (parsovaná a surová data webhooků) |
| `test` | konzole: testy, simulátor |

Které právo potřebuje požadavek na `/admin/telephony/*`, říká kontrakt
`TELEPHONY_API` (`control/api-contract.ts`): čtení stačí modul, změna
potřebuje své právo; starší endpointy mimo kontrakt drží dřívější pravidlo
(změna `settings`, staré `/test` `test` nebo `settings`). Vlastník konzole
smí vždy.

## 9. API konzole (admin služba)

| Požadavek | Právo | Co |
|---|---|---|
| `GET /admin/telephony/permissions` | — | `{ permissions, access, bounds, meta }` |
| `PUT /admin/telephony/permissions` | `settings` | uloží (validace, ořezání) → `{ permissions, notes }` nebo `400 { problems }` |
| `GET /admin/telephony/rules` | — | `{ inbound, outbound, trunks, meta }` |
| `PUT /admin/telephony/rules/inbound` · `/outbound` | `routing` | `{ rules }` nahradí seznam (pořadí = priorita) |
| `POST /admin/telephony/rules/test` | — | `RouteQuestion` (nebo `{ question, draft }`) → `RouteDecision` |
| `GET /admin/telephony/inroute` | — | `{ entries, limits }` — kódy celé |
| `POST /admin/telephony/inroute` | `settings` | `{ code?, type, room, user?, ttl?, label?, maxUses? }` → `{ entry }` (409 kód obsazený, 429 limit) |
| `DELETE /admin/telephony/inroute/:code` | `settings` | odstraní (404 když není) |

## 10. Ověřeno testy

`test/telephony-control-rules.test.ts` (vzory, vyloučení, okna v pásmech,
noční okna, pořadí, výchozí cíle, důvody, blokovaná čísla a země),
`test/telephony-control-console.test.ts` (validace a ořezání, uložení vedle
trunků, shovívavé čtení, endpointy konzole, mapování práv přes skutečný
`consoleGuard`), `test/telephony-inroute.test.ts` (náhodné kódy,
jedinečnost, TTL, limity, `maxUses`, úklid, čítač špatných pokusů,
maskování v logu), `test/telephony-control-outbound.test.ts` (SDK v JS a
Pythonu přes sandbox, granty, uzly tvůrce, lekce tutoriálu, odmítnutí,
rozpočty, SIP trunk a caller ID u poskytovatele, TSA po přijetí,
`/api/telephony/*`). Poskytovatelé jsou napodobení; skutečný hovor přes SIP
trunk ani propojení zvuku kódem (Route audio — jiná část 6.9) tu ověřené
nejsou.
