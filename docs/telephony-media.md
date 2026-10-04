# M5cet — telefonie: zvuk hovoru do místnosti (Route audio, 6.9)

Nástroj **Route audio** (`route_audio`) v TSA (Telephony & SIP Application,
kreslený tok hovoru v konzoli) přepojí zvuk živého hovoru **oběma směry** do
chatu — buď do **celé místnosti**, nebo jen **jednomu členovi**. Kam, to
určuje **route kód** (4–6 číslic) z tabulky inroute, který předem vytvoří
funkce (`m5.telephony.inroute.add(CODE, TYPE, …)`, výchozí TTL 600 s), TSA
nebo konzole.

```
volající ──► číslo (DID) ──► příchozí pravidlo ──► TSA
                                                   │  Read DTMF → KEY (4–6 číslic)
                                                   ▼
                                             Route audio ──► tabulka inroute
                                   ┌───────────────┼────────────────┐
                              on_success     on_code_error      on_failed
                       (přepojeno; pokračuje  (kód neexistuje,  (kód platí, ale zvuk
                        až zvuk skončí)        vypršel, formát)  nejde přepojit)
```

Nástroj má vstup **KEY** a parametry *Jen jedno použití* (`consume`), *Říct
po spojení* (`announce`) a *Když nikdo nepřevezme zvuk* (`mode`: `fail` →
on_failed, `text` → textový režim). Vyhledání kódu a jeho spotřebování dělá
běhové prostředí TSA; tato část (server `telephony/route-audio.ts`) dostane
platný záznam a přepojí zvuk (`telHooks.routeAudio`).

## 1. Jak přepojení probíhá

1. **Rozhodnutí** (`decideRoute`): záznam musí mít typ `room` / `user` a
   nevypršet (jinak `on_code_error`); místnost musí být **slepé id** `r3.…`
   (jinak `on_failed`). Server najde živou místnost na signalizačním hubu
   přímo podle slepého id — jiné id místnost v3 na serveru nemá.
2. **Kdo je připojený**: `room` → všichni členové místnosti připojení k této
   instanci serveru; `user` → člen podle jména v místnosti, nebo `@účet`
   (nejdřív v místnosti z kódu, jinak kdekoli je účet připojený — jen v
   místnostech se slepým id). Nikdo → `mode: fail` vrátí hned
   `{ ok: false, reason: "failed" }` (on_failed), `mode: text` pokračuje
   textovým režimem.
3. **Akce pro poskytovatele**: nejdřív `say` s ohlášením (je-li), pak
   `stream` na `wss://…/media/tel/<token>` — Twilio `<Connect><Stream>`
   (JSON, µ-law 8 kHz), Telnyx `streaming_start` (JSON, PCMU 8 kHz,
   obousměrně), Vonage `connect` websocket (binární 16bit PCM 16 kHz). TSA
   je předá poskytovateli a čeká na událost `{ kind: "route", … }`.
4. **Stream se otevře**: každý cílový člen dostane na signalizačním socketu
   rámec `phone-bridge` / `incoming` s **vlastním** tokenem svého media
   socketu (`/media/tel/client/<token>`), počtem lidí v hovoru a — jen
   v místnosti, kterou kód jmenuje — číslem volajícího. Volající mezitím
   slyší vyzváněcí tón (425 Hz, 1 s / 4 s).
5. **Připojení**: člen klikne *Připojit se zvukem*, prohlížeč otevře media
   socket, pošle `{ "type": "audio" }` a začne posílat mikrofon. Server ho
   přidá do mixu; všem ostatním přijde `status` s novým počtem.
6. **Konec** — viz kapitolu 4.

Členové, kteří se připojí do místnosti **během** hovoru, dostanou nabídku
také (server každé 2 s porovná seznam členů). Místnost, kterou má uživatel
otevřenou **na pozadí** (víc místností najednou), kartu ukáže taky — media
socket jde na server té místnosti.

## 2. Místnost vs. člen

| | `room` | `user` |
|---|---|---|
| kdo dostane kartu | každý člen místnosti (i ten, kdo se připojí později) | člen podle jména, nebo `@účet` |
| kdo slyší volajícího | každý, kdo se připojí zvukem | ten člen |
| volající slyší | všechny připojené smíchané | toho člena |
| další zařízení | každé je samostatný účastník | druhé zařízení hovor **převezme** (první se odpojí) |
| číslo volajícího | ukáže se v místnosti z kódu | ukáže se jen, je-li člen v místnosti z kódu |
| *Odejít* | hovor jde dál ostatním | — |
| *Ukončit (pro všechny)* | ukončí přepojení, TSA pokračuje | ukončí přepojení, TSA pokračuje |

## 3. Míchání zvuku

Mixer (`server/telephony/mixer.ts`) je konferenční **mix-minus**: každý
zdroj (volající, každý připojený člen) slyší všechny ostatní, nikdy sám
sebe. Napsaná odpověď přečtená hlasem (TTS) a vyzváněcí tón jsou zdroje, které
nikdo „neposlouchá", takže je slyší všichni.

- **Rámce 20 ms při 16 kHz** (320 vzorků) — rychlost prohlížečů. Linka
  volajícího se převzorkuje do mixu a z něj (8 kHz pro Twilio/Telnyx, 16 kHz
  Vonage; dolní propust proti aliasingu, `audio.ts`).
- **Hodiny**: časovač po 20 ms s korekcí driftu — zpožděný tik dožene,
  zaseknutá smyčka událostí přeskočí dopředu (nepošle dávku). Jeden tik je
  pár desítek tisíc operací se vzorky (16 členů) — smyčku neblokuje.
- **Jitter buffer pro každý zdroj**: prohlížeč posílá kusy ~43 ms, poskytovatel
  20 ms. Zdroj začne hrát po naplnění cíle (člen 80 ms, volající 40 ms), při
  podtečení zahraje zbytek doplněný tichem a znovu se plní, při přetečení
  (člen > 300 ms, volající > 200 ms) zahodí nejstarší zvuk zpět na cíl —
  zpoždění nikdy neroste.
- **Součet a limiter**: 32bitový součet 16bitových vzorků; do 75 % plného
  rozsahu se nic nemění, nad tím soft limiter (tanh) ohne špičky — hlasitá
  místnost nikdy nepřeteče ani tvrdě neořízne.
- **Sám v hovoru** slyší ticho (ne sám sebe); připojení a odchody se
  projeví v dalším rámci.

## 4. Konec a návrat do TSA

| co se stane | výsledek |
|---|---|
| všichni připojení odešli (a do 6 s se nikdo nevrátil) | `resume({ kind: "route", ok: true })` → **on_success** |
| člen hovor ukončil (*Ukončit pro všechny* / *Zavěsit*) | on_success |
| nejdelší doba přepojení (`permissions.outbound.maxMinutes`, 1–240 min) | on_success |
| nikdo nemluvil 5 min (textový režim: nic řečeno ani napsáno 3 min) | on_success |
| nikdo se nepřipojil zvukem do 30 s, `mode: fail` | `{ ok: false, reason: "failed" }` → **on_failed** |
| poskytovatel neotevřel stream do 20 s | on_failed |
| **volající zavěsil** | vše se zavře, zaloguje; TSA se neobnovuje (konec hovoru jí řekne webhook) |

Po `resume` server provede vrácené akce TSA na živém hovoru (Twilio: nové
TwiML hovoru, Vonage: transfer NCCO, Telnyx: příkazy Call Control) — tím
poskytovatel ukončí stream — a pak zavře svou stranu streamu. Když TSA není
nebo skončila bez akcí, hovor se zavěsí.

Zavěšení se pozná podle stavu hovoru v záznamech (`tel-store`, finální stav
z webhooku poskytovatele); když stream skončí a hovor podle záznamu ještě
běží, TSA dostane on_success („stream se zavřel").

## 5. Textový režim

`mode: "text"` a nikdo nepřevzal zvuk (nikdo připojený, nebo nikdo do 30 s):

- co volající řekne, se rozdělí na promluvy (detekce hlasu, `Segmenter`),
  přepíše (*AI & speech*, STT) a pošle jako oznámení serveru (`server-notice`)
  **celé místnosti** (u `user` jen členovi) a do karty hovoru;
- člen napíše odpověď do karty → přečte se volajícímu (TTS) — slyší ji i
  členové připojení zvukem;
- člen se může kdykoli připojit zvukem — přepis tím končí;
- jazyk přepisu a oznámení: `TELEPHONY_ROUTE_LANGUAGE` (výchozí `cs`).

## 6. Webový klient

Karta je layout **`phone.bridge`** (Layout builder, `lib/layouts/phonebridge.ts`)
— tentýž jako u telefonního můstku 6.0, rozšířený o přepojené hovory:

- proměnné `$calls[].route` (`room` / `user`, `""` = můstek 6.0),
  `.members` (kolik je ve zvuku), `.level` (0–5 dílků), stav `ignored`;
- akce `join` (*Připojit se zvukem*), `ignore` (*Teď ne* — karta se
  zúží na upozornění „telefonní hovor v místnosti" s tlačítkem *Připojit*),
  `leave` (*Odejít* — hovor jde dál ostatním);
- ve zvuku: měřič úrovně (`role="meter"`, hlasitější z toho, co slyším a co
  říkám), *Ztlumit*, *Odejít*, *Ukončit pro všechny*;
- náhledy v builderu: `room`, `room-audio`, `room-ignored`;
- texty cs / en / de (`phone.inRoom`, `phone.join`, `phone.ignore`,
  `phone.leave`, `phone.endAll`, `phone.inCall`, `phone.level`, …).

Media socket klienta: binárně 16bit little-endian PCM 16 kHz mono oběma
směry; JSON nahoru `audio` (připojit), `leave`, `hangup` (ukončit pro
všechny), `say` (text → hlas), `text-mode`; dolů `hello`, `roster`
(`members`), `transcript`, `ended`, `error`.

Po změně výchozího stromu layoutu je třeba obnovit archiv
(`npx tsx script/archive-layouts.ts`, jinak selže `test/layout-merge.test.ts`).

## 7. Android

Nativní aplikace zvuk můstku **nepřebírá** (už od 6.0): rámec `phone-bridge`
ukáže jen jako systémový řádek „☎ …" a upozornění. U přepojeného hovoru
tedy člen v aplikaci vidí, že hovor přišel, a **připojit se zvukem musí z
webu** (stejný účet / místnost v prohlížeči). Textový režim funguje i v
aplikaci — přepisy jsou běžná oznámení serveru; odpovědět psaním do karty
ale aplikace neumí.

## 8. Limity

| limit | hodnota |
|---|---|
| členů smíchaných najednou | 16 (`routeLimits.maxMembers`; další dostane „hovor je plný") |
| čekání na první připojení | 30 s |
| čekání na stream poskytovatele | 20 s |
| návrat po odchodu všech | 6 s |
| nečinnost (zvuk / text) | 5 min / 3 min |
| nejdelší přepojení | `permissions.outbound.maxMinutes` (výchozí 30, 1–240) |
| přepojení na jeden hovor | 1 (nové `route_audio` téhož hovoru nahradí staré) |
| text odpovědi | 1 000 znaků |

## 9. Soukromí a bezpečnost

- **Telefonní hovor není koncově šifrovaný** — jde telefonní sítí a server
  ho převádí a míchá (karta to říká).
- Místnost se hledá **jen podle slepého id** `r3.…`; jméno místnosti server
  nezná a nikdy nezjistí. Kód se jménem místnosti (id v2) se nepřepojí.
- Přepojí se **jen do místnosti, kterou kód jmenuje**; `@účet` mimo ni
  dostane hovor bez čísla volajícího.
- Každý člen má vlastní token media socketu (192 bitů), platný jen po dobu
  přepojení; neznámý token odmítne (404) obsluha můstku.
- Log (Telephony › Log, `kind` `inroute` / `call`): kód maskovaný (`•••1`),
  místnost jen jako hash (16 hex), počty, doby (`durationSec`, `memberSec`,
  `callerSec`), počty přepisů a odpovědí — **nikdy zvuk, nikdy co kdo řekl
  nebo napsal, nikdy slepé id ani jména členů**. Číslo volajícího je
  metadatum hovoru (záznam hovoru).

## 10. Známá omezení

- **Jedna instance**: přepojené hovory žijí v paměti hlavní služby; stream
  poskytovatele i media sockety členů musí dojít na tutéž instanci (bez
  REDIS clusteru nebo se sticky routováním `/media/tel/*`). Členové
  připojení k jiné instanci clusteru nabídku nedostanou.
- **Členové v hovoru místnosti (WebRTC)**, kteří se připojí i zvukem
  telefonu, uslyší ostatní dvakrát — jeden z hovorů je vhodné ztlumit.
- Simulátor TSA nemá zvuk: přepojení jen ohlásí, komu by šlo, a za 1,5 s
  pokračuje on_success.
- Zavěšení volajícího se pozná podle stavu hovoru v záznamech; když webhook
  se stavem dorazí později než 1,5 s po konci streamu, TSA dostane
  on_success a její další akce na mrtvém hovoru selžou (zaloguje se).

## 11. Pro vývojáře

| soubor | co |
|---|---|
| `server/telephony/route-audio.ts` | `telHooks.routeAudio`, rozhodnutí, přepojený hovor, textový režim, návrat do TSA |
| `server/telephony/mixer.ts` | mixer, jitter buffer, soft limiter (čisté funkce) |
| `server/telephony/bridge.ts` | WebSocket cesty `/media/tel/…` (`claimMedia` pro tokeny přepojení) |
| `server/signaling/hub.ts` | `roomMembers`, `sendToPeer`, `accountMembers` |
| `server/routes.ts` | `setRouteHub(…)` — napojení na hub |
| `client/src/lib/phone-bridge.ts` | karta z rámců, media socket, `leave`, měřič |
| `client/src/lib/room-hub.ts` | rámce `phone-bridge` z místností na pozadí |
| `client/src/lib/layouts/phonebridge.ts` | layout karty, kontrakt, náhledy |
| `test/telephony-route-audio.test.ts` | mixer, rozhodnutí, hovory end-to-end (Twilio, Vonage) |
| `test/phone-route-ui.test.tsx` | karta v prohlížeči |
