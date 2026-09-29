# M5cet — telefonie: hovory, SMS, SIP trunky, webhooky

Volitelný serverový modul. Umí odeslat **SMS** a založit **hovor** na mobil či
pevnou linku přes **Twilio, Telnyx nebo Vonage (Nexmo)**, spravovat konfiguraci
**SIP trunků** (perzistentně) a přijímat **webhooky** poskytovatelů (doručenky,
příchozí SMS, události hovoru) na hlavní aplikaci pod `/wh/{provider}/{typ}`.

Vše se zapíná a nastavuje v `.env` (klíče nikdy nejsou v kódu ani se nevrací
klientovi). Default je **vypnuto**.

## 1. Zapnutí a volba poskytovatele

```env
ENABLE_TELEPHONY=1
PUBLIC_BASE_URL=https://chat.example.org     # veřejná adresa appky (pro webhooky)

# Který poskytovatel obsluhuje SMS a který hovory (twilio | telnyx | vonage):
SMS_PROVIDER=twilio
VOICE_PROVIDER=vonage
```

**Pořadí, jak se vybírá poskytovatel** (pro SMS i pro hovory zvlášť):

1. `connector` uvedený přímo v požadavku (`POST /api/telephony/sms {connector:"telnyx"}`),
2. **volba v administraci** (*Default providers* → uloží se do datového souboru, přežije restart),
3. `SMS_PROVIDER` / `VOICE_PROVIDER` z `.env`,
4. první poskytovatel, který je skutečně nakonfigurovaný.

Administrace u každého defaultu ukazuje, který krok ho určil (`admin` / `env` / `auto`).

## 2. Poskytovatelé

| Poskytovatel | SMS | Hovor | Proměnné |
|---|---|---|---|
| **Twilio** | ✅ | ✅ | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, volitelně `TWILIO_VOICE_URL` (TwiML) |
| **Telnyx** | ✅ | ✅ | `TELNYX_API_KEY`, `TELNYX_FROM`, `TELNYX_CONNECTION_ID` (call‑control app), volitelně `TELNYX_MESSAGING_PROFILE_ID` |
| **Vonage** | ✅ | ✅ | SMS: `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_FROM` · Hovor: `VONAGE_APPLICATION_ID`, `VONAGE_JWT_KEY` |

### Vonage Voice — JWT aplikace

Vonage Voice API se autentizuje **JWT podepsaným privátním klíčem aplikace**
(RS256), ne API klíčem. Server ho razí sám (`node:crypto`, bez závislostí):

```env
VONAGE_APPLICATION_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
# privátní klíč aplikace (private.key z Vonage dashboardu), buď s "\n":
VONAGE_JWT_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----"
# …nebo cestou k souboru:
# VONAGE_PRIVATE_KEY_PATH=/etc/m5cet/vonage-private.key
VONAGE_FROM=447700900000
```

(`VONAGE_PRIVATE_KEY` je alias pro `VONAGE_JWT_KEY`.)

**Pozor na víceřádkový klíč v `.env` bez uvozovek.** Parser `.env` (i systemd
`EnvironmentFile`) si z něj nechá jen první řádek `-----BEGIN PRIVATE KEY-----`
a hovor pak padal na `502 … error:1E08010C:DECODER routines::unsupported`.
Od teď se klíč kontroluje už ve stavu konektoru: admin (Telephony) i
`/api/telephony/call` hlásí přesnou příčinu (`VONAGE_JWT_KEY holds only the PEM
header line …`, `… is a public key …`, `… passphrase-protected`, `… cannot be
read: ENOENT` …) a volání vrátí 503 dřív, než cokoli odejde k Vonage.
Přijímané tvary: PEM v uvozovkách, jeden řádek s `\n` (i `\\n`, `\r\n`),
PEM slitý do řádku s mezerami, PKCS#1 `RSA PRIVATE KEY`, base64 celého PEM,
holé base64 tělo, cesta k souboru (i přímo ve `VONAGE_JWT_KEY`) a hotový JWT
z Vonage „JWT generatoru" (použije se, dokud nevyprší — lepší je klíč, token
se pak razí pro každý hovor zvlášť). Nejjednodušší a nejspolehlivější je
soubor:

```bash
install -m 0640 -o root -g m5cet private.key /etc/m5cet/vonage-private.key
# .env
VONAGE_PRIVATE_KEY_PATH=/etc/m5cet/vonage-private.key
```

(v Dockeru soubor namountovat do kontejneru). Odpověď Vonage `401` znamená,
že klíč nepatří k `VONAGE_APPLICATION_ID`, nebo aplikace nemá zapnutou Voice.

Hovor se zakládá přes
`POST https://api.nexmo.com/v1/calls` s `Authorization: Bearer <jwt>`; když je
nastaven `PUBLIC_BASE_URL`, předá se `answer_url` = `/wh/vonage/answer` (vrátí
NCCO) a `event_url` = `/wh/vonage/events`, jinak inline NCCO `talk`.

Čísla pro Vonage jdou bez `+` (převádí se automaticky).

## 3. Webhooky — `/wh/{provider}/{typ}` na hlavní appce

Obsluhuje je **hlavní aplikace (port 5000)**, ne admin. Nginx je musí proxovat
(`location /wh/` v [deploy/nginx/m5cet.conf](../deploy/nginx/m5cet.conf)) a
`PUBLIC_BASE_URL` musí být přesně veřejná adresa (Twilio podepisuje celé URL).

| Endpoint | Co přijde | Odpověď |
|---|---|---|
| `POST /wh/twilio/sms` | příchozí SMS na tvé číslo | prázdné TwiML |
| `POST /wh/twilio/sms_status` | doručenky SMS | prázdné TwiML |
| `POST /wh/twilio/voice` | answer URL (příchozí i naše testovací hovory) | TwiML `<Say>` |
| `POST /wh/twilio/voice_status` | průběh hovoru (initiated/ringing/answered/completed) | prázdné TwiML |
| `POST /wh/telnyx/events` | všechny messaging + call‑control události | JSON |
| `ANY /wh/vonage/sms` | příchozí SMS (SMS API) | JSON |
| `ANY /wh/vonage/sms_status` | doručenky (SMS API) | JSON |
| `ANY /wh/vonage/answer` | answer URL hovoru | **NCCO** (`talk`) |
| `POST /wh/vonage/events` | události hovoru + Messages API | JSON |

Text hlášky pro `<Say>` / NCCO: `TELEPHONY_GREETING`.

### Ověřování podpisů

| Poskytovatel | Mechanismus | Potřebuje |
|---|---|---|
| Twilio | `X-Twilio-Signature` = base64(HMAC‑SHA1(auth token, URL + seřazené parametry)) | `TWILIO_AUTH_TOKEN` (máš už kvůli odesílání) |
| Telnyx | Ed25519 nad `<timestamp>|<tělo>`, tolerance 5 min | `TELNYX_PUBLIC_KEY` (portál → API Keys → Public Key) |
| Vonage | `Authorization: Bearer <HS256 JWT>`, `payload_hash` = SHA‑256 těla; legacy SMS API volitelně `sig` (md5) | `VONAGE_SIGNATURE_SECRET` |

Když je ověřovací materiál nastaven, kontrola je **vynucená** — špatný podpis =
`403`. Když nastaven není, událost se přijme, ale uloží jako **neověřená** a do
logu jde varování. Události nikdy nespouští nic placeného; jen se logují,
zobrazují v adminu a u příchozích SMS/hovorů se dopočítá **routing DID → SIP
trunk**.

### Kde události vidíš

Webhooky přijímá **appka**, ale konzole běží v **admin procesu**. Proto se
přijaté události ukládají do sdíleného souboru `telephony-events.json` vedle
datového souboru (posledních 500, atomický zápis, `0600`) a admin je čte odtud
(*Inbound / status events*; *Clear* smaže soubor, takže platí i pro appku).
Pokud není kam psát, drží si je každý proces jen v paměti.

### Instalace webhooků u poskytovatele

Admin → *Webhooks* → **Install in …** provede skutečná API volání:

- **Twilio**: najde číslo `TWILIO_FROM` v účtu a nastaví mu `SmsUrl`, `VoiceUrl`,
  `StatusCallback`. Doručenky SMS se žádají per zpráva automaticky.
- **Telnyx**: `PATCH messaging_profiles/{TELNYX_MESSAGING_PROFILE_ID}` (`webhook_url`)
  a `PATCH call_control_applications/{TELNYX_CONNECTION_ID}` (`webhook_event_url`).
- **Vonage**: `PUT /v2/applications/{VONAGE_APPLICATION_ID}` — voice `answer_url`
  + `event_url`, messages `inbound_url` + `status_url` (potřebuje `VONAGE_API_KEY`
  + `VONAGE_API_SECRET`). Legacy SMS API URL (`/wh/vonage/sms`, `/wh/vonage/sms_status`)
  jsou na úrovni účtu → nastavit ručně v dashboardu (admin je vypíše).

Bez `PUBLIC_BASE_URL` instalace odmítne (URL nejsou absolutní). Odesílané SMS/hovory
si callbacky předávají samy, když je base URL nastaven.

## 4. SIP trunky — perzistence a `.env`

SIP trunky přežijí restart. Dva zdroje:

**a) `.env` (read‑only z adminu):**
```env
SIP_TRUNKS='[{"id":"prague1","label":"Praha","host":"sip.example.com","port":5060,
  "username":"user","password":"secret","didNumbers":["+420123456789"],
  "callerIdName":"M5cet","callerIdNumber":"+420123456789"}]'
```
Načtou se při startu, v adminu mají štítek *from .env (read‑only)*; úprava/smazání
vrací `409` — edituj `.env` a restartuj.

**b) Admin konzole → datový soubor** (atomický zápis, mód `0600`):

| Kde | Kdy |
|---|---|
| `TELEPHONY_DATA_FILE` | explicitní cesta |
| `$DATA_DIR/telephony.json` | Docker: volume `m5cet-data` na `/data`, `DATA_DIR=/data` (compose i instalátor to už dělají) |
| `./.m5cet/telephony.json` | jinak, vedle aplikace |

Soubor obsahuje i hesla trunků (jsou potřeba) — API je **nikdy nevrací** (jen
`hasPassword`). Aplikace a admin běží jako samostatné procesy: admin zapisuje,
appka soubor při změně mtime **znovu načte** bez restartu. Když není kam psát
(read‑only kontejner bez volume), admin to ukáže (*NOT writable*) a trunky drží
jen v paměti. Stejný soubor nese i **volbu defaultních poskytovatelů**.

### Poctivé omezení SIP

Prohlížeč neumí SIP/RTP. Modul spravuje **konfiguraci trunků, záměr vytáčení a
rozhodnutí o směrování příchozího DID** — ne přenos médií. Skutečné audio mezi
WebRTC klientem a SIP trunkem vyžaduje externí bránu (Asterisk / FreeSWITCH /
Janus / Kamailio). `POST /api/telephony/call` vrací id hovoru u poskytovatele a
tuto poznámku.

## Po aktualizaci: přebuildovat a restartovat admin

Admin GUI (`admin-ui/public/index.html`) se čte z disku, ale API běží ze
sestaveného `dist/admin.cjs`. Po `git pull` proto **starý admin proces servíruje
novou stránku** — ta pak ukazuje `(—)` u zdroje defaultů a „NOT writable" bez
důvodu (chybí `apiVersion`, `persistence`, `defaultsSource`). GUI to od této verze
hlásí jako nesoulad verzí. Náprava:

- nativně: `npm run build` a restart admin služby (nebo `./update.sh`),
- Docker: `docker compose --profile admin up -d --build` — nový compose zároveň
  mountuje volume `m5cet-data` na `/data`, bez něj je úložiště v read‑only
  kontejneru opravdu nezapisovatelné.

Stejně tak `PUBLIC_BASE_URL` se nastavuje v `.env` (a je potřeba restart).

## 5. Endpointy

Klient (jen s `ENABLE_TELEPHONY=1`, tvrdý limit 10 / 10 min / IP, E.164):
`GET /api/telephony/status`, `POST /api/telephony/sms {to,text,connector?}`,
`POST /api/telephony/call {to,connector?}`.

Admin (Bearer `ADMIN_API_TOKEN`): `GET /admin/telephony` (snapshot: konektory,
defaulty + jejich zdroj, perzistence, trunky, webhooky), `PUT /admin/telephony/settings
{smsProvider,voiceProvider}`, `POST /admin/telephony/test {kind,id?,to,text?}`,
`GET /admin/telephony/webhooks`, `POST /admin/telephony/webhooks/install {provider}`,
`GET|DELETE /admin/telephony/events`, `GET|PUT|DELETE /admin/telephony/sip/trunks`,
`POST /admin/telephony/sip/route {did}`.

## 5a. m5.telephony z funkcí a telefonní most (6.0)

Funkce (JavaScript i Python) mají `m5.telephony`: `call` (obsluha jménem =
později v modelu, funkcí = běh čeká a `on_answer` vrací logiku živého
hovoru), `wait`, `say`, `hangup`, `steer`, `calls.*`, `actions.*` (say, play,
pause, gather, record, redirect, hangup), `sms`, `whatsapp`, `viber`,
`messenger`, `messages.get`, `lookup` (offline číslovací plán + data
poskytovatelů), `hlr`, `did.*`, `log`, `providers()`. Podrobně v dokumentaci
(`docs/site/index.html#m5-telephony`).

| Poskytovatel | Umí |
|---|---|
| Twilio | hovory, SMS, lookup, WhatsApp, Messenger (beta), čísla |
| Telnyx | hovory, SMS, lookup, WhatsApp, čísla |
| Vonage | hovory, SMS, lookup + HLR (Number Insight), WhatsApp, Viber, Messenger, čísla |
| HLR-Lookups.com | HLR |
| Meta | Messenger |

```bash
# .env — navíc k SMS/voice klíčům výše
PUBLIC_BASE_URL=https://chat.example.com     # povinné: webhooky každého hovoru a zprávy
TWILIO_MESSAGING_SERVICE_SID=MG…             # nebo TWILIO_FROM
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_MESSENGER_PAGE_ID=…
TELNYX_WHATSAPP_FROM=+…
VONAGE_WHATSAPP_FROM=…   VONAGE_VIBER_FROM=…   VONAGE_MESSENGER_PAGE_ID=…
VONAGE_MESSAGES_SANDBOX=1                    # sandbox Vonage Messages
HLRLOOKUPS_API_KEY=…     HLRLOOKUPS_API_SECRET=…
META_PAGE_ID=…           META_PAGE_TOKEN=…     META_GRAPH_VERSION=v21.0
TELEPHONY_DID_POOL="+420222111000, vonage:+442079460000"   # čísla k půjčení
TELEPHONY_DID_ASSIGN=0                       # neměnit webhook čísla u poskytovatele
TELEPHONY_FN_RATE=30                         # placené operace jednoho modelu za minutu
```

Webhooky: `/wh/tel/<token>/answer|event|gather|record|status` (každý hovor a
zpráva má svůj token, podpis poskytovatele se kontroluje), příchozí hovory na
půjčená čísla `/wh/tel/in/<provider>` (Twilio VoiceUrl se nastaví při
půjčení), u Vonage a Telnyx přes `/wh/vonage/answer` a `/wh/telnyx/events`.

**Telefonní most**: `did.allocate({ room, member, minutes: 10, mode:
auto|audio|text, language, number?, buy? })` → `{ number, code, expiresAt }`.
Volající zadá 5místný kód a `#` (3 pokusy), poskytovatel streamuje zvuk na
`wss://…/media/tel/<token>` (Twilio/Telnyx µ-law 8 kHz, Vonage L16 16 kHz),
člen ho převezme v prohlížeči (`/media/tel/client/<token>`, PCM 16 kHz), nebo
jako přepis (VAD → STT → soukromá oznámení; odpovědi TTS). `auto` přejde na
text po 8 s. **Není koncově šifrovaný.** Za nginx musí `/media/tel/` projít
jako WebSocket — `deploy/nginx/m5cet.conf` i instalátor to od 6.0 mají.

Práva: běh člověka potřebuje jeho Telephony & SIP práva (`call`, `sms`,
`message`, `lookup`, `hlr`, `did`, `number:+420*`); běh, který nikdo
nespustil (webhook, plán, API), grant modelu (Functions › model › *Beyond
the caller* › m5.telephony). Vestavěné balíčky `tel-*` (`/call`, `/sms`,
`/whatsapp`, `/viber`, `/messenger`, `/lookup`, `/hlr`, `/phone-bridge`) se
instalují vypnuté. Konzole: karta *m5.telephony* na stránce Telephony
(`GET /api/admin/telephony/sdk`, `GET …/sdk/calls/:id`,
`POST …/sdk/bridges/:id/release`).

Omezení: ověřeno proti napodobeným API poskytovatelů (vymyšlená čísla),
skutečný hovor ne; Android zvuk mostu nepřevezme; když se přesměrování
čísla nepovede (Vonage zemi čísla bere z číslovacího plánu), most zapíše
varování a webhook čísla je třeba nastavit u poskytovatele; vyzvánění Twilio může být asi o 5 s delší než `timeout`.

## 6. Co je ověřené testy

`test/telephony.test.ts` + `test/telephony-webhooks.test.ts`: referenční vektor
Twilio podpisu z dokumentace, Ed25519 Telnyx (podepsáno vygenerovaným klíčem,
odmítnutí změněného těla i starého timestampu), Vonage JWT + `payload_hash` a
legacy `sig`, RS256/HS256 JWT, Vonage Voice konektor (razí JWT, čísla bez `+`,
NCCO vs. `answer_url`/`event_url`; `fetch` je stubnutý — nic se neposílá),
perzistence trunků přes „restart", reload při změně souboru, `SIP_TRUNKS` seed +
read‑only, pořadí volby providera, živé `/wh/*` routy na expressu (200/403/404,
TwiML, NCCO, routing na trunk). Skutečná volání poskytovatelů vyžadují účty a
klíče — ty se testují až u tebe tlačítkem *Test* / *Install* v adminu.
