# M5cet 6.9 — Telefonie & SIP: poskytovatelé, příchozí a odchozí routing, webhooky, log a testy

Tento dokument popisuje, jak modul **Telephony & SIP** (6.9) mluví se
třemi poskytovateli hlasu — **Twilio**, **Vonage** a **Telnyx**: kudy přichází
příchozí hovor (aplikace poskytovatele vs. SIP trunk), které webhooky server
obsluhuje, jak se neutrální akce hovoru (`CallAction`) překládají do TwiML /
NCCO / příkazů Call Control, jaká jsou pravidla pro caller ID, DTMF,
rozpoznávání řeči a nahrávání, jak vzniká testovací SIP adresa a co je v logu.
Základy modulu (klíče v `.env`, podpisy webhooků, SIP trunky, m5.telephony)
jsou v [telephony.md](telephony.md).

Vše níže je ověřené proti **oficiální dokumentaci** poskytovatelů (odkazy na
konci každé části) a testy s napodobenými API; co bez skutečných účtů ověřit
nešlo, je shrnuto v poslední kapitole.

## 1. Routing v kostce

**Příchozí hovor** dorazí k serveru dvěma cestami:

| Služba | Jak hovor přijde | `service` v pravidlech |
|---|---|---|
| **aplikace** poskytovatele | číslo (DID) u poskytovatele má webhook na tento server (Twilio Voice URL, Vonage Voice aplikace, Telnyx Call Control aplikace) | `app` |
| **SIP trunk** | váš trunk / ústředna pošle INVITE na SIP doménu poskytovatele (Twilio SIP Domain, Vonage Programmable SIP, Telnyx SIP subdoména aplikace) a ta ho předá **stejnému webhooku** | `sip` |

Server pak:

1. číslo **půjčené audio mostem** (`did.allocate`) → beze změny most (PIN),
2. jinak se zeptá **příchozích pravidel** (`telHooks.decide`) s
   `{ direction: "inbound", from, to: DID nebo SIP URI, provider, service }`;
   hovor na **testovací SIP adresu** se počítá jako hovor na její testovací DID,
3. výsledek **stav** (`busy`, `congestion`, `rejected`, `hangup`) se vykreslí pro
   poskytovatele (viz tabulky), výsledek **TSA** založí záznam hovoru (`TelCall`
   s vlastním webhook tokenem) a spustí TSA (`telHooks.tsa.start`) — jeho první
   krok jde poskytovateli jako odpověď webhooku (Twilio, Vonage), u Telnyx se
   hovor přijme (`answer`) a krok se provede po `call.answered`,
4. když část modulu chybí (nejsou načtena pravidla nebo běhové prostředí TSA),
   odpoví webhook **jako dřív** (Twilio pozdrav, Vonage `talk`, Telnyx nic).

Limity (`Telephony › Oprávnění`, `inbound`): souběžné příchozí hovory
(`maxConcurrentCalls`) a hovory jednoho volajícího za hodinu
(`perCallerPerHour`) — po překročení dostane volající **busy** a pravidla se
neptají. Každé rozhodnutí je v logu (druh `route`).

**Odchozí hovor** (test z konzole, TSA `dial`) se ptá **odchozích pravidel**,
který poskytovatel a jaká služba ho ponese:

| Služba | Jak | Autentizace |
|---|---|---|
| `app` | REST API poskytovatele (Twilio Calls, Vonage `/v1/calls`, Telnyx `/v2/calls`) na číslo | API klíč a secret z `.env` (Twilio SID + token, Vonage JWT aplikace, Telnyx API key) |
| `sip` | poskytovatel vytočí `sip:<číslo>@<host trunku>` — volání odejde **přes váš trunk** s caller ID pravidla (číslo, jméno, `presentation`) | heslo trunku ze `SIP_TRUNKS` / datového souboru — posílá se jen poskytovateli (Twilio `SipAuthPassword`, Telnyx `sip_auth_password`), nikdy do logu ani do odpovědi |

## 2. Webhooky tohoto serveru (hlavní služba)

| URL | Poskytovatel | Co |
|---|---|---|
| `POST /wh/twilio/voice` | Twilio | Voice URL čísla **i SIP Domainy** — příchozí hovor → pravidla |
| `POST /wh/twilio/voice_status` | Twilio | status callback čísla / SIP Domainy — konec hovoru s TSA → `{ kind: "hangup" }` |
| `POST /wh/tel/in/twilio` | Twilio | Voice URL čísla půjčeného mostem (pak pravidla, když most číslo nedrží) |
| `ANY /wh/vonage/answer` | Vonage | answer URL Voice aplikace (čísla **i PSIP domény**) → NCCO |
| `POST /wh/vonage/events` | Vonage | event URL aplikace — stav hovoru, konec TSA |
| `POST /wh/telnyx/events` | Telnyx | webhook Call Control aplikace — `call.initiated` (příchozí), všechny další události hovoru |
| `ALL /wh/tel/<token>/answer\|event\|gather\|record\|status` | všichni | vlastní webhooky každého hovoru / zprávy (6.0) |
| `ALL /wh/tel/<token>/tsa?s=<session>&n=<uzel>[&e=played]` | všichni | **6.9: zpětné volání kroku TSA** (Gather / Record / Dial action, Redirect; Vonage input / record / connect / notify; Telnyx druhá noha přepojení) |

Podpis se ověřuje u všech cest stejně (Twilio HMAC-SHA1 přes celé veřejné URL
včetně query, Telnyx Ed25519, Vonage HS256 JWT s `payload_hash`) — viz
[telephony.md](telephony.md#ověřování-podpisů). URL `/wh/tel/<token>/…` je
capability (192 bitů), podpis je důkaz odesílatele; zpětné volání TSA navíc
musí nést `s` = session toho hovoru.

## 3. Twilio

### Příchozí hovory

- **Aplikace:** číslo v účtu má `VoiceUrl = https://<server>/wh/twilio/voice`
  (Webhooks › Install to nastaví pro `TWILIO_FROM`) a `StatusCallback =
  …/wh/twilio/voice_status`. Twilio pošle `CallSid, From, To, Direction=inbound`.
- **SIP trunk:** **SIP Domain** `<jméno>.sip.twilio.com` (Programmable Voice)
  s `VoiceUrl` na `/wh/twilio/voice`. Ústředna / trunk pošle INVITE na
  `sip:<cokoli>@<jméno>.sip.twilio.com`; webhook dostane `To = sip:…`,
  `From = sip:…`, `SipDomain`, `SipCallId`, vlastní hlavičky `X-…` jako
  `SipHeader_X-…`. Doména **musí** mít autentizaci — IP Access Control List
  nebo Credential List (digest), jinak Twilio hovory blokuje.
  Pro vlastního operátora (svá čísla) je **BYOC trunk** s `voice_url` —
  chová se stejně. **Elastic SIP Trunking** naopak jen spojuje ústřednu s PSTN
  a neposílá webhooky — pro pravidla a TSA ho nelze použít přímo.

### Odchozí

- `app`: `POST /Accounts/{Sid}/Calls.json` (`To`, `From`, `Url` = vlastní answer
  webhook hovoru, `StatusCallback` + 4× `StatusCallbackEvent`).
- `sip`: `To = sip:+420…@host[:port];transport=tls`, `SipAuthUsername`,
  `SipAuthPassword`; `From` je k SIP uživatelská část P-Asserted-Identity
  (libovolný řetězec) — skryté číslo = `anonymous`.

### Mapování akcí → TwiML

| CallAction | TwiML |
|---|---|
| `say` | `<Say voice language loop>` |
| `play` | `<Play loop>url</Play>` |
| `pause` | `<Pause length>` |
| `gather` (DTMF) | `<Gather input="dtmf" action method="POST" timeout finishOnKey [numDigits]>` + `<Say>` výzva; `numDigits` jen bez ukončovací klávesy |
| `gather` (řeč) | `input="speech"` / `"dtmf speech"`, `speechTimeout` (výchozí `auto`), `language`, `hints` (čárkou) → akce dostane `SpeechResult`, `Confidence` |
| `record` | `<Record action maxLength playBeep timeout finishOnKey trim transcribe>` — `timeout` = sekundy ticha (0 vypne), `finishOnKey="any"` → `1234567890*#`, `trim` → `trim-silence` / `do-not-trim`; akce dostane `RecordingUrl`, `RecordingDuration`, `RecordingSid`, `Digits` (klávesa nebo `hangup`) |
| `stream` | `<Connect><Stream url><Parameter …/></Stream></Connect>` |
| `redirect` | `<Redirect method="POST">` |
| `hangup` | `<Hangup/>` |
| `sendDigits` | `<Play digits="1w2#"/>` (`w` 0,5 s, `W` 1 s) |
| `dial` (číslo) | `<Dial action method timeout callerId record="record-from-answer"><Number>+420…</Number></Dial>` → akce dostane `DialCallStatus` (`completed` = přijato, `busy`, `no-answer`, `failed`, `canceled`), `DialCallDuration` |
| `dial` (SIP / přes trunk) | `<Dial …><Sip username password>sip:…;transport=tls</Sip></Dial>` → navíc `DialSipResponseCode` |
| `reject` | `<Reject reason="busy\|rejected"/>` — **jen jako první sloveso** nepřijatého hovoru (Twilio ho pak neúčtuje); `congestion` se hraje jako `busy`; později se z něj stane `<Hangup/>` |

Specifika TSA: `<Gather>` / `<Record>`, který nic nedostane, pokračuje dalším
slovesem — server za ně proto přidá `<Redirect>` na totéž zpětné URL s
`&timeout=digits|speech|recording` a TSA dostane událost s `timedOut: true`.

### Caller ID, DTMF, řeč, nahrávání

- **Caller ID:** číslo hovoru (`To`/`From`), číslo vlastněné v Twilio nebo
  ověřené (Verified Caller ID); k SIP libovolný alfanumerický řetězec (`+-_.`).
  **Jméno** Twilio nepřenáší; **skryté číslo** k PSTN nejde (zapíše se do logu,
  číslo se ukáže), k SIP se pošle `anonymous`.
- **DTMF:** příjem `<Gather>` (RFC 2833 i in-band detekce u Twilio); odesílání
  `<Play digits>` / `SendDigits` (RFC 2833) — volba in-band / SIP INFO není.
- **Řeč:** Twilio ASR v `<Gather>` (`SpeechResult`, `Confidence` 0–1).
- **Nahrávání:** `<Record>` (URL nahrávky je za autentizací účtu), `<Dial record>`.

### Testovací SIP adresa

`POST /admin/telephony/tests/sip-address { provider: "twilio", did? }`:
`POST /SIP/CredentialLists.json` → `POST …/Credentials.json` (uživatel + heslo:
≥ 12 znaků, číslice, malá i velká písmena) → `POST /SIP/Domains.json`
(`DomainName = m5cet-xxxx.sip.twilio.com`, `VoiceUrl = /wh/twilio/voice`,
`VoiceStatusCallbackUrl = /wh/twilio/voice_status`) → `POST
/SIP/Domains/{SD}/Auth/Calls/CredentialListMappings.json`. Adresa
`sip:test-<náhodné>@m5cet-xxxx.sip.twilio.com`, **heslo se ukáže jen jednou**
(do softphonu) a server ho nikde nedrží. Selže-li krok, vytvořené prostředky
se smažou. `DELETE` smaže doménu i credential list.

Odkazy: [Gather](https://www.twilio.com/docs/voice/twiml/gather) ·
[Record](https://www.twilio.com/docs/voice/twiml/record) ·
[Dial](https://www.twilio.com/docs/voice/twiml/dial) ·
[Sip](https://www.twilio.com/docs/voice/twiml/sip) ·
[Number](https://www.twilio.com/docs/voice/twiml/number) ·
[Reject](https://www.twilio.com/docs/voice/twiml/reject) ·
[Play](https://www.twilio.com/docs/voice/twiml/play) ·
[Call resource](https://www.twilio.com/docs/voice/api/call-resource) ·
[SIP Domain](https://www.twilio.com/docs/voice/sip/api/sip-domain-resource) ·
[SIP Credential](https://www.twilio.com/docs/voice/sip/api/sip-credential-resource) ·
[CredentialListMapping](https://www.twilio.com/docs/voice/sip/api/sip-credentiallistmapping-resource) ·
[Sending SIP to Twilio](https://www.twilio.com/docs/voice/api/sending-sip) ·
[BYOC](https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc)

## 4. Vonage

### Příchozí hovory

- **Aplikace:** číslo propojené s **Voice aplikací** (`VONAGE_APPLICATION_ID`);
  aplikace má `answer_url = /wh/vonage/answer` a `event_url = /wh/vonage/events`
  (Webhooks › Install, zapne i podepsané callbacky). Answer webhook nese `to`,
  `from` (číslice bez `+`), `uuid`, `conversation_uuid`, `endpoint_type`.
- **SIP trunk:** **Programmable SIP** doména `<jméno>.sip-eu|sip-us|sip-ap.vonage.com`
  propojená s aplikací — hovor na `sip:<cokoli>@<doména>` jde na `answer_url`
  (hlavičky `X-…` jako `SipHeader_X-…`). Zabezpečení: ACL (IP / CIDR) a/nebo
  digest uživatelé domény. URI **musí** obsahovat regionální část.
- Odmítnout hovor stavem NCCO **neumí** (žádná akce reject / busy): server vrátí
  prázdné NCCO, hovor hned skončí, a zapíše do logu, že stav nešel vyjádřit.

### Odchozí

- `app`: `POST /v1/calls` s JWT aplikace (`to` phone, `from` vaše číslo,
  `answer_url`, `event_url`, `ringing_timer`).
- `sip`: `to: [{ type: "sip", uri: "sip:+420…@host;transport=tls" }]`. Voice API
  **neposílá digest heslo** — trunk musí Vonage povolit podle adresy (nebo jít
  přes PSIP doménu); jméno a skryté číslo neumí (zapíše se do logu).

### Mapování akcí → NCCO

| CallAction | NCCO |
|---|---|
| `say` | `talk` (`language`, `loop`; před `input` `bargeIn: true`) |
| `play` | `stream` (`streamUrl: [url]`, `loop`) |
| `pause` | `talk` se SSML `<break time="…s"/>` (max 10 s na kus) |
| `gather` (DTMF) | `input` `type: ["dtmf"]`, `dtmf: { maxDigits, submitOnHash, timeOut }` |
| `gather` (řeč) | `input` `type: ["speech"]` / `["dtmf","speech"]`, `speech: { language, context: hints, endOnSilence, startTimeout }` → `speech.results[0].text` / `confidence`, při tichu `timeout_reason` |
| `record` | `record` (`endOnKey` jedna klávesa — `any` → `#`, `endOnSilence` 3–10 s, `timeOut` 3–7200 s, `beepStart`, `transcription: { language, eventUrl }`); bez podmínky konce se doplní `timeOut` (aby NCCO čekalo) |
| `stream` | `connect` websocket (`audio/l16;rate=16000`) |
| `redirect` | pro TSA **`notify`** (odpověď webhooku nahradí NCCO); jinak `executeActions` = transfer na URL |
| `hangup` | konec NCCO |
| `sendDigits` | v NCCO nelze → `PUT /v1/calls/{uuid}/dtmf` (`w` → `p` 0,5 s) |
| `dial` | `connect` (`endpoint` phone / sip, `from`, `timeout`, `eventType: "synchronous"`, `eventUrl` = zpětné URL) + **`notify`** po skončení spojené nohy; `record` → `record` na pozadí (`split: conversation`) před `connect` |
| `reject` | nelze — NCCO skončí |

Specifika TSA: `connect` se `eventType: synchronous` pošle na `eventUrl`
neúspěch (`busy`, `timeout`, `unanswered`, `failed`, `rejected`,
`cancelled`) a jeho NCCO nahradí běžící → TSA `dial` s výsledkem. Průběh spojené
nohy (`started`, `ringing`, `answered`, `completed` s `duration`) server jen
zapamatuje (odpoví 204 = „pokračuj“); když spojená noha zavěsí, NCCO dojde k
`notify { m5: "dial-ended" }` → TSA `dial: answered` s délkou.

### Caller ID, DTMF, řeč, nahrávání

- **Caller ID:** `from` musí být vaše Vonage číslo; **jiná hodnota = „unknown“**
  — to server použije pro `presentation: restricted`. Jméno neumí.
- **DTMF:** příjem `input`; odesílání `PUT …/dtmf` (`p` = pauza) a `dtmfAnswer`
  u `connect`.
- **Řeč:** ASR v `input` (jazyk, `context`, `endOnSilence` 0,4–10 s,
  `startTimeout` 1–60 s).
- **Nahrávání:** `record` → `recording_url` (stáhnout s JWT aplikace),
  přepis přes `transcription` (událost `transcribed` s `transcription_url`).

### Testovací SIP adresa

`POST https://api.nexmo.com/v1/psip/` (Basic `api_key:api_secret`) `{ name:
"m5cet-xxxx", application_id, acl, digest_auth: true, tls: "optional", srtp:
"optional" }` → `POST /v1/psip/{name}/users { key, secret }`. Adresa
`sip:test-<náhodné>@m5cet-xxxx.sip-<eu|us|ap>.vonage.com`, uživatel + heslo
(jednou). `acl` v požadavku = IP vašeho softphonu / ústředny. `DELETE
/v1/psip/{name}?cascade=true`.

Odkazy: [NCCO reference](https://developer.vonage.com/en/voice/voice-api/ncco-reference) ·
[Webhook reference](https://developer.vonage.com/en/voice/voice-api/webhook-reference) ·
[ASR](https://developer.vonage.com/en/voice/voice-api/concepts/asr) ·
[DTMF do hovoru](https://developer.vonage.com/en/voice/voice-api/code-snippets/controlling-media/play-dtmf-into-a-call) ·
[Programmable SIP](https://developer.vonage.com/en/voice/voice-api/concepts/programmable-sip) ·
[Vytvoření domény](https://developer.vonage.com/en/voice/voice-api/code-snippets/programmable-sip/create-a-domain) ·
[PSIP API](https://developer.vonage.com/en/api/psip) ·
[Account API](https://developer.vonage.com/en/api/account) ·
[Podepsané webhooky](https://developer.vonage.com/en/getting-started/concepts/webhooks)

## 5. Telnyx

### Příchozí hovory

- **Aplikace:** číslo na **Call Control aplikaci** (`TELNYX_CONNECTION_ID`),
  `webhook_event_url = /wh/telnyx/events`. Příchozí hovor = `call.initiated`
  s `direction: incoming`; server buď **odmítne** (`reject`), nebo **přijme**
  (`answer`) a první krok TSA pustí po `call.answered`.
- **SIP trunk:** **SIP subdoména** aplikace (`inbound.sip_subdomain`,
  `sip_subdomain_receive_settings: from_anyone | only_my_connections`) —
  `sip:<cokoli>@<subdoména>.sip.telnyx.com` přijde jako `call.initiated` na
  stejný webhook. (SIP Connection — credential / FQDN / IP — doručuje hovory
  na vaše SIP zařízení, ne do Call Control; pro pravidla použijte subdoménu
  nebo číslo na aplikaci. TeXML aplikace tento server neřídí.)

### Odchozí

- `app`: `POST /v2/calls` (`connection_id`, `to`, `from`, `webhook_url`,
  `timeout_secs` ≥ 5, `client_state` base64).
- `sip`: `to = sip:+420…@host;transport=…`, `sip_auth_username`,
  `sip_auth_password`, `sip_transport_protocol` (`UDP`/`TCP`/`TLS`),
  `from_display_name` (jméno, max 128 znaků), `privacy: "id"` (skryje číslo i
  jméno).

### Mapování akcí → Call Control

Call Control je asynchronní: příkazy jdou postupně až k prvnímu, který čeká, a
událost, která čekání ukončí, posune TSA dál.

| CallAction | Příkaz | Čeká na |
|---|---|---|
| `say` / `pause` | `speak` (pauza = SSML, premium hlas) | `call.speak.ended` |
| `play` | `playback_start` | `call.playback.ended` |
| `gather` (DTMF) | `gather` / `gather_using_speak` (`minimum_digits`, `maximum_digits`, `terminating_digit`, `timeout_millis`) | `call.gather.ended` (`digits`, `status`) |
| `gather` (řeč) | `speak` výzvy + `transcription_start` (`language`, `transcription_tracks: inbound`) + `gather` jako **časovač** (a klávesy, je-li `dtmf`) | první finální `call.transcription` → `transcription_stop` + `gather_stop`; nebo `call.gather.ended` (klávesa / vypršení) |
| `record` | `record_start` (`max_length`, `timeout_secs` = ticho, `play_beep`, `trim: trim-silence`, `transcription`, `transcription_language`) | `call.recording.saved` (`recording_urls.mp3`); **ukončovací klávesa** nemá pole → server sleduje `call.dtmf.received` a pošle `record_stop` |
| `stream` | `streaming_start` | `streaming.stopped` |
| `redirect` | pro TSA rovnou běhové prostředí (bez HTTP); jiné URL Call Control neumí | — |
| `hangup` | `hangup` | — |
| `sendDigits` | `send_dtmf` (`duration_millis` 100–500) | — |
| `dial` | `transfer` (`to`, `from`, `from_display_name`, `privacy`, `timeout_secs`, `sip_auth_*`, `sip_transport_protocol`, `record: record-from-answer`, `webhook_url` = zpětné URL, `park_after_unbridge: self`) | `call.hangup` **druhé nohy** na zpětném URL (přijato podle `call.answered` / `call.bridged`; jinak `user_busy` → busy, `timeout` → no-answer…) |
| `reject` | `reject` `cause`: `USER_BUSY` (486), `CALL_REJECTED` (603), congestion → `TEMPORARILY_UNAVAILABLE` (480) — jen nepřijatý hovor; přijatý se zavěsí | — |

### Caller ID, DTMF, řeč, nahrávání

- **Caller ID:** `from` v E.164 (u `transfer` výchozí = `to` původního hovoru);
  `from_display_name` = SIP From display name; `privacy: id` skryje číslo i
  jméno. K PSTN musí být číslo povolené pro váš účet (outbound voice profile).
- **DTMF:** `send_dtmf` (RFC 2833); příjem `call.dtmf.received`, `gather`.
- **Řeč:** real-time přepis (`transcription_start`, výchozí engine Google,
  kód jazyka bez regionu, např. `cs`). Start-timeout Telnyx nemá — časovač je
  souběžný `gather` (čekání + konec řeči + 5 s).
- **Nahrávání:** `record_start` → `call.recording.saved` (URL na S3, časově
  omezená), přepis `call.recording.transcription.saved`.

### Testovací SIP adresa

`GET /v2/call_control_applications/{id}` → `PATCH` s `application_name`,
`webhook_event_url` (stávající nebo `/wh/telnyx/events`) a `inbound: {
…stávající, sip_subdomain: "m5cet-xxxx", sip_subdomain_receive_settings:
"from_anyone" }`. Adresa `sip:test-<náhodné>@m5cet-xxxx.sip.telnyx.com` —
**bez hesla** (subdoména autentizaci nemá; tajemstvím je náhodná adresa;
volání na jiné uživatele té subdomény jdou pravidly jako SIP URI). `DELETE`
vrátí `sip_subdomain: null`.

Odkazy: [Dial](https://developers.telnyx.com/api-reference/call-commands/dial) ·
[Transfer](https://developers.telnyx.com/api-reference/call-commands/transfer-call) ·
[Reject](https://developers.telnyx.com/api-reference/call-commands/reject-a-call) ·
[Send DTMF](https://developers.telnyx.com/api-reference/call-commands/send-dtmf) ·
[Transcription start](https://developers.telnyx.com/api-reference/call-commands/transcription-start) ·
[Recording start](https://developers.telnyx.com/api-reference/call-commands/recording-start) ·
[call.recording.saved](https://developers.telnyx.com/api-reference/callbacks/call-recording-saved) ·
[Call Control aplikace](https://developers.telnyx.com/api-reference/call-control-applications/update-a-call-control-application) ·
[Webhooky](https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks)

## 6. Zpětná volání TSA → `TsaEvent`

| Událost | Twilio (form) | Vonage (JSON) | Telnyx (webhook) |
|---|---|---|---|
| `digits` | `Digits` (+ `FinishedOnKey`); `&timeout=digits` = vypršelo | `dtmf.digits`; prázdné + `timed_out` = vypršelo | `call.gather.ended` (`status: timeout`) |
| `speech` | `SpeechResult`, `Confidence`; `&timeout=speech` | `speech.results[0]`; bez výsledků = vypršelo | finální `call.transcription`; vypršení = časovač `gather` |
| `recording` | `RecordingUrl`, `RecordingSid`, `RecordingDuration`, `Digits`; `&timeout=recording` = nic nenahráno | `recording_url`, `recording_uuid`, `start_time`/`end_time` | `call.recording.saved` (+ klávesa z `call.dtmf.received`) |
| `dial` | `DialCallStatus`, `DialCallDuration` | neúspěch `connect` (`status`), konec = `notify { m5: "dial-ended" }` | `call.hangup` druhé nohy |
| `played` | `&e=played` (Redirect) | `notify { m5: "redirect" }` na URL s `e=played` | `call.speak.ended` / `call.playback.ended` + redirect TSA |
| `hangup` | status callback (`completed`, `busy`…) | event URL aplikace (`completed`…) | `call.hangup` původní nohy |

Session v URL (`s`) musí být session toho hovoru, jinak `404`. Když se TSA
ukončí samo (`hangup`), konec hovoru ho už znovu nevolá.

## 7. Log (Telephony › Log)

Tabulka `tel_log` v `telephony.db` (vedle hovorů; hlavní služba píše, admin
čte), retence `permissions.log.days`. Každý webhook (všichni poskytovatelé,
všechny cesty `/wh/…`) zapíše: ověřený podpis ano/ne, HTTP metodu / cestu /
status / ms, **normalizovanou** událost (`NormalizedCallEvent` bez raw, starší
`TelephonyEvent`, rozhodnutí pravidel) a — když `permissions.log.keepRaw` —
surový payload **bez tajemství** (hlavičky `Authorization` a podpisy se
neukládají vůbec; klíče typu token / secret / password / api_key / signature /
jwt → `[redacted]`; JWT, `Bearer …`, `api_secret=` v URL, heslo v `sip:u:heslo@`
a token hovoru v `/wh/tel/<token>/` se maskují). Dále: rozhodnutí pravidel
(`route`), kroky TSA (`tsa`), hovory a SMS (`call`, `sms` — i starší log
hovorů z 6.0), testy (`test`) a změny v konzoli (`config`: metoda, cesta,
status, kdo, jen **názvy** polí).

- `GET /admin/telephony/log?kind&provider&level&callId&q&before&limit` →
  `{ entries, next }` (bez `parsed` / `raw`; `level` = aspoň tak závažné;
  `before` = `next` předchozí stránky),
- `GET /admin/telephony/log/:id` → celý záznam (právo `log` nebo `settings`),
- `DELETE /admin/telephony/log` → smaže (a zapíše, kdo).

Starý seznam událostí (`telephony-events.json`, `/admin/telephony/events`)
funguje dál.

## 8. Testy (Telephony › Tests)

Každý test vrací kontrolní seznam (`TelTestResult`) a bez klíčů napíše přesně,
co chybí. Všechny se zapisují do logu.

| Endpoint | Co dělá |
|---|---|
| `POST /tests/provider { provider }` | PUBLIC_BASE_URL, klíče, materiál pro podpis; API (Twilio účet + zůstatek, Telnyx zůstatek, Vonage zůstatek), vlastněná čísla, zda webhooky míří sem (Twilio Voice URL čísel, Telnyx `webhook_event_url` aplikace, Vonage answer / event URL aplikace) |
| `POST /tests/webhook { provider }` | syntetická událost podepsaná **jako ji podepisuje poskytovatel**, doručená na **veřejné URL** hlavní služby (ověří PUBLIC_BASE_URL, DNS/TLS, proxy `/wh/` a podpis) a dohledaná v logu (`[test]`). Telnyx podepisuje svým soukromým klíčem → s `TELNYX_PUBLIC_KEY` test ověří, že **nepodepsaná** událost dostane 403 |
| `POST /tests/route RouteQuestion` | rozhodnutí + co by dostal poskytovatel: TwiML / NCCO / příkazy Telnyx pro první krok TSA (hesla trunků maskovaná), u odchozích i umístění hovoru (SIP URI přes trunk, caller ID) |
| `POST /tests/call { provider?, to, tsa?, say? }` | **skutečný hovor** (placený) přes odchozí pravidla (stav → odmítnuto; `sip` → přes trunk s jeho heslem a caller ID; TSA se spustí po přijetí) |
| `POST /tests/sms { provider?, to, text }` | skutečná SMS |
| `POST /tests/room-voice { room, user?, type, ttl? }` | kód inroute + čísla, která podle pravidel vedou do TSA (pool DID, čísla poskytovatelů, testovací SIP adresa) + návod („zavolejte …, zadejte kód a #“) |
| `GET/POST/DELETE /tests/sip-address` | testovací příchozí SIP adresa (kap. 3–5); uložená v datovém souboru telefonie (bez hesla) |

## 9. Co nešlo ověřit bez skutečných účtů

Ověřeno: tvar každého požadavku (URL, metoda, autentizace, tělo) proti
dokumentaci a napodobeným API, parsování realistických webhooků, celé toky
na živém expressu (podepsané Twilio webhooky, Vonage JWT, Telnyx události).
**Neověřeno se skutečným poskytovatelem:**

- že Twilio přijme `speechTimeout="auto"` spolu s `hints` a `language` pro češtinu, a `finishOnKey=""` u `<Record>` (server ho proto neposílá),
- skutečné chování Vonage `notify` po `connect` (dokumentace výslovně neuvádí, že NCCO po zavěšení spojené nohy pokračuje — server na tom staví konec `dial`), tvar těla požadavku `notify` (server přijme payload v těle i pod `payload`), a že prázdné NCCO na answer webhooku hovor ukončí bez účtování,
- Vonage PSIP: povinnost `acl` při `digest_auth: true`, hodnoty `tls` / `srtp`, a tvar `to` v answer webhooku pro hovor z PSIP (server porovnává uživatelskou část),
- Telnyx: souběh `transcription_start` a `gather` (časovač) na jednom hovoru, jazykové kódy přepisu (`cs` vs `cs-CZ`), že `transfer` s `webhook_url` posílá události druhé nohy na toto URL a `park_after_unbridge: self` nechá původní nohu žít, `PATCH` aplikace se `sip_subdomain: null` pro odstranění,
- doručení `call.dtmf.received` během `record_start` (ukončovací klávesa),
- caller ID: zda konkrétní operátor zobrazí jméno (Telnyx `from_display_name`) a respektuje `privacy: id`; Vonage `from: "anonymous"` → „unknown“,
- odchozí hovor přes trunk: autentizace trunku proti Twilio (`SipAuth*`) a Telnyx (`sip_auth_*`), u Vonage povolení IP adres Vonage na trunku,
- poplatky: Twilio `<Reject>` jako první sloveso neúčtuje (dokumentace), ostatní poskytovatelé — neověřeno.
