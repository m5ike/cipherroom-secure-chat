# M5cet — bezpečnostní model

> **Od 3.1.0** platí šifrování v3: Argon2id (64 MiB) ve Web Workeru, slepé ID místnosti (server
> nezná název), živé zprávy pod klíči odesílatelů s ratchetem (forward secrecy, vyloučení člena),
> soukromé zprávy pod párovými klíči (ECDH), identita zařízení potvrzená účtem (Ed25519),
> bezpečnostní čísla s QR a E2EE rámců hovoru — viz
> [dokumentace › Šifrování v3](site/index.html#sifrovani-v3) a [› Soubory, relay a hovory](site/index.html#prenosy).
> **Od 3.0.0** platí šifrování v2 (klíče podle účelu z PBKDF2 600 000 + HKDF, associated data,
> zapečetěná signalizace, podpisy ECDSA uvnitř šifrování, ověřené soubory) — viz
> [dokumentace 3.0 › Šifrování](site/index.html#sifrovani) a [› Bezpečnost serveru](site/index.html#bezpecnost).

Tento dokument popisuje, **co M5cet chrání, jak to chrání, a co naopak
chránit nemůže**. Je psán pro ty, kdo M5cet nasazují nebo auditují.

## TL;DR

- Server vidí signalizační rámce (SDP/ICE) a (volitelně) opaque metadata.
  **Nikdy** plaintext ani klíč. Chatové zprávy přes server nejdou vůbec (ani
  jako ciphertext). **Výjimky:** soubory v *proxy* režimu posílají přes `/ws`
  IV a ciphertext chunků (viz „Známé mezery") a zprávy pro účastníka ve stavu
  **away** (viz níže) — v obou případech jen ciphertext klíčem místnosti,
  který server nemá.
- Šifrování: AES-GCM 256, IV 12 B per frame, klíč PBKDF2-SHA256
  (250 000 iter), salt obsahuje `room id`. Klíč je `extractable: false`.
- WebRTC media: standardní DTLS-SRTP, řešený prohlížečem.
- Admin příkazy jsou **whitelisted** a **token-protected**. Cokoli mimo
  allowlist je shozeno na úrovni serveru.
- Klíč místnosti se sdílí **out-of-band**.

## Aktiva (assets)

| ID | Aktivum                          | Kde žije                                 |
|----|----------------------------------|------------------------------------------|
| A1 | Plaintext zpráv / souborů        | RAM prohlížeče A i B                      |
| A2 | Klíč místnosti (room key)        | Web Crypto subtle, non-extractable        |
| A3 | Passphrase                       | UI vstup → použito k odvození A2          |
| A4 | Audio/video stream               | RAM, DTLS-SRTP wire                       |
| A5 | Server metadata (LOG_EVENTS)     | Backend (in-memory ring nebo SQLite)      |
| A6 | Admin token                      | Operátor / `.env`                         |

## Adversáři

1. **Pasivní síťový odposlech** (MITM) — vidí WSS handshake, DTLS handshake.
   Všechno užitečné je za TLS / DTLS.
2. **Aktivní MITM** — bez TLS by mohl podstrčit jiný server. Proto je
   produkce vždy za HTTPS / WSS s ověřeným certifikátem (`install.sh
   --enable-tls`).
3. **Compromised server** — i kdyby byl server kompromitovaný, nikdy nezíská
   plaintext: klíč nikdy neopustí prohlížeč.
4. **Compromised endpoint** — pokud útočník ovládá prohlížeč jednoho z
   účastníků, je hra u konce. Žádné kryptografické řešení tomu nezabrání.
5. **Phishing / sdílení klíče přes nezabezpečený kanál** — uživatelé musí
   passphrase sdílet out-of-band (Signal, papír, ústně).
6. **Malicious browser extension** — extension v page contextu může číst DOM,
   přečíst plaintext **před** zašifrováním. Web Crypto `extractable: false`
   pomáhá proti exportu klíče, ale ne proti pre-encrypt sniffingu.

## Garance, které dáváme

- **Confidentiality zpráv mezi účastníky** vůči serveru a síti — ano.
- **Integrity zpráv** přes GCM tag — ano. Tampering = `OperationError`.
- **Authenticity účastníka** — pouze v rozsahu *"druhá strana zná klíč"*.
  Pokud passphrase znají třetí strany, autenticita je narušena. Není zde
  certifikační infrastruktura.
- **Forward secrecy** — částečně: nový klíč pokaždé, když je rotován room
  passphrase. WebRTC DTLS handshake přidává PFS pro media. WebSocket TLS PFS
  závisí na konfiguraci serveru / Nginx.

## Co negarantujeme

- **Anonymitu vůči serveru** — server vidí IP a (pokud `LOG_EVENTS=1`) opaque
  ID. Pokud chce uživatel anonymitu, musí přijít přes Tor / VPN.
- **Skrytí faktu komunikace** — server ví, že někdo komunikoval, kdy a s
  kým (po IP). Nezašifrujeme metadata transport vrstvy.
- **Trvalý záznam zpráv** — žádný se neukládá. Pokud uživatel chce historii,
  musí si ji exportovat do svého úložiště.
- **Ochranu proti compromised endpoint** — viz výše. Toto je hard limit
  prohlížečové crypto.

## Crypto detaily

### Odvození klíče
```
material  = PBKDF2( passphrase, salt = "CipherRoom:v1:" || roomId,
                    iter = 250 000, hash = SHA-256 )
roomKey   = HKDF? — ne, přímo derive AES-GCM 256 z material via deriveKey
```

Salt prefix `CipherRoom:v1:` je součástí formátu klíče. Změna prefixu = breaking
migrace; verzujeme `v2:` atd.

### Envelope formát
```json
{
  "iv": "<base64 12 B>",
  "ciphertext": "<base64 ciphertext + 16 B GCM tag>"
}
```

IV se generuje `crypto.getRandomValues`. **Nikdy** ho necachujeme. Reuse IV se
stejným klíčem GCM by leak nonce-aliasing odhalil plaintext rozdíly.

### WebRTC media
DTLS-SRTP. Klíče se vyjednávají v rámci DTLS handshake při setup
RTCPeerConnection. M5cet do toho nezasahuje — používá standardní browser API.

## Admin příkazy

Allowlist v [`server/routes-admin-shared.ts`](../server/routes-admin-shared.ts):

```ts
ADMIN_COMMAND_ALLOWLIST = [
  "refresh-settings",
  "reconnect",
  "purge-local",
  "show-notification",
  "run-diagnostic",
  "download-file-from-admin",
];
```

Bezpečnostní vlastnosti:

- Bez `ADMIN_API_TOKEN` admin proces vrací `503` na všechno kromě
  `/admin/health`.
- Příkaz mimo allowlist: HTTP 400 a žádný přepis na queue.
- `download-file-from-admin` na klientovi **vyžaduje user gesture**.
  V `client/src/lib/admin-commands.ts` se nikdy nevolá automatický download.
- Audit log (`/admin/commands/audit`) je read-only.
- Žádný `exec`, žádný shell, žádný eval — neexistuje cesta k arbitrary remote
  code execution.

## Header hardening

| Header                       | Hodnota                                    |
|------------------------------|--------------------------------------------|
| Cache-Control                | `no-store, no-cache, must-revalidate, ...` |
| X-Content-Type-Options       | `nosniff`                                  |
| Referrer-Policy              | `no-referrer`                              |
| Permissions-Policy           | `camera=(self), microphone=(self), geolocation=(self), interest-cohort=()` |
| X-Robots-Tag (Nginx)         | `noindex, nofollow`                        |

`Permissions-Policy` povoluje kameru, mikrofon a polohu **jen vlastnímu
originu** (`self`); jakýkoli vložený cizí iframe je má zakázané. Prohlížeč
se uživatele dál ptá při každém prvním použití.

> Do verze 2.4.x zde bylo `camera=()` atd. Prázdný allowlist ale funkci
> zakazuje i samotnému dokumentu a user gesture to nepřebije — `getUserMedia`
> a geolokace selhaly bez dotazu (ověřeno: `document.featurePolicy
> .allowsFeature("camera") === false`). Hovory, STT a sdílení polohy proto
> při servírování tímto serverem nefungovaly. Opraveno ve 2.5.0.

## Doporučení pro nasazení

1. **Vždy HTTPS / WSS** v produkci. `install.sh --enable-tls`.
2. **Silný `ADMIN_API_TOKEN`** (≥32 B random). Nikdy v gitu.
3. **`ADMIN_PORT` na private síti** nebo za reverse proxy s IP allowlistem.
4. **`LOG_EVENTS=0`** dokud kompliance opravdu nevyžaduje opak.
5. **`DATABASE_URL`** mít na šifrovaném disku (full-disk encryption).
6. **Aktualizovat OS i Docker base image** — viz `Dockerfile` (`node:24-slim`,
   runtime běží jako `USER node` a neobsahuje `node_modules`).
   `.env` je v `.dockerignore`: tajemství (`ADMIN_API_TOKEN`, VAPID privátní
   klíč, TURN údaje) nesmí skončit ve vrstvě image — předávejte je prostředím.
7. **Reverse proxy timeout** dimenzovat na delší WebSocket session
   (`proxy_read_timeout 3600s` v Nginx — viz `install.sh`).

## Relace a pozvánky (od 2.7.0)

Podrobně v [`session-and-sharing.md`](session-and-sharing.md). Pro model hrozeb
je podstatné:

- **A3 (passphrase) se nově ukládá** — šifrovaně (AES-GCM, neexportovatelný
  klíč v IndexedDB), jen v `sessionStorage` dané karty a nejdéle hodinu bez
  aktivity. Proti adversářům 4 a 6 (kompromitovaný endpoint, rozšíření) to
  nechrání o nic víc než zbytek aplikace.
- **Pozvánky**: klíč k datům je `HKDF(klíč z fragmentu URL ‖ klíč na serveru ‖
  PBKDF2(12místný kód))`. Server sám data nerozšifruje; držitel odkazu má na
  kód 5 pokusů. Odkaz a kód se mají posílat různými kanály.
- **„Smazat vše a odejít"** odstraní úložiště, cookies (přes `Clear-Site-Data`
  i HttpOnly), cache a service worker. **Historii prohlížeče smazat nelze.**

## Účty s passkey a stav away (od 2.9.0)

Podrobně v [`accounts-away.md`](accounts-away.md). Pro model hrozeb:

- **Ověření identity.** Server kontroluje podpis WebAuthn nad vlastní
  jednorázovou výzvou (2 min), rpId hash, origin, user presence + user
  verification a čítač podpisů (klesající = klonovaný autentikátor →
  odmítnuto). Token relace je náhodných 32 B, uložený jen jako SHA-256 otisk
  v paměti procesu; restart odhlásí všechny.
- **Nová aktiva na serveru**: trezor (profil + historie chatu) a schránka
  zpráv. Obojí je **ciphertext** — trezor zapečetěný klíčem z PRF rozšíření
  passkeye (HKDF → AES-GCM), schránka klíčem místnosti. Server zná metadata:
  velikosti, počty, jména v místnosti, časy, zkrácenou IP (/24, /48) a třídu
  prohlížeče u přihlášení.
- **Nové riziko ztráty dat.** Kdo přijde o passkey, přijde o trezor — server
  ho odemknout neumí a záložní cesta neexistuje. Vědomá výměna.
- **Away relay** znamená, že ciphertext zpráv pro nepřítomného účastníka
  **projde serverem a leží tam** (výchozí 30 dní, `RELAY_RETENTION_DAYS`,
  500 položek / 4 MB na účet). Adversář se serverovým přístupem tedy vidí
  objem a metadata komunikace i zpětně — u přímého P2P to neplatilo. Volba
  je per-uživatel a vypnutá, dokud si nezvolí *data na serveru*.
- **Kdo smí poslat do schránky**: kdokoli v téže místnosti (jméno místnosti
  je jediná vstupenka — stejně jako u signalizace). Zprávy, které nesedí na
  klíč místnosti, klient zahodí; limity schránky a 120 relay rámců za minutu
  na socket omezují zahlcení.
- **Probouzecí push** nese jen `<jméno odesílatele> · <místnost>` a odkaz na
  `/signin` — žádný obsah.
- **Klient**: token v `sessionStorage` karty, klíč trezoru jako
  neexportovatelný `CryptoKey` v IndexedDB. Proti adversáři 4 a 6
  (kompromitovaný endpoint, rozšíření) to nechrání — může požádat o
  dešifrování stejně jako aplikace.

## Registrace formulářem (od 6.4.0)

Registrace vytváří účet s passkeyem ze jména, země, mobilu a e-mailu
(podrobně `docs/registration.md`). Co server o člověku ví:

* **Nic v čitelné podobě.** Účet nese jen `contact` — HMAC-SHA256
  normalizovaného e-mailu a mobilu klíčovaný náhodným pepřem
  (`registration.json`, 0600, nebo `REGISTRATION_PEPPER`). Stačí to na
  odmítnutí druhé registrace se stejným e-mailem či číslem; zpět na údaje
  se z toho nedostane nikdo bez pepře. Mobilní čísla mají malý prostor —
  kdo má pepř (tedy server), je umí dohledat hrubou silou; proto pepř
  neopouští server a otisky neopouštějí `accounts.json`.
* **Profil je šifrovaný klientem** (slot `registration` v trezoru, klíč
  z PRF passkeye) — server ho uloží, ale neotevře.
* Hodnoty projdou serverem jen přechodně při `check`/`start` (rozbor čísla,
  dotaz DNS na MX domény). Nezapisují se do logu ani auditu — ten nese jen
  názvy polí a kódy chyb.
* Kontrola jedinečnosti odpovídá na otázku „je tento e-mail registrovaný?“
  — je to věštírna, proto má vlastní limit (20 dotazů / 10 min / adresa)
  a zapisuje se do auditu (`account.register.check`).
* Smazání účtu uvolní jeho e-mail i mobil (otisky zmizí s účtem).

Passkeys aplikace pro Android navíc závisí na `/.well-known/assetlinks.json`
na doméně passkeyů: certifikát, který tam server uvede (vydání, env nebo
„důvěryhodný pro passkeys“ z konzole), dává každé aplikaci s tímto podpisem
přístup k passkeyům serveru. Důvěryhodný certifikát se nikdy nepromítne do
kontroly vydání APK (`certSha256`).

## HTML ve výstupech funkcí a čtení karet NFC (od 6.6.0)

### `m5.out.html`

Funkce smí poslat formátované HTML (podrobně
[`functions-architecture.md` › 9.1](functions-architecture.md)). Hrozba: HTML
nepíše jen důvěryhodný operátor — **peer** může do místnosti poslat zprávu
s libovolnými „výstupy“ (`flags.fn.outputs`), takže každý prohlížeč musí
s HTML zacházet jako s cizím vstupem. Opatření:

- **Jeden sanitizér, víc kontrol.** `client/src/lib/fn-html.ts` (čistý parser
  bez DOM) nechá jen dokumentový markup: žádné `script`, `style`, `iframe`,
  `object`, `svg`, `form`, `input`, `button`, média ani `meta` / `link` / `base`
  (zmizí i s obsahem), žádné atributy `on…`; `class` jen `m5h-…` (funkce se
  nepřestrojí za prvky aplikace), `style` jen vyjmenované vlastnosti bez
  `url(`, `expression`, `javascript:`, `@import`, `var(`, `attr(`; odkazy jen
  `http(s)` a `mailto`, obrázky jen `data:image/…;base64`. Server ho použije při
  kontrole výstupu a ukládá už vyčištěný strom; **příjemce zprávy ho použije
  znovu** (`sanitizeFnOutputs` ve `validate.ts`) a **vykreslení znovu**
  (`FnHtml.tsx`, v konzoli `functions-outputs.js` přes `window.M5Html`) — server
  ani odesílatel tedy nejsou kořenem důvěry.
- **Žádné `innerHTML`.** Chat i konzole staví z bezpečného stromu prvky DOM
  (React elementy, `document.createElement`, styly přes CSSOM). Odkazy se
  otevírají ven s `rel="noopener noreferrer nofollow"`; obrázky jsou jen
  vložená data, takže zobrazení zprávy nic nestahuje z cizích serverů.
- **Meze** proti zahlcení: 2 000 000 znaků, 20 000 uzlů, hloubka 48, lineární
  parser (test na nepřátelský vstup v `test/fn-html.test.tsx`).

Aplikace pro Android výstup `html` čistí týmž sanitizérem přeneseným do Javy
(`fn/FnHtml.java`) a vykresluje ho v uzamčeném WebView (`fn/FnHtmlView.java`):
vypnutý JavaScript, zablokovaná síť, žádný přístup k souborům,
Content-Security-Policy `default-src 'none'` (jen obrázky `data:` a vlastní
styl); odkazy otevírá aplikace ven, nic se nenačítá na místě.

### Čtení karet NFC

Hloubková čtení EMV a e-ID / e-pasu (podrobně [`nfc.md`](nfc.md)) zůstávají
**jen ke čtení** a jen na kartě či dokladu, který člověk drží:

- **EMV**: GET DATA a READ RECORD čtou to, co karta ukáže každému terminálu —
  čítače, historii transakcí, soubory. Nikdy VERIFY (PIN), nikdy `GENERATE AC`,
  žádný kryptogram ani transakce, žádný zápis.
- **e-ID / e-pas**: čip se otevře jen **přístupem řízeným samotným dokladem** —
  klíčem z MRZ nebo CAN, které držitel opíše z dokladu; kdo doklad nedrží, ho
  nepřečte. DG3 / DG4 (otisky prstů, duhovka) vyžadují Extended Access Control
  (certifikát státního terminálu) a nečtou se.

PACE (6.6, web `pace.ts`, Android `PaceProtocol.java`) je stejně jako BAC
přístupové řízení samotného dokladu, ne jeho obcházení — heslem je CAN nebo MRZ
z dokladu; ECDH generic mapping na standardizovaných parametrech 12, 13, 15–18
(NIST P-256/384/521, brainpoolP256/384/512r1), secure messaging AES-128/192/256
nebo 3DES. Nabídne-li EF.CardAccess variantu, kterou čtečka umí, zkusí nejdřív
PACE; jinak, nebo když PACE selže, otevře doklad přes BAC, má-li MRZ. DH
mapping, Integrated Mapping, CAM ani jiné křivky čtečka neumí. Implementace je
bajtově ověřená proti ukázkovým příkladům ICAO 9303-11 (dodatky G.1 a I.1)
a BSI TR-03110 (`test/nfc-pace.test.ts`, Android `PaceTest.java`).
Uvnitř 3DES secure
messagingu platí stavové slovo chráněné v DO'99' (skutečný stav příkazu, ne
vnější 9000).

- **Pasivní autentizace je jen kontrola otisků.** Otisk každé přečtené skupiny
  se porovná s otiskem v EF.SOD. **Podpis EF.SOD se neověřuje, certifikát
  podepisovatele dokladu se neověřuje proti seznamu CSCA** a aktivní ani čipová
  autentizace (AA / CA) se neprovádí. Výsledek „passive ok“ tedy říká, že data
  sedí s EF.SOD, ne že je doklad pravý — klon s okopírovanými soubory by prošel.
- **Model dostane, co se přečetlo.** Server výsledek ze zařízení ořízne
  (`host-nfc.ts`: jen známá pole, délky, počty a velikosti obrázků a souborů) a
  nikdy nepustí klíč karty ani PIN. PAN ale model dostane celý (vlastní karta
  držitele; maskuje ho až výpis, `fullPan` je ve výchozím stavu vypnuté), u e-ID
  osobní údaje a fotografie.
- **Klíč dokladu se zadává na zařízení** (6.6, `client/src/lib/nfc/document-key.ts`).
  Čtení e-ID (`eid-read` / `mrtd-read`), jehož argumenty nemají `can`, `mrz`
  ani všechna tři pole `documentNumber` + `dateOfBirth` + `dateOfExpiry`,
  zařízení volajícího nespustí, dokud se držitele samo nezeptá — ve webu
  v dialogu interakce (`handleFnInteraction` v `App.tsx`), v aplikaci pro
  Android v panelu NFC (`NfcModelSheet.java`; pole se po zadání vymažou, CAN se
  ve zprávách odpovědi maskuje). Klíč se přidá jen k příkazu tohoto čtení
  a **na server nejde**; běh dostane, co vrátí čip. `/eid` proto nemá formulář
  na serveru. Předá-li model `can` / `mrz` sám, je to jeho volba a pochází
  z jeho vlastních vstupů.
- **Běhy se ukládají.** Vstupy a výstupy běhu — u `/eid` výpis s fotografií
  a osobními údaji (CAN ani MRZ zadaný na zařízení mezi vstupy není) — leží
  v `$DATA_DIR/functions/functions.db` (SQLite, soubor 0600, nešifrovaný) do
  `FUNCTIONS_RUNS_DAYS` (výchozí 30 dní) a operátor s přístupem
  k *Functions › Runs* je vidí. Vestavěné příkazy mají viditelnost *caller* —
  výpis nejde do místnosti. Čtení v nástroji NFC (*Celý výpis*, export) zůstává
  v prohlížeči.
- **Aplikace pro Android odpovídá na NFC požadavek modelu** (6.6) jen čtením:
  zápis a emulace karty modelem jsou `denied`, ostatní operace katalogu, které
  model na Androidu nedostane (`raw-apdu`, `select-aid`, sektory MIFARE
  Classic…), `unsupported`; čte vestavěným NFC telefonu nebo USB čtečkou,
  kterou uživatel povolil v pracovišti (Bluetooth / sériová `unsupported`),
  a uživatel vidí panel s odpočtem a tlačítkem *Zrušit*.

## Serverové úložiště (od 2.10.0)

Podrobně v [`storage.md`](storage.md). Pro model hrozeb:

- **Nové aktivum: databáze na serveru.** Data uživatele leží v SQLCipher
  databázi (šifrovaný celý soubor, včetně indexů). Klíč přihlášeného
  uživatele se počítá z jeho passkey (PRF → HKDF) v prohlížeči a server ho
  drží **jen v paměti** po dobu sezení — po restartu nebo odhlášení je soubor
  neotevíratelný, dokud se uživatel znovu nepřihlásí.
- **Server ale klíč po dobu sezení vidí.** To je rozdíl proti trezoru, který
  je pečetěný druhým, nezávislým klíčem a zůstává nečitelný i s otevřenou
  databází. Kdo kompromituje běžící server, přečte, co je v ten okamžik
  otevřené (kromě trezoru); kdo získá jen disk, nepřečte nic.
- **Relace bez passkey** mají klíč od serveru, zabalený master klíčem
  (`STORAGE_MASTER_KEY`, jinak soubor `storage.key` 0600). Server je tedy
  otevřít umí — proto mají TTL jeden den, proto je „Smazat vše a odejít"
  maže okamžitě a proto se po registraci passkey data převedou do databáze
  klíčované passkeyem a dočasná se smaže i s klíčem.
- **Globální databáze je nešifrovaná**, ale drží jen veřejné klíče, id,
  časy, velikosti a hash místnosti; `detail` u logů a přenosů je zapečetěný
  master klíčem. Ztráta master klíče znamená nečitelné relace a nečitelné
  detaily — ne ztrátu účtů.
- **Passkey bez PRF účet nezaloží.** Zamezí to datům, která by nikdo
  neodemkl; cenou je, že na části autentikátorů (část USB klíčů, starší
  platformy) účet vytvořit nelze.
- **Nová závislost**: nativní modul `better-sqlite3-multiple-ciphers`. Když
  se nenačte, úložiště se vypne a server relayuje dál.

## Známé mezery (stav 2.5.0)

Zjištěno revizí kódu a měřením 2026-09-21. Opravené řádky jsou označené
verzí; ostatní vyžadují návrhové rozhodnutí. Berte je v úvahu při nasazení
i auditu.

| # | Mezera | Dopad | Doporučení |
|---|--------|-------|------------|
| 1 | Rate limit WS upgradu se nikdy nespustí (Express middleware není na cestě `upgrade`; změřeno 45/45 přijato při limitu 30/min) | neomezený počet spojení z jedné IP | limitovat v `verifyClient` / vlastním `upgrade` handleru, nebo v reverse proxy (`limit_conn`) |
| 2 | ~~Není nastaveno `trust proxy`~~ **opraveno ve 2.8.0** | IP klienta z `X-Forwarded-For` jen od důvěryhodné proxy; limity jsou per návštěvník | `TRUST_PROXY` (výchozí loopback, v kontejneru i privátní rozsahy; počet hopů / seznam) |
| 3 | ~~`POST /api/push/test`, `GET|POST /api/admin/retention*` bez autentizace~~ **opraveno ve 2.8.1** | bez tokenu už jen self-test push na vlastní id odběru (pevný text); broadcast a retence jen s `ADMIN_API_TOKEN` (`503` bez něj, `401` se špatným; porovnání v konstantním čase, `server/admin-auth.ts`) | routy zůstávají v hlavní službě — stav, na který působí, žije v její paměti; admin proces má prázdné kopie (viz ř. 9 a `docs/admin.md`). Token ≥ 32 B. |
| 4 | `GET /api/turn` vydává statické TURN údaje komukoli | zneužití TURN relaye | efemérní údaje (coturn `use-auth-secret`) |
| 5 | Proxy relay souborů: server drží IV + ciphertext (prvních 256 znaků) v paměti, ale data nedoručuje | funkce nefunguje; metadata o přenosu (počet chunků ≈ velikost) jsou serveru viditelná | dokončit relay, nebo proxy režim vypnout |
| 6 | TOFU otisky klíčované náhodným `peerId` relace; při neshodě se přepíší | panel „Důvěra" nikdy nezachytí změnu protistrany — **nespoléhat na něj** | klíčovat stabilní identitou; při neshodě nepřepisovat bez potvrzení |
| 7 | „Otisk místnosti" = SHA-256 jen z room ID | neověřuje shodu klíče/passphrase | odvodit z klíče (např. HKDF → krátký kód k porovnání) |
| 8 | CSP `script-src unsafe-inline unsafe-eval` | oslabená obrana proti XSS | pro produkci zpřísnit (nonce/hash), ponechat jen pro dev |
| 9 | Admin služba nemá Helmet ani rate limit | brute-force tokenu není brzděn | držet na loopbacku / za proxy s allowlistem; token ≥ 32 B |
| 10 | `download-file-from-admin`: potvrzovací dialog ukazuje jen název, ne URL | uživatel nevidí, odkud stahuje | zobrazit i origin |

Co naopak ověřeno **je**: obálka obsahuje jen `iv` + `ciphertext`, IV má 12 B
a je náhodné pro každý rámec i chunk, klíč je neexportovatelný, špatná
passphrase i pozměněný ciphertext se odmítnou, admin token se porovnává
v konstantním čase, příkaz mimo allowlist vrací `400`, `.env` se nedostává
do Docker image.

## Reportování zranitelností

Otevřete prosím *Security advisory* v repozitáři, ne veřejný issue:
<https://github.com/m5ike/cipherroom-secure-chat/security/advisories>.
