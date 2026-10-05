# M5cet — bezpečnostní analýza

> **Stav kódu:** verze 6.7.0, commit `594202f5` (větev `android_application`), analýza ke dni 2026-10-04.
> **Aktualizace:** kap. 11 — stav po opravách 6.7 (`28f10ad0`); **kap. 12 — stav 6.10** (rozpracovaná
> verze 6.10.0, výchozí commit `addff2a9`, opravy této revize `16695a1b`, `327c9efc`, `76bdbc03`),
> analýza ke dni 2026-10-05. Kde kap. 12 mění dřívější tvrzení, je u něj odkaz *„→ kap. 12"*.
> **Metoda:** revize zdrojového kódu (server `server/`, webový klient `client/src`, konzole
> `admin-ui/public`, aplikace pro Android `android/`). Každé tvrzení o M5cet je doloženo odkazem
> `soubor:řádek` na stav uvedeného commitu. Dokumentace projektu (`docs/security-model.md`,
> `docs/architecture.md`, `docs/site/`) sloužila jen jako mapa — **v několika bodech kódu
> neodpovídá** (viz [§ 10](#10-nesoulad-dokumentace-s-kódem)). Tvrzení o jiných aplikacích jsou
> z veřejných zdrojů uvedených v [§ 6.3](#63-zdroje-ke-srovnání).
> **Co tento dokument není:** externí audit, penetrační test živého nasazení ani test na
> zařízeních — viz [§ 9](#9-co-nebylo-ověřeno). Body, které se z kódu nedaly jednoznačně
> rozhodnout, jsou označené **„ověřit"**.

## Obsah

1. [Shrnutí a verdikt](#1-shrnutí-a-verdikt)
2. [Rozsah a metoda](#2-rozsah-a-metoda)
3. [Architektura a model důvěry](#3-architektura-a-model-důvěry)
4. [Kryptografie](#4-kryptografie)
5. [Bezpečnost platforem](#5-bezpečnost-platforem)
6. [Srovnání se Signal, Threema, WhatsApp, Wire, Element/Matrix a Session](#6-srovnání)
7. [Nálezy seřazené podle závažnosti](#7-nálezy-seřazené-podle-závažnosti)
8. [Roadmapa](#8-roadmapa)
9. [Co nebylo ověřeno](#9-co-nebylo-ověřeno)
10. [Nesoulad dokumentace s kódem](#10-nesoulad-dokumentace-s-kódem)
11. [Stav po opravách 6.7](#11-stav-po-opravách-67) (doplněno po vydání, commit `28f10ad0`)
12. [Stav 6.10: nové části a srovnání](#12-stav-610-nové-části-a-srovnání) (6.8, 6.9 telefonie, 6.10; srovnání i s iMessage a Telegramem)

---

## 1. Shrnutí a verdikt

**Verdikt: M5cet dnes není bezpečnostně srovnatelný se Signalem ani s Threemou.** Má pečlivě
navržené kryptografické jádro pro živé zprávy mezi připojenými zařízeními — Argon2id, HKDF
s oddělenými účely, AES-256-GCM s associated data, podpisy uvnitř šifry, podepsaný ECDH párový
klíč, sender keys s hash ratchetem a šifrování rámců hovoru — a v tom je výrazně nad úrovní
běžných hobby projektů. Celková bezpečnost je ale omezená čtyřmi věcmi:

1. **Provozovatel serveru je pro obsah důvěryhodnou stranou na obou klientech.** Web stahuje
   kód ze serveru při každém načtení (F-02) a aplikace pro Android kreslí zprávy podle
   serverem podepsaných designů, které umí obsah vynést (F-01, kritické). Sandbox funkcí navíc
   nemá slibovanou procesní hranici (F-03), takže i role „operátor" má pravděpodobně cestu ke
   klíčům serveru.
2. **Kořenem důvěry místnosti je sdílená passphrase** bez vynucené síly; slepé ID místnosti je
   offline orákulum pro její hádání a název místnosti (sůl) na několika místech teče na server
   (F-04, F-10). Členství není spravované — kdo passphrase zná, je členem napořád.
3. **Protokol nemá obnovu po kompromitaci ani asynchronní ustavení klíče.** Párové klíče jsou
   statické ECDH, chybí DH ratchet (PCS), X3DH/PQXDH, post-kvantová ochrana; zprávy pro
   nepřítomné, soubory a outbox jsou pod statickým klíčem místnosti (F-06, F-09).
4. **Identita je TOFU podle zobrazovaného jména**, bez transparentnosti klíčů; na Androidu se
   „ověřeno" ukáže i u cizího podpisu (F-07, F-13).

Kde M5cet **srovnatelný je nebo se liší záměrně:** nevyžaduje telefonní číslo; jde provozovat
jen na vlastním serveru; živé zprávy jdou P2P a server je nevidí ani jako ciphertext;
push neobsahuje obsah ani jméno; účty stojí na passkey s PRF a recovery kódu se 130 bity;
web má CSP se `script-src` bez `unsafe-inline` / `unsafe-eval` a žádné HTML sinky. Neexistuje ale žádný nezávislý audit,
formální analýza ani reprodukovatelný build — u Signalu, Threemy, Wire i Matrixu existují.

### Hodnocení po oblastech

Stupnice 0–10, kde 10 odpovídá dnešnímu Signalu v dané oblasti (ne absolutní bezpečnosti).

| Oblast | Skóre | Stručné zdůvodnění |
|---|---:|---|
| Šifrování živých zpráv (P2P) | **7** | AEAD s kontextem, podpisy uvnitř šifry, sender keys + DTLS; párový kanál statický |
| Zprávy přes server, soubory, offline doručení | **4** | statický klíč místnosti, 30 dní ve schránce, „soukromé" zprávy čitelné pro všechny členy |
| Správa klíčů a odvozování | **5** | Argon2id a HKDF dobře; passphrase bez síly, orákulum slepého ID, únik názvu místnosti |
| Identita a ověřování | **3** | bezpečnostní čísla s QR existují; TOFU podle jména, „ověřeno" při prvním kontaktu, bez revokace a transparentnosti; chyba na Androidu |
| Dopředná utajenost, PCS, post-kvantová ochrana | **3** | jen hash ratchet a periodická výměna řetězu; žádný DH ratchet, žádné PQ |
| Ochrana metadat | **3** | slepé ID a neutrální push; server zná jména, členství, účty, časy, plné IP v access logu; peery vidí IP |
| Webový klient | **5** | CSP, žádné HTML sinky, sanitizace výstupů; kód ze serveru, automaticky spouštěný JS od člena |
| Aplikace pro Android | **4** | Keystore, zámek s vymazáním, uzamčený WebView, podepsané APK; kritický únik přes design, obejitelný pin klíče serveru |
| Server a provoz | **4** | autentizace, limity, CSP, zálohy bez master klíče; sandbox bez hranice, SSRF rebinding, nešifrovaná `functions.db`, telefonie fail-open |
| Ověřitelnost (audity, formální důkazy, reprodukovatelné buildy) | **1** | nic z toho; dokumentace místy neodpovídá kódu |
| **Celkově** | **≈ 4** | silné stavební kameny, slabý model důvěry vůči provozovateli a protokol bez PCS |

### Nejzávažnější nálezy

| ID | Závažnost | Nález | Místo |
|---|---|---|---|
| F-01 | **Kritická** | Designový balíček Androidu vynese dešifrované zprávy na libovolný https server | `android/…/ui/Renderer.java:724-731`, `:961-967`; `server/android/design.ts:628` |
| F-02 | **Vysoká** | Webový klient je doručován serverem; žádná ochrana proti zlému serveru | `client/src/lib/integrity.ts:1-20`, `:60-61`; `client/public/sw.js` |
| F-03 | **Vysoká** | Sandbox funkcí bez procesní izolace; pravděpodobný únik z Pyodide k souborům a env serveru | `server/functions/sandbox/pool.ts:105-106`; `engine-py.ts:31`, `:54` |
| F-04 | **Vysoká** | Passphrase bez vynucené síly + slepé ID jako orákulum → offline lámání, pak čtení schránky a MITM | `client/src/lib/envelope.ts:107-132`; `client/src/App.tsx:3228` |
| F-05 | **Vysoká** | Android: připnutí klíče serveru porovnává jen řetězec `kid` od serveru | `android/…/ui/parts/Forms.java:204-208`; `core/Config.java:77-84` |

Úplný seznam s opravami je v [§ 7](#7-nálezy-seřazené-podle-závažnosti), plán v [§ 8](#8-roadmapa).

---

## 2. Rozsah a metoda

| Oblast | Co bylo čteno |
|---|---|
| Kryptografie klienta | `client/src/lib/envelope.ts`, `sender-keys.ts`, `identity.ts`, `kdf.ts`, `crypto.ts`, `media-frames.ts`, `media-e2ee*.ts`, `file-transfer.ts`, `passkey.ts`, `account.ts`, `recovery.ts`, `message-kinds.ts`, `nfc.ts`, `nfc/cards/connection-card.ts`, `chat-history.ts`, `session-cache.ts`, `share-link.ts` |
| Protokol v aplikaci | `client/src/App.tsx` (hello, doručování, relay, ověřování identity, příkazy) a `lib/room-hub.ts` |
| Server | `server/signaling/*` (hub, relay, limity, rámce), `server/accounts/*` (WebAuthn, účty, schránka), `server/storage/*` (SQLCipher, klíče, zálohy), `server/functions/*`, `server/ai/*`, `server/telephony/*`, `server/index.ts`, `server/monitor/*`, `server/push*.ts`, `server/turn.ts`, `server/share.ts` |
| Platformy | webové hlavičky a CSP, XSS povrchy (Markdown, HTML výstupy funkcí, rozvržení), service worker, konzole `admin-ui/public`, aplikace `android/` (manifest, úložiště, WebView, síť, FCM, aktualizace) |
| Srovnání | veřejné specifikace, blogy a audity Signal, Threema, WhatsApp, Wire, Element/Matrix a Session |

Model útočníka, se kterým analýza počítá:

| Útočník | Schopnosti |
|---|---|
| **S1 pasivní síť** | vidí veškerý provoz (TLS/DTLS), ukládá ho na později |
| **S2 aktivní síť** | podvrhuje a mění pakety, ale nemá platný TLS certifikát serveru |
| **S3 zvědavý / kompromitovaný server** | čte vše, co server zpracuje a uloží, mění rámce, doručuje upravený klient (web) |
| **S4 operátor / administrátor** | legitimní přístup ke konzoli, logům, zálohám, funkcím |
| **S5 zlomyslný člen místnosti** | zná passphrase místnosti, může spolupracovat se S3 |
| **S6 kompromitované zařízení** | dočasný nebo trvalý přístup k prohlížeči / telefonu (XSS, malware, forenzní kopie) |
| **S7 budoucí kvantový útočník** | „sklízí teď, dešifruje později" |

---

## 3. Architektura a model důvěry

### 3.1 Komponenty a toky dat

```text
 Prohlížeč / Android A                     Server M5cet (Node/Express)                 Prohlížeč / Android B
 ─────────────────────                     ───────────────────────────                 ─────────────────────
 passphrase ─Argon2id─▶ room secret        /ws  signalizace (zapečetěné SDP/ICE)        room secret ◀─Argon2id─ passphrase
   └─HKDF─▶ message/signal/files/check/      ├─ členství v místnosti (slepé ID, jména)    ...
            room-id (slepé ID)               ├─ away relay: schránka (ciphertext klíčem místnosti, 30 dní)
 identita zařízení (ECDSA P-256)           /api/account  passkey (WebAuthn + PRF), trezor (ciphertext)
 statický ECDH P-256 klíč zařízení         /api/storage  SQLCipher DB uživatele (klíč z PRF drží server po dobu relace)
 účet: Ed25519 z kořene (PRF)              /api/functions, /api/ai, /api/speech, telefonie — PLAINTEXT
        │                                                                                  │
        └──────── WebRTC DataChannel (DTLS) — hello → párový klíč → sender keys ──────────┘
                  hovory: DTLS-SRTP + šifrování rámců (párové mediální klíče)
```

Podstatné vlastnosti návrhu:

* **Místnost je definovaná dvojicí (název, passphrase).** Kdo zná obě, je členem — neexistuje
  seznam členů chráněný kryptograficky ani správce skupiny; pozvánka (share link) jen předá
  název a passphrase.
  Z passphrase se Argon2id (64 MiB, 3 průchody, p = 1) odvodí kořen místnosti
  ([`kdf.ts:17`](../client/src/lib/kdf.ts), [`kdf.ts:24-35`](../client/src/lib/kdf.ts),
  sůl `m5cet:room:v3:<název>` [`envelope.ts:111`](../client/src/lib/envelope.ts)) a z něj HKDF
  oddělené klíče pro zprávy, signalizaci, soubory, kontrolní hodnotu a **slepé ID místnosti**
  ([`envelope.ts:114-132`](../client/src/lib/envelope.ts)). Server směruje podle slepého ID
  (`r3.<192 bitů>`), ne podle názvu.
* **Živé zprávy jdou P2P** přes WebRTC DataChannel (DTLS), nad ním aplikační šifrování
  sender keys / párovými klíči ([`sender-keys.ts`](../client/src/lib/sender-keys.ts)).
* **Přes server jdou šifrované zprávy** v těchto případech: away relay pro přihlášené nepřítomné
  členy ([`App.tsx:1530-1535`](../client/src/App.tsx), [`relay.ts:242-280`](../server/signaling/relay.ts)),
  proxy přenos souborů, serverová historie (trezor nebo session DB). Tvrzení README a
  `docs/security-model.md` „chatové zprávy přes server nejdou vůbec" proto **neplatí**.
* **Mimo E2EE (záměrně, opt-in):** chatové příkazy / Functions (vstupy i výstupy zpracovává
  server), AI chat a řeč (TTS/STT) — kód to sám přiznává
  ([`ai.ts:1-5`](../client/src/lib/ai.ts)), telefonie (viz [§ 5.3](#53-server)).

### 3.2 Co server vidí a ukládá

| Údaj | Vidí | Ukládá | Doklad |
|---|---|---|---|
| Obsah živých P2P zpráv | ne | ne | zprávy jdou po DataChannel, server jen signalizuje |
| SDP / ICE (IP adresy, DTLS otisky) | **ne** (zapečetěno klíčem `signal`) | ne | [`envelope.ts:237-245`](../client/src/lib/envelope.ts), [`App.tsx:2105-2106`](../client/src/App.tsx) |
| ID místnosti | slepé ID `r3.…` (v3) | v auditu jako `hashRoom` (16 hex znaků SHA-256), v away záznamech a schránce celé | [`traffic.ts:120-123`](../server/monitor/traffic.ts), [`store.ts:115`](../server/accounts/store.ts), [`mailqueue.ts`](../server/accounts/mailqueue.ts) |
| **Název místnosti v čitelné podobě** | **ano, v některých cestách** (serverová historie hosta, analytika s opt-in, chatové příkazy) | podle cesty | [`App.tsx:2786-2791`](../client/src/App.tsx), [`App.tsx:2972-2982`](../client/src/App.tsx), [`App.tsx:3651`](../client/src/App.tsx), [`App.tsx:3726`](../client/src/App.tsx) |
| Zobrazované jméno (přezdívka) každého člena | **ano, plaintext** | v paměti, v away záznamech, ve schránce (`from.name`, zapečetěno master klíčem) | [`hub.ts:530-626`](../server/signaling/hub.ts), [`frames.ts:59-60`](../server/signaling/frames.ts) |
| Kdo je v které místnosti, kdy přišel / odešel | **ano** | audit (`room.join` / `room.leave` s `accountId`, `/24` resp. `/48` IP) | [`hub.ts:624-625`](../server/signaling/hub.ts), [`hub.ts:683-684`](../server/signaling/hub.ts) |
| Vazba účet ↔ místnost | **ano** (token na socketu) | ostatním členům jen místnostně vázaná reference (HMAC) | [`hub.ts:635-642`](../server/signaling/hub.ts), [`refs.ts:46-48`](../server/signaling/refs.ts) |
| IP adresa | ano (celá, v paměti spojení) | zkrácená `/24`, `/48` v auditu a relacích | [`traffic.ts:126-132`](../server/monitor/traffic.ts), [`accounts/routes.ts:125`](../server/accounts/routes.ts) |
| Zprávy pro nepřítomné (away relay) | ciphertext klíčem místnosti + odesílatel, velikost, čas | ano, výchozí 30 dní, 1 000 položek / 8 MB na účet, „dead" 7 dní | [`mailqueue.ts:66-80`](../server/accounts/mailqueue.ts), [`relay.ts:242-280`](../server/signaling/relay.ts) |
| Potvrzení doručení / přečtení relayovaných zpráv | ano (id zprávy, stav, čas) | ano | [`hub.ts:506-507`](../server/signaling/hub.ts) |
| Trezor účtu (profil, historie, uložená připojení vč. passphrase) | ciphertext (klíč z PRF passkeye) | ano | [`passkey.ts:104-111`](../client/src/lib/passkey.ts), [`connections.ts:9-12`](../client/src/lib/connections.ts) |
| SQLCipher databáze uživatele | **klíč drží server v paměti po dobu relace** (max. 12 h bez použití) | soubor šifrovaný | [`passkey.ts:39-41`](../client/src/lib/passkey.ts), [`storage/keys.ts:6-12`](../server/storage/keys.ts) |
| Session DB hosta (bez passkeye) | server umí otevřít (master klíč); řádky historie navíc pečetí prohlížeč | 1 den | [`storage/keys.ts:14-19`](../server/storage/keys.ts), [`chat-history.ts:184-209`](../client/src/lib/chat-history.ts) |
| Účet | username, veřejné klíče passkeyů, zapečetěný kořen, ověřovač recovery kódu, HMAC e-mailu/telefonu (pepř), push endpointy, audit | `accounts.json` | [`store.ts:81-117`](../server/accounts/store.ts) |
| Tokeny relací | SHA-256 otisky, 12 h od posledního použití, max. 7 dní | `sessions.json` | [`store.ts:15-18`](../server/accounts/store.ts), [`store.ts:562-576`](../server/accounts/store.ts) |
| Push | endpoint + neutrální probuzení (bez jména a místnosti) | ano | [`relay.ts:385-411`](../server/signaling/relay.ts) |
| Chatové příkazy (Functions), AI, řeč | **plaintext** vstupů a výstupů | běhy funkcí v `functions.db` (nešifrováno, výchozí 30 dní) — viz [§ 5.3](#53-server) | [`App.tsx:3628-3652`](../client/src/App.tsx) |

### 3.3 Co může operátor / administrátor (S4)

Vše, co je v tabulce výše, plus (podrobně [§ 5.4](#54-administrátorská-konzole)):

* blokovat místnosti, omezit počet členů, odpojit členy, posílat do místnosti **oznámení
  s libovolným podpisem `from`** (až 60 znaků), která klient vykreslí v proudu zpráv
  ([`hub.ts:101-103`](../server/signaling/hub.ts), [`App.tsx:3072-3087`](../client/src/App.tsx));
* posílat klientům příkazy z allowlistu (`server/routes-admin-shared.ts`);
* číst běhy funkcí včetně vstupů a výstupů (u `/eid` osobní údaje a fotografie dokladu) a
  access log s plnými IP adresami;
* u zapsaných zařízení Android posílat podepsané příkazy `lock`, `wipe`, `status` (logy),
  `push`, `update`, `config` a měnit politiku zámku včetně vypnutí `FLAG_SECURE`
  ([§ 5.2](#52-aplikace-pro-android));
* **publikovat designové balíčky Androidu, které umí vynést dešifrované zprávy** (F-01);
* u webového klienta **doručit jiný JavaScript** (F-02).

Operátor (a každý, kdo ovládne server nebo jeho nasazení) je tedy dnes **pro důvěrnost obsahu
důvěryhodnou stranou na obou klientech** — E2EE chrání před pasivním čtením serveru a před
únikem jeho dat, ne před zlým provozovatelem. U Signal / Threema by zlý provozovatel musel
podvrhnout podepsanou aplikaci z obchodu.

### 3.4 Kompromitovaný server (S3)

| Útok | Proveditelnost | Proč |
|---|---|---|
| Přečíst živé zprávy pasivně | **ne** | zprávy nejdou přes server; DTLS + aplikační šifrování |
| MITM hovoru / kanálu záměnou DTLS otisků | **ne bez passphrase** | SDP/ICE jsou zapečetěné klíčem `signal` s AAD (odesílatel, příjemce) — [`envelope.ts:237-245`](../client/src/lib/envelope.ts) |
| MITM ve spolupráci se členem místnosti (S3 + S5) | **částečně** | člen umí otevřít zapečetěnou signalizaci, server přesměruje rámce → DTLS končí u útočníka. Sender keys a párové zprávy přesto neotevře: ECDH klíč v hello je podepsaný klíčem zařízení ([`sender-keys.ts:164-192`](../client/src/lib/sender-keys.ts)). **Otevře ale** vše pod klíčem místnosti (záložní obálky, soubory, relay) a — v prohlížeči bez `RTCRtpScriptTransform` — i hovor (jen DTLS-SRTP) |
| Podvrhnout zprávu člena | **ne** bez passphrase; s passphrase jen nepodepsanou nebo podepsanou cizím klíčem (TOFU varuje jen u jména, které už bylo připnuté; na Androidu vůbec — F-07) | AES-GCM + podpis uvnitř šifry ([`envelope.ts:156-181`](../client/src/lib/envelope.ts)) |
| Podvrhnout historii hosta v režimu „server" | **ano** | klient přijme i nezapečetěný řádek jako historii ([`chat-history.ts:198-202`](../client/src/lib/chat-history.ts)) — nález **F-11** |
| Přehrát starou relayovanou zprávu | **ano po znovunačtení stránky** (efemérní režim) | ochrana proti přehrání je jen v paměti relace ([`envelope.ts:314-332`](../client/src/lib/envelope.ts), [`App.tsx:1874`](../client/src/App.tsx)) |
| Doručit „soukromou" zprávu nepřítomnému jinému členovi | **ano, a ten ji otevře** | relay nese obálku klíčem místnosti, ne klíčem příjemce ([`App.tsx:3409-3427`](../client/src/App.tsx)) |
| Skrýt člena / předstírat odchod | ano | seznam členů je jen tvrzení serveru (`peer-joined` / `peer-left`); po `peer-left` klienti rotují sender key ([`App.tsx:3113`](../client/src/App.tsx)) — potlačením odchodu se rotace oddálí do hodinové / 500zprávové rotace |
| Přidat do místnosti „ducha" | ne bez passphrase | duch neprojde hello (kontrolní hodnota + podpis) |
| Offline lámat passphrase | **ano** | slepé ID místnosti = HKDF(Argon2id(passphrase, název)) je ověřitelné orákulum — nález **F-04** |
| Doručit upravený webový klient | **ano** | webová aplikace se načítá ze serveru; `integrity.ts` porovnává s manifestem téhož serveru ([`integrity.ts:1-20`](../client/src/lib/integrity.ts)) — nález **F-02** |
| Číst zprávy na Androidu | **ano** | podepsaný designový balíček s obrázkem `https://…/{$msg.text}` — nález **F-01** |
| Podstrčit Androidu vlastní klíč serveru při zápisu | **ano** (podvržený server) | připnutý `kid` se porovnává s řetězcem od serveru, ne s otiskem klíče — nález **F-05** |
| Číst trezor | ne | klíč z PRF passkeye neopouští prohlížeč (ale viz F-02) |
| Číst SQLCipher DB přihlášeného uživatele | **ano po dobu relace** | klíč DB posílá prohlížeč serveru ([`passkey.ts:39-41`](../client/src/lib/passkey.ts)) |

### 3.5 Síťový útočník (S1, S2)

* Signalizace jde přes WSS (TLS řeší reverse proxy / nasazení — ověřit konfiguraci konkrétního
  serveru), DataChannel a média přes DTLS / DTLS-SRTP s efemérním ECDHE, takže proti S1 platí
  dopředná utajenost transportu i u obsahu, který je aplikačně šifrovaný statickým klíčem.
* **IP adresy:** WebRTC běží s `iceTransportPolicy: "all"` a výchozím STUN serverem Google
  ([`rtc.ts:6-9`](../client/src/lib/rtc.ts), [`rtc.ts:25`](../client/src/lib/rtc.ts)) — každý člen
  místnosti zná IP adresy ostatních a Google vidí STUN dotazy. Volba „jen přes TURN" (jako
  Signal „Always relay calls") v kódu není.
* Délky zpráv nejsou zarovnané (žádný padding v `envelope.ts` ani `sender-keys.ts`) — délka
  ciphertextu prozrazuje délku textu.

### 3.6 Zlomyslný člen místnosti (S5)

Kdo zná passphrase, čte vše, co je pod klíčem místnosti (relay, outbox, soubory, signalizace),
může se kdykoli vrátit s novou identitou a „vyloučení" ho zastaví jen u toho, kdo ho vyloučil
a jen do konce relace ([`App.tsx:3978-3992`](../client/src/App.tsx)). Skutečné odebrání člena
znamená **změnit passphrase a sdělit ji ostatním mimo aplikaci.** To je zásadní rozdíl proti
Signal / WhatsApp / Threema / Wire (MLS), kde je členství ve skupině spravované a odebraný člen
nedostane nové klíče.

---

## 4. Kryptografie

### 4.1 Klíč místnosti a odvozování

| Prvek | Implementace | Hodnocení |
|---|---|---|
| KDF passphrase | Argon2id, 64 MiB, t = 3, p = 1, výstup 32 B; ve Web Workeru (hash-wasm) — [`kdf.ts:17-35`](../client/src/lib/kdf.ts) | dobré parametry (RFC 9106 druhá doporučená volba má p = 4; OWASP minimum je nižší) |
| Sůl | `m5cet:room:v3:<název místnosti>` — deterministická, protože obě strany musí dojít ke stejnému klíči — [`envelope.ts:111`](../client/src/lib/envelope.ts) | předpočítané slovníky pro běžné názvy místností jsou možné |
| Doménová separace | HKDF-SHA256, sůl `m5cet:v2`, info `message` / `signal` / `files` / `check` / `room-id` — [`envelope.ts:114-124`](../client/src/lib/envelope.ts) | správně |
| Kontrolní hodnota | 64 bitů HKDF, posílá se jen v hello po DTLS — [`envelope.ts:122`](../client/src/lib/envelope.ts), [`sender-keys.ts:164-166`](../client/src/lib/sender-keys.ts) | v pořádku (členové passphrase znají) |
| Slepé ID místnosti | 192 bitů HKDF `room-id` — [`envelope.ts:123`](../client/src/lib/envelope.ts), [`envelope.ts:132`](../client/src/lib/envelope.ts) | skrývá název, **ale je to orákulum pro hádání** (F-04) |
| Síla passphrase | **nevynucuje se** — jen „není prázdná" ([`App.tsx:3228`](../client/src/App.tsx), [`App.tsx:3263-3280`](../client/src/App.tsx)); generátor 24 znaků (~140 bitů) existuje jen v panelu uložených připojení ([`ConnectionsPanel.tsx:62-72`](../client/src/components/ConnectionsPanel.tsx)) | **slabé místo** |
| Zastaralé verze | obálky v2 (PBKDF2 600 000, název místnosti v čitelné podobě jako ID) a **v1 (PBKDF2 250 000, bez AAD, bez vazby na id)** se stále přijímají — [`envelope.ts:210-228`](../client/src/lib/envelope.ts), [`crypto.ts:75-89`](../client/src/lib/crypto.ts) | downgrade cesta (F-20) |

**Proč je slepé ID orákulum:** server (a každý, kdo vidí audit, zálohu `accounts.json` nebo
schránku) zná `r3.<HKDF(Argon2id(passphrase, sůl s názvem))>`. Pro každou dvojici
(název, passphrase) z kandidátních seznamů stojí ověření jeden Argon2id (64 MiB). Proti
náhodné 24znakové passphrase je to bezpečné, proti „heslo123" v místnosti „rodina" ne. Po
úspěšném uhodnutí útočník otevře celou schránku (30 dní zpětně), soubory zachycené v proxy
režimu a může MITM budoucí hovory (zná klíč `signal`). Totéž platí pro 16znakový `hashRoom`
v auditu (64 bitů stačí na potvrzení odhadu).

### 4.2 Obálka zpráv, AEAD a nonce

* AES-256-GCM, **12bajtové náhodné IV** z `crypto.getRandomValues` pro každou obálku
  ([`envelope.ts:183-188`](../client/src/lib/envelope.ts)); u sender keys je navíc každý klíč
  zprávy použit jednou ([`sender-keys.ts:270-278`](../client/src/lib/sender-keys.ts)), takže
  kolize IV je bezpředmětná.
* **Associated data** váže kontext: `m5cet/2|msg|<místnost>|<id>`, u sender keys
  `msg-sk|…|<keyId>|<n>`, u párových zpráv `msg-pair|…|<od>|<komu>`, u signalizace
  `signal|…|<od>|<komu>`, u souborů `chunk|<transfer>|<seq>|<počet>`
  ([`envelope.ts:63-65`](../client/src/lib/envelope.ts), [`envelope.ts:265-269`](../client/src/lib/envelope.ts)).
  Přesun ciphertextu jinam selže. Id uvnitř musí odpovídat id obálky
  ([`envelope.ts:223`](../client/src/lib/envelope.ts)).
* **Autenticita odesílatele:** tělo je podepsané ECDSA P-256 klíčem zařízení *uvnitř*
  šifrování, podpis pokrývá AAD i text ([`envelope.ts:156-181`](../client/src/lib/envelope.ts)).
  U párové zprávy se navíc kontroluje, že podepsal týž klíč, který podepsal hello
  ([`sender-keys.ts:312-313`](../client/src/lib/sender-keys.ts)).
* **Přehrání:** množina viděných id, max. 20 000, jen v paměti
  ([`envelope.ts:314-332`](../client/src/lib/envelope.ts)); sender keys odmítnou opakovaný index
  ([`sender-keys.ts:117-129`](../client/src/lib/sender-keys.ts)). Obálky klíčem místnosti
  (relay) lze po znovunačtení přehrát (F-21). `createdAt` má jen horní mez
  ([`validate.ts:176`](../client/src/lib/validate.ts)).
* **Validace payloadu:** `senderId` musí odpovídat peeru kanálu (u relaye peeru, kterého jmenuje
  server), délky jsou omezené ([`validate.ts:164-205`](../client/src/lib/validate.ts)).
* **Popiratelnost:** podpisy ECDSA (zařízení) a certifikát Ed25519 (účet) jsou **nepopiratelné**
  — příjemce může třetí straně dokázat, že zprávu podepsalo dané zařízení / účet. Signal záměrně
  autentizuje MAC klíči ze sdíleného tajemství (popiratelnost). Je to vědomá návrhová volba, ne
  chyba, ale do srovnání patří.
* **Padding:** žádný.

### 4.3 Identita, ověřování a TOFU

| Prvek | Implementace |
|---|---|
| Identita zařízení | ECDSA P-256, privátní klíč neexportovatelný v IndexedDB `m5cet-identity` ([`identity.ts:30-34`](../client/src/lib/identity.ts), [`identity.ts:115-142`](../client/src/lib/identity.ts)) |
| DH klíč zařízení | ECDH P-256, **vygenerovaný jednou a uložený natrvalo** ([`identity.ts:60-63`](../client/src/lib/identity.ts), [`identity.ts:128-141`](../client/src/lib/identity.ts)) |
| Identita účtu | Ed25519 odvozený HKDF z kořene účtu (stejný na všech zařízeních), certifikuje klíč zařízení podpisem `m5cet/device-cert/1\|<SPKI>` — **bez expirace a bez revokace** ([`identity.ts:169-198`](../client/src/lib/identity.ts)) |
| Připnutí (TOFU) | v `localStorage` podle **(místnost, zobrazované jméno)** → id klíče (účtu, nebo zařízení) ([`identity.ts:284-342`](../client/src/lib/identity.ts), [`App.tsx:1554-1577`](../client/src/App.tsx)) |
| Bezpečnostní číslo | SHA-512 iterovaný 1 025× nad seřazenými klíči zařízení, 12 × 5 číslic, QR `M5CET-SN:1:` se skenováním kamerou ([`identity.ts:261-273`](../client/src/lib/identity.ts), [`UserInfoModal.tsx:45-128`](../client/src/components/UserInfoModal.tsx)) |
| Adresář klíčů / transparentnost | **neexistuje**; server veřejný klíč účtu jen eviduje (`PUT /api/account/identity`), klienti ho od serveru neberou |

Slabiny:

1. **První kontakt se zobrazí jako „Ověřeno podpisem"** — verdikt `new` padá do větve
   `verified` ([`App.tsx:1569-1576`](../client/src/App.tsx), text
   [`i18n-security.ts:32-33`](../client/src/lib/i18n-security.ts)). Uživatel nerozliší „tento
   klíč vidím poprvé" od „tento klíč znám". Ověření bezpečnostním číslem má vlastní stav
   (`checked`), ale je jen v detailu zprávy.
2. **Pin je vázaný na zobrazované jméno**, které si každý volí sám. Útočník v nové místnosti
   (nebo pod jménem, které tam ještě nepsalo) získá „ověřený" stav okamžitě.
3. **Změna klíče jen varuje** (jednou za relaci) a zpráva se zobrazí; „nepodepsáno" je jen
   tlumený stav v detailu — přitom každý klient ≥ 3.1 podepisuje, takže nepodepsaná zpráva od
   člena s passphrase je podezřelá (odstranění podpisu je downgrade).
4. **Certifikát zařízení nelze odvolat.** Ukradené zařízení zůstává „ověřeným zařízením účtu"
   napořád; při kompromitaci kořene (passkey PRF nebo recovery kód) může útočník certifikovat
   libovolná zařízení a klíč účtu nelze rotovat bez nového účtu.
5. Otisky DTLS v panelu „Důvěra" jsou klíčované náhodným `peerId` relace a při neshodě se
   přepíší ([`fingerprint.ts:119-145`](../client/src/lib/fingerprint.ts),
   [`App.tsx:2535-2550`](../client/src/App.tsx)); „otisk místnosti" je SHA-256 jen z názvu
   ([`App.tsx:2811`](../client/src/App.tsx)) — neříká nic o klíči. Obojí jsou známé mezery č. 6
   a 7 z `docs/security-model.md`, stále neopravené, a UI je nabízí jako bezpečnostní údaj.

### 4.4 Párové klíče, sender keys, dopředná utajenost a obnova po kompromitaci

**Párový klíč** ([`sender-keys.ts:164-192`](../client/src/lib/sender-keys.ts)): po otevření
kanálu si strany pošlou podepsané hello `{check, pk, dh, sig}`; podpis ECDSA váže DH klíč na klíč
zařízení i na místnost a peer id. Párový klíč = HKDF(ECDH(můj DH, tvůj DH), sůl = místnost,
info = oba klíče zařízení seřazené). **Oba DH klíče jsou statické** (§ 4.3), takže párový klíč
je pro danou dvojici zařízení a místnost **stále stejný** napříč všemi relacemi. To je
„static–static" Diffie-Hellman — bez efemérní složky, bez dopředné utajenosti na aplikační
vrstvě.

**Sender keys** ([`sender-keys.ts:43-99`](../client/src/lib/sender-keys.ts)): každý odesílatel
má řetěz `CK`; `MK_n = HMAC(CK_n, 0x01)`, `CK_{n+1} = HMAC(CK_n, 0x02)`, starý článek se
přepíše nulami. Aktuální `CK` dostane každý peer zapečetěný párovým klíčem. Rotace: po 500
zprávách, po hodině, při odchodu nebo vyloučení člena
([`sender-keys.ts:46`](../client/src/lib/sender-keys.ts), [`sender-keys.ts:251-256`](../client/src/lib/sender-keys.ts)).
Přeskočit lze nejvýš 1 000 zpráv. Konstrukce odpovídá „symetrickému ratchetu" Signal Sender Keys
/ Megolm.

| Vlastnost | M5cet | Poznámka |
|---|---|---|
| Dopředná utajenost živých skupinových zpráv | **částečná** | hash ratchet: ze současného `CK` nelze spočítat starší klíče. Ale distribuce `CK` jde pod statickým párovým klíčem — kdo později získá DH klíč zařízení (nebo jen možnost ho použít) a má záznam distribuční zprávy, spočítá celé řetězy. Proti S1 to vyvažuje efemérní DTLS. |
| Dopředná utajenost soukromých (párových) zpráv | **ne na aplikační vrstvě** | statický párový klíč; spoléhá se na DTLS |
| Obnova po kompromitaci (PCS) | **ne kryptograficky** | žádný DH ratchet. Nový náhodný řetěz po hodině / 500 zprávách „vyléčí" jen únik samotného řetězu, ne únik DH klíče zařízení, a nový řetěz putuje pod týmž statickým klíčem |
| Zprávy přes server (relay, outbox), soubory | **bez FS i PCS** | statický klíč místnosti odvozený z passphrase (§ 4.5) |
| Asynchronní ustavení klíče (offline příjemce) | **neexistuje** | nic jako X3DH/PQXDH prekeys — offline příjemce dostane jen obálku klíčem místnosti |

Signal (Double Ratchet + PQXDH, od 2025 i SPQR), WhatsApp (Signal protocol) a Wire (Proteus,
MLS) mají pro 1:1 DH ratchet a tím PCS; Threema (Ibex) dává dopřednou utajenost efemérním ECDH
na začátku relace a hash ratchetem, PCS nedeklaruje. M5cet je zde na úrovni Megolm v Matrixu
(sender keys bez PCS), s tím rozdílem, že párový kanál pod ním je navíc statický.

### 4.5 Co zůstává pod klíčem místnosti

Klíč `message` / `files` / `signal` je odvozený jen z passphrase a názvu, nikdy se nemění a
znají ho všichni členové minulí i budoucí. Používá se pro:

* zprávy nepřítomným (away relay) — **i soukromé** (`to: [...]`): odesílatel posílá do relaye
  `envelope` zapečetěný klíčem místnosti ([`App.tsx:3409-3427`](../client/src/App.tsx));
* frontu odchozích zpráv v light režimu (outbox) — tamtéž;
* peery, se kterými ještě neproběhlo hello (`?? roomEnvelope`, [`App.tsx:2139-2143`](../client/src/App.tsx));
* **všechny soubory** — klíč přenosu = HKDF(`files`, sůl = id přenosu)
  ([`envelope.ts:255-263`](../client/src/lib/envelope.ts), [`file-transfer.ts:20-27`](../client/src/lib/file-transfer.ts));
* signalizaci (SDP/ICE).

Důsledek: kdo passphrase zná dnes nebo ji pozná kdykoli později (bývalý člen, uhodnutí přes
slepé ID, únik z NFC tagu, F-12), otevře vše, co server ze schránky uchoval (30 dní), a všechny
soubory, jejichž ciphertext získal (proxy režim jde přes server).

### 4.6 Hovory

* DTLS-SRTP prohlížeče; DTLS otisky v SDP chrání zapečetěná signalizace.
* Navíc šifrování rámců přes `RTCRtpScriptTransform` (myšlenka SFrame): AES-GCM, jasný prefix
  1 / 3 / 10 B jako AAD, klíče směrové z párového ECDH
  ([`media-frames.ts:1-57`](../client/src/lib/media-frames.ts), [`sender-keys.ts:184-188`](../client/src/lib/sender-keys.ts)).
  UI ukazuje stav `e2ee` / `partial` / `off` ([`media-e2ee.ts:95-101`](../client/src/lib/media-e2ee.ts)).
* **Nonce:** IV = 4 B náhodná sůl + 64bit čítač od nuly, nová sůl při každém nastavení klíčů
  ([`media-frames.ts:32-43`](../client/src/lib/media-frames.ts), [`media-e2ee.worker.ts:64-67`](../client/src/lib/media-e2ee.worker.ts)).
  Protože mediální klíč je odvozený ze **statického** párového klíče, je pro dvojici zařízení
  v místnosti stejný ve **všech** hovorech a pro audio i video. Kolize 32bitové soli mezi
  dvěma proudy pod týmž klíčem (pravděpodobnost ≈ S² / 2³³ pro S proudů za život klíče) znamená
  znovupoužití IV v GCM — únik XOR plaintextů a autentizačního klíče GHASH. Riziko je malé, ale
  strukturální (F-19). SFrame (RFC 9605) tomu brání odvozením klíče a soli per KID.
* Přijímač **propustí nezapečetěný rámec** (`clearIn`) i poté, co má klíče
  ([`media-e2ee.worker.ts:41`](../client/src/lib/media-e2ee.worker.ts)) — kdo ovládne SRTP
  (S3 + S5 v MITM), může snížit ochranu na samotné DTLS-SRTP; UI pak ukáže `partial`.
* Prohlížeč bez `RTCRtpScriptTransform` má jen DTLS-SRTP ([`media-e2ee.ts:12-14`](../client/src/lib/media-e2ee.ts)).

### 4.7 Soubory

Šifrování po 32 KiB blocích, klíč na přenos, AAD (přenos, pořadí, počet), podepsaný otisk
otisků bloků v koncovém rámci, MIME typ zúžený na bezpečný ([`file-transfer.ts:1-35`](../client/src/lib/file-transfer.ts)).
Konstrukce je čistá; slabinou je jen klíč odvozený z klíče místnosti (§ 4.5) — soubor neotevře
server, ale otevře ho každý držitel passphrase, který získá ciphertext.

### 4.8 Účty, passkey, trezor a obnova

* **WebAuthn na serveru** vlastní implementací (CBOR, COSE): kontrola výzvy (jednorázová,
  2 min), originu, `crossOrigin`, hashe rpId, UP **i UV**, čítače podpisů
  ([`webauthn.ts:85-101`](../server/accounts/webauthn.ts), [`webauthn.ts:191-238`](../server/accounts/webauthn.ts)).
  Atestace se neověřuje (běžné u passkeyů). Vlastní parser CBOR je kód, který by měl projít
  fuzzingem.
* **Origin politika:** bez `WEBAUTHN_ORIGINS` projde jakýkoli https origin na rpId **včetně
  subdomén** ([`webauthn.ts:74-84`](../server/accounts/webauthn.ts)). S PRF to má váhu: skript
  na libovolné subdoméně rpId může (po potvrzení uživatelem) získat PRF výstup téhož passkeye
  a tím kořen účtu a klíč trezoru (F-24).
* **Hierarchie klíčů** ([`passkey.ts:1-43`](../client/src/lib/passkey.ts)): PRF prvního
  passkeye = kořen účtu; HKDF → klíč trezoru (`m5cet:profile:v1`), klíč DB (`m5cet:userdb:v1`,
  **posílá se serveru**), důkaz klíče (`m5cet:key-proof:v1`, server drží SHA-256). Další
  passkeye a recovery kód mají kořen zapečetěný AES-GCM s AAD.
* **Recovery kód:** 26 znaků Crockford base32 = 130 bitů, server zná jen HMAC-odvozené id a
  SHA-256 důkazu ([`recovery.ts:1-51`](../client/src/lib/recovery.ts)). Dostatečné; protahovací
  KDF není při 130 bitech potřeba.
* **Trezor** (profil, historie, uložená připojení včetně passphrase místností) je AES-GCM klíčem
  z PRF; klíč je neexportovatelný `CryptoKey` v IndexedDB, aby reload nevyžadoval passkey
  ([`account.ts:1-10`](../client/src/lib/account.ts)). „Neexportovatelný" chrání před
  JavaScriptem, ne před forenzní kopií profilu prohlížeče.
* **Passkey bez PRF účet nezaloží** — žádný tichý pád na slabší režim
  ([`passkey.ts:48-55`](../client/src/lib/passkey.ts)).

### 4.9 Další mechanismy s heslem

| Mechanismus | Konstrukce | Hodnocení |
|---|---|---|
| Zapečetěná zpráva (kód mimo kanál) | 12 znaků (~59 bitů), PBKDF2-SHA256 600 000, sůl 16 B; v1: 6 znaků / 150 000 ([`message-kinds.ts:100-146`](../client/src/lib/message-kinds.ts)) | přijatelné pro účel; v1 je slabá (~30 bitů) a stále se otevírá |
| NFC tag „Připojka" | **název + passphrase místnosti** pod PINem **4–16 číslic**, PBKDF2 200 000 ([`nfc.ts:30-43`](../client/src/lib/nfc.ts), [`connection-card.ts:11-12`](../client/src/lib/nfc/cards/connection-card.ts), [`connection-card.ts:47-55`](../client/src/lib/nfc/cards/connection-card.ts)) | **slabé:** tag přečte kdokoli s telefonem, 4–6místný PIN padne offline během sekund až hodin (F-12) |
| Pozvánka (share link) | klíč z fragmentu URL ‖ klíč na serveru ‖ PBKDF2(12místný kód), 5 pokusů na serveru ([`share-link.ts:96`](../client/src/lib/share-link.ts)) — viz [§ 5.1](#51-webový-klient) | rozumné rozdělení tajemství |
| Relace v kartě | passphrase v `sessionStorage`, AES-GCM klíčem z IndexedDB, nečinnost 1 h ([`session-cache.ts:1-40`](../client/src/lib/session-cache.ts)) | poctivě popsaný kompromis pohodlí |

### 4.10 Náhodnost

Veškerá klientská náhodnost je z `crypto.getRandomValues` / WebCrypto `generateKey`
(IV, řetězy sender keys, identity, recovery a pečeticí kódy s rejection samplingem — [`ConnectionsPanel.tsx:62-72`](../client/src/components/ConnectionsPanel.tsx),
[`message-kinds.ts:110-117`](../client/src/lib/message-kinds.ts); `b & 31` je u recovery kódu
nestranné, [`recovery.ts:21-26`](../client/src/lib/recovery.ts)). Server používá
`crypto.randomBytes` (tokeny, výzvy, resume tajemství — [`store.ts:563`](../server/accounts/store.ts),
[`hub.ts:586`](../server/signaling/hub.ts)). `Math.random` se objevuje jen mimo kryptografii —
id volání funkce v UI, výchozí přezdívka a rozptyl opakovaného připojení
([`App.tsx:3642`](../client/src/App.tsx), [`App.tsx:494`](../client/src/App.tsx), [`App.tsx:2712`](../client/src/App.tsx)).

### 4.11 Post-kvantová odolnost

Žádná. Všechna asymetrická kryptografie je klasická (ECDH P-256, ECDSA P-256, Ed25519, ECDHE
v DTLS). Proti S7 („sklízej teď") chrání živé zprávy jen DTLS (klasické ECDHE) a statické ECDH
párové klíče; zprávy pod klíčem místnosti jsou symetrické (AES-256) a ohrožené jen přes
passphrase. Signal (PQXDH 2023, SPQR 2025) je zde výrazně napřed; Threema, Wire, Matrix a
Session post-kvantovou ochranu teprve plánují, u WhatsAppu není zdokumentovaná (§ 6).

### 4.12 Úložiště na zařízení

**Prohlížeč** (podrobnosti [§ 5.1](#51-webový-klient)):

| Data | Kde | Ochrana |
|---|---|---|
| Passphrase aktuální relace | `sessionStorage` | AES-GCM, neexportovatelný klíč v IndexedDB, nečinnost 1 h; `touchedAt` je mimo AEAD, skript v originu může limit prodloužit ([`session-cache.ts:166-221`](../client/src/lib/session-cache.ts)) |
| Uložená připojení (vč. passphrase) | jen v trezoru účtu | klíč z PRF ([`connections.ts:9-12`](../client/src/lib/connections.ts)); export passphrase vynechává ([`ConnectionsPanel.tsx:238-239`](../client/src/components/ConnectionsPanel.tsx)) |
| Historie v režimu „session" | `sessionStorage` | AES-GCM (bez AAD) + **název místnosti v čitelné podobě** ([`chat-history.ts:224-231`](../client/src/lib/chat-history.ts)) |
| Klíč trezoru | IndexedDB `m5cet-account`, přežije zavření karty | neexportovatelný `CryptoKey`; maže ho odhlášení / smazání účtu / „Smazat vše" ([`account.ts:111-113`](../client/src/lib/account.ts), [`account.ts:629-639`](../client/src/lib/account.ts)) |
| Identita zařízení, DH klíč | IndexedDB `m5cet-identity`, trvale | neexportovatelné klíče |
| TOFU piny, otisky, předvolby | `localStorage` **v čitelné podobě** | názvy místností, jména lidí, id klíčů — trvalý „sociální graf" ([`identity.ts:280-299`](../client/src/lib/identity.ts), [`preferences.ts:191`](../client/src/lib/preferences.ts)); slovník klíčů MIFARE ([`NfcWorkbench.tsx:121`](../client/src/components/NfcWorkbench.tsx)) |
| „Smazat vše a odejít" | — | maže úložiště, IndexedDB (vyjmenované databáze), cache, service worker, push, cookies a volá `Clear-Site-Data` ([`wipe.ts`](../client/src/lib/wipe.ts), [`share.ts:206`](../server/share.ts)); **neodvolá token účtu na serveru** ([`App.tsx:4745-4760`](../client/src/App.tsx)) |

**Android** (podrobnosti [§ 5.2](#52-aplikace-pro-android)): trezor `noBackupFilesDir/m5`, každý záznam
AES-256-GCM s AAD `tier|name` ([`Vault.java:42`](../android/app/src/main/java/cz/m5cet/app/security/Vault.java),
[`Vault.java:200-207`](../android/app/src/main/java/cz/m5cet/app/security/Vault.java)). Vrstva USER
(passphrase místností, historie, klíče identity, piny) je pod klíčem z PINu / biometrie, vrstva SYS
(konfigurace, logy, balíčky, čítač pokusů, push token) pod klíčem Keystore bez autentizace
uživatele. Zálohy vypnuté (`allowBackup=false`, `dataExtractionRules` vylučují vše —
[`AndroidManifest.xml:45-47`](../android/app/src/main/AndroidManifest.xml)).

### 4.13 Push notifikace

* **Web Push** (RFC 8291, šifrováno pro prohlížeč): relay posílá neutrální probuzení — titulek
  „M5cet", prázdné tělo, odkaz `/signin`, žádné jméno ani místnost
  ([`relay.ts:394-406`](../server/signaling/relay.ts)); service worker text doplní v jazyce
  zařízení ([`sw.js:50-51`](../client/public/sw.js)). Operátorské pushe nesou text operátora.
* **FCM (Android):** jen datové zprávy `{m5:1, i, e, iv, ct, s}` — příkaz podepsaný klíčem
  serveru a zašifrovaný ECIES pro zařízení, s deduplikací a expirací
  ([`Control.java:41-60`](../android/app/src/main/java/cz/m5cet/app/push/Control.java),
  [`server/android/commands.ts:41`](../server/android/commands.ts)). Chatové zprávy přes FCM
  nejdou; Google vidí jen časování a velikost.
* Hodnocení: obsahově srovnatelné se Signalem (prázdné probuzení), metadata časování zůstávají
  u poskytovatele push služby jako u všech.

### 4.14 Metadata, „sealed sender" a kontakty

* **Žádné telefonní číslo** se nevyžaduje; host (bez účtu) je jen přezdívka + IP. Registrace
  formulářem (6.4) e-mail a telefon na serveru uchovává jen jako HMAC s pepřem
  ([`store.ts:97-103`](../server/accounts/store.ts)); hodnoty jdou serverem přechodně
  v plaintextu ([`registration/client.ts:35-40`](../client/src/lib/registration/client.ts)).
* **Žádný „sealed sender":** server zná odesílatele každého relayovaného rámce (socket, účet,
  přezdívka) i příjemce ([`relay.ts:242-280`](../server/signaling/relay.ts)). Sealed sender v
  Signalu skrývá odesílatele i před serverem.
* **Členství a časování** zná server vždy (§ 3.2). Slepé ID místnosti skrývá název, ale ne
  graf „kdo je s kým, kdy a jak dlouho".
* **Vyhledávání kontaktů** (contact discovery) v Signal smyslu neexistuje — místnost se
  domlouvá mimo aplikaci. To je soukromější než nahrávání adresáře, ale přesouvá výměnu
  tajemství na uživatele.
* Android používá **jeden statický klíč identity pro všechny místnosti** — člen dvou místností
  je napříč nimi spojitelný ([`Rooms.java:107-121`](../android/app/src/main/java/cz/m5cet/app/chat/Rooms.java)).
  Totéž platí pro web (jedna identita na profil prohlížeče).

### 4.15 Integrita členství ve skupině

Neexistuje kryptograficky chráněný seznam členů ani správa skupiny. Členem je, kdo zná
(název, passphrase); seznam přítomných je tvrzení serveru. Klient zvládne odmítnout nečlena (hello
s kontrolní hodnotou a podpisem), ale nezjistí, že server někoho zatajil, a „vyloučení" je
lokální a do konce relace (§ 3.6). Signal (skupiny v2, zkgroup), WhatsApp, Threema a Wire (MLS)
mají členství podepsané / spravované a odebraný člen nedostane nové klíče.

---

## 5. Bezpečnost platforem

### 5.1 Webový klient

**Hlavičky a CSP** (produkce, [`server/index.ts:164-190`](../server/index.ts)):
`script-src 'self' 'wasm-unsafe-eval'` (bez `unsafe-inline` / `unsafe-eval` — známá mezera č. 8
je v produkci opravená, `unsafe-*` zůstává jen pro vývoj), `object-src 'none'`,
`frame-ancestors 'none'`, `frame-src 'self'` (jen sandbox funkcí), `style-src` s
`'unsafe-inline'` a Google Fonts / Fontshare (jen po souhlasu, [`fonts.ts:131`](../client/src/lib/fonts.ts)),
`connect-src 'self' wss: ws: https://tile.openstreetmap.org`. `connect-src wss: ws:` povoluje
jakýkoli WebSocket host — při případném XSS hotový kanál ven (nízké). V `client/index.html`
nejsou skripty třetích stran.

**XSS povrchy (ověřeno):**

* V `client/src` není žádný `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval` ani `new Function`.
* Markdown se parsuje do stromu a vykresluje React elementy; odkazy jen `https?:` a `mailto:`
  ([`markdown.ts:29-34`](../client/src/lib/markdown.ts), [`Markdown.tsx:9-55`](../client/src/components/Markdown.tsx)).
* HTML výstupy funkcí (`m5.out.html`): parser bez DOM s allowlisty tagů, atributů, CSS a URL,
  kontrola na serveru, u příjemce i při vykreslení ([`fn-html.ts:17-73`](../client/src/lib/fn-html.ts),
  [`FnHtml.tsx:27-44`](../client/src/components/fn/FnHtml.tsx)). Zbývá jen vizuální přesah
  (okraje, rozměry) — nízké.
* Rozvržení a menu (od operátora) prochází `sanitizeTree` / `parseSafeHtml` s allowlisty akcí
  ([`layout-tree.ts:207`](../client/src/lib/layout-tree.ts), [`layout-tree.ts:337-361`](../client/src/lib/layout-tree.ts),
  [`menu-template.ts:753-833`](../client/src/lib/menu-template.ts)). Operátor ale může postavit
  překryvné prvky a pole `password` — v rámci jeho důvěry (stejně doručuje celý bundle).
* Přílohy a soubory: MIME zúžené na bezpečný allowlist ([`validate.ts:31-81`](../client/src/lib/validate.ts),
  [`file-transfer.ts:712-713`](../client/src/lib/file-transfer.ts)); soubory funkcí jen jako
  `application/octet-stream`.

**Problémy:**

1. **Kód v prohlížeči od člena místnosti (F-08).** Zpráva může nést výstup funkce typu `js`
   (až 200 000 znaků): validace u příjemce ho propustí ([`validate.ts:97-110`](../client/src/lib/validate.ts),
   [`fn-outputs.ts:289-296`](../client/src/lib/fn-outputs.ts)) a [`FnOutputs.tsx:193-204`](../client/src/components/fn/FnOutputs.tsx)
   ho **spustí bez kliknutí** v `<iframe sandbox="allow-scripts">` ([`FnSandbox.tsx:67-78`](../client/src/components/fn/FnSandbox.tsx)).
   Neprůhledný origin chrání DOM, úložiště i klíče aplikace, ale CSP sandboxu povoluje
   `connect-src https:` a `img-src https:` ([`sandbox-page.ts:16-28`](../server/functions/sandbox-page.ts)),
   takže kód odešle IP, user-agent a čas zobrazení **každého příjemce** na libovolný server.
   Most `send` / `submit` navíc volá `/api/functions/event` **s tokenem prohlížejícího**
   a s modelem / řetězem, které zvolil odesílatel ([`FnOutputs.tsx:198-199`](../client/src/components/fn/FnOutputs.tsx),
   [`App.tsx:3721-3727`](../client/src/App.tsx)); server kontroluje jen, že řetěz patří modelu
   ([`server/functions/routes.ts:224-228`](../server/functions/routes.ts)). Pokud model odpoví
   interakcí `nfc`, web ji spustí bez dalšího potvrzení ([`App.tsx:3586-3601`](../client/src/App.tsx);
   výjimkou je e-ID, které si klíč dokladu vyžádá — ověřit, kdy je NFC executor registrovaný).
2. **Podvržené prvky UI v cizí zprávě (F-22).** Výstupy funkcí od člena mohou obsahovat formuláře
   s polem `password`, tlačítka, toast notifikace a „okna", která samy otevřou panely aplikace
   (připojení, pozvánka, telefon, důvěra) ([`fn-outputs.ts:18`](../client/src/lib/fn-outputs.ts),
   [`FnOutputs.tsx:146-159`](../client/src/components/fn/FnOutputs.tsx)). Citace (`replyTo`)
   a „přeposláno od" jsou volný text odesílatele ([`validate.ts:201-205`](../client/src/lib/validate.ts)).
   Jména procházejí jen odstraněním řídicích znaků C0 — bidi a homoglyfy projdou
   ([`validate.ts:51-55`](../client/src/lib/validate.ts)).
3. **Doručování kódu serverem (F-02).** Každé načtení stahuje JavaScript ze serveru.
   [`integrity.ts`](../client/src/lib/integrity.ts) porovnává verze a seznam souborů s manifestem
   **téhož** serveru a hodnoty `sha256` z manifestu vůbec neporovnává ([`integrity.ts:60-61`](../client/src/lib/integrity.ts))
   — chrání před míchanými verzemi, ne před zlým serverem. Service worker nemá `fetch` handler
   ani cache ([`sw.js`](../client/public/sw.js)), takže ani „pin" verze kódu neexistuje.
4. **Podvržená historie** v režimu „server" bez passkeye (F-11): řádek bez pečeti se přijme a
   neprojde ani `validatePayload`, ani sanitizací výstupů funkcí či MIME
   ([`chat-history.ts:88-105`](../client/src/lib/chat-history.ts), [`chat-history.ts:202`](../client/src/lib/chat-history.ts)).
5. **Trezor bez vazby slotů:** profil, historie, připojení i registrace jsou AES-GCM jedním klíčem
   bez AAD ([`passkey.ts:129-144`](../client/src/lib/passkey.ts)) — server může sloty prohodit nebo
   vrátit starší verzi (nízké).
6. **Vývojový server:** `vite.config.ts` zakazuje jen `.env`, `.env.*`, `.git`, `.m5cet`, `*.key`,
   `*.pem` ([`vite.config.ts:138-144`](../vite.config.ts)), Vite běží jako middleware s
   `allowedHosts: true` a server poslouchá na `0.0.0.0` ([`server/vite.ts:13-15`](../server/vite.ts),
   [`server/index.ts:259`](../server/index.ts)). Soubor jako `.env-bak` (v hlavním checkoutu
   existuje) je pak v dev režimu pravděpodobně čitelný přes `/@fs/…` z místní sítě — **ověřit**;
   produkce se netýká.
7. Ověření „stejný origin" u cest přijme `/\evil.com`, které prohlížeč vyloží jako
   `//evil.com` ([`sw.js:33`](../client/public/sw.js), [`App.tsx:985`](../client/src/App.tsx),
   [`menu-config.ts:306`](../client/src/lib/menu-config.ts)) — otevřené přesměrování z hodnot
   serveru / operátora (nízké).

**Pozvánky** ([`share-link.ts:55-133`](../client/src/lib/share-link.ts)): `/#j=<id>.<linkKey>` jen ve
fragmentu (po příchodu se smaže, [`App.tsx:4680-4685`](../client/src/App.tsx)); klíč dat =
HKDF(linkKey ‖ serverKey ‖ PBKDF2-200k(12místný kód ≈ 40 bitů)). Server sám nic neotevře;
server **spolu s odkazem** může kód lámat offline (10¹² × PBKDF2-200k — drahé, ale pro
dobře financovaného útočníka proveditelné). Limit 5 pokusů je na serveru.

### 5.2 Aplikace pro Android

Nativní aplikace (Java 17, minSdk 29, targetSdk 37, R8 v release —
[`build.gradle.kts`](../android/app/build.gradle.kts)) implementuje **stejný protokol** jako web:
Argon2id 64 MiB / 3 / 1 s toutéž solí, HKDF účely, slepé ID, AAD kontexty, sender keys
(500 zpráv / 1 h, MAX_SKIP 1 000), párový klíč a podepsané hello
([`RoomKeys.java:18-67`](../android/app/src/main/java/cz/m5cet/app/chat/RoomKeys.java),
[`Envelopes.java:23-185`](../android/app/src/main/java/cz/m5cet/app/chat/Envelopes.java),
[`SenderKeys.java:24-274`](../android/app/src/main/java/cz/m5cet/app/chat/SenderKeys.java)) —
JCA / AndroidKeyStore, Argon2id je **vlastní implementace v Javě** (proti testovacím vektorům
RFC 9106 neověřeno — ověřit). Náhodnost `SecureRandom`.

Silné stránky (ověřeno):

* Keystore: `m5.sys` AES-GCM (StrongBox, jinak TEE), `m5.bio` s `setUserAuthenticationRequired`
  a `setInvalidatedByBiometricEnrollment`, BiometricPrompt vždy s `CryptoObject` a
  BIOMETRIC_STRONG ([`Keystore.java:21-112`](../android/app/src/main/java/cz/m5cet/app/security/Keystore.java),
  [`Biometric.java:41-46`](../android/app/src/main/java/cz/m5cet/app/security/Biometric.java)).
* Zámek: PIN 4–12 číslic (výchozí 6), 8 pokusů (3–20), exponenciální čekání 30 s·2ⁿ, po
  vyčerpání výchozí **vymazání** (klíče Keystore i data) ([`AppLock.java:38-112`](../android/app/src/main/java/cz/m5cet/app/security/AppLock.java),
  [`Wiper.java:28-63`](../android/app/src/main/java/cz/m5cet/app/security/Wiper.java)). `FLAG_SECURE`
  je výchozí i pro dialogy.
* Jediný WebView (`FnHtmlView`): JS vypnutý, síť a soubory blokované, žádný
  `addJavascriptInterface`, CSP `default-src 'none'` ([`FnHtmlView.java:168-261`](../android/app/src/main/java/cz/m5cet/app/fn/FnHtmlView.java)).
* Síť: `HttpURLConnection` bez přesměrování, vlastní WebSocket nad `SSLSocket` s explicitním
  ověřením jména hostitele, žádné přepsané `TrustManager` / `HostnameVerifier`; release
  `network_security_config` zakazuje cleartext a důvěřuje jen systémovým CA (bez TLS pinningu).
* Aktualizace APK: podepsaný manifest vydání (hash APK + certifikát) ověřený klíčem serveru
  **a** shoda podpisového certifikátu instalovaného balíčku ([`Releases.java:88-126`](../android/app/src/main/java/cz/m5cet/app/update/Releases.java))
  — server sám nový kód nepodstrčí bez podpisového klíče APK.
* Exportované komponenty jsou minimální (`MainActivity`; stubové `AuthenticatorService` /
  `SyncService` bez oprávnění; HCE `CardService` s `BIND_NFC_SERVICE` a `requireDeviceUnlock`).

Problémy:

1. **Kritické — designové balíčky mohou vynášet dešifrované zprávy (F-01).** UI aplikace se
   kreslí podle serverem podepsaných „design" balíčků. Bublina zprávy dostává rozsah `$msg`
   s dešifrovaným textem, odesílatelem, kódem zapečetěné zprávy, polohou a citací
   ([`ChatMessage.java:190-212`](../android/app/src/main/java/cz/m5cet/app/chat/ChatMessage.java),
   [`MessageList.java:378`](../android/app/src/main/java/cz/m5cet/app/ui/parts/MessageList.java)).
   Prvek `image` vyhodnotí `src` jako šablonu / výraz ([`Renderer.java:645-650`](../android/app/src/main/java/cz/m5cet/app/ui/Renderer.java),
   [`Renderer.java:724-731`](../android/app/src/main/java/cz/m5cet/app/ui/Renderer.java)) a
   libovolnou `https://` adresu stáhne na pozadí ([`Renderer.java:961-967`](../android/app/src/main/java/cz/m5cet/app/ui/Renderer.java)).
   Serverová kontrola designu to propustí: výrazy `=` jsou vyjmuté a `https://[^\s"'<>]+`
   připouští `{…}` ([`server/android/design.ts:628`](../server/android/design.ts)). Design
   `"src": "https://evil.example/{$msg.text}"` tedy vynese každou zobrazenou zprávu. Stejně lze
   číst `$form` (falešná obrazovka PINu / passphrase), přepínat nastavení (`setting.set` —
   sledování polohy na server, hlas přes server, emulace NFC) a posílat příkazy do místnosti
   ([`Actions.java:79-91`](../android/app/src/main/java/cz/m5cet/app/ui/Actions.java)). Kód
   spustit nelze (výrazový jazyk je čistý), ale **operátor, který smí publikovat design, nebo
   kdokoli, kdo převezme server, čte E2E obsah na Androidu.** Tím padá výhoda nativní aplikace
   proti webu (F-02).
2. **Vysoké — obejitelné připnutí klíče serveru (F-05).** Při zápisu zařízení se `kid` z QR a
   `BuildConfig.SERVER_KEY_PIN` porovná jen s řetězcem `kid`, který **pošle server**
   ([`Forms.java:204-208`](../android/app/src/main/java/cz/m5cet/app/ui/parts/Forms.java)); veřejný
   klíč se uloží bez kontroly, že jeho otisk tomu `kid` odpovídá ([`Config.java:77-84`](../android/app/src/main/java/cz/m5cet/app/core/Config.java);
   `Ec.kid()` existuje, ale na klíč serveru se nepoužije). Podvržený server stačí, aby `kid`
   zopakoval — a jeho klíč se stane kořenem důvěry pro příkazy (wipe, lock, status s logy),
   designy i vydání.
3. **Středně vysoké — „ověřeno" u cizího podpisu (F-07).** Na P2P cestě `verified = signer.valid &&
   !p.changed`, na relay cestě jen `signer.valid` — bez kontroly, že klíč podpisu je klíč z hello
   peeru nebo připnutý klíč pro dané jméno ([`RoomSession.java:429`](../android/app/src/main/java/cz/m5cet/app/chat/RoomSession.java),
   [`RoomSession.java:650`](../android/app/src/main/java/cz/m5cet/app/chat/RoomSession.java)).
   Člen místnosti pošle zprávu se jménem „Alice" podepsanou svým klíčem a Android ji ukáže
   jako ověřenou. Android navíc certifikát účtu (`apk` / `ac`) neposílá, jen ověřuje — peery
   z Androidu web nikdy neuvidí jako „ověřený účet".
4. **Střední — název místnosti na server (F-10).** Běhy funkcí posílají `Origin.room = label`
   (zadaný název, [`Fn.java:95`](../android/app/src/main/java/cz/m5cet/app/ui/parts/Fn.java)),
   logy obsahují název místnosti a server si je vyžádá podepsaným příkazem `status`
   ([`Control.java:67-70`](../android/app/src/main/java/cz/m5cet/app/push/Control.java)). Název je sůl
   Argon2id — server pak lámá passphrase proti slepému ID (F-04).
5. **Střední — politika zámku není podepsaná (F-16).** Odpověď check-inu (`screenshots`, `wipe`,
   `maxAttempts`, `biometric`, `autolockSeconds` bez horní meze) se aplikuje jen pod TLS
   ([`Checkin.java:116-120`](../android/app/src/main/java/cz/m5cet/app/push/Checkin.java)); s
   `screenshots: true` se vypne `FLAG_SECURE` ([`MainActivity.java:154-157`](../android/app/src/main/java/cz/m5cet/app/ui/MainActivity.java)).
6. **Střední — PIN proti útočníkovi na zařízení (F-16).** Klíč PINu = HMAC(pepř v Keystore,
   PBKDF2(PIN, 210 000)) ([`Vault.java:97-100`](../android/app/src/main/java/cz/m5cet/app/security/Vault.java));
   pepř nemá vazbu na autentizaci ani hardwarový limit pokusů a čítač pokusů je obyčejný záznam
   SYS s pevným AAD, takže ho lze vrátit starší kopií ([`AppLock.java:34-35`](../android/app/src/main/java/cz/m5cet/app/security/AppLock.java)).
   S rootem / spuštěním kódu jako aplikace padne 4místný PIN odhadem zhruba za hodinu (neměřeno). „Zamknout" zamyká
   jen UI — datový klíč zůstává v paměti procesu ([`AppLock.java:150-162`](../android/app/src/main/java/cz/m5cet/app/security/AppLock.java)).
   Nouzový (duress) PIN není.
7. **Nízké:** designové balíčky bez ochrany proti návratu ke starší podepsané verzi
   ([`Bundles.java:205-246`](../android/app/src/main/java/cz/m5cet/app/update/Bundles.java));
   vlastní schéma `m5cet://enroll` bez App Links (zachytitelné cizí aplikací); kopírování
   zprávy bez `IS_SENSITIVE` ([`MainActivity.java:662-665`](../android/app/src/main/java/cz/m5cet/app/ui/MainActivity.java));
   nešifrované dočasné soubory (`cache/capture/photo.jpg` ~30 s, `cache/fn-media` se nemaže —
   [`Composer.java:636-641`](../android/app/src/main/java/cz/m5cet/app/ui/parts/Composer.java),
   [`FnView.java:420-425`](../android/app/src/main/java/cz/m5cet/app/fn/FnView.java)); počet iterací
   PBKDF2 zapečetěné zprávy bere z přijaté zprávy bez horní meze — DoS
   ([`Sealed.java:72-74`](../android/app/src/main/java/cz/m5cet/app/chat/Sealed.java)); čtení
   EMV na žádost modelu vrací serveru **celé PAN** ([`EmvReader.java:376`](../android/app/src/main/java/cz/m5cet/app/nfc/EmvReader.java),
   [`ModelNfc.java:432-443`](../android/app/src/main/java/cz/m5cet/app/nfc/ModelNfc.java)).
8. **Model správy zařízení:** aplikace je zapsaná k serveru a ten jí podepsanými příkazy přes FCM
   umí poslat `lock`, `wipe`, `status` (až 200 řádků logu), `push`, `update`, `config`
   ([`Control.java`](../android/app/src/main/java/cz/m5cet/app/push/Control.java)). Je to vědomá
   vlastnost pro firemní nasazení, ale z pohledu soukromí dává operátorovi pravomoci MDM —
   spotřebitelské verze Signalu a Threemy nic takového nemají (firemní nabídky jako Threema Work
   správu zařízení mají — neověřováno do detailu).

### 5.3 Server

**Autentizace a autorizace.** Admin token se porovnává v konstantním čase
([`admin-auth.ts:40-43`](../server/admin-auth.ts)); pojmenované tokeny a passkey relace
administrátorů jako SHA-256 ([`admin-users.ts:101-120`](../server/admin-users.ts)); relace účtů
32 B náhodné, uložené jako SHA-256, 12 h / 7 dní ([`store.ts:562-576`](../server/accounts/store.ts)).
Admin služba poslouchá ve výchozím stavu na `127.0.0.1` se striktní CSP a `X-Frame-Options:
DENY` ([`admin.ts:160-169`](../server/admin.ts), [`admin.ts:321-323`](../server/admin.ts)); výsledek
`whoami` cachuje 60 s, takže odvolaný token tam platí ještě minutu ([`admin.ts:124-141`](../server/admin.ts)).

**Hlavičky:** Helmet (HSTS 365 dní s `includeSubDomains`, `nosniff`, `X-Frame-Options`),
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, Permissions-Policy
([`index.ts:165-208`](../server/index.ts)).

**Omezení rychlosti:** `/api` 100 / 15 min, samostatné limity pro trezor, úložiště, Android a
admin ([`index.ts:51-136`](../server/index.ts)), funkce 40 / min, webhooky 120 / min, pozvánky
30 vytvoření a 40 uplatnění / 15 min. **WebSocket upgrade je nově omezen** — kontrola originu a
`gate.admit(ip)`: 30 / min na IP, 20 současných, 5 000 celkem ([`hub.ts:260-271`](../server/signaling/hub.ts),
[`limits.ts:129-146`](../server/signaling/limits.ts)) — známá mezera č. 1 je tedy opravená.
Požadavek bez hlavičky `Origin` projde ([`hub.ts:131-133`](../server/signaling/hub.ts)) — není to
prohlížeč, ale limity per IP pak závisí na správném `TRUST_PROXY`: v kontejneru se ve výchozím
stavu věří i privátním rozsahům ([`trust-proxy.ts:29-38`](../server/trust-proxy.ts)), takže při
některých síťových režimech (rootless podman, Docker Desktop) lze `X-Forwarded-For` podvrhnout
a limity obejít (ověřit podle nasazení).

**Functions — sandbox** ([`server/functions/sandbox/*`](../server/functions/sandbox/)):

* Každý běh v samostatném podřízeném procesu Node; JavaScript v QuickJS-ng (WASM) s limitem
  haldy, zásobníku a přerušením po čase ([`engine-js.ts:122-134`](../server/functions/sandbox/engine-js.ts)),
  Python v Pyodide bez přerušení (zastaví ho jen zabití procesu). Výchozí limity 30 s / krok 2 s /
  128 MB ([`protocol.ts:28-29`](../server/functions/sandbox/protocol.ts)), hlídač RSS jen na Linuxu
  ([`pool.ts:263-271`](../server/functions/sandbox/pool.ts)).
* **Vysoké — slibovaná hranice procesu neexistuje (F-03).** Komentáře popisují
  `node --permission --allow-fs-read=… --disallow-code-generation-from-strings` a bubblewrap
  ([`child.ts:4`](../server/functions/sandbox/child.ts), [`harden.ts:4-8`](../server/functions/sandbox/harden.ts)),
  ale skutečné spuštění předává jen `--max-old-space-size` a `env: {PATH}`
  ([`pool.ts:105-106`](../server/functions/sandbox/pool.ts)); `--permission` ani bwrap se v kódu
  nikde nepoužívá. Zbytek izolace stojí na jazykové úrovni: v Pythonu je „pečeť" jen blokátor
  v měnitelném `sys.meta_path` a ze seznamu odstraněných API zůstává dostupné `py._module`
  ([`engine-py.ts:31`](../server/functions/sandbox/engine-py.ts), [`engine-py.ts:54`](../server/functions/sandbox/engine-py.ts)).
  Pravděpodobná cesta Python → `_module.FS` (NODEFS) → čtení / zápis souborů pod uživatelem
  serveru, na Linuxu i `/proc/<ppid>/environ` — tedy `STORAGE_MASTER_KEY`, `ADMIN_API_TOKEN`,
  klíč HMAC tokenů `m5adm` (ražba tokenu vlastníka, [`adm-token.ts:34-50`](../server/functions/adm-token.ts)),
  VAPID a klíče poskytovatelů. **Řetězec je odvozený z kódu, nebyl spuštěn — ověřit.** Psát
  Python smí role operátor ([`admin-routes.ts:228-231`](../server/functions/admin-routes.ts)) nebo
  import balíčku; hranice operátor × vlastník tím padá. Pokud je `dist/` zapisovatelný uživatelem
  služby (ověřit u instalací bez Dockeru), vede to až k podvržení webového klienta, tj. k F-02.
* Volání hostitele jen z allowlistu `HOST_CALLS` ([`child.ts:49`](../server/functions/sandbox/child.ts),
  [`runner.ts:337-404`](../server/functions/runner.ts)); `adm` jen s tokenem vydaným hostitelem
  (role + oblasti, max. 15 min, uděluje jen vlastník — [`adm-token.ts:61-116`](../server/functions/adm-token.ts),
  [`packages.ts:168`](../server/functions/packages.ts)).
* Žádný globální strop souběžných procesů sandboxu ([`pool.ts:156`](../server/functions/sandbox/pool.ts)) —
  běh čekající na `m5.prompt` drží proces až 10 min (DoS paměti).
* Trvalé webhooky běží s uloženou identitou tvůrce ([`runner.ts:286`](../server/functions/runner.ts));
  webhook vytvořený při běhu vlastníka bez TTL nechá kohokoli s tokenem webhooku volat
  telefonii / NFC s právy vlastníka ([`host-telephony.ts:36-46`](../server/functions/host-telephony.ts)).
* `POST /api/functions/runs/:id/events` nemá vazbu na volajícího; schopností je jen runId a
  interactionId (~48 bitů náhody každý — [`routes.ts:294-302`](../server/functions/routes.ts)).

**SSRF** ([`host-net.ts:24-149`](../server/functions/host-net.ts)): blokuje privátní, loopback,
link-local, CGNAT, multicast a mapované adresy a kontroluje každý záznam DNS na každém přesměrování.
**Ochrana proti DNS rebinding ale neběží (F-14):** připnutí adresy volá `require("undici")`, který
v závislostech není (v `package-lock.json` žádný `node_modules/undici`), a tiše padá na
nepřipnutý `fetch` ([`host-net.ts:142-149`](../server/functions/host-net.ts)). Vestavěný příkaz
`/web` stahuje URL od uživatele ([`builtins/index.ts:47-49`](../server/functions/builtins/index.ts)),
modely jsou bez skupin dostupné i hostům ([`routes.ts:45-61`](../server/functions/routes.ts);
výchozí politiku modulů po instalaci ověřit) — po
zapnutí Functions (ve výchozím stavu vypnuté, [`plugins/settings.ts:67`](../server/plugins/settings.ts))
je tak možné zkoušet SSRF na `127.0.0.1` / metadata cloudu přes rebinding. Další drobnosti:
`Authorization` funkce se posílá i na cizí cíl přesměrování ([`host-net.ts:100-134`](../server/functions/host-net.ts)),
NAT64 `64:ff9b::/96` a `fec0::/10` nejsou blokované, URL zpětného volání webhooku volí volající
([`webhook-log.ts:127-140`](../server/functions/webhook-log.ts)).

**Data funkcí (F-18):** `functions.db` **není šifrovaná** ([`functions/store.ts:146-153`](../server/functions/store.ts)) —
běhy se vstupy, výstupy a logy, KV cache, tokeny API a webhooků, HMAC tajemství, logy webhooků
(výchozí `"full"`: tělo, hlavičky, plná IP — [`webhook-log.ts:113-124`](../server/functions/webhook-log.ts)),
30 dní. Výsledky čtení NFC (MRZ, jméno, datum narození, fotografie, u Androidu celé PAN) jdou
serveru v plaintextu ([`host-nfc.ts:175-206`](../server/functions/host-nfc.ts)).

**AI a řeč** ([`server/ai/*`](../server/ai/)): jen to, co uživatel sám napíše do AI panelu, nebo co
funkce předá `m5.ai` — žádné automatické čtení místností; ve výchozím stavu vypnuté. Klíče
poskytovatelů zapečetěné master klíčem s AAD ([`ai/config.ts:334-345`](../server/ai/config.ts));
žurnál AI nešifrovaný SQLite, logování obsahu volí vlastník s časovým omezením
([`ai/service.ts:169-171`](../server/ai/service.ts)). Modely řeči (Whisper/Piper) se stahují z GitHubu
**bez kontroly hashe** ([`local-speech.ts:180-210`](../server/ai/local-speech.ts)).

**Telefonie:** podpisy webhooků Twilio (HMAC-SHA1), Telnyx (Ed25519, 300 s), Vonage (JWT HS256 /
legacy) s porovnáním v konstantním čase ([`webhooks.ts:113-172`](../server/telephony/webhooks.ts)),
ale **ověření selže otevřeně (F-17)**: bez `TELNYX_PUBLIC_KEY` / `VONAGE_SIGNATURE_SECRET`, a u SMS Vonage
i bez parametru `sig`, se události přijmou s `verified=false` a dojdou až k funkcím
([`webhooks.ts:220-246`](../server/telephony/webhooks.ts), [`webhooks.ts:313-328`](../server/telephony/webhooks.ts)).
*→ kap. 12, G-01: od 6.9 takový webhook spouštěl i pravidla a TSA; od 6.10 nepodepsaný webhook hovoru
k pravidlům, TSA ani mostu nedojde (výjimka `TELEPHONY_ALLOW_UNSIGNED=1`).*
JWT má algoritmus připnutý na HS256, `exp` je ale volitelné ([`jwt.ts:59-70`](../server/telephony/jwt.ts)).
Zvuk hovorů se na serveru překódovává — **telefonie je mimo E2EE** ([`bridge.ts:7-13`](../server/telephony/bridge.ts)).

**Ostatní:**

* TURN: `/api/turn` bez autentizace vydává HMAC efemérní údaje (1 h) nebo statické — relé může
  používat kdokoli ([`routes.ts:337-343`](../server/routes.ts), [`turn.ts:41-49`](../server/turn.ts)).
* Proxy souborů: přeposílá neprůhledné bloky AES-GCM bez ukládání ([`file-proxy.ts:1-36`](../server/file-proxy.ts));
  globální strop 64 přenosů lze obsadit.
* Mapové dlaždice jdou přes server (IP uživatele k OSM nejde), ale souřadnice dlaždic se zkrácenou
  IP padají do provozního kruhu ([`map-tiles.ts:65-115`](../server/map-tiles.ts), [`index.ts:78-85`](../server/index.ts)).
* **Access log s plnou IP**, jménem a cestou každého rozhodnutí modulu (vč. každého
  `/api/functions/run`), 30 dní na disku ([`access.ts:94`](../server/access.ts), [`access-log.ts:8-72`](../server/access-log.ts)) —
  jinde se IP zkracují na /24 /48.
* `LOG_EVENTS=1` ukládá syrová ID místností ([`hub.ts:624`](../server/signaling/hub.ts)), audit jen
  nesolený `hashRoom` ([`traffic.ts:120-123`](../server/monitor/traffic.ts)).
* **Auditní řetěz (F-23):** řádky řetězené SHA-256, kontrolní body podepsané Ed25519 — ale ověření bere
  veřejný klíč **z téhož řádku** kontrolního bodu a řádky bez hashe jen počítá jako „unchained"
  ([`global-store.ts:688-724`](../server/storage/global-store.ts)). Kdo smí zapisovat do DB, řetěz
  přepíše a znovu podepíše vlastním klíčem — evidence manipulace jen proti naivnímu útočníkovi.
* Cluster přes Redis: HMAC zpráv volitelný (`CLUSTER_SECRET`), bez nonce a časového razítka,
  AUTH / TLS Redisu volitelné ([`cluster/bus.ts:9-60`](../server/cluster/bus.ts)) — vadí jen při
  dosažitelném Redisu.
* Zálohy: globální DB, DB uživatelů (šifrované jejich klíči), trezory, bez master klíče
  ([`backup.ts:1-18`](../server/storage/backup.ts)).
* Docker: `node:24-slim` jen podle tagu (bez digestu), běh jako `USER node` a výsledný obraz
  nese jen `dist`, `package.json` a `admin-ui` ([`Dockerfile:11-22`](../Dockerfile)); build stage
  dělá `COPY . .` a `.dockerignore` vylučuje `.env` a `.env.*`, ale ne `.env-bak` — ten skončí
  v mezivrstvě build stage (build cache), ne ve výsledném obrazu ([`Dockerfile:1-5`](../Dockerfile),
  [`.dockerignore`](../.dockerignore)).

### 5.4 Administrátorská konzole

* Token konzole jen v `sessionStorage` a jen se „zapamatovat" ([`console.js:164-167`](../admin-ui/public/console.js)).
* DOM se staví helperem `h()` s textovými uzly; od 6.9 konzole `innerHTML` nepoužívá vůbec
  (poslední místa v `legacy-tools.js` zmizela s novou stránkou Telephony & SIP,
  [`telephony-console.js`](../admin-ui/public/telephony-console.js)); CSP konzole `script-src 'self'`
  ([`server/admin.ts:168`](../server/admin.ts)).
* Role vynucuje server: GET/HEAD = auditor, ostatní = operátor, správa administrátorů = owner,
  tokeny funkcí s oblastmi ([`admin-auth.ts:28-72`](../server/admin-auth.ts),
  [`admin-api.ts:131-160`](../server/admin-api.ts)). Každý GET je tedy dostupný auditorovi —
  citlivé GET odpovědi spoléhají na redakci per route (neověřováno route po route — ověřit).
  *→ kap. 12: pro telefonii ověřeno — G-02 (obejití práv velikostí písmen), G-03 (route kódy a slepá ID).*
* Operátorské příkazy klientům: `purge-local` smaže předvolby bez souhlasu uživatele,
  `download-file-from-admin` vyžaduje potvrzení ([`App.tsx:2895-2930`](../client/src/App.tsx)).

---

## 6. Srovnání

Stav ostatních aplikací je podle veřejných zdrojů k 2026-10-04 (seznam v [§ 6.3](#63-zdroje-ke-srovnání),
odkazy [1]–[41]). „Neověřeno" = tvrzení jsme nedokázali potvrdit z primárního pramene;
„odvozeno" = náš závěr z citovaného materiálu, ne tvrzení zdroje.

### 6.1 Tabulka

| Vlastnost | **M5cet 6.7** | Signal | Threema | WhatsApp | Wire | Element / Matrix | Session |
|---|---|---|---|---|---|---|---|
| E2EE ve výchozím stavu | chat, soubory, hovory P2P ano; **mimo E2EE**: příkazy / Functions, AI, řeč, telefonie (opt-in) | vše [1] | vše [10] | chaty, hovory; zálohy volitelně [16] | vše, MLS „always on" [21] | soukromé místnosti a DM od 2020 [25] | 1:1 a skupiny ≤ 100; komunity jen transport [32] |
| Protokol 1:1 | vlastní: Argon2id passphrase → HKDF; podepsané hello se **statickým** ECDH P-256; AES-GCM | PQXDH + Double Ratchet + SPQR (Triple Ratchet) [2][3] | NaCl (X25519, XSalsa20-Poly1305) + Ibex [10][11] | Signal Protocol [16] | Proteus (Double Ratchet) a MLS RFC 9420 [21] | Olm (vodozemac) [26] | Session Protocol, bezstavový [32][33] |
| Dopředná utajenost | **částečná**: hash ratchet sender keys; párový kanál statický; relay / soubory ne; transport DTLS | ano | ano s Ibex; **ne** v režimu multi-device [10] | ano | ano | Olm ano, Megolm částečně [27] | **ne** (v1); V2 plánováno [32][34] |
| Obnova po kompromitaci (PCS) | **ne** (jen výměna řetězu po 1 h / 500 zprávách) | ano, i post-kvantově [3] | nedeklaruje (odvozeno) | 1:1 ano; skupiny jen reset při odchodu [16] | ano (Proteus i MLS) [21] | Olm ano, Megolm ne [27] | ne (odvozeno) |
| Post-kvantová ochrana | **ne** | ano: PQXDH 2023, SPQR 2025 (zavádí se) [2][3] | plán (spolupráce s IBM, 2026) [12] | nedokumentováno (whitepaper 02/2026) [16] | jen plán / otevřený PR (07/2026) [22][24] | plán [28] | plán ve V2 [34] |
| Skupinový protokol | sdílená passphrase + sender key na odesílatele; **členství nespravované** | Sender Keys + private group system (server nezná členy) [4] | šifrování pro každého člena; server nezná skupiny [10] | Sender Keys, reset při odchodu [16] | MLS [21] | Megolm [27] | Groups v2: sdílený klíč rotovaný adminem [35] |
| Skrytí odesílatele / metadat | **ne**; slepé ID místnosti | sealed sender, kontakty v SGX [5] | server nezná skupiny; úřadům jen data vytvoření / přihlášení [13] | ne; sbírá IP, časy, frekvenci [17] | ne (neověřeno) | ne; server vidí členství a názvy místností [29] | onion requests přes 3 uzly [32] |
| Telefonní číslo | **ne** (host bez účtu; formulář drží e-mail / telefon jen jako HMAC) | dosud ano; registrace bez čísla v Android betě (09/2026, ~3 USD) [6] | ne (náhodné ID) [13] | ano [18] | ne (neověřeno) | ne | ne |
| Ověření identity | TOFU podle **jména**, bezpečnostní čísla + QR; bez transparentnosti | bezpečnostní čísla + QR; **automatické ověření přes key transparency** (08/2026, auditoři Cloudflare a Trail of Bits) [7] | 3 úrovně ověření, QR [10] | QR / 60 číslic + Auditable Key Directory (2023) [19] | otisky (Proteus), X.509 E2E identita (MLS, on-prem) [21] | cross-signing, emoji / QR [25] | Account ID = veřejný klíč |
| Otevřený kód | kód v repozitáři; `package.json` uvádí MIT (soubor LICENSE chybí; veřejnost repozitáře ověřit) | klient i server [8] | aplikace AGPLv3, server ne [14] | ne | klienti i backend GPLv3 (části ne) [21] | ano | ano |
| Nezávislé audity / formální analýza | **žádné** | formální analýzy PQXDH (USENIX 2024) a SPQR (ProVerif, hax) [3][9] | Münster 2019, Cure53 2020 a 2024, FAU 2023 (Ibex); ETH „Three Lessons" 2023 [11][15] | NCC (zálohy 2021, AKD 2023) [19][20] | Kudelski / X41 (aplikace) [23] | Least Authority (vodozemac 2022); nálezy IEEE S&P 2023 [30][31] | Quarkslab 2021 [36] |
| Reprodukovatelné buildy | **ne** (web se doručuje serverem) | Android od 2016 (s výhradami ke kontrolnímu skriptu) [8] | Android experimentálně [14] | ne | backend ano [21] | nedeklaruje | nenalezeno |
| Vlastní hosting | **ano — jen self-hosted**, instance izolované | kód serveru veřejný, bez federace | Threema OnPrem (izolované instance) [14] | ne | on-prem i federace [21] | ano, federace | síť uzlů se stakingem [37] |
| Data na serveru | relay 30 dní, běhy funkcí 30 dní (nešifrované), access log 30 dní s plnou IP, audit; volí provozovatel | minimum (datum vytvoření, poslední připojení) [4] | minimum [13] | metadata komunikace [17] | fronta klienta 4 týdny [21] | homeserver drží historii a metadata | swarmy uzlů |
| Více zařízení | účet s více passkeyi, Ed25519 klíč účtu certifikuje zařízení (bez revokace) | propojená zařízení | multi-device (bez PFS) [10] | companion zařízení [16] | ano | ano | ano |
| Zálohy | trezor na serveru (PRF passkeye), recovery kód 130 bitů | Secure Backups (2025), 64znakový klíč [1] | Threema Safe (ID, kontakty, ne zprávy) [10] | E2EE zálohy volitelné, HSM / passkey [16][20] | lokální s heslem [21] | online key backup [25] | obnovovací fráze účtu |
| Push | Web Push prázdné probuzení; FCM jen podepsané a šifrované řídicí příkazy | bez citlivého obsahu [41] | Android prázdné, iOS šifrované [10] | neověřeno | FCM / APNs, obsah neověřen | event ID + room ID [29] | „fast mode" přes push server STF [38] |
| Jurisdikce | **provozovatel instance** | USA (nadace) | Švýcarsko (vlastník Comitis Capital, DE, 2026) [39] | USA / Irsko [17] | Švýcarsko / Německo [21] | UK / FR / DE / US | Švýcarsko (STF od 10/2024) [40] |

### 6.2 Rozbor

**Kde je M5cet srovnatelný:**

* *Symetrická kryptografie a formát zpráv.* AES-256-GCM s náhodnými IV, doménově oddělené HKDF
  klíče, associated data s kontextem, odmítnutí přesunutého ciphertextu, podpisy uvnitř šifry —
  řemeslně na úrovni hlavních aplikací.
* *Push.* Prázdné probuzení jako Signal a Threema na Androidu.
* *Účty a zálohy.* Passkey s PRF jako kořen trezoru a 130bitový recovery kód jsou moderní a
  silnější než heslem chráněné zálohy (Threema Safe, Wire); odpovídají zhruba Signal Secure
  Backups.
* *Skupinové šifrování živých zpráv* je na úrovni Megolm / Sender Keys ve WhatsAppu (hash
  ratchet, rotace při odchodu) — dopředná utajenost ano, PCS ne. Stejné omezení mají skupiny
  Signalu i WhatsAppu (sender keys), jen tam stojí na párových kanálech s Double Ratchetem.

**Kde je M5cet slabší:**

* *Ustavení klíče a PCS.* Žádné prekeys, žádný DH ratchet, statické ECDH klíče zařízení. Signal,
  WhatsApp, Wire a Matrix (Olm) mají pro 1:1 Double Ratchet, Wire i MLS pro skupiny.
* *Post-kvantová ochrana.* Signal ji má od 2023 (PQXDH) a od 2025 i v ratchetu (SPQR); ostatní
  ji plánují. M5cet ji nemá a v kódu ani dokumentaci jsme plán nenašli.
* *Model důvěry vůči provozovateli.* Signal, Threema i WhatsApp distribuují podepsané nativní
  aplikace a server kód klienta nezmění. M5cet web doručuje server a Android přijímá serverem
  podepsané designy schopné vynášet obsah (F-01, F-02).
* *Identita.* Signal (key transparency 2026), WhatsApp (AKD 2023) a Wire (X.509 s MLS) ověřují
  klíče automaticky proti logu nebo certifikátu; Threema má jasné úrovně ověření. M5cet má
  bezpečnostní čísla, ale výchozí stav je TOFU podle jména a první kontakt se tváří jako ověřený.
* *Metadata.* Bez sealed sender; server zná jména, členství a účty; peery si vidí IP adresy.
  Signal a Session jdou mnohem dál, Threema minimalizuje uchovávání.
* *Ověřitelnost.* Žádný audit, formální analýza ani reprodukovatelný build — u ostatních
  (kromě uzavřeného WhatsAppu) standard. I Threema, Matrix a Session v minulosti měly závažné
  nálezy, které se našly **právě díky** auditům a akademickým analýzám [15][31].

**Kde se M5cet liší záměrně (samo o sobě to není slabina):**

* *Bez telefonního čísla a bez adresáře* — jako Threema a Session; Signal to teprve zavádí.
* *Jen vlastní hosting* — žádný centrální provozovatel a žádná jurisdikce vývojáře; veškerá
  důvěra se ale přesouvá na provozovatele instance, který má dnes pravomoci z [§ 3.3](#33-co-může-operátor--administrátor-s4).
* *Efemérní místnosti P2P* — pro jednorázovou schůzku s dlouhou náhodnou passphrase předanou
  osobně je model jednoduchý a server obsah opravdu nevidí. Slabiny se projeví u dlouhodobých
  skupin, nepřítomných členů a slabých passphrase.
* *Přidané funkce* (modely na serveru, AI, telefonie, NFC, správa zařízení) jsou pro firemní
  použití užitečné, ale každá rozšiřuje plochu útoku a část je z definice mimo E2EE. Signal ani
  Threema nic z toho nemají.

**Co musí platit, než bude možné tvrdit „srovnatelné se Signalem / Threemou":**

1. Obsah nesmí být čitelný provozovatelem ani při zlém úmyslu: opravené F-01, F-03, F-05;
   web s ověřitelným doručením kódu (podepsaná vydání, reprodukovatelný bundle, ověření mimo
   server) nebo nativní / desktopová aplikace jako primární klient (F-02).
2. Ustavení klíčů s prekeys a Double Ratchet (ideálně libsignal) pro 1:1 a MLS (RFC 9420) se
   spravovaným členstvím pro skupiny — místo passphrase jako jediné vstupenky; offline zprávy
   šifrované pro příjemce, ne klíčem místnosti (F-06, F-09).
3. Hybridní post-kvantové ustavení klíče (ML-KEM-768 + klasická křivka).
4. Identita vázaná na klíč, ne na jméno; stavy „nový / ověřený / změněný"; revokace zařízení;
   ideálně transparentní log klíčů účtů (F-13).
5. Minimalizace metadat: neposílat čitelné názvy a jména, zkracovat IP, padding, volba „jen přes
   TURN", šifrovaná `functions.db` (F-10, F-15, F-18).
6. Nezávislý kryptografický audit a penetrační test, formální model handshake (ProVerif /
   Tamarin), reprodukovatelné buildy, bug bounty a dokumentace odpovídající kódu (F-29, § 10).

### 6.3 Zdroje ke srovnání

Data v závorce jsou data zveřejnění zdroje.

1. Signal — Introducing Secure Backups (2025-09-08), <https://signal.org/blog/introducing-secure-backups/>; Backup improvements (2026-09-28), <https://signal.org/blog/backup-improvements/>; šifrované skupinové hovory přes SFU (2021-12-15), <https://signal.org/blog/how-to-build-encrypted-group-calls/>
2. Signal — PQXDH (2023-09-19), <https://signal.org/blog/pqxdh/>
3. Signal — SPQR / Triple Ratchet, ML-KEM-768 (2025-10-02), <https://signal.org/blog/spqr/>
4. Signal — Private Group System (2019-12-09), <https://signal.org/blog/signal-private-group-system/>; odpovědi na předvolání, <https://signal.org/bigbrother/>
5. Signal — Sealed sender (2018-10-29), <https://signal.org/blog/sealed-sender/>; Private contact discovery (2017-09-26), <https://signal.org/blog/private-contact-discovery/>
6. Freedom of the Press Foundation — Signal registrace bez telefonního čísla (2026-09-23), <https://freedom.press/digisec/blog/signal-introduces-registration-without-a-phone-number/>
7. Signal — Automatic key verification (2026-08-11), <https://signal.org/blog/automatic-key-verification/>
8. Signal Android — reproducible builds, <https://github.com/signalapp/Signal-Android/blob/main/reproducible-builds/README.md>; kritika kontrolního skriptu (2022-12), <https://gist.github.com/obfusk/c51ebbf571e04ddf29e21146096675f8>
9. Bhargavan, Jacomme, Kiefer, Schmidt — formální analýza PQXDH, USENIX Security 2024, <https://www.usenix.org/system/files/usenixsecurity24-bhargavan.pdf>
10. Threema — Cryptography Whitepaper (verze 2026-06-26), <https://threema.com/assets/documents/threema-cryptography-whitepaper.pdf>
11. Threema — Ibex (2022-12-04), <https://threema.com/en/blog/ibex>; důkaz bezpečnosti Ibex (2023-08-01), <https://threema.com/en/blog/posts/security-proof-ibex>
12. Threema — quantum-secure future (2026-02-24), <https://threema.com/en/blog/quantum-secure-future>
13. Threema — transparency report, <https://threema.com/en/transparency-report>; anonymní používání, <https://threema.com/en/support/private>
14. Threema — open source a reprodukovatelné buildy, <https://threema.com/en/why-threema/open-source>; OnPrem, <https://threema.com/en/products/onprem>
15. Threema — audity kódu, <https://threema.com/en/faq/code-audit>; Paterson, Scarlata, Truong: Three Lessons From Threema, USENIX Security 2023, <https://www.usenix.org/system/files/usenixsecurity23-paterson.pdf>
16. WhatsApp — Encryption Overview v9 (2026-02-25), <https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf>
17. WhatsApp — Privacy Policy, <https://www.whatsapp.com/legal/privacy-policy>
18. WhatsApp — usernames FAQ (2026), <https://www.whatsapp.com/usernames-faq>
19. Meta — WhatsApp key transparency (2023-04-13), <https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/>; knihovna AKD, <https://github.com/facebook/akd>
20. Meta — E2EE zálohy WhatsApp (2021-09-10), <https://engineering.fb.com/2021/09/10/security/whatsapp-e2ee-backups/>
21. Wire — Security Whitepaper (05/2025), <https://wire.com/hubfs/Whitepapers/-wire-security-whitepaper.pdf>; MLS GA (2025), <https://wire.com/en/blog/wire-mls-is-now-generally-available>
22. Wire — openmls PR s post-kvantovými sadami (otevřen 2026-07-15), <https://github.com/wireapp/openmls/pull/110>
23. X41 D-Sec / Kudelski — Wire security review, <https://www.x41-dsec.de/reports/X41-Kudelski-Wire-Security-Review-Android.pdf>
24. Wire — Messaging Layer Security („cipher suite agility"), <https://wire.com/en/messaging-layer-security>
25. Matrix — cross-signing a E2EE ve výchozím stavu (2020-05-06), <https://matrix.org/blog/2020/05/06/cross-signing-and-end-to-end-encryption-by-default-is-here/>
26. Matrix — deprecace libolm (08/2024), <https://matrix.org/blog/2024/08/libolm-deprecation/>
27. Specifikace Megolm, <https://gitlab.matrix.org/matrix-org/olm/-/raw/master/docs/megolm.md>
28. Matrix — Holiday special, plán MLS a PQ (2025-12-24), <https://matrix.org/blog/2025/12/24/matrix-holiday-special/>
29. Element — skrytí metadat místností (2025-09-30), <https://element.io/blog/hiding-room-metadata-from-servers/>; push, <https://github.com/element-hq/element-android/blob/develop/docs/notifications.md>
30. Least Authority — audit vodozemac (2022), <https://matrix.org/blog/2022/05/16/independent-public-audit-of-vodozemac-a-native-rust-reference-implementation-of-matrix-end-to-end-encryption/>
31. Albrecht, Celi, Dowling, Jones — Practically-exploitable Cryptographic Vulnerabilities in Matrix, IEEE S&P 2023, <https://eprint.iacr.org/2023/485>
32. Session — whitepaper v3 (2024-07-02), <https://arxiv.org/abs/2002.04609>
33. Session — technické informace o protokolu (2020-12-15), <https://getsession.org/blog/session-protocol-technical-information>
34. Session — Protocol V2 (2025-12-01), <https://getsession.org/blog/session-protocol-v2>; stav vývoje (2026-08-02), <https://getsession.org/blog/session-development-update-pro-beta-protocol-v2>
35. Session — Groups v2 (2025-03-10), <https://getsession.org/blog/groups-v2-how-to-upgrade>
36. Quarkslab — audit Session (2021-05-04), <https://blog.quarkslab.com/resources/2021-05-04_audit-of-session-secure-messaging-application/20-08-Oxen-REP-v1.4.pdf>
37. Session — staking uzlů, <https://docs.getsession.org/contribute-to-the-session-network/staking-to-a-session-node>
38. Session — push notifikace, <https://sessionapp.zendesk.com/hc/en-us/articles/4439028541849-How-do-push-notifications-work-on-mobile-platforms>
39. Threema — vlastníci, <https://threema.com/en/faq/owners>
40. OPTF — předání Session Technology Foundation, <https://optf.ngo/blog/the-optf-and-session>
41. MediaNama — Meredith Whittaker o obsahu push notifikací Signalu (2023-12-12), <https://www.medianama.com/2023/12/223-signal-push-notifications-content-meredith-whittaker/>

Doplňující: Jaeger, Kumar — vazební slabiny skupinového šifrování Matrix, Signal, MLS a Session,
Eurocrypt 2025, <https://eprint.iacr.org/2025/554>.

---

## 7. Nálezy seřazené podle závažnosti

Závažnost zohledňuje dopad na důvěrnost a integritu obsahu a proveditelnost útoku. „Návrhový" =
vyžaduje změnu protokolu nebo modelu, ne jen opravu chyby. `android/…` znamená
`android/app/src/main/java/cz/m5cet/app/`.

| ID | Závažnost | Nález | Místo | Oprava |
|---|---|---|---|---|
| F-01 | **Kritická** | Designový balíček Androidu vynese dešifrované zprávy, `$form` i nastavení přes `image src` se šablonou / výrazem | `android/…/ui/Renderer.java:645-650`, `:724-731`, `:961-967`; `android/…/chat/ChatMessage.java:190-212`; `server/android/design.ts:628` | Ve vlastnostech vedoucích na síť zakázat šablony a výrazy (`image src` jen `asset:` nebo pevná URL bez `{}` / `=`); rozsahy `$msg` / `$form` nedávat prvkům se síťovým přístupem; síťové obrázky jen z allowlistu; `setting.set` pro citlivé klíče zakázat |
| F-02 | **Vysoká** (návrhová) | Webový klient doručuje server; `integrity.ts` porovnává s manifestem téhož serveru a hashe nekontroluje | `client/src/lib/integrity.ts:1-20`, `:60-61`; `client/public/sw.js` | Podepsaná vydání a reprodukovatelný bundle; service worker, který přijme nový kód jen s podpisem vývojáře; ověřovací rozšíření nebo desktopová / nativní aplikace jako doporučený klient; dokumentovat, že web chrání jen proti pasivnímu serveru |
| F-03 | **Vysoká** | Sandbox funkcí bez `--permission` / bwrap; Pyodide `_module` a měnitelné `sys.meta_path` → pravděpodobný přístup k souborům a env serveru (master klíč, admin token, HMAC `m5adm`) | `server/functions/sandbox/pool.ts:105-106`; `child.ts:4`; `harden.ts:4-8`; `engine-py.ts:31`, `:54` | Spouštět dítě s `--permission --allow-fs-read=<jen vlastní soubory>`, v bwrap / kontejneru bez sítě a pod jiným uživatelem; odstranit `_module` / `FS` i z interního objektu; tajemství nepředávat v env procesu serveru; ověřit exploitací v testu |
| F-04 | **Vysoká** (návrhová) | Passphrase bez vynucené síly; slepé ID a `hashRoom` jsou offline orákulum; po uhodnutí čitelná schránka, soubory a signalizace (MITM) | `client/src/lib/envelope.ts:107-132`; `client/src/App.tsx:3228`, `:3263-3280`; `server/monitor/traffic.ts:120-123` | Náhodný klíč místnosti jako výchozí (generátor už je v `ConnectionsPanel.tsx:62-72`); měřit sílu a varovat / odmítnout; solit `hashRoom` tajným klíčem serveru; dlouhodobě pozvánky a správa členství (MLS) |
| F-05 | **Vysoká** | Android: připnutý `kid` se porovná s řetězcem od serveru, veřejný klíč se uloží bez kontroly otisku | `android/…/ui/parts/Forms.java:204-208`; `android/…/core/Config.java:77-84` | Po `Server.info` spočítat `Ec.kid(publicKey)` a porovnat s pinem i s `kid`; totéž při každé změně klíče |
| F-06 | **Střední** (návrhová; pro srovnatelnost klíčová) | Statické ECDH klíče zařízení → párové klíče bez FS; žádný DH ratchet (PCS), žádné asynchronní ustavení klíče, žádné PQ | `client/src/lib/identity.ts:60-63`, `:128-141`; `client/src/lib/sender-keys.ts:173-192`; `android/…/chat/Rooms.java:107-121` | Krátkodobě efemérní ECDH v každém hello (podepsaný klíčem zařízení); cílově libsignal (PQXDH + Double Ratchet / SPQR) pro páry, MLS pro skupiny, hybridní ML-KEM |
| F-07 | **Střední až vysoká** | Android ukáže „ověřeno" u zprávy podepsané jakýmkoli platným klíčem (cizí jméno, cizí klíč) | `android/…/chat/RoomSession.java:429`, `:650` | Porovnat klíč podpisu s klíčem z hello peeru a s pinem pro (místnost, jméno) jako web; relay zprávy bez pinu jako „nový", ne „ověřený" |
| F-08 | **Střední** | Člen místnosti pošle výstup `js`, který se bez kliknutí spustí u všech příjemců (IP a čas zobrazení na libovolný https server, události funkcí s tokenem prohlížejícího, případně NFC interakce) | `client/src/lib/validate.ts:97-110`; `client/src/lib/fn-outputs.ts:289-296`; `client/src/components/fn/FnOutputs.tsx:193-204`; `server/functions/sandbox-page.ts:16-28`; `client/src/App.tsx:3586-3601`, `:3721-3727`; `server/functions/routes.ts:224-228` | `js` z peer zpráv odstranit nebo spouštět až po kliknutí; v CSP sandboxu `connect-src 'none'` (síť jen přes most hostitele); události z cizí zprávy neposílat s vlastním tokenem bez potvrzení; řetěz vázat na místnost a volajícího |
| F-09 | **Střední** (návrhová) | Zprávy pro nepřítomné (i soukromé), outbox, záložní obálky a všechny soubory jsou pod statickým klíčem místnosti; schránka 30 dní | `client/src/App.tsx:3409-3427`, `:2139-2143`; `client/src/lib/envelope.ts:255-263`; `server/accounts/mailqueue.ts:66-80` | Šifrovat položky schránky pro příjemce (veřejný klíč účtu / prekeys); soubory pod párovými nebo sender klíči; kratší výchozí retence |
| F-10 | **Střední** | Čitelný název místnosti (sůl Argon2id) jde na server: serverová historie hosta (query v URL), analytika (opt-in), chatové příkazy; Android: běhy funkcí, logy dostupné příkazem `status` | `client/src/App.tsx:2786-2791`, `:2972-2982`, `:3651`, `:3726`; `client/src/lib/storage-client.ts:261-268`; `android/…/ui/parts/Fn.java:95`; `android/…/push/Control.java:67-70` | Posílat jen slepé ID; cestu „pod čitelným názvem" (3.0) odstranit; název nelogovat |
| F-11 | **Střední** | Server může hostovi v režimu „server" podvrhnout historii (nezapečetěný řádek se přijme bez validace — i `mine: true`, „ověřeno", výstupy funkcí, MIME) | `client/src/lib/chat-history.ts:88-105`, `:198-202` | Odmítat nezapečetěné řádky; obnovu prohnat `validatePayload` / `sanitizeFnOutputs` / `safeMime`; stav identity přepočítat, neobnovovat |
| F-12 | **Střední** | NFC tag „Připojka" nese název + passphrase pod 4–16místným PINem (PBKDF2 200 000) — offline hádání kýmkoli, kdo tag přečte | `client/src/lib/nfc.ts:30-43`; `client/src/lib/nfc/cards/connection-card.ts:11-12`, `:47-55`; `android/…/nfc/Nfc.java:36-37` | Aspoň Argon2id a dlouhý náhodný kód; lépe tag jen s odkazem a odděleným tajemstvím (jako pozvánka) |
| F-13 | **Střední** | Web: TOFU podle zobrazovaného jména, první kontakt jako „Ověřeno podpisem", nepodepsaná zpráva jen tlumeně, certifikát zařízení bez revokace a expirace, žádný adresář / transparentnost | `client/src/App.tsx:1554-1577`; `client/src/lib/identity.ts:194-198`, `:284-342`; `client/src/lib/i18n-security.ts:32-35` | Odlišit „nový klíč" od „ověřeno"; pin podle klíče účtu napříč místnostmi; nepodepsané zprávy výrazně; seznam zařízení s revokací; zvážit key transparency |
| F-14 | **Střední** | SSRF: připnutí adresy proti DNS rebinding nefunguje (`undici` chybí); `/web` dostupné hostům po zapnutí Functions; další mezery (NAT64, `Authorization` při přesměrování, callback URL) | `server/functions/host-net.ts:100-149`; `server/functions/builtins/index.ts:47-49`; `server/functions/routes.ts:45-61`; `server/functions/webhook-log.ts:127-140` | Připnout adresu přes `http.Agent` s vlastním `lookup` nebo přidat závislost; doplnit `64:ff9b::/96`, `fec0::/10`; neposílat `Authorization` na cizí origin; `/web` jen pro přihlášené |
| F-15 | **Střední** (návrhová) | Metadata: server zná jména, členství, účty, časy; peery si vidí IP (`iceTransportPolicy: "all"`, STUN Google); plné IP v access logu 30 dní; žádný padding ani sealed sender | `client/src/lib/rtc.ts:6-9`, `:25`; `server/signaling/hub.ts:530-626`; `server/access.ts:94`; `server/access-log.ts:8-72` | Volba „jen přes TURN"; vlastní STUN; zkracovat IP v access logu; padding obálek; jména šifrovat pro členy; dlouhodobě doručování ve stylu sealed sender |
| F-16 | **Střední** | Android: politika zámku (vč. vypnutí `FLAG_SECURE`) není podepsaná; čítač pokusů lze vrátit starší kopií; pepř PINu bez hardwarového limitu; „zamknout" nechá datový klíč v paměti; bez duress PINu | `android/…/push/Checkin.java:116-120`; `android/…/ui/MainActivity.java:154-157`; `android/…/security/AppLock.java:34-35`, `:150-162`; `android/…/security/Vault.java:97-100` | Podepisovat politiku jako příkazy; monotónní čítač (vazba na Keystore); pepř s autentizací uživatele nebo StrongBox s limitem; při zamčení zahodit DEK |
| F-17 | **Střední** | Telefonie: ověření webhooků Telnyx / Vonage selže otevřeně (bez klíče, u SMS i bez `sig`); JWT bez povinného `exp` | `server/telephony/webhooks.ts:220-246`, `:313-328`; `server/telephony/jwt.ts:59-70` | Fail-closed, kde poskytovatel podpis podporuje; `exp` povinné, kontrola `iat` / `jti` |
| F-18 | **Střední** | `functions.db` nešifrovaná: běhy se vstupy / výstupy (vč. e-ID, PAN), tokeny, HMAC tajemství, logy webhooků s plnou IP; 30 dní | `server/functions/store.ts:146-153`; `server/functions/webhook-log.ts:113-124`; `server/functions/host-nfc.ts:175-206`; `android/…/nfc/EmvReader.java:376` | SQLCipher s master klíčem jako ostatní úložiště; výchozí log webhooků jen metadata; kratší retence osobních dat; PAN maskovat |
| F-19 | **Nízká až střední** | E2EE rámců hovoru: statický mediální klíč pro všechny hovory dvojice, IV = 32bit náhodná sůl + čítač od 0 → riziko opakování IV v GCM; nezapečetěné rámce se přijímají i s klíčem | `client/src/lib/media-frames.ts:32-43`; `client/src/lib/media-e2ee.worker.ts:41`, `:64-67`; `client/src/lib/sender-keys.ts:184-188` | Klíč hovoru z čerstvé náhodnosti (HKDF s nonce z podepsaného hello) nebo SFrame (RFC 9605); po nastavení klíčů nezapečetěné rámce zahazovat |
| F-20 | **Nízká** | Downgrade: obálky v1 (bez AAD, PBKDF2 250 000) a v2 i zapečetěné zprávy v1 (6 znaků / 150 000) se stále otevírají | `client/src/lib/envelope.ts:210-228`; `client/src/lib/crypto.ts:75-89`; `client/src/lib/message-kinds.ts:36-37`, `:140-146` | Ukončit přijímání po přechodném období; do té doby výrazné varování |
| F-21 | **Nízká** | Přehrání relayovaných zpráv po znovunačtení (ochrana jen v paměti); `createdAt` bez dolní meze | `client/src/lib/envelope.ts:314-332`; `client/src/App.tsx:1874`; `client/src/lib/validate.ts:176` | Trvalý seznam viděných id per místnost; odmítat zprávy starší než retence |
| F-22 | **Nízká až střední** | Podvržené prvky UI: výstupy funkcí od člena (formuláře s `password`, panely aplikace, toasty), volné `replyTo` / „přeposláno", jména s bidi / homoglyfy; operátorská oznámení s libovolným `from` v proudu zpráv | `client/src/lib/fn-outputs.ts:18`; `client/src/components/fn/FnOutputs.tsx:146-159`; `client/src/lib/validate.ts:51-55`, `:201-205`; `server/signaling/hub.ts:101-103`; `client/src/App.tsx:3072-3087` | Výstupy cizích funkcí vizuálně oddělit a bez automatických akcí; citace ověřovat proti skutečné zprávě; normalizovat jména; `from` oznámení pevně „operátor" |
| F-23 | **Nízká** | Auditní řetěz ověřuje podpis klíčem z téhož řádku; řádky bez hashe projdou jako „unchained" | `server/storage/global-store.ts:688-724` | Připnout veřejný klíč kontrolních bodů mimo DB; nezřetězené řádky = chyba ověření |
| F-24 | **Nízká** (nasazení) | WebAuthn bez `WEBAUTHN_ORIGINS` přijme každou subdoménu rpId; s PRF tak subdoména může získat kořen účtu | `server/accounts/webauthn.ts:74-84` | Výchozí přesný seznam originů; varování v dokumentaci nasazení |
| F-25 | **Nízká** | Zavádějící bezpečnostní UI: otisky DTLS klíčované náhodným `peerId`, „otisk místnosti" jen z názvu, text „PBKDF2 250 000" v nastavení | `client/src/lib/fingerprint.ts:119-145`; `client/src/App.tsx:2535-2550`, `:2811`; `client/src/lib/i18n.ts:177`, `:640`, `:1103`; `client/src/lib/layouts/settings.ts:245` | Panel přestavět na bezpečnostní čísla; otisk místnosti z klíče (HKDF); texty aktualizovat |
| F-26 | **Nízká** | Sloty trezoru bez AAD (server je může prohodit nebo vrátit starší verzi); „Smazat vše" neodvolá token účtu; `touchedAt` relace mimo AEAD | `client/src/lib/passkey.ts:129-144`; `client/src/App.tsx:4745-4760`; `client/src/lib/session-cache.ts:216-221` | AAD se jménem slotu a verzí; při „Smazat vše" volat `/api/account/signout`; čas nečinnosti do AEAD |
| F-27 | **Nízká** (vývoj / build) | Dev server čte celý repozitář kromě úzkého seznamu (`.env-bak` projde) a poslouchá na `0.0.0.0`; Docker build stage `COPY . .` bez vyloučení `.env-bak` (build cache, ne výsledný obraz) | `vite.config.ts:138-144`; `server/vite.ts:13-15`; `server/index.ts:259`; `Dockerfile:1-5`; `.dockerignore` | `deny` rozšířit o `.env*` a zálohy; dev bind na `127.0.0.1`; `.dockerignore` s `.env*` |
| F-28 | **Nízká** | DoS a zneužití: TURN bez autentizace, globální strop pozvánek (2 000) a proxy přenosů (64), žádný strop souběžných sandboxů | `server/routes.ts:337-343`; `server/share.ts:31`, `:99`; `server/file-proxy.ts:24`, `:57`; `server/functions/sandbox/pool.ts:156` | TURN jen pro připojené sockety; stropy per IP / účet; fronta sandboxů |
| F-29 | **Informativní** | Žádný nezávislý audit, formální analýza ani reprodukovatelný build; CI `npm ci --no-audit` bez SAST; modely řeči bez kontroly hashe; Docker base jen podle tagu | `.github/workflows/ci.yml`; `server/ai/local-speech.ts:180-210`; `Dockerfile` | Roadmapa, fáze 3 |
| F-30 | **Informativní** | Nepopiratelné podpisy (ECDSA zařízení, Ed25519 účtu) — opak popiratelnosti Signalu | `client/src/lib/envelope.ts:156-181`; `client/src/lib/identity.ts:194-198` | Vědomě rozhodnout a zdokumentovat |
| F-31 | **Informativní** | README tvrdí, že server nikdy nevidí obsah — neplatí pro Functions, AI, řeč a telefonii (opt-in) | `README.md`; `client/src/lib/ai.ts:1-5` | Upravit README a UI, aby bylo zřejmé, kdy data opouštějí E2EE |

---

## 8. Roadmapa

### Fáze 0 — hned (dny)

* **F-01** — zablokovat síťové vlastnosti se šablonami v designech (server i Android), vydat
  novou APK; do té doby nepublikovat designy s `image` z cizích URL.
* **F-05** — kontrola `Ec.kid(publicKey)` při zápisu zařízení.
* **F-07** — vazba podpisu na klíč z hello a na pin i na Androidu.
* **F-03** — zapnout `--permission` a izolaci procesu sandboxu, odstranit `_module`; do té doby
  nedávat roli operátor nikomu, komu by nebyl svěřen i root serveru.
* **F-08**, **F-11**, **F-10** — nespouštět `js` z cizích zpráv, odmítat nezapečetěné řádky,
  neposílat čitelný název místnosti.
* **F-14**, **F-17** — připnutí adresy v SSRF guardu, fail-closed webhooky.
* **F-27** — dev `deny` a bind; zkontrolovat, že `.env-bak` není v žádném obrazu ani commitu.
* Opravit dokumentaci a texty UI (§ 10, F-25, F-31).

### Fáze 1 — krátkodobě (týdny)

* **Klíč místnosti:** výchozí náhodný klíč (QR / pozvánka), měřič síly, solený `hashRoom`
  (F-04); NFC tag přes odkaz + oddělené tajemství (F-12).
* **Identita:** stav „nový" vs „ověřený", pin podle klíče účtu, seznam a revokace zařízení
  (F-13).
* **Efemérní ECDH v hello** → FS pro párový kanál a distribuci sender keys; klíč na hovor nebo
  SFrame (F-06 částečně, F-19).
* **Relay pro příjemce:** šifrovat položky schránky veřejným klíčem účtu příjemce (F-09).
* Trvalá ochrana proti přehrání, ukončení v1 / v2 (F-20, F-21).
* Metadata: „jen přes TURN", vlastní STUN, padding, zkrácené IP v access logu (F-15).
* Šifrovaná `functions.db`, kratší retence (F-18); Android: podepsaná politika, čítač pokusů,
  zahození DEK při zamčení, anti-rollback designů (F-16).

### Fáze 2 — střednědobě (měsíce)

* **Protokol:** libsignal (PQXDH + Double Ratchet, případně SPQR) pro 1:1 a zařízení účtu;
  **MLS (RFC 9420)** pro skupiny se spravovaným členstvím a pozvánkami místo passphrase jako
  jediné vstupenky; hybridní ML-KEM.
* **Transparentnost klíčů:** append-only log klíčů účtů ověřovaný klienty, nebo aspoň podepsaný
  adresář s porovnáváním mezi klienty.
* **Doručování kódu:** podepsaná vydání webu, reprodukovatelný bundle, ověřování mimo server
  (rozšíření, desktopová aplikace); reprodukovatelné APK.
* Relay ve stylu sealed sender (server zná jen příjemce).

### Fáze 3 — ověřitelnost (průběžně)

* Nezávislý kryptografický audit (hello, sender keys, trezor) a penetrační test serveru,
  Androidu a webu.
* Formální model handshake a ratchetu (ProVerif / Tamarin), fuzzing parseru CBOR a rámců,
  testovací vektory RFC 9106 pro Argon2id v Javě.
* Bug bounty, transparenční zpráva, SAST a audit závislostí v CI, připnuté akce a obrazy podle
  digestu.

---

## 9. Co nebylo ověřeno

* **Žádný externí audit** — dokument je revize kódu, ne audit třetí strany.
* **Žádný penetrační test živého nasazení** — TLS konfigurace reverse proxy a skutečné hodnoty
  `TRUST_PROXY`, `WEBAUTHN_ORIGINS`, `TURN_SECRET`, `CLUSTER_SECRET` a oprávnění k `dist/`
  nebyly zkoumány.
* **Žádné testy na zařízeních** — chování Androidu (StrongBox, Keystore, `FLAG_SECURE`,
  Credential Manager), skutečné vynesení přes design (F-01) ani URL kódování `{$msg.text}`
  nebyly spuštěny.
* **Nic nebylo spuštěno:** únik z Pyodide (F-03), dosažitelnost dev serveru z LAN (F-27),
  rebinding (F-14) a spuštění `js` od člena (F-08) jsou odvozené z kódu.
* Vlastní implementace Argon2id v Javě, WebSocket nad `SSLSocket` a parser CBOR nebyly
  testovány proti vektorům ani fuzzovány.
* Chování prohlížečů (podpora `RTCRtpScriptTransform`, ukládání neexportovatelných klíčů
  v IndexedDB, obnova `sessionStorage`, `Clear-Site-Data`) se liší a nebylo měřeno.
* Neproběhl sken závislostí na známé CVE ani kontrola historie gitu na tajemství.
* Redakce tajemství v GET odpovědích pro roli auditor nebyla procházena route po route.
* Údaje o ostatních aplikacích jsou z veřejných zdrojů k 2026-10-04; body označené „neověřeno"
  nemají primární zdroj. Některé (registrace Signalu bez čísla, key transparency, SPQR) se
  rychle vyvíjejí.

---

## 10. Nesoulad dokumentace s kódem

| Dokument | Tvrzení | Skutečnost v kódu |
|---|---|---|
| `README.md` | „Server je pouze signalizační relé a nikdy nevidí ani obsah zpráv" | relay, serverová historie, Functions, AI, řeč a telefonie (§ 3.1) |
| `docs/security-model.md`, TL;DR | AES-GCM s klíčem PBKDF2-SHA256 250 000, sůl s room id | v3: Argon2id 64 MiB / 3 + HKDF ([`envelope.ts:107-141`](../client/src/lib/envelope.ts)) |
| `docs/security-model.md`, TL;DR | „Chatové zprávy přes server nejdou vůbec" (až na výjimky) | relay, outbox a historie na serveru jsou běžné cesty |
| tamtéž, známá mezera č. 1 | WS upgrade bez limitu | opraveno — `gate.admit` ([`hub.ts:260-271`](../server/signaling/hub.ts)) |
| tamtéž, č. 5 | proxy souborů nedoručuje | doručuje neprůhledné bloky ([`file-proxy.ts:1-36`](../server/file-proxy.ts)) |
| tamtéž, č. 6 a 7 | TOFU podle `peerId`, otisk místnosti z ID | **stále platí** (F-25) |
| tamtéž, č. 8 | CSP s `unsafe-inline unsafe-eval` | jen dev; produkce `'self' 'wasm-unsafe-eval'` ([`index.ts:173`](../server/index.ts)) |
| `docs/architecture.md` | „Stav k 2.5.0", PBKDF2 250 000, „e2ee mezi více než dvěma peers… nemáme klíč-per-peer výměnu" | párové klíče a sender keys od 3.1 |
| UI nastavení | „PBKDF2 SHA-256, 250 000 iterací, salt = CipherRoom:v1:&lt;room&gt;" | viz výše ([`i18n.ts:177`](../client/src/lib/i18n.ts), [`settings.ts:245`](../client/src/lib/layouts/settings.ts)) |
| `server/accounts/store.ts:12` (komentář) | server loguje „room names" | v3 jen slepá ID — kromě cest z F-10 |
| `server/functions/sandbox/child.ts:4`, `harden.ts:4-8` | `--permission`, bubblewrap | v kódu se nepoužívá (F-03) |
| `client/src/lib/nfc.ts:10-13` | „EMV card-data reading is NOT implemented here" | hloubková čtení EMV existují v `client/src/lib/nfc/*`; komentář se týká jen tohoto souboru, ale mate |

---

*Analýza vznikla revizí kódu s pomocí AI (Claude). Neslouží jako náhrada nezávislého auditu.*

---

## 11. Stav po opravách 6.7

> **Stav kódu:** 6.7.0, commit `28f10ad0` (větev `android_application`), po sloučení
> oprav serveru, webu a Androidu (`docs/audit-6.7.md`, kapitoly „Opraveno v 6.7“).
> Kapitoly 1–10 výše popisují stav **před** opravami (`594202f5`) a zůstávají beze
> změny. Každý řádek níže je ověřený proti kódu `28f10ad0` (ne podle textu auditu);
> `A/` = `android/app/src/main/java/cz/m5cet/app/`. Stav: **opraveno** · **částečně**
> · **otevřené**.

| ID | Stav | Commit | Doklad v kódu | Co zbývá |
|---|---|---|---|---|
| F-01 | **částečně** — kritický únik opraven | `d5d6b818`, `9bdb4cdc` | `A/ui/DesignUrls.java:33` (počítaný `src` jen `asset:` / `data:image/`, vzdálený jen přesně pevná adresa), `:43` (`url.open` po potvrzení); `server/android/design.ts:610`, `:625` (`checkImageSrc`, `checkActionArg`, `ANDROID_DESIGN_IMAGE_HOSTS`) | `url.open` s adresou poskládanou z dat projde jedním potvrzeným klepnutím; `setting.set` / `toggle` smí na každý známý klíč (`A/core/Settings.java`: sledování polohy, hlas přes server, emulace NFC); `share` / `copy` berou počítaný text; serverová kontrola výrazu (`/https?:|\/\//`) jde obejít skládáním řetězců — drží jen kontrola v aplikaci. *→ kap. 12, G-20: třída F-01 je dál zneužitelná (`setting.set` → synchronizace na server, log → příkaz `status`)* |
| F-02 | otevřené | — | `client/src/lib/integrity.ts:60-61`, `:72` (jen názvy souborů, manifest od téhož serveru) | podepsaná vydání, ověřování mimo server |
| F-03 | **částečně** | `14590ef0` | `server/functions/sandbox/pool.ts:118-120` (`--permission`, `--allow-fs-read` jen pro skript a interpret, `--disallow-code-generation-from-strings`), `:128` (prostředí dítěte jen `PATH`); `harden.ts` (konstruktory `Function` odstavené) | bez bubblewrap / nsjail a jiného uživatele; síť zavírají jen stuby v JS (permission model Node síť nepokrývá); interní `_module` Pyodide není v `NEUTERED` (`engine-py.ts:31`). Přepínač `--permission` má Node podle changelogu až od 22.13 / 23.5, `engines` říká `>=22` |
| F-04 | **částečně** (varování) | `bc850f12`, `9107eb8b` | `client/src/lib/passphrase-strength.ts:152` (`weakKeyBlocks`), `client/src/components/RoomDialog.tsx:156` | slabý klíč se zadrží jen jednou (druhé *Připojit* projde) a jen v ručně zadané místnosti na webu — uložená připojení ani Android sílu neměří; výchozí klíč není náhodný; `hashRoom` bez tajné soli (`server/monitor/traffic.ts:120-123`); slepé ID zůstává orákulum (offline pokus stojí jedno Argon2id) |
| F-05 | **opraveno** | `76c472e8` | `A/security/ServerPin.java:28` (`check`), `:51` (`same`); `A/ui/parts/Forms.java:219`, `:222` | bez pinu z buildu i z QR je zápis dál TOFU |
| F-06 | otevřené | — | `client/src/lib/sender-keys.ts:172-184` (hello nese dlouhodobý DH klíč), `client/src/lib/identity.ts:59-62`, `A/chat/SenderKeys.java:118` | efemérní ECDH, DH ratchet (PCS), PQ |
| F-07 | **opraveno** | `1d712f9a` | `A/chat/Verified.java:21` (P2P: klíč z hello, jméno peeru), `:28` (relay: kid = pin); `A/chat/RoomSession.java:451`, `:724` | první kontakt je dál TOFU (jako web, F-13) |
| F-08 | **částečně** | `1c007087` | `client/src/components/fn/FnOutputs.tsx:54` (`PEER_JS_EVENTS = 20`), `:58` (`userActivation`) — kód od jiného člena až po kliknutí, skrytý nikdy; `server/functions/chain-access.ts:47` (`mayContinue`) → `server/functions/routes.ts:231` (`410`) | CSP sandboxu dál `img-src … https:` a `connect-src https:` (`server/functions/sandbox-page.ts:20`, `:23`) — po kliknutí může cizí kód poslat data na libovolný https server; tlačítka ve zprávě modelu od jiného člena posílají událost s tokenem diváka po jednom kliknutí |
| F-09 | otevřené | — | `client/src/App.tsx:3539-3549` (jedna obálka klíčem místnosti pro relay i outbox); `server/accounts/mailqueue.ts:77` (30 dní) | šifrovat položky schránky pro příjemce |
| F-10 | **opraveno** (web i Android) | `6d4b49aa`, `4a1078a8`, `75ef3f7d` | `client/src/lib/room-privacy.ts:14` (`serverRoomId`: slepé `r3.…` nebo nic) pro historii, analytiku a funkce; `A/ui/parts/Fn.java:98` (slepé id); jména místností a peerů mimo log příkazu `status` | v **ladicím** buildu `A/ui/Actions.java:28` loguje každou akci designu s argumentem (i čitelný název místnosti) a s politikou `logs: "all"` ho příkaz `status` vrátí — release build `Log.d` nezapisuje |
| F-11 | **opraveno** | `a366786e` | `client/src/lib/chat-history.ts:217` (nezapečetěný řádek se odmítne), obnovené zprávy znovu přes `validateAttachment` / pravidla výstupů funkcí, `safeMime()` pro bloby | — |
| F-12 | otevřené | — | `client/src/lib/nfc.ts:30-43`, `A/nfc/Nfc.java:30-40` (4–16 číslic, PBKDF2 200 000) | Argon2id a dlouhý náhodný kód, nebo odkaz + oddělené tajemství |
| F-13 | otevřené | — | `client/src/App.tsx:1633-1637` (poprvé viděný klíč = „verified“), piny podle (místnost, jméno) | odlišit „nový“ / „ověřený“, revokace zařízení, transparentnost klíčů (N23 odloženo) |
| F-14 | **částečně** (připnutí opraveno) | `2043c239` | `server/functions/host-net.ts:157-161` (připojení na ověřenou adresu), `:194-198` (`node:http(s)` s pevným `lookup`), `:174` (`Authorization` / `Cookie` pryč při přesměrování na jiný origin); NAT64, Teredo, `fec0::/10` blokované | `/web` je dál dostupné hostům po zapnutí Functions (`server/functions/builtins/index.ts:47`, viditelnost `caller`); URL zpětného volání webhooku volí volající (projde ale guardem) |
| F-15 | otevřené | — | `client/src/lib/rtc.ts:7-8` (Google STUN, `iceTransportPolicy: "all"`); `server/access.ts:94` (plná IP), 30 dní | vše; 6.7 navíc dává serveru přítomnost / „naposledy online“ a seznam zmíněných účtů (`relay.mention`) |
| F-16 | **částečně** | `68c2243f`, `e6b9ce09`, `75ef3f7d` | `A/security/SignedPolicy.java:31` (`open`: podpis, zařízení, ne starší), `server/android/routes.ts:217`, `:241` (`policySigned`); `A/security/LockCounter.java` (pokus uložen před derivací) | pepř `m5.pep` bez ověření uživatele a hardwarového limitu; čítač v souboru trezoru (starší kopie ho vrátí); „zamknout“ nezahodí DEK; žádný nouzový PIN |
| F-17 | **částečně** | `d41469a3` | `server/telephony/webhooks.ts:262` (Vonage SMS bez `sig` → `403`, výjimka `VONAGE_ALLOW_UNSIGNED_SMS=1`), `:164` (JWT s čerstvým `iat` ≤ 10 min, `payload_hash`) | bez nastaveného materiálu se webhook dál přijme jako neověřený (záměr — *→ kap. 12, G-01: v 6.9 už to záměr nebyl, nepodepsaný hovor spouštěl TSA; opraveno*); `exp` JWT nepovinné; žádná cache `jti`; legacy SMS `sig` bez `timestamp` nemá kontrolu stáří |
| F-18 | **částečně** | `190ea08f` | `server/functions/store.ts:139` (`FUNCTIONS_NFC_RUN_HOURS`, výchozí 24 h, běh `sensitive`), `:180` (dál obyčejný SQLite) | `functions.db` nešifrovaná; log webhooků výchozí „full“ s plnou IP; PAN uložen; ostatní běhy 30 dní |
| F-19 | otevřené | — | `client/src/lib/media-frames.ts:33-43` (4 B sůl + čítač), `client/src/lib/media-e2ee.worker.ts:41` (nezapečetěné rámce projdou) | klíč na hovor / SFrame |
| F-20 | otevřené | — | `client/src/lib/envelope.ts:211-227` (v2 a v1 se otevírají); varování jen `sec.legacyPeer` (`App.tsx:2557`) | ukončit v1 / v2 |
| F-21 | otevřené | — | `client/src/lib/envelope.ts:314-332` (viděná id jen v paměti) | trvalý seznam, dolní mez `createdAt` (N32 odloženo) |
| F-22 | **částečně** | `1c007087` | `client/src/components/fn/FnOutputs.tsx` (kód od člena až po kliknutí, flash nese jméno odesílatele), `client/src/lib/validate.ts` (`function:*` jako odesílatel odmítnut) | formuláře od člena (i pole `password`) se dál vykreslí a odešlou; `replyTo` / „přeposláno“ volný text; jména bez normalizace bidi / homoglyfů; `from` oznámení libovolné |
| F-23 | otevřené | — | `server/storage/global-store.ts:698` (řádek bez hashe = „unchained“, ne chyba) | připnout klíč kontrolních bodů mimo DB |
| F-24 | otevřené | — | `server/accounts/webauthn.ts:80-82` (bez `WEBAUTHN_ORIGINS` každá https subdoména rpId) | výchozí přesný seznam originů |
| F-25 | **částečně** | `dac281a1` (N27) | `client/src/lib/fingerprint.ts:152` (úložiště otisků max. 100 peerů) | otisky DTLS dál podle `peerId`; otisk místnosti z názvu (`App.tsx:2927`); text „PBKDF2 … 250 000“ v `client/src/lib/i18n.ts:177` (a en / de) a `layouts/settings.ts` |
| F-26 | otevřené | — | `client/src/lib/passkey.ts:129-144` (sloty bez AAD); `session-cache.ts` (`touchedAt` mimo AEAD) | AAD se jménem slotu a verzí; „Smazat vše“ neodvolá token (N24 odloženo) |
| F-27 | **částečně** | `79c48cf1` | `vite.config.ts:145` (`deny`: `.env*`, `*.bak`, `*~`), `.dockerignore` (`.env*`, `*.bak`) | dev i hlavní server dál poslouchá na `0.0.0.0` (`server/index.ts:252`, `HOST` to změní); `fs.allow` celý repozitář |
| F-28 | otevřené | — | `server/routes.ts:357` (`/api/turn` bez autentizace), `server/share.ts:31` (2 000), `server/file-proxy.ts:24` (64), `server/functions/sandbox/pool.ts` (bez stropu souběžných sandboxů) | stropy na IP / účet, fronta sandboxů (6.7 omezila jiné věci: brána WS, relace úložiště, audit) |
| F-29 | otevřené | `09f6c307` (jednorázový `npm audit fix`) | `.github/workflows/ci.yml:55` (`npm ci --no-audit`, bez SAST); `Dockerfile` (`node:24-slim` podle tagu); `server/ai/local-speech.ts` (modely bez kontroly hashe) | `npm audit --omit=dev` je čisté, celý `npm audit` hlásí 5 vysokých (dev řetěz tailwind 3 → braces); audit, formální analýza, reprodukovatelný build |
| F-30 | otevřené | — | `client/src/lib/envelope.ts:156` (`signBody`, ECDSA), `client/src/lib/identity.ts:196` (Ed25519) | vědomé rozhodnutí zdokumentovat |
| F-31 | **opraveno v dokumentaci 6.7** | (dokumentační commit 6.7) | `README.md` — úvod a režimy nově říkají, kdy server obsah vidí (Functions, AI, řeč, telefonie, veřejný profil) | UI (texty u funkcí a AI) beze změny |

### Revidované hodnocení (6.7.0)

| Oblast | Před 6.7 | 6.7 | Proč |
|---|---:|---:|---|
| Šifrování živých zpráv (P2P) | 7 | **7** | návrh beze změny; kolize `keyId` sender keys opravena (S18) |
| Zprávy přes server, soubory, offline doručení | 4 | **4** | historii už server nepodvrhne (F-11), soubor je vázaný na peera (S19); schránka pořád pod klíčem místnosti (F-09) |
| Správa klíčů a odvozování | 5 | **6** | čitelný název místnosti (sůl) už na server nejde (F-10); síla klíče se měří, ale nevynucuje (F-04) |
| Identita a ověřování | 3 | **3** | „ověřeno“ na Androidu opraveno (F-07); TOFU podle jména, první kontakt jako „ověřeno“ a chybějící revokace trvají (F-13) |
| Dopředná utajenost, PCS, post-kvantová ochrana | 3 | **3** | beze změny (F-06) |
| Ochrana metadat | 3 | **3** | název místnosti už neteče (F-10), ale server nově zná přítomnost, „naposledy online“ a zmínky (F-15) |
| Webový klient | 5 | **6** | cizí kód z výstupů funkcí jen po kliknutí a bez cizí relace (F-08), historie, soubory a paměť ošetřené (S17–S20); kód dál doručuje server (F-02) |
| Aplikace pro Android | 4 | **6** | design už zprávy nevynese (F-01 — *→ kap. 12, G-20: po jednom klepnutí ano*), pin klíče serveru (F-05), „ověřeno“ (F-07), podepsaná politika, PIN počítaný předem, neutrální notifikace, úplný wipe, Android 10–12 (F-16, S10–S13, V5); zbývá `setting.set` / `url.open` v designu a pepř PINu bez hardwarového limitu |
| Server a provoz | 4 | **5** | sandbox s permission modelem (F-03), připnutí SSRF (F-14), webhooky telefonie fail-closed (F-17), omezený stav bez přihlášení, regexy a WS brána (V3, V4, S1–S9); bez izolace procesu a s nešifrovanou `functions.db` (F-18) |
| Ověřitelnost (audity, formální důkazy, reprodukovatelné buildy) | 1 | **1** | audit 6.7 i tato analýza jsou revize kódu s pomocí AI, ne externí audit (F-29) |
| **Celkově** | **≈ 4** | **≈ 4,5** | implementační chyby s nejvyšší závažností jsou opravené nebo zúžené; zbývají návrhové mezery |

**Verdikt po 6.7.** M5cet ani po opravách **není bezpečnostně srovnatelný se Signalem
ani s Threemou**, ale už ho od nich dělí hlavně **návrh**, ne chyby v implementaci:
kritický únik přes design Androidu (F-01), obejitelný pin klíče serveru (F-05),
falešné „ověřeno“ (F-07), podvržená historie (F-11) a únik názvu místnosti (F-10)
jsou opravené; sandbox Funkcí (F-03), spouštění cizího kódu z výstupů funkcí
(F-08), SSRF (F-14), telefonie (F-17) a zámek Androidu (F-16) jsou výrazně zúžené.
Zůstávají návrhové mezery z kap. 1: **web doručovaný serverem** (F-02), **sdílené
heslo jako kořen důvěry** se slepým ID jako orákulem (F-04), **statické klíče
zařízení bez obnovy po kompromitaci** a bez post-kvantové ochrany (F-06), **schránka
pod klíčem místnosti** (F-09), **TOFU podle jména** (F-13) a **metadata** (F-15) —
a dál **žádný nezávislý audit** ani reprodukovatelný build (F-29). Nic z oprav 6.7
nebylo vyzkoušeno na skutečném zařízení ani proti skutečným poskytovatelům (FCM,
SMTP, web push, telefonie); viz `docs/audit-6.7.md`, kap. 6.

*Kapitola 11 vznikla stejně jako zbytek analýzy — revizí kódu s pomocí AI (Claude).*

---

## 12. Stav 6.10: nové části a srovnání

> **Stav kódu:** rozpracovaná verze 6.10.0, výchozí commit `addff2a9` (větev `android_application`),
> opravy této revize `16695a1b`, `327c9efc`, `76bdbc03`; Android G-20 až G-24 `e3fefe00`, G-17 na
> Androidu `9086ab31` (web `4a7f5fce`); analýza ke dni 2026-10-05.
> **Rozsah:** všechno, co přibylo od kap. 11 (`28f10ad0`): 6.8 (záznam hovorů a konverzace na
> Androidu, volby odeslání, `API_RATE_LIMIT`, oprava velkých souborů), 6.9 (Telephony & SIP —
> webhooky, pravidla, TSA, route kódy, zvuk hovoru do místnosti, konzole) a 6.10 (šablony APDU,
> kostra designu 6.10); znovu prověřené otevřené nálezy F-xx. **Metoda** jako v kap. 1–11:
> revize kódu, každý řádek doložený `soubor:řádek` na stav po opravách (u Androidu a NFC na
> `addff2a9` — tyto soubory se neměnily). Obcházení práv konzole (G-02) bylo ověřeno spuštěním
> na Express 5 projektu; nic jiného neběželo proti skutečnému poskytovateli, telefonu ani kartě.
> Opravy: `npx tsc --noEmit -p .` čisté, `npx vitest run` 236 souborů / 2813 testů (4 přeskočené),
> `npm run build` v pořádku (před opravami 235 / 2802). `A/` = `android/app/src/main/java/cz/m5cet/app/`.
> **Druhé kolo oprav** (G-05, G-06, G-08, G-12 – G-16): `0bffa178` (server, konzole, editor TSA),
> `7210cdc8` (web); na `fbaafa61` — `npx vitest run` 238 souborů / 2854 testů (4 přeskočené; předtím
> 237 / 2827), `tsc` i `npm run build` v pořádku. Řádky v doložení oprav jsou podle `7210cdc8`.
> Stav: **opraveno** (v této revizi) · **otevřené** · **návrhové** · **jen nález** (soubory
> spravuje jiný agent — Android, NFC; oprava je doporučená přesně).

### 12.0 Shrnutí pro uživatele

1. **Verdikt se nemění: ≈ 4,5 / 10 vůči Signalu.** Kryptografické jádro je dobré; chybí obnova po kompromitaci (PCS) i post-kvantová ochrana, web doručuje server, identita je TOFU podle jména a kód nikdo nezávislý neauditoval.
2. **Telefonie 6.9 je největší nová plocha útoku.** Měla tři vážné chyby, opravené v této revizi: padělaný nepodepsaný webhook řídil aplikace TSA — SMS, HTTP, funkce, route kódy, zvuk do místnosti (G-01); čtenář konzole obešel práva změnou velikosti písmen v adrese (G-02); bez pravidla modulu mohl kdokoli z internetu volat a psát SMS na účet provozovatele (G-04).
3. **Web:** „soukromá" příloha či hlasová zpráva pro nepřítomné mohla odejít celé místnosti (G-10) — opraveno.
4. **Android (opraveno v `e3fefe00`):** design podepsaný serverem po jednom klepnutí vynášel dešifrovaný text (G-20, třída F-01) a přepínal soukromé volby (G-21); oznámení z doby před automatickým zámkem si nechávala obsah (G-22). Model funkce dostane data karty jen se souhlasem držitele, výchozí je zamaskované (G-17, web `4a7f5fce`, Android `9086ab31`).
5. **Druhé kolo oprav (hotovo):** hádání route kódů s podvrženým číslem (G-05), toll fraud v TSA (G-06), přehrání zachyceného webhooku (G-08), cesty odesílání mimo výběr příjemců (G-12), tiše ztracené volby zprávy (G-13), plaintext pro řeč serveru bez upozornění (G-14), tajemství v editoru TSA (G-15) a `replace()` ve vzorcích (G-16); NFC: souhlas s odesláním dat karty, šablony jen pro čtení, úplné maskování PAN (G-17 – G-19).
6. **Otevřené:** nešifrovaná `telephony.db` (G-07) a slepé ID jako klíč k hubu (G-09) — návrhové; zbytky po opravách vyjmenovává § 12.2.
7. **Proti komerčním messengerům** je M5cet slabší než Signal, iMessage (PQ3), WhatsApp a Threema v protokolu a ověřitelnosti. Silnější je než výchozí chaty Telegramu, které server čte. Záměrně se liší: bez telefonního čísla, jen na vlastním serveru.

### 12.1 Co přibylo od 6.7 a jakou plochu útoku to otevírá

| Verze | Část | Nová plocha | Kdo útočí |
|---|---|---|---|
| 6.8 | Záznam hovorů v telefonu, Záznam v aplikaci, místnosti jako konverzace Androidu, sdílení do místnosti | systémový call log (čte každá aplikace s `READ_CALL_LOG`), zkratky v launcheru a sdílení, oznámení | jiné aplikace v telefonu, S6 |
| 6.8 | Volby odeslání (Android `SendPlan`, web „Poslat jako hlas") | text jde na TTS serveru; trvalé volby | S3/S4 (plaintext TTS) |
| 6.8 | `API_RATE_LIMIT` a výjimky | cesty s vlastním limitem nejdou do obecného | anonymní klient |
| 6.8 | Velký soubor jen vybraným | směrování příloh | S5 |
| 6.9 | Webhooky poskytovatelů + callback TSA `/wh/tel/<token>/tsa` | veřejně dosažitelné, podpis podle poskytovatele | kdokoli na internetu |
| 6.9 | Runtime TSA (27 nástrojů: SMS, Dial, HTTP, Function, zpráva do místnosti, route kódy) | placené akce, síť, funkce — řízené volajícím (DTMF, řeč) | volající (podvrhnutelné číslo) |
| 6.9 | Route kódy a zvuk hovoru do místnosti (`route-audio.ts`, `mixer.ts`) | 4–6 číslic = klíč ke zvuku místnosti; zvuk mimo E2EE | volající, kdo zná slepé ID |
| 6.9 | Konzole Telephony & SIP, editor TSA, log s „raw" payloady | práva po endpointech (`api-contract.ts`) | S4 (auditor, operátor) |
| 6.9 | `telephony.db` (hovory, SMS, log, relace TSA, kódy, TTS) | další úložiště osobních dat | S3, S6 serveru |
| 6.10 | Šablony APDU jako úplná čtení typů karet; kostra designu 6.10 | APDU z šablon a modelů | S4 (šablony), modely |

### 12.2 Nálezy

| ID | Závažnost | Stav | Nález | Doklad | Oprava / doporučení |
|---|---|---|---|---|---|
| G-01 | **Vysoká** | **opraveno** `327c9efc` | Bez `TELNYX_PUBLIC_KEY` / `VONAGE_SIGNATURE_SECRET` se webhook přijme neověřený (F-17) — a od 6.9 tím **spouštěl pravidla, TSA i audio most**. Padělaný příchozí hovor dostal v odpovědi (NCCO) capability callbacku TSA a mohl řídit celý tok: SMS na libovolné „číslo volajícího" na účet provozovatele, HTTP, funkce, zprávy do místnosti, hádání route kódů s vymyšleným caller ID a připojení k WebSocketu zvuku. 10 padělaných „živých" hovorů navíc na 4 h obsadí limit souběhu (DoS linky) | `server/telephony/webhooks.ts:263`, `:271` (bez materiálu `enforced: false`); `server/telephony/control/calls.ts:143-187` (pravidla → TSA), `:290-302` (tahy v HTTP odpovědi), `:122-133` (souběh počítá 4 h) | `tel-routes.ts:36`, `:54`: neověřený webhook hovoru k pravidlům, TSA ani mostu nedojde (výjimka `TELEPHONY_ALLOW_UNSIGNED=1`); `overview.ts` to hlásí; test `telephony-inbound-69` |
| G-02 | **Střední–vysoká** | **opraveno** `16695a1b` | **Obejití práv konzole velikostí písmen.** Express směruje bez ohledu na velikost písmen, strážci práv (`rightOf`) porovnávají cestu přesně: `GET /admin/telephony/LOG/<id>` vrátil celý záznam logu (syrové payloady: SMS, čísla, přepisy) jen s právem čtení modulu; totéž obešlo právo `devices` (polohy telefonů, `/api/admin/android/Devices/<id>/LOCATIONS`) a `webhooks` u Functions. Ověřeno spuštěním | `server/telephony/control/guard.ts:15-22`, `:31-38`; `server/android/admin-routes.ts:42-44`; `server/functions/admin-routes.ts:170-187` | `server/exact-routing.ts` — obě služby a routery s právy podle cesty směrují přesně; strážce telefonie porovnává bez ohledu na velikost písmen; test `exact-routing-610` |
| G-03 | **Střední** | **opraveno** `327c9efc` (výpis, log) | Route kódy (klíč ke zvuku místnosti) a **slepá ID místností** viděl v plném znění každý, kdo modul jen čte (auditor); slepé ID bylo i v souhrnech logu dostupných bez práva `log`. Slepé ID je offline orákulum hesla (F-04) a adresa místnosti na hubu (viz G-09) | `server/telephony/control/routes.ts:141` (dřív bez kontroly práva); `server/telephony/control/inroute.ts:77-79` (dřív `room: r.room`); `server/telephony/tsa/runtime.ts:645`, `:661` | v plném znění jen s právem `settings` (`routes.ts:77`, `:141-148`), jinak poslední číslice a hash místnosti; log jen hash; test `telephony-control-console` |
| G-04 | **Vysoká** (při `ENABLE_TELEPHONY=1` bez pravidla modulu) | **opraveno** `327c9efc` | **Anonymní toll fraud:** modul bez pravidla je „pro všechny se všemi právy"; web posílá `/api/telephony/call\|sms` bez tokenu účtu, takže kdokoli z internetu volal a psal SMS na účet provozovatele kamkoli, kam nevedl výchozí blokovaný seznam (výchozí `countries: []` = celý svět); brzdou byl jen limit 10 / 10 min a rozpočet na IP | `client/src/lib/modules.ts:341` (`unlisted` → vše); `client/src/lib/telephony.ts:29`, `:46` (bez `Authorization`); `server/telephony/control/types.ts:191` | `server/telephony/routes.ts:56-62`: „unlisted" se pro tyto dvě placené cesty odmítne — provozovatel musí pravidlo napsat (i pro `guest`); test `telephony-control-outbound`. **Zbývá:** výchozí `countries` prázdné = kamkoli pro funkce a aplikaci (pro TSA od `0bffa178` jen vlastní země, G-06) |
| G-05 | **Střední** | **opraveno** `0bffa178` | **Hádání route kódů:** limity špatných kódů jsou na číslo volajícího, které je podvrhnutelné (CLI spoofing, u SIP volání libovolné `From`); chybí globální limit a limit na DID / TSA. Vlastní kód smí mít 4 číslice a TTL až 24 h (triviální kódy jen varují) — s 10 souběžnými hovory po 3 pokusech je 4místný kód uhodnutelný za hodiny | `server/telephony/control/inroute.ts:262-299` (klíč = číslo volajícího), `:181-185`; `server/telephony/tsa/runtime.ts:615`, `:625-628`; `server/telephony/control/types.ts:193` | Špatné kódy se počítají na volajícího, na **volané číslo (DID)** a **za celý modul** za minutu a hodinu (`inroute.ts:382` `inrouteFailure`, nová oprávnění `maxFailuresPerDidPerHour` 30, `maxFailuresPerMinute` 10, `maxFailuresPerHour` 100). Po vyčerpání rozpočtu DID nebo modulu se kódy **pozastaví** — 1 min, při opakování do hodiny dvojnásobek až 60 min (`:338` `trip`); během pauzy se kód ani nehledá (`:363` `inrouteGuard`, `runtime.ts:663`). Každá pauza je varování v logu a bezpečnostní událost v auditu `telephony.inroute.lockout` (napájí alert konzole). Kód, který dosáhne `maxAttemptsPerCall`, **ukončí hovor** (`runtime.ts:640`). Kód s TTL nad 10 min má 6 číslic, triviální zvolený kód se odmítne a živých kódů jedné délky je nejvýš 1 z 1000 (10 / 100 / 1000; `inroute.ts:200-207`, `:236`). Testy `telephony-inroute`, `tsa-runtime`. **Zbývá:** pauzu může útočník vyvolat i úmyslně (odepření služby zákazníkům s kódem) — je to cena za limit nezávislý na caller ID; kódy do 10 min smějí mít 4 číslice (nejvýš 10 živých) |
| G-06 | **Střední** | **opraveno** `0bffa178` | **Toll fraud v TSA:** SMS jde bez parametru `to` na číslo volajícího (podvrhnutelné → „SMS pumping" až 60 / h na TSA); výchozí `countries: []` povolí celý svět; Dial (přepojení) jde mimo `planOutbound` — bez `callsPerHour`, souběhu a `maxMinutes`; Twilio `<Dial>` bez `timeLimit` (výchozí 4 h) | `server/telephony/tsa/runtime.ts:425`, `:433-434`, `:668-718`; `server/telephony/control/types.ts:191`; `server/telephony/control/enforce.ts:110-154` (TSA ho nevolá); `server/telephony/providers/twilio.ts:185-189` | SMS i Dial TSA jdou přes `planOutbound` jako `tsa:<id>` (`runtime.ts:439`, `:723`; `tsa/deps.ts` `outbound`, `sendSms`): země, blokovaná čísla, hodinový rozpočet, souběh, odchozí pravidla (stav odmítne i při „Route through: app / trunk") a nejdelší hovor. **Prázdné `countries` znamená pro TSA jen vlastní země provozovatele** — podle nastavených čísel (`TWILIO_FROM`, `TELNYX_FROM`, `VONAGE_FROM`, `TELEPHONY_DID_POOL`, DID a caller ID SIP trunků) a volaného čísla (`enforce.ts:127` `ownCountries`, `:160`; `rules.ts:58`); `*` = celý svět i pro TSA. Přepojení TSA za hodinu nejvýš `callsPerHour` (`runtime.ts:727`). Dial má časový limit (`runtime.ts:753`: Twilio `timeLimit` `twilio.ts:189`, Vonage `limit` `vonage.ts:182`, Telnyx `time_limit_secs` `telnyx.ts:276`). Validátor varuje u SMS na volajícího při `countries: ["*"]`. Testy `tsa-runtime`, `telephony-control-outbound`, `telephony-control-rules`, `telephony-providers-69`. **Zbývá:** funkce a aplikace s prázdnými `countries` dál smějí kamkoli (jsou přihlášené a od G-04 za pravidlem modulu); SMS na podvržené číslo ve vlastních zemích jde dál (domácí pumping, brzdí ho `smsPerHour` na TSA); přepojení TSA se nezapisují jako hovory, takže je nepočítá limit souběhu odchozích hovorů (omezuje je souběh příchozích) |
| G-07 | **Střední** | otevřené (návrhové, jako F-18) | `telephony.db` je obyčejný SQLite (0600): čísla, texty SMS, přepisy řeči, hodnoty relací TSA, odpovědi HTTP, TTS audio a log se **syrovými payloady** (výchozí `keepRaw: true`, 30 dní). Maskování route kódů v logu je neúplné — kód zadaný volajícím je v syrovém `Digits` a v `parsed.event` | `server/telephony/tel-store.ts:209-225`; `server/telephony/control/types.ts:195`; `server/telephony/control/log.ts:236`; `server/telephony/control/calls.ts:115` | SQLCipher s master klíčem (jako ostatní úložiště); `keepRaw` výchozí vypnuté; v logu maskovat `Digits` / `dtmf` / `SpeechResult`; kratší retence |
| G-08 | **Nízká** | **opraveno** `0bffa178` (část F-17) | Přehrání zachyceného webhooku: Telnyx 300 s, Vonage JWT 10 min, bez cache id / `jti`; `exp` nepovinné | `server/telephony/webhooks.ts:141-152`, `:157-176`; `server/telephony/jwt.ts:59-70` | Ověřený požadavek si server pamatuje 15 min podle toho, co ho dělá jedinečným: Telnyx id události (`data.id`, jinak podpis), Vonage `jti` JWT (jinak celý token), podepsaná SMS Vonage `sig` (`webhooks.ts:265` `replayKey`, `:289`). Kopie dostane `200` a nezpracuje se — ve všech třech cestách (`webhooks.ts:428`, `tel-routes.ts:95`, `engine.ts:657`); stejně se přeskočí i opakované doručení téže události poskytovatelem. Test `telephony-webhooks-failclosed`. **Zbývá:** Twilio se neklíčuje — jeho podpis neobsahuje čas a dva skutečné požadavky mohou být shodné (stejná klávesa ve stejném menu); paměť je v procesu (restart nebo druhá instance ji nemá) |
| G-09 | **Nízká–střední** | návrhové | Hub přijme do místnosti každého, kdo zná slepé ID — bez důkazu znalosti klíče. Server-side zvuk z telefonu (mimo E2EE) a karta s číslem volajícího jdou všem připojeným; kód typu „user" cílí podle **zobrazovaného jména** (neověřené) | `server/signaling/hub.ts:659-686` (join jen s `room`); `server/telephony/route-audio.ts:105-124`, `:277-282` | nabízet hovor jen členům, kteří prokázali znalost klíče místnosti (HMAC výzvy klíčem `signal`) nebo účtem (`@account`); jméno jako cíl jen s ověřeným účtem |
| G-10 | **Vysoká** (soukromí) | **opraveno** `76bdbc03` | „Soukromá" příloha, hlasová zpráva (i 6.8 „Poslat jako hlas") nebo text pro vybrané, kteří jsou všichni pryč: relay ji nevzal, outbox ji uložil **bez cílů**, což čte jako „všem", a při dalším otevření kanálu ji poslal celé místnosti | `client/src/lib/outbox.ts:19` („empty = everyone"); `client/src/App.tsx:752-755` (flush); dřív `App.tsx:3577` (`targets: … : []`) | `outbox.ts:38` `queueTargets()` — soukromé odeslání bez dosažitelného příjemce se odmítne s hláškou (`App.tsx:3575-3581`, `:3624`); test `outbox` |
| G-11 | **Nízká–střední** | **opraveno** `76bdbc03` | Znovu nabídnutý telefonní hovor (člen se vrátil s novým `peerId`) ztratil server, který ho nabídl, a token média člena šel na server místnosti na obrazovce — při více serverech ho vidí jiný provozovatel | `client/src/App.tsx:1781` (záloha `socketRef.current?.url`); `client/src/lib/phone-bridge.ts:70-77` | `phone-bridge.ts:61` `withServer()`; test `phone-route-ui` |
| G-12 | **Střední** | **opraveno** `7210cdc8` | Další cesty odesílání ignorují výběr příjemců a nikde neříkají „všem": velký soubor z panelu Soubory (i přes relay), poloha jednorázová i průběžná, text z panelu Řeč | `client/src/App.tsx:4754`, `:4763`, `:4774`, `:5461` | Všechny čtyři jdou přes `resolveRecipients()` jako zpráva: soubor z panelu Soubory (`App.tsx:4764`, `client/src/lib/send-plan.ts` `largeFileTargets`; pro vybrané jen přímým spojením, relay se nepoužije — `largeFileRoute`), poloha jednou (`App.tsx:4774`, i s nepřítomnými, které server drží), průběžná poloha (`:4789` — výběr se zafixuje při spuštění a nikdy se nerozšíří; aktualizaci dostanou jen připojení vybraní, `liveLocationTargets`; systémová zpráva říká komu), text z panelu Řeč (`:5486`). Test `send-paths-610`. **Zbývá:** Android tyto cesty neprověřoval (jiný agent) |
| G-13 | **Nízká** | **opraveno** `7210cdc8` | Volby zprávy se u příloh tiše ztrácí: zapečetění vždy, u velkých souborů i klikací / mizející (velká hlasová zpráva s „mizející" je trvalá); Přeposlat posílá vlastní zapečetěnou zprávu odpečetěnou a mizející jako trvalou | `client/src/App.tsx:4175-4186`; `:4029-4033` | Příloha v chatu nese klikací / mizející; co nejde (zapečetění souboru, u velkého souboru vše), aplikace **vyjmenuje a zeptá se před odesláním** — bez souhlasu nic neodejde (`App.tsx:4182`, `send-plan.ts` `attachmentKinds`). Přeposlat zachová klikací a mizející, vlastní zapečetěnou zprávu znovu zapečetí jejím kódem a zprávu, jejíž kód aplikace nemá (cizí, vlastní po znovunačtení), odmítne a tlačítko neukáže (`App.tsx:4034`, `:494`, `forwardPlan`). Test `send-paths-610`. **Zbývá:** velký soubor (blokový přenos) klikací / mizející / zapečetěný být neumí — jen se to řekne |
| G-14 | **Nízká** | **opraveno** `7210cdc8` | Plaintext na server bez jasného upozornění: „Poslat jako hlas" bere první TTS konektor (může být cloud) a čip v composeru to neříká; odpověď funkci se zapnutým „zapečetěno" jde jako plaintext i s citovaným textem | `client/src/lib/speak-send.ts:48`; `client/src/App.tsx:3684` | Čip pod polem: „Jako hlas — text čte server"; první hlasová zpráva v místnosti **jmenuje poskytovatele řeči a zeptá se** (`speak-send.ts:49` `serverVoiceConsent`, `:77`; `App.tsx:4219`), „ne" nic neodešle. Odpověď funkci se zapnutým „Individuálně šifrovaná" se odmítne s vysvětlením (`App.tsx:3676`). Test `send-paths-610`. **Zbývá:** souhlas platí do znovunačtení stránky; Android (`voice.engine=server`, G-21) neřešen |
| G-15 | **Nízká** | **opraveno** `0bffa178` | Konzole: koncepty TSA a schránka editoru v `localStorage` bez vazby na administrátora, nesmažou se při odhlášení; hlavičky uzlu HTTP mohou nést doslovná tajemství (místo `{secret:…}`) | `admin-ui/public/tsa-editor.js:35-36`, `:92-94`; `server/telephony/tsa/catalog.ts:374` | Místní kopie a schránka jsou v `sessionStorage` (jen tato karta) a **bez hodnot hlaviček, které vypadají jako tajemství** (`tsa-editor.js:98`, `:129` `stripSecrets`); kopie z 6.9 se při otevření přesunou a z `localStorage` smažou (`:102`); odhlášení z konzole editor zavře a vše zapomene (`console.js:225` → `forgetLocal`, `tsa-editor.js:3019`). Pole Headers varuje hned (`:2004`); server doslovné tajemství v hlavičce (JWT, `Bearer/Basic …`, hodnota hlavičky typu `Authorization`, `Cookie`, `*-Key`, `*-Token`) hlásí jako **chybu, která blokuje publikování** (`template.ts:99` `literalSecretHeader`, `validate.ts:284`). Testy `tsa-editor`, `tsa-validate`. **Zbývá:** už uložený graf s doslovným tajemstvím zůstane v `telephony-tsa.json` a v exportech, dokud ho autor neopraví; publikovaná verze dál běží |
| G-16 | **Informativní** | **opraveno** `0bffa178` | `replace()` ve vzorcích TSA ořízne až výsledek — mezivýsledek může mít miliony znaků (DoS jen autorem TSA nebo daty z HTTP) | `server/telephony/tsa/formula.ts:544-548` | Výsledek se skládá po kusech a skončí na `FORMULA_LIMITS.string` (`formula.ts:544`); 64 Ki shod × 16 000 znaků dřív stavělo gigabajtový řetězec. Test `tsa-formula` |
| G-17 | **Střední** | **opraveno** — web `4a7f5fce` (jiný agent), Android `9086ab31` | Čtení karty spuštěné modelem (`emv-read`, `eid-read`) vrací serveru PAN, data stopy 2 a všechny záznamy, u e-ID MRZ a fotografii — bez dialogu souhlasu; „zprávu" sestavuje server | `client/src/App.tsx:3751-3765` (bez dialogu); `client/src/lib/nfc/web-executor.ts:188-193`; `client/src/lib/functions.ts:103-109` | web: `client/src/lib/nfc/consent.ts`, `client/src/App.tsx:3787-3791`. Android: `A/nfc/ModelNfc.java:779` (`consent` — tytéž řádky jako web), `:855` (`masked`: bez pole `pan`, 5A / stopy maskované v elementech, záznamech, logu i přepisu — pravidla `TemplateViews` z G-19, 6 + 4 číslice; surová data s PAN se nepošlou; u dokladu bez řádků MRZ, volitelných údajů, fotografie, obrázků, DG11/12/13/16 a souborů, číslo dokladu maskované), `:850` (`declined`); `A/ui/parts/NfcModelSheet.java:416`, `:427` (list jmenuje model a vypíše, co odejde; „Poslat (zamaskované)“ je výchozí, „Poslat vše“ řekne, co přidá, „Neposílat“ i zavření listu = `denied`); test `ModelNfcConsentTest`, `android-security-610`. **Zbývá:** ověřit na skutečné kartě (§ 12.9) |
| G-18 | **Střední** | **opraveno** — web `4a7f5fce` (allowlist `READ_ONLY_COMMANDS` v `apdu-templates.ts`, kontrola v `templateProblems`, před každým pevným příkazem i u příkazů kroků čtečky, `raw-apdu` z modelu bez `allowWrites` jen čtení), Android `daa26cee` (`ApduTemplates.commandProblem`, `TemplateRunner`), pokračování `more` jen čtecí `0a08c4e2` | `raw-apdu` z modelu obchází `allowWrites` (VERIFY, GENERATE AC, UPDATE, DESFire FormatPICC); šablony 6.10 se deklarují „jen pro čtení", ale krok `{ apdu }` bere libovolný hex | `client/src/lib/nfc/web-executor.ts:205-210`, `:216`; `client/src/lib/nfc/apdu-templates.ts:18-19`, `:194-212` | allowlist CLA/INS (A4, B0, B2, CA, A8, C0, DESFire 60/AF/6A/6E/45) v `web-executor`, v `templateProblems` i v Androidu |
| G-19 | **Střední** | **opraveno** — web `4a7f5fce` (`pan-mask.ts`: PAN v BCD i ASCII-hex, data stopy 57 / 9F6B / 56 / 9F1F / 9F20, ve všech pohledech šablony i ve zprávě 6.6), Android `daa26cee` (`TemplateViews`) | „Maskovaná" zpráva o kartě maskuje PAN jen jako desítkový řetězec — v hex záznamech (tag 56 Track 1 v ASCII-hex) zůstane celý, i v příloze `emv-records.txt` a JSON | `client/src/lib/nfc/card-report.ts:141-145`, `:198-219` | maskovat i ASCII-hex podobu PAN; hodnoty 56/57/9F6B/9F1F redigovat bez `fullPan` |
| G-20 | **Vysoká** | **opraveno** `e3fefe00` | **Třída F-01 trvá:** akce designu s počítaným argumentem mají v rozsahu dešifrovaná data (`$msg`, od 6.8 `$log` se všemi místnostmi a `$composer.sealCode`). Kanály k serveru: `setting.set` na `notify.quietFrom={$msg.text}` → synchronizace `PUT /api/account/notify` za 1,5 s; počítaný `lib.run` / klíč nastavení skončí v logu, který vrací podepsaný příkaz `status`; `url.open` zobrazí jen 299 znaků a otevře celou adresu; `profile.public` | `A/core/Settings.java:131-158`; `A/push/NotifyPrefs.java:146-152`, `:161`, `:185`; `A/ui/Actions.java:197`; `A/push/Control.java:69-70`; `A/ui/DesignUrls.java:46-50` | `A/ui/ActionGuard.java:70` — surový argument jde z `Renderer` (`A/ui/Renderer.java:69`), menu, řádků se swipe i knihoven do `A/ui/Actions.java:43`; počítaný argument se odmítne u `lib.run`, `url.open`, `fn.run`, `profile.public` (výjimka: přesně uživatelské jméno osoby otevřené v aplikaci, `A/ui/parts/People.java:215`) a u klíče `setting.set` / `look.set` / `setting.toggle`; `A/core/SettingSchema.java:139` — pravidlo pro každý klíč (rozsahy, výčty, vzory; `notify.quietFrom` = `HH:MM`), kontroluje ho `Settings.set` i čtení (`A/core/Settings.java:124-125`, `:143`); log bez argumentů a hodnot (`Actions.java:42`, `:218`, `:237`; `Settings.java:141`; `A/ui/MainActivity.java:392`); `url.open` nad 300 znaků, s mezerou, řídicím nebo `\p{Cf}` znakem se odmítne místo zkrácení (`A/ui/DesignUrls.java:54`); testy `ActionGuardTest`, `SettingSchemaTest`, `DesignUrlsTest`. **Zbývá:** `share` / `copy` s počítaným textem (vždy přes uživatele — systémový výběr, schránka); hodnota v mezích pravidla nese nanejvýš pár bitů (jazyk, čas) a ty ze `notify.*` design nastavit nesmí (G-21) |
| G-21 | **Střední** | **opraveno** `e3fefe00` | `setting.set` / `toggle` z designu potichu zapne soukromé volby 6.8: `callLog` + `calls.logName=people` (jména místností a lidí do systémového záznamu hovorů), `conversations.names`, `notify.privacy`, `voice.engine=server` (+ trvalé „jako hlas" = každá zpráva na TTS serveru) | `A/core/Settings.java:49-51`, `:132-145`; `A/telecom/ConversationPlan.java:47-50`; `A/ui/parts/CallLogUi.java:242-246` | `A/core/SettingSchema.java:126` — `callLog`, `calls.*`, `conversations.*`, `notify.*`, `location.*`, `security.*`, `voice.engine` / `autoplay` / `dictateSend`, `nfc.emulate`, `nfc.keyDictionary`, potvrzení o doručení a přečtení, `people.contacts`: akce designu (`setting.set`, `setting.toggle`, krok knihovny, handler `change`) je nezmění (`A/ui/ActionGuard.java:94`); mění je jen klepnutí uživatele na vlastní přepínač / volbu toho nastavení; test `ActionGuardTest`, `SettingSchemaTest`. **Zbývá:** design může přepínač soukromé volby nakreslit s klamavým popiskem (klepnutí je uživatelovo) — nativní potvrzení neděláme |
| G-22 | **Střední** | **opraveno** `e3fefe00` | Oznámení zveřejněná před **automatickým** zámkem si nechají místnost, odesílatele i text; automatický zámek nevyvolá událost; `VISIBILITY_PRIVATE` při výchozím systémovém „zobrazit vše" ukáže na zamčené obrazovce plný obsah (komentáře v kódu tvrdí opak); widget konverzací drží poslední text | `A/telecom/Notify.java:147-159`; `A/telecom/CallRing.java:56-60`, `:88`; `A/security/AppLock.java:171-187` | `A/telecom/Notify.java:268` `neutralizeAll()` — každé oznámení zprávy, šablony serveru, vyzvánění a zmeškaného hovoru zveřejněné za odemčení (značka `:186`, `:232`; `A/telecom/CallRing.java:95`, `:119`) se znovu zveřejní jen s názvem aplikace a neutrálním textem, bez odpovědi a bez zvuku; volá ho `lockNow` (`A/M5.java:157`, `:166`), časovač / alarm automatického zámku, teď vždy po odchodu do pozadí (`A/telecom/Conversations.java:158`, `:170`), a start procesu (`M5.java:98`); komentáře o zamčené obrazovce opraveny. **Zbývá:** `VISIBILITY_SECRET` nezaveden; mezi uzamčením telefonu a automatickým zámkem aplikace ukáže zamčená obrazovka s „zobrazit vše“ obsah jako jiné messengery; widget konverzací neověřen na zařízení |
| G-23 | **Nízká–střední** | **opraveno** `e3fefe00` | Exportovaná aktivita věří extra `room` od libovolné aplikace (připojí místnost, kterou uživatel opustil); PendingIntent přímé odpovědi je `FLAG_MUTABLE` a extra `room` jde přepsat (posluchač oznámení pošle odpověď do jiné místnosti) | `A/ui/MainActivity.java:117-118`, `:238-243`; `A/telecom/Notify.java:120-121`; `A/push/ReplyReceiver.java:16-20` | `A/security/IntentSeal.java` — místnost oznámení a přímé odpovědi nese HMAC štítek klíčem procesu (`A/telecom/Notify.java:90`, `:135`); `A/ui/MainActivity.java:120` bere `room` jen se štítkem a jednou, `:245` otevře jen místnost, ve které aplikace je (nikdy nepřipojí); `A/telecom/ReplyReceiver.java:26` odmítne změněnou místnost; test `IntentSealTest`. **Zbývá:** oznámení z předchozího procesu po jeho ukončení otevře aplikaci, ne místnost |
| G-24 | **Nízká** | **opraveno** `e3fefe00` (výchozí `conversations.names` beze změny) | Drobnosti 6.8: neutralizace jmen zkratek má mezery (časovač jen `if (named)`, při rate-limitu zůstanou cached / pinned, alarm se po restartu ztratí, staré ikony s monogramem); výchozí `conversations.names = true`; oprava legacy záznamů nečistí `CACHED_*` sloupce; dialogy Záznamu bez `FLAG_SECURE`; seznam Záznamu v paměti po autozámku | `A/telecom/Conversations.java:155-163`, `:189`, `:286-301`; `A/telecom/CallLogBridge.java:173-177`; `A/ui/parts/CallLogUi.java:45`, `:82`, `:204-234` | `A/telecom/Conversations.java:251` (časovač i při jménech zveřejněných v pozadí), `:395` (rate-limit: cached pryč, pinned vypnuté do dalšího zveřejnění), `:383` (vyřazená zkratka: ikona aplikace a intent bez id), `:219` + manifest (`BOOT_COMPLETED`: jména zbylá před restartem neutrálně); `A/telecom/CallLogBridge.java:180`, `:200`, `:207` (sloupce `CACHED_*` a `geocoded_location` řádků aplikace prázdné, i řádků opravených v 6.8); `A/ui/parts/CallLogUi.java:214`, `:229`, `:244` (dialogy Záznamu přes `SecureDialog`), `:106` (seznam pryč i po autozámku); test `CallLogBridgeTest`. **Zbývá:** připnutá zkratka si při rate-limitu ponechá popisek (systém ho vypnuté nechá); výchozí `conversations.names = true` beze změny (jména jen při odemčené aplikaci) |

**G-01 podrobněji.** Webhook bez podpisu je u Telnyxu a Vonage možný, protože ověřovací materiál
je volitelný (`TELNYX_PUBLIC_KEY` je jiný údaj než API klíč; `VONAGE_SIGNATURE_SECRET` jiný než
klíč aplikace). Kapitola 11 to brala jako záměr, protože události jen plnily log. V 6.9 ale
`inbound()` předal každý takový webhook pravidlům a runtime TSA. Útok: `POST /wh/vonage/answer`
s vymyšleným `from` / `to` → odpověď NCCO obsahuje URL callbacku s tokenem hovoru a ID relace →
útočník posílá „DTMF" na `/wh/tel/<token>/tsa` a vede tok, kam chce. U Telnyxu stačí padělat
`call.initiated` a `call.gather.ended`. Twilio postižené nebylo: bez `TWILIO_AUTH_TOKEN` nefunguje
ani API, takže je ověření vždy vynucené. Oprava je fail-closed s jasnou výjimkou pro provozovatele.
Podepsané webhooky a tokeny callbacků (24 B, `tel-store.ts:20`) zůstávají beze změny.

**G-02 podrobněji.** Ověřeno skriptem i testem: na výchozím Express 5 se `GET /admin/telephony/LOG/x`
dostal k handleru záznamu logu a strážce vrátil „stačí modul". Stejná třída chyby postihovala každého
strážce, který rozhoduje podle `req.path`: Android (polohy jen s právem `devices`) a Functions (logy
webhooků s plnou IP jen s právem `webhooks`). Oprava je na jednom místě — přesné směrování
v obou službách. Všechny cesty v kódu jsou malými písmeny a klienti je tak volají (ověřeno grepem).

### 12.3 Co bylo ověřeno a je v pořádku

* **Callback TSA** má tři vrstvy: token hovoru 24 B (`tel-store.ts:20`), podpis poskytovatele
  (`engine.ts:649-653`) a vazbu na relaci (`calls.ts:379`, jiná relace → 404).
* **Jazyk vzorců:** vlastní tokenizer a parser, bez `eval` / `Function` a bez regulárních výrazů
  z vstupu. Přístup do objektů jen přes vlastní vlastnosti, `__proto__` / `constructor` / `prototype`
  jsou zakázané (`formula.ts:387-388`, `:456-477`). Limity délky, hloubky, uzlů a řetězců (`:53`).
  Výjimka je G-16.
* **Šablony a `{secret:NAME}`:** tajemství se dosazuje jen do hlaviček uzlu HTTP a jen z proměnné
  `TSA_SECRET_<NAME>` (`runtime.ts:757`; `template.ts:15`, `:51`), jinde je prázdné. URL uzlu HTTP
  vstupy kóduje (`runtime.ts:750`).
* **Nástroj HTTP** je bez povolených hostů vypnutý a přijímá jen `https:` (`runtime.ts:748-754`).
  Jde přes SSRF guard s připnutou adresou a přesměrování odmítá (`deps.ts:111-114` →
  `functions/host-net.ts`). Přihlašovací údaje k nahrávkám dostanou jen hosté poskytovatele
  (`deps.ts:43-56`).
* **Soubory pod `/wh/tsa/`:** ID souboru je 96 bitů s regexem a pevnou příponou, bez path traversal,
  soubory 0600 (`files.ts:18`, `:61-72`). TTS audio má token 18 B a platnost 2 h (`runtime.ts:828-831`);
  `nosniff` (`media.ts:31-32`).
* **Redakce logu:** hlavičky, podpisy, tokeny, hesla, JWT, `user:pass@` v SIP URI a capability
  `/wh/tel/<token>` se odstraní (`log.ts:28-46`). Heslo trunku v logu chybí (klíč `password`),
  API ho nevrací (`control/routes.ts:106-107`). Heslo testovací SIP adresy se ukáže jednou a neuloží se
  (`sip-address.ts:18`, `:193`). Neúplné maskování kódů je v G-07.
* **Placené testy** (hovor, SMS, SIP adresa) vyžadují právo `test` (`api-contract.ts:55-63`).
  Route kódy se losují přes `crypto.randomInt` a triviální kódy se vynechávají (`inroute.ts:186-190`).
  Těla webhooků: JSON 256 kB, formulář 100 kB (`index.ts:141-155`).
* **Konzole:** v `telephony-console.js` ani `tsa-editor.js` není `innerHTML`, `eval` ani řetězcový
  `setTimeout`. Syrové payloady se zobrazují jako text. CSP je stejné jako v 6.7
  (`server/admin.ts`, `script-src 'self'`).
* **Web:** karta telefonního hovoru otevře mikrofon až po kliknutí. Rámce `phone-bridge` od člena
  podvrhnout nejde, hub je přebalí jako `signal` (`server/signaling/hub.ts:853-861`). Oprava velkých
  souborů z 6.8 drží: prázdný výběr se odmítne a relay se nepoužije (`file-transfer.ts:219-227`, `:225`).
  Výjimky z obecného limitu API mají vlastní limitery (`api-limit.ts:46-61`, `index.ts:101-133`).
* **Android 6.8:**
  * Zálohy jsou vypnuté a cleartext zakázaný; exportované komponenty jsou chráněné oprávněním nebo
    nečinné, `M5ConnectionService` odmítne každé spojení.
  * Všechny PendingIntenty jsou `FLAG_IMMUTABLE` kromě tří nutných explicitních. Připojit se z
    oznámení jde jen s tokenem procesu (`A/telecom/CallRing.java:48`).
  * ID zkratek jsou HMAC klíčem instalace (`ConversationPlan.java:86-88`). Cíl sdílení přijme jen
    `text/plain` a text vloží, neodešle.
  * Záznam hovorů je bez čísla a s výchozím jménem „M5cet" (`CallLogBridge.java:140-142`).
  * Žádný nový WebView a žádné logování jmen místností v nových třídách.
  * Kostra designu 6.10 je prázdná (`server/android/design-610-chat.ts:11`).

### 12.4 Otevřené nálezy z 6.7 v 6.10

| ID | Stav 6.10 | Doklad | Poznámka |
|---|---|---|---|
| F-01 | **částečně → lépe** | viz G-20 (`e3fefe00`) | obrázky jsou ošetřené; akce s počítaným argumentem, které by data vynesly (`url.open`, `lib.run`, `fn.run`, `profile.public`, klíč nastavení), aplikace odmítne a hodnoty nastavení drží pravidla; zbývá `share` / `copy` (přes uživatele) a obcházitelná serverová kontrola výrazu |
| F-02 | otevřené | `client/src/lib/integrity.ts:7-15`, `:49` (manifest od téhož serveru) | beze změny |
| F-03 | **částečně** (drobný posun) | `server/functions/sandbox/pool.ts:113-116` (`--permission` / `--experimental-permission` podle verze Node) | `_module` Pyodide dál není v `NEUTERED` (`engine-py.ts:31`); bez bwrap / jiného uživatele. TSA nástroj Function spouští modely i pro anonymního volajícího (`tsa/deps.ts:116-133`) — sandbox je teď dosažitelný z telefonní linky |
| F-04 | **částečně** | `client/src/lib/passphrase-strength.ts:152`, `client/src/components/RoomDialog.tsx:156`; `server/monitor/traffic.ts:120-123` | beze změny; G-03 omezilo, kdo v konzoli vidí slepá ID |
| F-06 | otevřené | `client/src/lib/sender-keys.ts`, `client/src/lib/identity.ts` beze změny od `28f10ad0` | žádné PCS ani PQ; mezitím je PQ ratchet u Signalu (SPQR) i iMessage (PQ3) — odstup se zvětšil |
| F-09 | otevřené | `client/src/App.tsx:3563` (jedna obálka klíčem místnosti), `server/accounts/mailqueue.ts:77` | G-10 opravilo únik přes outbox, ne podstatu |
| F-13 | otevřené | `client/src/App.tsx:1628-1638` (nový pin = „verified") | beze změny |
| F-15 | otevřené (rozšířeno) | `client/src/lib/rtc.ts:7-8` | k tomu telefonie: čísla volajících, časy a délky hovorů, přepisy v `telephony.db` (G-07); číslo volajícího vidí všichni na hubu (G-09) |
| F-17 | **částečně → lépe** | G-01 (opraveno), G-08 (opraveno `0bffa178`) | nepodepsaný webhook už nic nespustí; kopie podepsaného webhooku Telnyx / Vonage se v okně nezpracuje (Twilio podpis čas neváže — bez klíče) |
| F-18 | otevřené (rozšířeno) | `server/functions/store.ts:173-180` (obyčejný SQLite) | k tomu `telephony.db` (G-07); NFC data jdou na server jen se souhlasem, výchozí zamaskovaná (G-17 opraveno) |
| F-29 | otevřené | `.github/workflows/ci.yml:55` (`npm ci --no-audit`) | žádný nezávislý audit; kap. 11 i 12 jsou revize kódu s pomocí AI |

### 12.5 Hodnocení po oblastech (6.10)

Stupnice stejná jako v kap. 1 (10 = dnešní Signal v dané oblasti).

| Oblast | 6.7 | **6.10** | Proč |
|---|---:|---:|---|
| Šifrování živých zpráv (P2P) | 7 | **7** | beze změny |
| Zprávy přes server, soubory, offline doručení | 4 | **4** | únik přes outbox opraven (G-10), velké soubory jen vybraným (6.8), výběr příjemců platí na všech cestách (G-12, druhé kolo); schránka pod klíčem místnosti (F-09) trvá |
| Správa klíčů a odvozování | 6 | **6** | beze změny; slepá ID už nevidí čtenáři konzole (G-03) |
| Identita a ověřování | 3 | **3** | beze změny (F-13) |
| Dopředná utajenost, PCS, post-kvantová ochrana | 3 | **3** | beze změny; ostatní mezitím přidali PQ ratchet |
| Ochrana metadat | 3 | **3** | telefonie (opt-in) ukládá čísla, časy a přepisy (G-07, G-09) |
| Webový klient | 6 | **6** | opravy G-10, G-11 a ve druhém kole G-12 – G-14 (výběr příjemců všude, volby zprávy se neztrácí tiše, plaintext pro řeč serveru se oznámí); kód dál doručuje server (F-02) |
| Aplikace pro Android | 6 | **6** | před opravami 5: třída F-01 byla zneužitelná po jednom klepnutí, nově s `$log` (G-20); soukromé volby 6.8 šly přepnout designem (G-21); oznámení po autozámku (G-22). Opraveno v `e3fefe00` (G-20 až G-24) a `9086ab31` (souhlas s daty karty, G-17); zbývá `share` / `copy` s počítaným textem, pepř PINu bez hardwarového limitu, ověření na zařízení |
| Server a provoz | 5 | **5** | telefonie 6.9 přinesla tři vysoké nálezy (G-01, G-02, G-04 — bez nich by to byla 4), opravené; ve druhém kole i hádání route kódů, toll fraud v TSA a přehrání webhooků (G-05, G-06, G-08); zbývá nešifrované `telephony.db` / `functions.db` a sandbox bez izolace (G-07, F-03, F-18) |
| Ověřitelnost (audity, formální důkazy, reprodukovatelné buildy) | 1 | **1** | beze změny (F-29) |
| **Celkově** | **≈ 4,5** | **≈ 4,5** | opravené chyby vyvažuje nová plocha útoku; návrhové mezery z kap. 1 trvají |

**Verdikt 6.10.** Bezpečnost M5cet se od 6.7 v podstatě nezměnila. Jádro (Argon2id, HKDF, AEAD,
podepsané hello, sender keys) je dobré. Celek drží dole návrh: web doručuje server (F-02), kořenem
důvěry je sdílené heslo (F-04), chybí PCS a PQ (F-06), schránka je pod klíčem místnosti (F-09),
identita je TOFU podle jména (F-13), metadata jsou na serveru (F-15) a nikdo nezávislý kód
neauditoval (F-29).

Verze 6.8–6.10 přidaly hodně funkcí. Telefonie je z definice mimo E2EE a řídí ji kdokoli, kdo zavolá.
Nejzávažnější nové chyby byly v řízení přístupu a v ověřování vstupů, ne v kryptografii; ty
v serveru a na webu jsou opravené, na Androidu také (G-17, G-20 až G-24: `e3fefe00`, `9086ab31`); G-18
a G-19 jsou opravené na obou platformách (`4a7f5fce`, `daa26cee`).
Pro firemní nasazení s telefonií doporučujeme:
* nastavit `TELNYX_PUBLIC_KEY` / `VONAGE_SIGNATURE_SECRET`,
* napsat pravidlo modulu Telephony & SIP,
* omezit `countries` (TSA je od druhého kola s prázdným seznamem omezená na vlastní země sama;
  funkce a aplikace ne),
* dávat route kódy 6místné s krátkou platností (nad 10 min to server od druhého kola vynucuje).

### 12.6 Srovnání s komerčními messengery (stav k 10/2026)

Údaje o ostatních aplikacích jsou z veřejných zdrojů: [1]–[41] z § 6.3 a nové [42]–[53] v § 12.8.
„Neověřeno" znamená, že tvrzení nemá primární zdroj nebo se mohlo od data zdroje změnit. Telegram
má dva režimy, proto ho tabulka uvádí jednou.

| Vlastnost | **M5cet 6.10** | Signal | Threema | WhatsApp | iMessage | Telegram (výchozí chaty / tajné chaty) | Wire | Element / Matrix | Session |
|---|---|---|---|---|---|---|---|---|---|
| E2EE ve výchozím stavu | chat, soubory, hovory P2P ano; **mimo E2EE**: Functions, AI, řeč, telefonie (opt-in, na serveru) | vše [1] | vše [10] | chaty a hovory [16] | iMessage ano; SMS / RCS záloha ne; zálohy iCloud bez ADP s klíčem u Applu [45][46] | **ne** — cloudové chaty a skupiny čte server; tajné chaty jen 1:1, opt-in, jedno zařízení [48][49]; hovory a skupinové hovory E2EE [48] | vše (MLS) [21] | soukromé místnosti a DM [25] | 1:1 a skupiny [32] |
| Protokol (FS / PCS / PQ) | vlastní; FS částečně (hash ratchet), **PCS ne, PQ ne** | PQXDH + Triple Ratchet (SPQR): FS, PCS i PQ [2][3] | Ibex FS; PQ plán [11][12] | Signal Protocol FS + PCS (1:1); PQ nedokumentováno [16] | PQ3: ML-KEM + ECDH, ratchet s PQ rekeyingem — FS, PCS, PQ; formálně analyzováno [42][43] | výchozí: MTProto 2.0 klient–server, bez E2EE; tajné: DH + rekey po 100 zprávách / týdnu (FS), PQ neohlášeno (neověřeno) [49] | Proteus / MLS: FS + PCS; PQ plán [21][22] | Olm FS + PCS, Megolm jen FS [27] | bez FS (v1); V2 plán [34] |
| Ověření identity | TOFU podle **jména**, bezpečnostní čísla + QR; bez transparentnosti | čísla + QR, key transparency [7] | 3 úrovně, QR [10] | QR + AKD [19] | volitelné Contact Key Verification (key transparency) [44] | tajné chaty: obrázek / emoji klíče; výchozí chaty nemají co ověřovat | otisky, X.509 (MLS) [21] | cross-signing [25] | Account ID = klíč |
| Metadata | server zná jména, členství, účty, časy; peery vidí IP; telefonie ukládá čísla a přepisy | sealed sender, minimum dat [4][5] | minimum [13] | sbírá metadata [17] | Apple vidí vyhledávání klíčů a směrování (IDS) [45]; rozsah vydávaných dat neověřen | server drží obsah cloudových chatů, kontakty a telefonní číslo; od 09/2024 vydá IP a číslo na soudní příkaz [52] | neověřeno | homeserver drží historii a metadata [29] | onion routing [32] |
| Telefonní číslo | **ne** | volitelné (beta) [6] | ne [13] | ano [18] | Apple ID nebo číslo | **ano** (pro registraci) [48] | ne | ne | ne |
| Důvěra v server / vlastní hosting | **jen vlastní server**; provozovatel je pro obsah důvěryhodný (F-02; design Androidu po opravě G-20 omezen) | centrální, kód serveru veřejný | centrální; OnPrem [14] | centrální, uzavřený | centrální, uzavřený | centrální, server uzavřený | centrální; on-prem, federace [21] | vlastní homeserver, federace | síť uzlů [37] |
| Audity / formální analýza | **žádné** (jen revize s AI) | formální analýzy PQXDH a SPQR [3][9] | audity, formální důkaz Ibex [11][15] | NCC [19][20] | formální analýzy PQ3 (Tamarin; redukční důkaz) [42][43] | akademické útoky a důkaz pro MTProto 2.0 (2022) [51] | Kudelski / X41 [23] | Least Authority; nálezy 2023 [30][31] | Quarkslab 2021 [36] |
| Reprodukovatelné buildy / ověřitelné doručení kódu | **ne**; web doručuje server | Android [8] | Android experimentálně [14] | ne | ne (uzavřený kód) | klienti open source, reprodukovatelné buildy iOS / Android deklarované [50] | backend [21] | nedeklaruje | nenalezeno |
| Bezpečnost platformy | Android: Keystore, PIN se zámkem a wipe, `FLAG_SECURE`; web v prohlížeči; design podepsaný serverem dešifrovaná data už nevynese (G-20, `e3fefe00`), dál ale kreslí celé UI | podepsané aplikace z obchodů | podepsané aplikace | podepsané aplikace | BlastDoor, Lockdown Mode [47]; v minulosti zero-click řetězce (FORCEDENTRY 2021 [53]) | podepsané aplikace | podepsané aplikace | podepsané aplikace | podepsané aplikace |
| Přídavná plocha útoku na serveru | **velká:** Functions (sandbox bez izolace procesu, F-03), telefonie (webhooky, TSA, route kódy, zvuk do místnosti), AI a řeč, NFC, MDM Androidu | minimální (bez serverové logiky nad obsahem) | minimální | ochrana proti spamu, Meta AI (opt-in, neověřeno) | Apple Intelligence (zařízení / Private Cloud Compute — neověřeno do detailu) | boti, mini aplikace, cloudové chaty | integrace (firemní) | boti a bridge na homeserveru | minimální |

**Rozbor.**

* **Kde je M5cet slabší:**
  * **Protokol.** Signal, WhatsApp, iMessage a Wire mají PCS. Signal a iMessage mají i
    post-kvantovou ochranu v ratchetu. M5cet nemá ani jedno.
  * **Model důvěry k provozovateli.** U komerčních aplikací musí zlý provozovatel podvrhnout
    podepsanou aplikaci v obchodě. U M5cet stačí změnit web (F-02); podepsaný design Androidu
    po opravě G-20 dešifrovaná data nevynese, ale dál kreslí celé UI (klamavé popisky).
  * **Identita.** Signal, WhatsApp a iMessage mají transparentní logy klíčů. M5cet má TOFU podle
    jména.
  * **Ověřitelnost.** Ostatní mají audity nebo formální analýzy. Chyby se tam hledají i našly díky
    nezávislým očím [15][31][51]. M5cet nemá nic z toho.
  * **Plocha útoku na serveru.** Functions, telefonie, AI a NFC jsou pro firmu užitečné. Server ale
    zpracovává plaintext a telefonie je řízená kýmkoli, kdo zavolá. Signal ani Threema nic
    podobného nemají.
* **Kde je srovnatelný:**
  * Symetrická kryptografie a formát zpráv, neutrální push, passkey s PRF jako kořen trezoru.
  * Skupinové šifrování živých zpráv je na úrovni sender keys (stejné omezení PCS ve skupinách
    mají i Signal a WhatsApp, viz § 6.2).
* **Proti Telegramu** je M5cet v ochraně obsahu **silnější**. Výchozí chaty i skupiny Telegramu jsou
  pro server čitelné; tajné chaty jsou jen 1:1 a opt-in. M5cet šifruje živé zprávy vždy a ve
  skupinách. Telegram má ale veřejně analyzovaný protokol [51] a reprodukovatelné buildy klientů [50].
* **Kde se liší záměrně:**
  * Bez telefonního čísla a jen na vlastním serveru — žádný centrální provozovatel ani jurisdikce
    vývojáře. Celá důvěra se tím ale přesouvá na provozovatele instance.
  * Telefonie a Functions jsou vědomě mimo E2EE. Je správně, že to README a UI říkají (F-31).

### 12.7 Doporučení (pořadí)

1. **Hned (Android) — hotovo v `e3fefe00`:**
   * G-20: počítaný argument u síťových akcí zakázat, `setting.set` validovat podle klíče a nelogovat
     hodnoty.
   * G-21: privacy klíče mimo dosah designu.
   * G-22: neutralizovat oznámení při zámku.
   * Zbývá: ověřit G-22 a G-24 na zařízení (zamčená obrazovka, widget konverzací, restart).
2. **Hned (provoz):** nastavit podpisové klíče webhooků, pravidlo modulu Telephony & SIP a `countries`.
   Route kódy dávat jen 6místné s krátkým TTL. Po G-01 / G-04 bez toho telefonie nepůjde nebo
   bude odmítat — to je záměr.
3. **Krátkodobě (server):**
   * ~~G-05: globální limit chybných kódů~~ — hotovo `0bffa178` (DID, modul, pauzy, ukončení hovoru).
   * ~~G-06: Dial přes `planOutbound` a `timeLimit`~~ — hotovo `0bffa178` (SMS i Dial jako `tsa:<id>`,
     vlastní země; potvrzení SMS na volajícího nahradilo omezení na vlastní země a varování při `*`).
   * G-07: šifrovat `telephony.db`, výchozí `keepRaw` vypnout, maskovat DTMF.
   * ~~G-08: cache `jti` / id událostí~~ — hotovo `0bffa178` (Twilio bez klíče).
4. **Krátkodobě (web, NFC):**
   * ~~G-12 až G-14~~ — hotovo `7210cdc8`; G-15, G-16 hotovo `0bffa178`.
   * ~~G-17 až G-19~~ — hotovo: souhlas s odesláním dat karty (web `4a7f5fce`, Android `9086ab31`), allowlist APDU a úplné maskování PAN (web `4a7f5fce`, Android `daa26cee`).
5. **Střednědobě a dlouhodobě (návrh):** beze změny proti kap. 8 — PCS a PQ (libsignal / MLS),
   ověřitelné doručení webu, identita vázaná na klíč s transparentností, šifrovaná schránka pro
   příjemce, nezávislý audit.

### 12.8 Zdroje (doplněk k § 6.3)

42. Apple Security Research — iMessage with PQ3: The new state of the art in quantum-secure messaging at scale (2024-02-21), <https://security.apple.com/blog/imessage-pq3/>
43. Linker, Sasse, Basin — A Formal Analysis of Apple's iMessage PQ3 Protocol (IACR ePrint 2024/1395), <https://eprint.iacr.org/2024/1395>; technická zpráva u Applu, <https://security.apple.com/assets/files/A_Formal_Analysis_of_the_iMessage_PQ3_Messaging_Protocol_Basin_et_al.pdf>
44. Apple Security Research — Advancing iMessage security: iMessage Contact Key Verification (2023-10-27), <https://security.apple.com/blog/imessage-contact-key-verification/>
45. Apple Platform Security Guide, <https://support.apple.com/guide/security/welcome/web>
46. Apple — Advanced Data Protection for iCloud, <https://support.apple.com/en-us/102651>
47. Apple — About Lockdown Mode, <https://support.apple.com/en-us/105120>
48. Telegram FAQ (cloudové a tajné chaty, hovory, registrace), <https://telegram.org/faq>
49. Telegram — MTProto, <https://core.telegram.org/mtproto>; end-to-end šifrování tajných chatů, <https://core.telegram.org/api/end-to-end>; dopředná utajenost tajných chatů, <https://core.telegram.org/api/end-to-end/pfs>
50. Telegram — reproducible builds, <https://core.telegram.org/reproducible-builds>
51. Albrecht, Mareková, Paterson, Stepanovs — Four Attacks and a Proof for Telegram, IEEE S&P 2022, <https://mtpsym.github.io/>
52. The Hacker News — Telegram Agrees to Share User Data With Authorities for Criminal Investigations (2024-09), <https://thehackernews.com/2024/09/telegram-agrees-to-share-user-data-with.html>; zásady soukromí Telegramu, <https://telegram.org/privacy>
53. Citizen Lab — FORCEDENTRY: NSO Group iMessage Zero-Click Exploit Captured in the Wild (2021-09-13), <https://citizenlab.ca/2021/09/forcedentry-nso-group-imessage-zero-click-exploit-captured-in-the-wild/>

### 12.9 Co nebylo ověřeno

* **Nic z telefonie neběželo proti skutečnému poskytovateli.** Útok G-01 je odvozený z kódu a
  ověřený testem s podvrženými API; G-05 / G-06 jsou odvozené z kódu. Opravy druhého kola
  (G-05, G-06, G-08) ověřují testy s napodobenými poskytovateli. Neověřeno: že Twilio `<Dial
  timeLimit>`, Vonage `connect.limit` a Telnyx `transfer.time_limit_secs` přepojený hovor opravdu
  ukončí; že každý podepsaný webhook Vonage nese vlastní `jti` (podle dokumentace; bez něj se klíčuje
  celý token) a že Telnyx posílá opakované doručení se stejným `data.id`.
* Opravy druhého kola mění chování (`docs/deployment.md` › Přechod na 6.10): TSA s prázdnými
  `countries` volá a píše jen do vlastních zemí; Dial TSA podléhá odchozím pravidlům i při „Route
  through: app / trunk"; route kód nad 10 min má 6 číslic a triviální zvolený kód se odmítne;
  třetí špatný kód ukončí hovor; doslovné tajemství v hlavičce HTTP zablokuje publikování TSA.
* **Android (G-20 až G-24) a NFC (G-17 až G-19) jsou revize kódu bez zařízení a bez karty.** Opravy
  G-17 a G-20 až G-24 na Androidu ověřují JVM testy (590, `testDebugUnitTest`), sestavení a lint, ne
  telefon. Neověřeno:
  * chování zamčené obrazovky na Fold6 (G-22) — přepsání oznámení při autozámku a po startu procesu,
    widget konverzací,
  * zkratky po restartu telefonu a při rate-limitu (G-24),
  * dialog souhlasu s daty karty se skutečnou kartou a modelem (G-17),
  * výskyt tagu 56 na skutečných kartách (G-19),
  * zda zálohy záznamu hovorů v telefonu nesou jména (G-21).
* Opravy G-01 / G-04 mění chování. Nasazení s Telnyx / Vonage bez podpisových klíčů nebo bez
  pravidla modulu přestanou směrovat příchozí hovory, resp. volat z webu, dokud provozovatel
  nastaví klíče, pravidlo nebo `TELEPHONY_ALLOW_UNSIGNED=1`. Dokumentaci nasazení
  (`docs/telephony.md`, CHANGELOG 6.10) je třeba doplnit.
* Údaje o iMessage a Telegramu jsou z veřejných zdrojů k datu jejich vydání. Post-kvantový stav
  Telegramu, rozsah metadat u Applu a serverové AI funkce WhatsAppu a Applu jsou **neověřené**.

*Kapitola 12 vznikla stejně jako zbytek analýzy — revizí kódu s pomocí AI (Claude). Nenahrazuje nezávislý audit.*
