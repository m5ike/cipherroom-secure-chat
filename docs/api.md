# M5cet — API surface

> **Od 3.1.0:** nové cesty účtů (`passkeys`, `recovery`, `sessions`, `identity`), `/metrics`,
> krátkodobé TURN přístupy v `/api/turn`, operátorské `whoami`, `admins`, `audit/verify`,
> `backups`, `alerts`; binární rámce kusů souborů na `/ws` — viz
> [dokumentace › API reference](site/index.html#api) a [› Binární rámce](site/index.html#binarni-ramce).
> **Od 3.0.0:** WebSocket běží na protokolu v2 — rámce, validace, limity a chybové kódy popisuje
> [dokumentace 3.0 › Protokol](site/index.html#protokol); operátorské API `/api/admin/*`
> [› API reference](site/index.html#api-admin). `/api/events/recent` a `/api/transfers/stats`
> vyžadují admin token.

Všechny endpointy běží na stejném portu jako frontend (`PORT`, default 5000).
Cache-Control je všude `no-store`.

## Realtime

### `WSS /ws`

Frame format: JSON. Rámce delší než **128 000 znaků** server tiše zahodí
(bez chybové odpovědi). Klient → server:

```json
{ "type": "join",   "room": "string", "peerId": "string", "name": "string?",
  "auth": "účet-token?", "away": true }
{ "type": "signal", "target": "peerId", "payload": { ... } }
{ "type": "ping",   "t": 1700000000000 }
{ "type": "leave",  "away": true }
{ "type": "storage",   "id": "42", "op": "kv.put", "payload": { ... }, "auth": "token?", "session": "id?" }
{ "type": "relay",     "messageId": "...", "to": ["accountId"], "envelope": { "iv", "ciphertext" }, "mention?": ["accountId"], "call?": true,
  "callEnd?": true, "callId?": "...", "video?": true }
{ "type": "relay-ack", "ids": ["mailId"] }
{ "type": "presence",  "away": true, "foreground": false }
{ "type": "receipt",   "to": { "peerId?", "accountId?" }, "messageIds": ["..."], "state": "delivered|read" }
{ "type": "command-poll", "deviceId": "string?" }
{ "type": "command-ack",  "commandId": "string", "result": "string?" }
{ "type": "proxy-meta",  "kind": "proxy-meta",  "transferId": "...", "iv": "...", "ciphertext": "..." }
{ "type": "proxy-chunk", "kind": "proxy-chunk", "transferId": "...", "seq": 0, "iv": "...", "ciphertext": "..." }
{ "type": "proxy-end" | "proxy-cancel", "kind": "...", "transferId": "..." }
```

Sanitizace při `join`: `room` ≤ 64 znaků (fallback `default`), `peerId` ≤ 64,
`name` ≤ 48 (fallback `Anonymous`), znaková sada `[a-zA-Z0-9 ._-]`. Strop
počtu peerů na místnost není.

**Upozornění (6.7).** `relay.mention` (≤ 50, jen účty, které jsou i v `to`)
říká, že zpráva toho nepřítomného člena zmiňuje — server mu pošle upozornění
druhu `mention` místo `message`; web ho vyplní z `@jméno` (u zapečetených
zpráv ne). `relay.call` server přijme (druh `call`); od 6.14 ho posílají web
a Android, když volající zahájí hovor — viz [Buzení při hovoru (6.14)](#buzení-při-hovoru-614).
Obsah zprávy server ani tak nevidí.

Rámec `presence` hlásí, že prohlížeč stránku odložil (nebo vrátil), aniž by
klient opouštěl místnost: server pro něj začne (nebo přestane) přebírat
zprávy a po návratu hned pošle, co nasbíral. Viz
[`lifecycle-and-notices.md`](lifecycle-and-notices.md).

**Přítomnost (6.7).** `presence.foreground` (a `join.foreground`, výchozí
`true`) říká, jestli má člen aplikaci v popředí; starší klient bez pole se
čte jako `foreground = !away`. Server drží u každého člena `foreground`
a `lastSeen` (kdy měl naposledy aplikaci otevřenou a byl připojený) a změnu
pošle **jen členům té místnosti** jako `peer-presence`. Spojení, které spadne
bez `leave`, není odchod: místnost dostane `peer-left` s `held: true`
a člen zůstane v seznamu (`joined.held`), dokud se nevrátí se svým `resume`
(týž `peerId`), neodejde, nebo ho server neodstraní (operátor, zrušená
relace, vyhazov, `PRESENCE_MAX_AWAY_DAYS` — výchozí 7 dní, `0` = nikdy).
Prahy stavu (online ≤ 5 min, pryč ≤ 60 min, jinak dlouho pryč) jsou
v `client/src/lib/presence.ts`. Podrobně
[`accounts-away.md`](accounts-away.md#4-přítomnost-a-naposledy-online-67).

`auth` + `away` zapínají **stav away**: přihlášený uživatel (passkey účet)
zůstane v místnosti i po ztrátě socketu a server za něj přebírá zprávy
(`relay` → schránka → `relay-deliver` po návratu). Jeden socket smí poslat
120 `relay` rámců za minutu. Podrobně
[`accounts-away.md`](accounts-away.md).

Server odpovídá:

```json
{ "type": "hello",       "peerId": "...", "cache": "no-store", "ip": "proxied|direct" }
{ "type": "joined",      "peerId": "...", "room": "...", "peers": [{ "peerId", "name", "joinedAt", "accountId?", "foreground", "lastSeen" }],
  "away": [{ "accountId", "name", "since", "lastSeen" }], "held": [{ "peerId", "name", "joinedAt", "lastSeen", "since", "accountId?" }],
  "account": { "id", "away" } | { "invalid": true } | null, "policy": { ... } }
{ "type": "peer-joined", "peerId": "...", "name": "...", "joinedAt": 0, "accountId?": "...", "foreground": true, "lastSeen": 0 }
{ "type": "peer-left",   "peerId": "..." }
{ "type": "peer-left",   "peerId": "...", "held": true, "name": "...", "joinedAt": 0, "lastSeen": 0, "since": 0, "accountId?": "..." }
{ "type": "peer-presence", "peerId": "...", "foreground": false, "lastSeen": 0 }
{ "type": "peer-away",   "accountId": "...", "peerId": "...", "name": "...", "since": 0, "lastSeen": 0 }
{ "type": "peer-back",   "accountId": "...", "peerId": "...", "name": "..." }
{ "type": "peer-gone",   "accountId": "..." }
{ "type": "relay-deliver", "items": [{ "id", "kind", "messageId", "from", "envelope?", "status?", "storedAt" }] }
{ "type": "storage-result", "id": "42", "ok": true, "data": { ... } }
{ "type": "presence-ack", "away": true }
{ "type": "relay-status",  "messageId": "...", "recipient": { "accountId", "name" },
  "state": "stored|forwarded|delivered|read|rejected", "at": 0, "reason?": "..." }
{ "type": "signal",      "source": "peerId", "payload": { ... } }
{ "type": "pong",        "t": 0, "serverTs": 0 }
{ "type": "admin-command", "command": { "id", "kind", "createdAt", "payload?" } }
{ "type": "proxy-ack",   "transferId": "...", "transport": "proxy", "accepted": true, "reason?": "..." }
{ "type": "proxy-end" | "proxy-cancel", "transferId": "..." }
{ "type": "error",       "message": "Malformed signaling frame ignored." }
```

Heartbeat je aplikační (`ping` → `pong`); server sám WS ping neposílá a nemá
idle timeout.

> **Pozor — rate limit.** `wsUpgradeLimiter` (30/min) je Express middleware
> a při WS upgradu se nevolá; počet spojení tedy reálně omezen není.
> REST limiter níže funguje.

### Buzení při hovoru (6.14)

Hovor v místnosti po síti nezvoní: ohlášením je, že někomu naskočí zvuk (`audio-status`
„live“ v datovém kanálu), a to vidí jen členové s živým kanálem. Člen, který je **pryč**
(*away* — nemá v místnosti bdělý socket: stránka odložená, aplikace na pozadí nebo zavřená),
se o hovoru nedozvěděl, dokud se sám nevrátil. Od 6.14 klient volajícího pošle nepřítomným
**jednu relay položku na hovor** a server je probudí upozorněním druhu `call` (Android, web
push, na iOS PushKit/VoIP — bez něj iOS na pozadí vůbec nezazvoní). Když volající zavěsí dřív,
než to kdokoli vzal, druhá položka zvonění ukončí.

**Kdy klient budí** (web `client/src/lib/call-wake.ts` z `App.tsx`, Android `chat/CallWake.java`
z `Calls`/`RoomSession`, iOS stejně — viz `ios/M5cet/Platform/Calls/README.md`):

1. server v `hello.features` hlásí **`"call-wake"`** (jinak klient nebudí vůbec — starý server);
2. já právě zapnul zvuk (hlas i video) a **nikdo jiný v hovoru není** (žádný peer nemá
   `audio-status` `live` / `muted`) — hovor zahajuji (Androidí `CallTrack`: odchozí). Kdo se
   připojuje k cizímu hovoru, nebudí nikoho;
3. v místnosti je aspoň jeden člen **away**, který se mnou nemá otevřený datový kanál (ten hovor
   vidí sám). Nejvýš 50 příjemců.

**Konec** (`callEnd`) pošle klient, když zavěsí a během jeho hovoru nikomu jinému nenaskočil
zvuk (= nikdo to nevzal), a jen těm příjemcům zvonění, kteří jsou pořád away (kdo se vrátil,
vidí místnost). Kdo ukončí spojení s místností úplně, konec už nepošle — zvonění pak skončí
samo po 60 s.

#### Relay rámec

```json
{ "type": "relay", "messageId": "cw-…:r", "to": ["ref…"], "per?": { "ref": { … } }, "envelope?": { … },
  "call": true, "callId": "cw-<24 hex>", "video?": true }
{ "type": "relay", "messageId": "cw-…:e", "to": ["ref…"], "per?": { "ref": { … } }, "envelope?": { … },
  "callEnd": true, "callId": "cw-<24 hex>", "video?": true }
```

Kontrola (`server/signaling/frames.ts`): `callId` je id (`[A-Za-z0-9_:.-]`, nejvýš 96 znaků),
`callEnd` bez `callId` i `call` spolu s `callEnd` je `invalid-frame`; bez `call` / `callEnd`
server pole `callId` a `video` zahodí (zpráva zůstane zprávou); platí jen `true`. `call: true`
bez `callId` (rámec klienta 6.7) server přijme a dá mu id `call-<messageId>`. `messageId` je
`<callId>:r` / `<callId>:e`, takže opakované odeslání fronta odhalí jako duplikát (nebudí
podruhé). Obálky (`per` protokolu 4 do schránek zařízení, jinak `envelope` protokolu 3) jsou
přesně jako u zprávy — klient používá `relayToAway` / `P4Relay`, žádná nová kryptografie.

#### Zapečetěný obsah

```json
{ "kind": "call", "id": "cw-…:r", "createdAt": 1760000000000, "senderId": "<peerId>", "senderName": "Alice",
  "call": "cw-…", "state": "ring" | "end", "video": false, "at": 1760000000000 }
```

`at` = kdy hovor začal (hodiny volajícího). Příjemce ho kontroluje jako zprávu: odesílatel musí
být peer, za kterého server položku předal, nikdy my ani vyhrazené id; jméno se normalizuje,
čas víc než 5 min dopředu se srazí na „teď“, id prochází oknem proti přehrání (§ 11). **Starší
klienti** neznámý `kind` tiše zahodí (web `validatePayload`, Android `Payloads.validate`, iOS
`Payloads.validate`): položku potvrdí a nic neukážou.

#### Server

* **Relay** (`server/signaling/relay.ts`): položka se uloží jako zpráva (příjemci z ní později
  udělají záznam hovoru); nepřítomného probudí druh `call` s `call: { id, video, end? }`. Kdo je
  v místnosti vzhůru, dostane ji předanou (`forwarded`) a nebudí se.
* **Limit** (`CALL_WAKE_LIMITS`): jeden odesílatel (účet, bez účtu adresa) smí v jedné místnosti
  zazvonit nejvýš jednou za 10 s a 6× za 10 min; nad limit se položka uloží, ale nikoho
  nebudí (audit `relay.call-limited`). Konec limitovaný není — notifikátor ho pošle jen tam, kam
  šlo zvonění.
* **Notifikátor** (`server/notify/dispatch.ts`): zvonění projde všemi kontrolami jako dosud
  (provozovatel má druh zapnutý, uživatel nemá vypnutá upozornění ani **Hovory**, nejsou tiché
  hodiny, throttle 5 s, hodinový limit) — **kdo má hovory vypnuté, nebudí se**. Odeslané zvonění
  si pamatuje 10 min (účet | místnost | `callId` → kanál, čas). Konec jde **jen tam, kam šlo
  zvonění**, jen tím kanálem, **nikdy e-mailem**, ne tomu, kdo je už v místnosti; kontrolami
  uživatele neprochází (prošlo jimi jeho zvonění, jeden konec na jedno zvonění). Text konce je
  `CALL_MISSED_BODY` („[{sender}: ]Zmeškaný hovor“ v devíti jazycích) s titulkem šablony
  `call`, bez zvuku, vibrace a „sticky“.
* **Obsah upozornění** (`NotifyPayload`): `tag: "m5-call-<callId>"` (zvonění i konec mají stejný
  — konec nahradí zvonění, zpráva ne), `call: { id, video, at, end?, room? }` — `at` čas
  zvonění podle serveru, **`room` jen pro kanál aplikace** (Android / iOS: zapečetěné pro jedno
  zařízení, které si ho přeloží na svou místnost). **Životnost 60 s na všech kanálech** — starší
  zvonění už nezvoní.

#### Co nese push

| kanál | zvonění | konec |
|---|---|---|
| **web push** (RFC 8291, šifrováno pro prohlížeč) | `NotifyPayload` + `call` (bez místnosti), `TTL: 60`, `Urgency: high`, topic z tagu | totéž s `call.end`; service worker zavře zvonění (`data.call`) a ukáže tiché „Zmeškaný hovor“ se stejným tagem |
| **Android FCM** | data jen `{m5, i, e, iv, ct, s}`; zapečetěno `{id, kind:"notify", at, exp: at+60 s, payload: NotifyPayload + call{id, room, video, at}}`; priorita HIGH, ttl 60, collapse `m5-notify-m5-call-<id>` | totéž s `call.end`; **jen aplikaci ≥ 6.14.0** (`appCode` 61400 — starší by „zmeškaný hovor“ zvonila na kanálu hovorů) |
| **iOS s VoIP tokenem** | PushKit: `{ "m5": {m5:"1", i, e, iv, ct, s} }`, topic `<bundle>.voip`, priorita 10, `apns-expiration` = teď + 60 s; zapečetěno `{id, kind:"call", at, exp, payload:{call, room, who, video, at}}` | `kind:"call-end"`, **jen do 60 s od zvonění** (pak už telefon zvonění ukončil sám a VoIP push by v CallKitu jen problikl) |
| **iOS bez VoIP tokenu** | alert s neutrálním „Příchozí hovor“, `apns-collapse-id: m5-call-<id>`, obsah jako na Androidu | alert „Zmeškaný hovor“ bez zvuku, stejné `apns-collapse-id` (nahradí zvonění) |

`who` ve VoIP pushi je jméno volajícího, jen pokud ho úroveň soukromí uživatele pustí
(`vars.sender`), jinak `""`; co ukáže CallKit, rozhoduje aplikace.

#### Příjemci

* **Android** (`telecom/CallRing.pushed`, `chat/CallWake`): push místnosti, kterou má aplikace
  otevřenou (`Rooms.byServerId(call.room)`), zvoní **stejně jako hovor, který místnost vidí**
  (`CallRing.ring`: kanál hovorů, kategorie call, Přidat se / Odmítnout, zmizí po 60 s, stejné
  upozornění — pozdější zvonění místnosti ho jen nahradí). Plnoobrazovkový intent ani
  ConnectionService aplikace nepoužívá ani u živých hovorů (`M5ConnectionService` odmítá každé
  spojení) — parita. *Přidat se* otevře místnost a počká (až 60 s), až se připojí a hovor
  ukáže, pak zapne zvuk; *Odmítnout* = odmítnutý hovor (i když ho místnost ukáže později, znovu
  nezazvoní). Konec → zvonění zmizí, Záznam dostane zmeškaný hovor a upozornění „Zmeškaný
  hovor“; bez odpovědi do 60 s totéž. Místnost, kterou aplikace otevřenou nemá: šablonové
  upozornění jako dosud (zvonění 60 s, konec tichý zmeškaný hovor).
* **Web**: service worker viz tabulka. Položka z fronty po návratu: konec → hned „📞 Zmeškaný
  hovor od X (čas)“ v chatu; zvonění počká 30 s, jestli místnost hovor neukáže (někomu naskočí
  zvuk) — pak ho má místnost, jinak zmeškaný hovor. Web historii hovorů nemá.
* **Jeden záznam na hovor**: jakmile místnost hovor ukáže, zaznamená ho její `CallTrack`
  (příchozí, zmeškaný, odmítnutý); zvonění z pushe i položka z fronty se pak zahodí. Stejný
  hovor (`callId`) se nezaznamená dvakrát.

#### Co se server dozví

Totéž co u každé zprávy s `call: true`: **probuzení kvůli hovoru od člena X v místnosti R
členům Y** a kdy — navíc náhodné `callId` (spojí zvonění s jeho koncem), příznak videa a že
zvonění skončilo nepřijaté. Obsah ne. Služby pushů: FCM vidí šifrový text a collapse klíč
s náhodným `callId`, APNs šifrový text (VoIP) nebo neutrální text, služba web push šifrový text
a topic odvozený z tagu. **ID místnosti a jméno volajícího jen uvnitř zapečetěných částí**,
nikdy v čitelné části pushe.

#### Změny chování

* Upozornění druhu `call` s informací o hovoru má tag `m5-call-<callId>` (dřív podle šablony
  `m5-call` / místnost) a na Androidu i iOS žije 60 s (dřív hodinu jako ostatní).
* Obsah VoIP pushe na iOS je nově hovor (`kind: "call"` / `"call-end"`), ne `notify` s
  `NotifyPayload`.
* Starý server (bez `call-wake`): klienti nebudí — beze změny. Starší klienti položku tiše
  zahodí; Android < 6.14 dostane zvonění jako šablonové upozornění 6.7 a konec žádný.

## REST

Všechny `/api/*` cesty: **100 požadavků / 15 min na IP** (`429` s JSON
zprávou). Za reverse proxy se IP klienta bere z `X-Forwarded-For` jen od
důvěryhodné proxy (`TRUST_PROXY`, výchozí loopback) — viz
[`troubleshooting.md`](troubleshooting.md).

**Operátorské cesty** vyžadují admin token (`Authorization: Bearer
$ADMIN_API_TOKEN`, porovnání v konstantním čase — `server/admin-auth.ts`):
`GET|POST /api/admin/retention*` a broadcast přes `POST /api/push/test`.
Bez nastaveného `ADMIN_API_TOKEN` vracejí `503`, bez tokenu / se špatným
`401` (s `WWW-Authenticate: Bearer`). Ostatní endpointy autentizaci nemají.
Jsou v hlavní službě, ne v admin procesu, protože stav, se kterým pracují,
žije v paměti hlavní služby (admin proces má vlastní, prázdné kopie).
Neznámá cesta pod `/api/` vrací `index.html` (SPA fallback), ne `404`.

### Health & meta

- `GET /api/health` → `{ ok, rooms, cache, persistence, role, version, build, builtAt }`
  (`build` = git commit sestavení z `dist/public/build.json`)
- `GET /api/modules` → `{ modes[], features{}, push{}, events{}, turn{ enabled, credentialUrl } }`
- `GET /api/turn` → `{ ok, iceServers[] }` včetně TURN `username`/`credential`.
  Bez `TURN_SERVER_URL` `200 { ok: true, configured: false, iceServers: [] }`
  (klient použije jen STUN), `503` když chybí údaje. Údaje jsou **statické**
  a vydají se komukoli — používejte účet vyhrazený jen pro TURN.
- `GET /api/transfers/stats` → `{ ok, totalActive, totalByPeer, maxParallel, capBytes, ttlMs }`

### Push

- `GET /api/push/status` → `{ enabled, vapidPublicKey, subscribers }`
- `POST /api/push/subscribe` → body `{ subscription, deviceId? }`. Vrací `{ ok, id }`.
  `503` bez VAPID, `400` pokud endpoint není `https://`.
- `POST /api/push/test` — dva režimy (limit 10 / min na IP navíc k REST limitu):
  - **self-test**, bez tokenu: body `{ id }` = vlastní id odběru z
    `subscribe` (klient ho drží v `localStorage` `m5cet:push:id`). Pošle
    **pevný** text („M5cet · test") jen na tuto subskripci; `title`/`body`
    se ignorují. `200 { ok, mode: "self" }`, `404` neznámé id (např. po
    restartu serveru), `502` když push služba doručení odmítne, `503` bez VAPID.
  - **broadcast**, jen s admin tokenem: body `{ broadcast: true, title?, body? }`
    (i požadavek **bez `id`** se bere jako broadcast). Pošle text všem
    subskripcím → `{ ok, mode: "broadcast", sent, failed, results[] }`.
    Bez tokenu `401` / `503` (kontroluje se dřív než cokoli jiného).
- Odhlášení (`unsubscribe`) anonymní subskripce neexistuje; mizí přes
  `/api/audit/purge`, retenci, restart nebo (6.7) odpověď 404 / 410 push
  služby. Odběr přihlášeného prohlížeče patří k účtu a ruší se
  `DELETE /api/account/push` (6.7, níže).

### Upozornění (6.7, `server/notify/*`, podrobně [`push.md`](push.md))

| Metoda a cesta | Kdo | Poznámka |
|---|---|---|
| `GET /api/notify/config` | kdokoli | šablony, druhy a přepínače kanálů (bez SMTP) |
| `GET \| PUT /api/account/notify` | `Bearer <token>` + modul `notifications` | volba účtu `{ on, kinds, privacy, order, quiet, lang }` a jeho koncové body |
| `POST /api/account/notify/test` | totéž | `{ channel? }`; 6 / min na IP a `testsPerHour` účtu; `200` / `409` nic neodešlo / `502` žádná cesta to nevzala |
| `POST \| DELETE /api/account/notify/email` | totéž | adresa pro upozornění — přijde potvrzovací e-mail (odkaz platí 48 h); POST 5 / h; `409`, když server e-maily neposílá |
| `GET /api/notify/email/confirm?t=…` | odkaz z e-mailu | potvrdí adresu |
| `DELETE /api/account/push` | `Bearer <token>` | `{ endpoint }` — tento prohlížeč přestane být buzen |
| `POST /api/android/notify` | zařízení (podepsaný požadavek) | `{ token, on }` — budit zařízení pro účet té relace |
| `GET \| PUT /api/admin/notify`, `POST /api/admin/notify/preview \| test \| email/test`, `GET /api/admin/notify/log` | admin token, oblast konzole `notifications` (změny potřebují `edit`) | nastavení operátora; heslo SMTP zapečetěné (`""` ponechá, `null` smaže); náhled šablony renderuje server |

### Veřejný profil (6.7, `server/accounts/public-profile.ts`)

| Metoda a cesta | Kdo | Poznámka |
|---|---|---|
| `GET /api/profile/:username` | kdokoli | veřejná část profilu `{ ok, username, profile, updatedAt, accountKey? }`; uživatelské jméno bez ohledu na velikost písmen; `404 no-profile` (chybí profil i účet — neodliší se); 60 / min na IP |
| `GET \| PUT \| DELETE /api/profile` | `Bearer <token>` (jinak `401 signed-out`) | vlastní veřejná část; `PUT { profile }` → `400 invalid \| bad-image \| empty`, `413 too-large`; PUT/DELETE 30 / 10 min na účet |
| `GET \| DELETE /api/admin/users/:id/public-profile` | admin token — čtení auditor, smazání operátor | moderace: zobrazit / odebrat (audit `admin.user.profile-removed`); uživatel může profil zveřejnit znovu |

Obě veřejné odpovědi mají `Cache-Control: no-store`; celé `/api/profile*` má
vlastní limit 600 / 15 min a tělo JSON do 1 MB. Server ukládá jen
normalizovanou veřejnou část (`$ACCOUNTS_DIR/profiles/<id>.json`, 0600);
obrázky (`data:` JPEG / PNG / WebP) neskóduje znovu, ale ověří skutečný formát,
velikost (≤ 4096 px na stranu, ≤ 8 000 000 px) a odstraní metadata. Položky
„jen já“ jsou v trezoru účtu (slot `card`, `GET /api/account/vault?only=card`),
položky „členové místností“ jdou jen P2P párovým klíčem (`{kind:"profile"}` —
viz DataChannel níže). Smazání účtu smaže i veřejný profil.

### Events (server-enhanced mode)

- `GET /api/events/recent?limit=50` — vyžaduje `LOG_EVENTS=1` (jinak `404`); limit 1–500
- `POST /api/events` — body `{ kind, room?, peerId?, meta? }`. Plaintext zpráv se
  nikdy neloguje.

### Settings sync (in-memory stub; klient ho zatím nevolá)

- `GET /api/settings?deviceId=...` → `{ ok, deviceId, settings, updatedAt }`
- `POST /api/settings` → `{ deviceId, settings }`. Vlastní obsah neinterpretovaný —
  kientský JSON. Doporučujeme klást jen ne-tajná data (téma, jazyk, font).
  Od 6.7 (audit V4) nejvýš 16 kB na zařízení (`413`), nejvýš 5000 zařízení
  (nejstarší zápis vypadne) a záznam po retenci zmizí i při čtení. Kdo zná
  `deviceId`, dál nastavení čte i přepisuje (vazba na doklad zařízení chybí).

### Audit

- `POST /api/audit/purge` → body `{ deviceId }`. Smaže settings, audit log,
  consent, push subskripce navázané na `deviceId`.
- `GET  /api/audit/log?deviceId=...` → `{ ok, deviceId, entries }`. Do logu zatím
  nic nezapisuje, vrací vždy prázdné pole.

### Pozvánky (split-key, viz [`session-and-sharing.md`](session-and-sharing.md))

- `POST /api/share/create` → body `{ id, proof, revokeToken, serverKey, iv, ciphertext, maxUses?, ttlSec? }`
  (base64url pevných délek; `maxUses` 1–50, `ttlSec` 300–604800). `201 { ok, expiresAt, maxUses, maxAttempts }`.
- `POST /api/share/redeem` → body `{ id, proof }`. Správně: `{ ok, serverKey, iv, ciphertext, usesLeft }`.
  Špatný kód `403 { reason: "wrong-code", attemptsLeft }`, po 5. pokusu `410 burned`;
  neznámé, vadné i prošlé ID shodně `404`. **Jen `POST`** — `GET` nic nespotřebuje.
- `POST /api/share/revoke` → body `{ id, revokeToken }` → `{ ok }`.

Server nikdy nedostane klíč z fragmentu URL, takže uložená data nerozšifruje.
Vše je v paměti procesu.

### Odchod

- `GET /goodbye` → statická stránka s `Clear-Site-Data: "cache", "cookies", "storage", "executionContexts"`.

### Úložiště (`/api/storage/*`)

Jedna globální SQLite databáze pro server, jedna SQLCipher databáze pro
každého uživatele (klíč z passkey) nebo pro anonymní relaci (klíč serveru,
TTL 1 den). Kompletní přehled včetně tabulek a operací přes WebSocket je v
[`storage.md`](storage.md).

| Metoda a cesta | Autorizace | Co dělá |
| --- | --- | --- |
| `GET /api/storage/status` | — | dostupnost, engine, statistiky |
| `POST /api/storage/session` | — | založí/obnoví relaci bez passkey |
| `POST /api/storage/open` | `Bearer` | otevře databázi účtu klíčem z passkey |
| `POST /api/storage/promote` | `Bearer` | převede data relace pod účet |
| `GET /api/storage/summary` | účet \| relace | velikosti, místnosti, schránka |
| `GET \| PUT \| DELETE /api/storage/kv` | účet \| relace | hodnoty (nastavení, trezor) |
| `GET \| POST \| DELETE /api/storage/messages` | účet \| relace | zprávy |
| `GET /api/storage/rooms` | účet \| relace | místnosti |
| `GET /api/storage/mailbox`, `POST /api/storage/mailbox/take` | účet \| relace | schránka |
| `GET \| POST /api/storage/events` | účet \| relace | auditní stopa uživatele |
| `POST /api/storage/log` | účet \| relace | log / ladicí řádek |
| `GET \| POST /api/storage/transfers` | účet \| relace | přenosy |
| `DELETE /api/storage` | účet \| relace | smaže vše, co volajícímu patří |
| `GET /api/admin/storage`, `…/logs`, `…/transfers` | admin token | index, uživatelé, logy, přenosy |

Relace se identifikuje hlavičkou `X-M5cet-Session`. Limity: 600 požadavků /
15 min (vlastní kbelík), tělo do 12 MB, 600 rámců za minutu na socket.
Proměnné: `STORAGE_DIR`, `STORAGE_MASTER_KEY`.

### Účty s passkey (`/api/account/*`)

Ověření podpisem WebAuthn, data zapečetěná klíčem z PRF rozšíření — server
drží jen šifrový text. Celé to popisuje
[`accounts-away.md`](accounts-away.md).

| Metoda a cesta | Autorizace | Co dělá |
| --- | --- | --- |
| `GET /api/account/status` | — | dostupnost, `rpId`, `persistent` |
| `POST /api/account/register/options` \| `/verify` | — (výzva) | vytvoření účtu |
| `POST /api/account/signin/options` \| `/verify` | — (výzva) | přihlášení |
| `GET /api/account/me` | `Bearer <token>` | velikosti, data, počty, audit |
| `GET \| PUT /api/account/vault` | `Bearer <token>` | zapečetěný profil + chat (a další sloty; 6.7: `card` — karta profilu se všemi publiky, ≤ 400 000 znaků; `GET …?only=card` vrátí jen ji) |
| `POST /api/account/event` | `Bearer <token>` | `decrypt-ok`, `decrypt-failed`, `data-loaded`, `data-cleared`, `chat-restored` |
| `POST /api/account/push` | `Bearer <token>` | propojení Web Push odběru |
| `POST /api/account/signout` | `Bearer <token>` | zneplatnění tokenu (`everywhere`) |
| `DELETE /api/account` | `Bearer <token>` | smazání účtu, trezoru i schránky |

Limity: ceremonie 30 / 10 min na IP, trezor 300 / 15 min (mimo veřejný limit
100 / 15 min), tělo trezoru do 8 MB, profil 128 000 znaků, chat 6 000 000
znaků. Výzva je jednorázová, platnost 2 minuty. Tokeny žijí 12 h a jen
v paměti — restart odhlásí.

Proměnné prostředí: `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `ACCOUNTS_DIR`
(jinak `$DATA_DIR/accounts`), `RELAY_RETENTION_DAYS` (30),
`PRESENCE_MAX_AWAY_DAYS` (7; jak dlouho zůstane v seznamu člen, jehož
spojení spadlo; desetinná čísla jdou, `0` = navždy), `ACCOUNTS_MAX` (5000,
6.7; plné úložiště nejdřív odstraní nejvýš 100 nikdy nepoužitých registrací
starších než týden, pak registrace vrací `409 account store full` a audit
`accounts.full`).

### Retence

Obě cesty vyžadují **admin token** (`503` bez `ADMIN_API_TOKEN`, `401` bez
něj / se špatným).

- `GET  /api/admin/retention` → `{ ok, policy, intervalMinutes, scheduled,
  nextSweepAt, lastSweep }` — politika v dnech z `*_RETENTION_DAYS`,
  plán a výsledek posledního sweepu (`trigger: "timer" | "manual"`).
- `POST /api/admin/retention/run` → sweep hned → `{ ok, removed{…}, total, ranAt, trigger }`.

Sweep běží i **sám**: hlavní služba ho spouští každých `RETENTION_SWEEP_MINUTES`
(výchozí 60, rozsah 1–1440) na `unref`-nutém timeru. Každá kategorie se
maže podle **svého** okna:

| Kategorie | Proměnná | Výchozí |
|---|---|---|
| settings sync | `SETTINGS_RETENTION_DAYS` | 30 dní |
| audit (`/api/audit/log`) | `AUDIT_RETENTION_DAYS` | 60 dní |
| push subskripce | `PUSH_RETENTION_DAYS` | 90 dní |
| analytics consent | `DATA_RETENTION_DAYS` | 30 dní |
| události (event ring, `LOG_EVENTS=1`) | `EVENT_RETENTION_DAYS` | 7 dní |

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" https://chat.example.org/api/admin/retention
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://chat.example.org/api/admin/retention/run
```

### Analytics consent (in-memory stub; klient ho zatím nevolá)

- `POST /api/analytics/consent` → `{ deviceId, analyticsConsent: bool }`
- `GET  /api/analytics/consent?deviceId=...` → `{ ok, record }`

## DataChannel payload (encrypted by client)

Každý paket v WebRTC DataChannelu je `{ iv, ciphertext }` (base64). Po dešifrování:

```ts
type DecryptedPayload =
  | {
      kind?: "text";
      id: string;
      text: string;
      createdAt: number;
      senderId: string;
      senderName: string;
      attachment?: { kind, name, mime, size, dataUrl };   // inline ≤ 512 KiB
      ttlMinutes?: number;
    }
  | {
      kind: "audio-status";
      id, createdAt, senderId, senderName,
      status: "off" | "joining" | "live" | "muted";
    };
```

**Profil v místnosti (6.7, `client/src/lib/profile/room.ts`, Android
`profile/ProfileRoom.java`).** Payload `{ kind: "profile", id, createdAt,
senderId, senderName, rev, want?, profile? }` jde vždy jednomu peeru,
zapečetěný **párovým klíčem** (`sealPrivate`) — nikdy klíčem místnosti
a nikdy přes server; nezapečetěný se odmítne. Tři tvary: oznámení `{rev}`
(peeru, jehož hello nabízí schopnost `profile`, a všem, když se profil
změní), žádost `{rev, want: true}` a celý `{rev, profile}`. Příjemce přijme
celý profil jen pro `rev`, o který sám požádal, a drží ho podle klíče
zařízení odesílatele a `rev` (LRU 64); odpověď nejvýš jednou za 30 s na peer
a verzi; rámec nad 240 000 znaků se pošle znovu bez obrázku pozadí.

## Frontend window API

`window.CipherRoomAPI` (viz `client/src/lib/cipherroom-api.ts`) je plugin registry pro
externí widgety. Skutečné rozhraní (read-only, instaluje se jednou — první
instalace vyhrává):

```ts
window.CipherRoomAPI.version                 // "1.0.0"
window.CipherRoomAPI.capabilities            // detekce funkcí prohlížeče
window.CipherRoomAPI.modules()               // Promise<manifest z GET /api/modules | null>
window.CipherRoomAPI.pushStatus()            // Promise<stav z GET /api/push/status>
window.CipherRoomAPI.recordEvent({ kind, meta? })   // POST /api/events
const off = window.CipherRoomAPI.on("message", ({ senderId }) => { ... })
```

Aplikace dnes vysílá jedinou událost: `message` s `{ senderId }` — nikdy
s obsahem zprávy. `registerWindow` / `openWindow` / `dispatch` zmiňované ve
starší dokumentaci v kódu nejsou.

Toto rozhraní je sdílené napříč všemi tématy (Motorsport / Glass / Terminal) a nesahá
na šifrovací klíč.
