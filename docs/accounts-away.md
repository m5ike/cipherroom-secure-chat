# Účty s passkey, data chatu a stav „away"

> **Od 3.1.0:** účet může mít víc passkeys a obnovovací kód (kořen účtu je pro každý zapečetěný),
> relace přežijí restart serveru a okno účtu ukazuje zařízení; položky fronty mají zapečetěného
> odesílatele, účtenky fungují i po restartu (`relay_ledger`) a text probuzení je neutrální —
> viz [dokumentace › Účty a passkeys](site/index.html#ucty).
> **Od 3.0.0** (viz [dokumentace 3.0](site/index.html#fronta)): členy s účtem místnost vidí pod
> pseudonymem `account` platným jen pro ni (ne pod ID účtu); fronta pro nepřítomné je tabulka
> SQLite s pořadím, deduplikací, lease a potvrzením (`relay-ack`), dead-letter a kvótami;
> `receipt` už nemá pole `to` — server ho doručí jen odesílateli zprávy, kterou tomuto čtenáři
> relayoval; přihlášení a odhlášení za běhu jde rámcem `auth` (bez nového `join`). Text níže
> popisuje principy a platí, kde se s tímto neliší.

Tři věci, které spolu souvisí:

1. **kde zůstává konverzace** (volba v *Spojení*),
2. **účet na serveru** ověřený passkeyem (a trezor zašifrovaný týmž klíčem),
3. **stav away** — server drží zprávy pro přihlášeného uživatele, který
   zrovna není připojený, a doručí je, jakmile se vrátí.

Vše řeší `server/accounts/*` (CBOR, WebAuthn, úložiště, relay, routy) a na
klientovi `client/src/lib/{passkey,account,chat-history}.ts`.

---

## 1. Data a historie chatu

*Menu → Spojení → Data a historie chatu.* Uloženo v
`Preferences.chatRetention`.

| Volba | Co se děje | Kde to leží |
| --- | --- | --- |
| `ephemeral` (výchozí) | Nové připojení smaže chat i logy. | nikde |
| `session` | Chat přežije obnovení stránky, končí se sezením nebo tlačítkem **Odhlásit — smazat sezení a data**. | `sessionStorage`, AES‑GCM; klíč je *neexportovatelný* `CryptoKey` v IndexedDB |
| `server` | Chat i profil leží na serveru zašifrované. Vyžaduje registrovaný passkey. | `$DATA_DIR/accounts/vault/<id>.json` — jen šifrový text |

Před uložením se historie ořízne (`chat-history.ts`): zahodí se šifrový text
zprávy (`cipher`), příloha nad 256 000 znaků se zredukuje na jméno + velikost
(`dropped: true`), `blob:` odkazy zmizí (ukazují do paměti staré stránky),
audit se zkrátí na posledních 12 událostí a drží se 500 nejnovějších zpráv do
rozpočtu 4 MB. Ukládá se každých 30 s, při skrytí karty a při odchodu ze
stránky.

## 2. Účet ověřený passkeyem

Passkey dělá dvě věci najednou:

- **přihlašuje k serveru** — server ověří podpis nad vlastní výzvou
  (`server/accounts/webauthn.ts`, ES256 / Ed25519 / RS256, kontrola rpId,
  originu, user presence + user verification a čítače podpisů),
- **odemyká data** — rozšíření **PRF** vydá stabilní tajemství vázané na ten
  konkrétní klíč; HKDF z něj udělá AES‑GCM klíč a **tím se zapečetí všechno,
  co jde na server**. Server drží šifrový text a metadata, obsah nepřečte.

> Bez passkeye nejsou data k odemčení — to je cena té výměny.

### Cesty

| Cesta | Co dělá |
| --- | --- |
| `GET /api/account/status` | zda server účty nabízí, `rpId`, zda přežijí restart |
| `POST /api/account/register/options` → `…/verify` | vytvoření účtu (výzva → attestace) |
| `POST /api/account/signin/options` → `…/verify` | přihlášení (výzva → podpis) |
| `GET /api/account/me` | shrnutí: velikosti, data, počty, audit |
| `GET|PUT /api/account/vault` | zapečetěný profil + chat (vlastní parser, limit 8 MB) |
| `POST /api/account/event` | klient hlásí `decrypt-ok`, `decrypt-failed`, `data-loaded`, `data-cleared`, `chat-restored` |
| `POST /api/account/push` | propojí Web Push odběr tohoto zařízení |
| `POST /api/account/signout` | zneplatní token (`{"everywhere":true}` všechny) |
| `DELETE /api/account` | smaže účet, trezor i schránku |

Výzva je **jednorázová**, platí 2 minuty a bere se z `clientDataJSON`
odpovědi. Ceremonie mají vlastní limit 30 pokusů / 10 min na IP; trezor má
vlastní kbelík 300 požadavků / 15 min, aby autosave nesnědl veřejný limit.

Relying party: `WEBAUTHN_RP_ID`, jinak host z `PUBLIC_BASE_URL`, jinak host
požadavku. Povolené originy: `WEBAUTHN_ORIGINS` (přesný seznam), jinak
libovolný **https** origin na rpId a jeho subdoménách (+ `http://localhost`
pro vývoj). WebAuthn nebere IP adresu jako rpId — pro testy `localhost`.

### Relace

Token je náhodných 32 bajtů, klientovi se ukáže jednou, server si drží jen
SHA‑256 otisk **v paměti** — restart tedy všechny odhlásí (stačí se znovu
přihlásit passkeyem). V prohlížeči žije token v `sessionStorage` a klíč
trezoru jako neexportovatelný `CryptoKey` v IndexedDB, takže obnovení
stránky nevyžaduje další ceremonii.

### `/signin`

Adresa, kam míří upozornění (push) i odkaz „přihlásit se". Návštěva:

1. zkusí obnovit relaci této karty (token + klíč) — bez ptaní,
2. jinak spustí ceremonii passkeyem; když ji prohlížeč odmítne (chybí gesto),
   otevře se *Spojení* s tlačítkem k přihlášení,
3. po úspěchu: dešifruje trezor, nahraje profil i historii, propojí push a
   znovu se ohlásí serveru — a cesta se hned přepíše zpět na `/`.

Server si zapíše přihlášení (hrubá metadata: zkrácená IP jako `/24` či `/48`,
třída prohlížeče a OS), načtení i uložení trezoru a hlášení klienta o
dešifrování. Uživatel to celé vidí v okně účtu pod odznakem **přihlášen**
vedle loga.

## 3. Stav away a relay

Když se přihlášený uživatel s volbou `server` odpojí (zavřená karta,
výpadek, tlačítko Odpojit), **nezmizí z místnosti** — server za něj zůstane:

```
Bob (odesílatel)                server                  Alice (away)
   │ relay {messageId, to:[acc], envelope}
   │ ───────────────────────────►  uloží do schránky
   │ ◄─────────────────────────── relay-status "stored"
   │                               Web Push → /signin
   │                                              ... Alice se vrátí (join)
   │                               peer-back ◄──────────┤
   │                               relay-deliver ──────►│ dešifruje
   │                               relay-ack    ◄───────┤
   │ ◄─────────────────────────── relay-status "delivered"
   │ ◄─────────────────────────── relay-status "read"   (potvrzení o přečtení)
```

Rámce na `/ws`: `join {auth, away}`, `leave {away}`, `relay`, `relay-ack`,
`receipt` od klienta; `joined {away[], account}`, `peer-away`, `peer-back`,
`peer-gone`, `relay-deliver`, `relay-status` od serveru.

- Server vidí **jen šifrový text** zprávy (klíč místnosti nemá), jméno
  odesílatele, místnost a velikost — tedy totéž co signalizace.
- Schránka: 500 položek / 4 MB na účet, jedna položka max 130 kB; jedno
  „probuzení" push nejvýš jednou za 30 s na místnost, mrtvý endpoint
  (404/410) se zapomene.
- Jiná karta téhož účtu ve stejné místnosti = uživatel **není** away.
- Odhlášení i smazání účtu away ukončí (`peer-gone`).
- Odesílatel, který sám odejde, najde potvrzení ve své schránce, až se vrátí.
- Jeden socket smí poslat nejvýš 120 relay rámců za minutu.

V seznamu **Příjemci** je away účastník vidět s měsícem a nápisem *away* a dá
se normálně zaškrtnout — zpráva pak jde přes server. U vlastní zprávy je
značka stavu: hodiny (podrženo) → fajfka (odesláno) → dvojitá fajfka
(doručeno) → modrá dvojitá fajfka (přečteno). Detail s časy je v okně
informací o zprávě.

## 4. Přítomnost a „naposledy online" (6.7)

Kdo neklikl **Odpojit**, zůstává v seznamu lidí v místnosti — i když mu
spadla síť, zavřel kartu, prohlížeč kartu uspal nebo Android aplikaci poslal
do pozadí. Ostatní ho vidí s barevnou tečkou:

| Tečka | Kdy |
| --- | --- |
| zelená (online) | připojen s aplikací v popředí, nebo naposledy viděn ≤ 5 min |
| žlutá (pryč) | naposledy viděn před 5–60 min |
| oranžová (dlouho pryč) | naposledy viděn před víc než hodinou |

Prahy jsou na jednom místě (`client/src/lib/presence.ts`, používá je server
i web; Android má kopii v `contacts/LastSeen.java`).

- **lastSeen** = kdy měl člen naposledy aplikaci otevřenou (v popředí)
  a byl připojený. Klient posílá `presence {away, foreground}` — web při
  uspání / probuzení stránky (`lib/lifecycle.ts`, včetně místností na pozadí),
  Android při přechodu aplikace do pozadí a zpět; změny bližší než ~6 s se
  sloučí (jde jen poslední), ať klient nenarazí na limit serveru (10 naráz,
  pak 1 za 5 s) — hned jde jen uspání, po kterém už stránka nemusí běžet,
  a návrat, když server mezitím držel zprávy (`away`).
  Server změnu pošle
  členům té místnosti jako `peer-presence {peerId, foreground, lastSeen}`.
- **Spadlé spojení** (bez `leave`): server člena drží (`server/signaling/presence.ts`),
  místnost dostane `peer-left` s `held: true` a nově příchozí ho najdou
  v `joined.held`. Vrátí-li se klient s tajemstvím `resume` z posledního
  `joined`, je to týž člen (stejné `peerId`) — web drží tajemství v šifrované
  session cache karty (přežije reload), Android v trezoru (přežije ukončení
  procesu). Cizí klient bez tajemství `peerId` drženého člena nedostane.
  Přihlášený člen, který přijde znovu (i bez tajemství), svůj starý záznam
  nahradí — žádný dvojník.
- **Ze seznamu zmizí** po `leave` (tlačítko Odpojit), po odpojení operátorem
  (člen i celá místnost, i když jsou všichni jen drženi), po zrušení relace
  účtu, po vyhazovu serverem (limity) a po `PRESENCE_MAX_AWAY_DAYS` dnech bez
  návratu (výchozí **7**, desetinná čísla jdou, **0 = nikdy**; kontroluje se
  s heartbeatem každých 30 s). Na webu ani hodina bez aktivity — konec session
  cache s klíčem místnosti — člena z místnosti neodhlásí (odchází bez `leave`).
- **Relay** zůstává, jak byl: přihlášený člen se zapnutým away dál dostává
  zprávy přes schránku; jeho záznam `peer-away` nese i `lastSeen` a ukládá se
  s účtem (`away[].lastSeen` v `accounts.json`), takže přežije restart. Klienti
  takového člena ukážou jednou (záznam relaye má přednost před drženým
  záznamem téhož účtu). Na webu odchází přihlášený člen se serverovým
  uchováním zpráv i tlačítkem *Odpojit* s `leave {away: true}` — zůstane
  tedy v seznamu jako nepřítomný; na jeho záznam relaye se
  `PRESENCE_MAX_AWAY_DAYS` ani odpojení místnosti operátorem nevztahují
  (drží se s účtem, nejvýš 20 místností; končí odhlášením nebo zrušením
  relace). Pro hosta bez účtu server zprávy nedrží — jen ho vede
  jako pryč; po návratu se WebRTC spojí znovu.
- **Soukromí**: `foreground`, `lastSeen` i držené členy vidí jen členové téže
  místnosti (stejně jako člena samotného); jiné místnosti se nic nepošle.
  Server se o obsahu zpráv nic nového nedozví.
- Držené členy má server **v paměti**: restart zapomene hosty (klienti se
  připojí znovu), přihlášené pokryté relayem obnoví z účtů. V clusteru drží
  kopii každá instance (zpráva `leave` s `held`) a návrat jde na kteroukoli;
  nově spuštěná instance o dříve držených neví.
- Konzole: `snapshot()` místností ukazuje u členů `foreground` / `lastSeen`
  a seznam `held`; `stats()` počet držených.

## Retence

Nedoručené položky schránky mizí po `RELAY_RETENTION_DAYS` (výchozí 30),
záznamy auditu účtu po `AUDIT_RETENTION_DAYS` (60) — obojí uklízí stejný
úklid jako zbytek (`docs/api.md`, sekce Retence), včetně vypršelých tokenů.

## Provoz

Účty potřebují **zapisovatelný adresář**: `ACCOUNTS_DIR`, jinak
`$DATA_DIR/accounts`, jinak `./.m5cet/accounts`. Systemd unit z instalátoru
má proto `StateDirectory=m5cet` a `DATA_DIR=/var/lib/m5cet` (starší instalace:
přidat do unitu, nebo nastavit `DATA_DIR` v `.env`). Když adresář zapisovat
nejde, aplikace běží dál, ale data drží jen v paměti a
`GET /api/account/status` hlásí `persistent: false` — okno účtu to řekne
uživateli.

Pro probuzení přes push musí být nastavené VAPID klíče (`docs/push.md`);
bez nich se zpráva jen uloží a čeká.
