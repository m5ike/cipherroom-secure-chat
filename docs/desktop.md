# M5cet Desktop (6.13) — aplikace pro macOS a Windows

M5cet Desktop je **tentýž webový klient** jako v prohlížeči (místnosti, chat protokolem 4,
soubory, hovory, funkce, AI, panel telefonie, čtečky NFC, účty a passkeys, nastavení, devět
jazyků), zabalený do aplikace **Electron 44** (Chromium 152) — a s jedním podstatným rozdílem:
**kód klienta je uvnitř podepsané aplikace, ne ze serveru.** To uzavírá pro desktop nález
**F-02** bezpečnostní analýzy (server doručuje webový kód, takže zlý provozovatel může
podvrhnout klienta): server dodává jen službu (API, WebSocket, soubory), ne kód, který běží.

| | |
|---|---|
| **macOS** | **13 Ventura a novější** (Electron 44 už macOS 12 nepodporuje), jeden **univerzální** build pro Intel i Apple Silicon (`.dmg` + `.zip`) |
| **Windows** | **10 a 11, x64 i arm64** — instalátor NSIS (pro uživatele, bez administrátora) a přenosný `.zip` pro každou architekturu |
| **Linux** | není cílem 6.13 (kód s ním počítá, balíček se nestaví) |

Zdrojáky: `desktop/` (vlastní `package.json` — `electron`, `electron-builder`, `electron-updater`
nejsou závislostmi kořenového balíčku), server `server/desktop-auth.ts`, klient
`client/src/lib/desktop-auth.ts`, `client/src/lib/desktop-bridge.ts`,
`client/src/components/DesktopSignIn.tsx`.

---

## 1. Instalace

**macOS.** Otevřete `M5cet-6.13.0-mac-universal.dmg` a přetáhněte M5cet do Aplikací (nebo
rozbalte `.zip`). Podepsaný a notarizovaný build se otevře normálně. **Nepodepsaný** build
(ad-hoc podpis, viz § 7) Gatekeeper na jiném Macu odmítne — buď *Ctrl-klik → Otevřít*, nebo
`xattr -dr com.apple.quarantine /Applications/M5cet.app`; dělejte to jen s buildem, který jste
sestavili sami nebo znáte jeho původ.

**Windows.** `M5cet-Setup-6.13.0-x64.exe` (nebo `-arm64.exe`) nainstaluje aplikaci pro
aktuálního uživatele, vytvoří zástupce v nabídce Start (s AppUserModelID kvůli upozorněním)
a zaregistruje odkazy `m5cet://`. Přenosná verze `M5cet-6.13.0-win-x64.zip` běží po rozbalení,
odkazy `m5cet://` si zaregistruje při prvním spuštění (HKCU). Nepodepsaný instalátor hlásí
SmartScreen.

## 2. První spuštění

1. Aplikace ukáže **výběr serveru**: zadejte adresu, na které M5cet otevíráte v prohlížeči
   (`chat.example.org` → `https://chat.example.org`). Výchozí adresu může nastavit build
   (`M5CET_DEFAULT_SERVER`). Vložená **pozvánka** (`https://server/#j=…`) přidá server a
   rovnou ji otevře.
2. Pravidla adresy: **jen `https://`** (`http://` jen pro vývojový server na `localhost` a jen
   v nezabaleném buildu nebo s `M5CET_ALLOW_LOOPBACK=1`), **žádné jméno ani heslo** v adrese,
   jména **IDN** se načítají v ASCII podobě (punycode) a ukazují se obě podoby — podvržené
   jméno z podobných znaků je tak vidět (`pаypal.example (xn--…)`). Aplikace server před
   přidáním ověří (`/api/health`).
3. Seznam serverů (až 20) je v nabídce **Server → Přepnout server…**; pamatuje si poslední.
4. **Kontrola verze**: před načtením aplikace porovná svůj klient (`version-manifest.json` uvnitř
   aplikace) se serverovým. Jiný signalizační protokol nebo jiná verze `major.minor` → nativní
   dotaz: **Aktualizovat aplikaci** · **Použít webový kód serveru** (zapamatuje se pro tento
   server) · **Zkusit kód aplikace** · Zrušit. Rozdíl v opravné verzi nebo buildu projde.

V aplikaci se přihlašujete zvlášť: má **vlastní úložiště** (oddíl `persist:m5cet`), oddělené od
prohlížeče — klíče zařízení, relace i historie jsou jiné než v prohlížeči.

## 3. Co je stejné jako na webu

* **Tentýž origin.** Okno načítá `https://<server>/` — skutečný origin serveru. Cookies,
  **RP ID passkeys**, WebSocket `/ws`, relativní URL i CSP fungují přesně jako na webu; server
  nic nového nepotřebuje (kromě volitelného přihlášení přes prohlížeč, § 5).
* **Tentýž klient a tentýž engine.** Stejný build `dist/public` jako na serveru, Chromium na
  obou systémech: WebRTC (hovory, DataChannel, `RTCRtpScriptTransform` pro šifrování médií),
  WebCrypto včetně Ed25519, WebAssembly (Argon2id, QuickJS, Pyodide funkcí), WebUSB / Web
  Serial / WebHID / Web Bluetooth.
* **Tytéž bezpečnostní hlavičky.** Soubory, které aplikace podává sama, dostávají hlavičky, jaké
  by poslal server — aplikace spouští serverovou konfiguraci helmetu ze
  `server/security-headers.ts` (jeden zdroj pro server i aplikaci): CSP (`script-src 'self'
  'wasm-unsafe-eval'`, `frame-ancestors 'none'`, …), COOP, CORP, HSTS, Referrer-Policy,
  Permissions-Policy, `no-store`. Test `test/desktop-web-headers.test.ts` je porovnává se
  skutečnou odpovědí serveru.

## 4. Co je jinak

### 4.1 Kód z aplikace (F-02)

Aplikace na své relaci zachytí origin serveru (`protocol.handle("https")`) a o každém požadavku
rozhoduje `desktop/src/router.ts`:

| Požadavek | Odkud |
|---|---|
| `/`, `index.html`, `/assets/*`, `sw.js`, `manifest.webmanifest`, ikony, `build.json`, `version-manifest.json`, `release-web.json` | **z aplikace** (`app.asar`) |
| `/assets/*`, který aplikace nemá; `release-web.json.sig`, `release-signing.pub`, manifesty, když v aplikaci chybí | **odmítnuto (404)** — nikdy ze serveru |
| service worker jiný než přibalený `sw.js` | **odmítnuto** (cizí worker by mohl odpovídat za celý origin) |
| navigace (dokument) na jakoukoli jinou cestu (`/signin`, `/r/…`) | **z aplikace** — `index.html`, jako serverový fallback SPA |
| `/api/*`, `/fn-sandbox.html`, `/wh/*`, `/hooks/*`, `/media/*`, `/.well-known/*`, nahrávání, stahování | **síť**, beze změny (tytéž cookies, proxy, kontrola certifikátu) |
| jiné originy (dlaždice OSM, písma po souhlasu) | síť |
| WebSocket (`wss://…/ws`) | síť (nezachytává se) |

Pojistky navíc:

* **Žádný dokument ze sítě nepoběží v originu serveru**: síťová odpověď na navigaci smí být
  HTML / SVG / XML jen u `/fn-sandbox.html` a jen s hlavičkou `Content-Security-Policy: sandbox`
  bez `allow-same-origin` (neprůhledný origin); jinak 403. Stahování (`Content-Disposition:
  attachment`) a pasivní typy (JSON, obrázky, PDF) projdou.
* **Druhá vrstva na `webRequest`** (zná typ prostředku): skript, styl, worker nebo rámec
  originu serveru, který neodpověděla aplikace, se zruší.
* **Přesměrování** odpovědi serveru se nenásleduje (API M5cet nepřesměrovává): jinak by
  Electron podal stránce obsah cíle pod původní URL.
* Při každém otevření serveru se smažou jeho service workery a HTTP cache z dřívějška.
* **Integrita**: Electron ověřuje hlavičku `app.asar` proti hashi v podepsaném `Info.plist` /
  prostředku `.exe` (pojistky v § 6) a při čtení souboru jeho bloky; aplikace navíc porovná
  SHA-256 každého podávaného souboru s hlavičkou (`desktop/src/asar-integrity.ts`). Ověřeno
  ručně na zabaleném buildu: po změně jednoho bajtu `index.html` uvnitř `app.asar` Electron
  ohlásí „ASAR Integrity Violation“ a aplikace skončí — stránka se nenačte.

**Kód ze serveru (výjimka).** Pokud uživatel po rozdílu verzí výslovně zvolí *Použít webový kód
serveru*, aplikace pro ten server nic nezachytává (jako prohlížeč) a **trvale ukazuje pruh**
„Kód stránky pochází ze serveru …, ne z podepsané aplikace“ (samostatný pohled nad stránkou
v jiné relaci — stránka ho nemůže skrýt), v titulku okna je „kód ze serveru“. Zpět: tlačítko
v pruhu nebo *Server → Kód klienta → Z podepsané aplikace*.

### 4.2 Passkeys podle systému

M5cet potřebuje od passkey rozšíření **PRF** (z něj je klíč účtu). Stav k 10/2026:

| | macOS | Windows |
|---|---|---|
| Platformní passkey v aplikaci | **ne pro M5cet**: Electron 44 umí jen vlastní autentikátor Chromia s Touch ID (`app.configureWebAuthn`), vázaný na zařízení, **bez PRF** a bez passkeys z Klíčenky na iCloudu; aplikace ho proto nezapíná | **Windows Hello** přes `webauthn.dll`; **PRF** jen Windows 11 24H2 / 25H2 s aktualizací z února 2026 (KB5077181), Chromium ≥ 147 — Electron 44 to splňuje |
| Bezpečnostní klíč (USB FIDO2 s `hmac-secret`) v aplikaci | ano | ano (přes dialog Windows) |
| Telefon (hybrid, QR) v aplikaci | ne | přes dialog Windows |
| **Přihlášení přes prohlížeč** | **výchozí** | záloha (nabídne se sama, když passkey v aplikaci PRF nedá) |

Volba: *Server → Přihlášení passkey → Automaticky / V aplikaci / Přes prohlížeč*.

**Přihlášení přes prohlížeč** (`server/desktop-auth.ts`, `client/src/lib/desktop-auth.ts`):

1. Stránka v aplikaci (kód aplikace) vytvoří **efemérní klíč ECDH P-256** (soukromá část
   nevyexportovatelná, jen v paměti) a **tajemství pro vyzvednutí**; server dostane veřejný klíč
   a SHA-256 tajemství, vrátí `id` (`POST /api/desktop-auth/start`).
2. Aplikace otevře v systémovém prohlížeči `https://<server>/desktop-signin?id=<id>#k=<veřejný
   klíč>` (klíč ve fragmentu se na server neposílá) a **nativně ukáže kód** (8 číslic z veřejného
   klíče). Stránka v prohlížeči ukáže tentýž kód, upozorní, pokud žádost přišla z jiné sítě, a po
   potvrzení spustí přihlášení passkey (tam jsou passkeys z Klíčenky na iCloudu, Správce hesel
   Google, 1Password…, s PRF).
3. Prohlížeč **zašifruje** token relace a kořen účtu klíčem aplikace (efemérní ECDH + HKDF-SHA-256
   + AES-256-GCM, AAD = id + origin) a uloží šifrový text na server (`…/complete`, jednou), pak
   otevře `m5cet://auth/callback?id=<id>` — odkaz nese jen id.
4. Aplikace šifrový text vyzvedne tajemstvím (`…/result`, **jednou, pak smazán**), otevře ho svým
   klíčem a dokončí přihlášení stejně jako na webu (důkaz klíče, databáze, trezor).

Server drží žádost **nejvýš 5 minut**, výsledek vydá **jednou** a jen se správným tajemstvím
(5 špatných pokusů žádost ukončí), druhé dokončení odmítne, limituje rozpracované žádosti na adresu
i celkem. Nic tajného není v URL. **Poctivě:** stránka v prohlížeči je webový kód ze serveru (F-02
jako na webu) — zlý server může nechat stránku tajemství passkey ponechat. Přihlášení přes prohlížeč
chrání tajemství na cestě, v URL, v logu a před jinými aplikacemi, ne před zlým serverem. Proti
zlému serveru chrání bezpečnostní klíč v aplikaci (macOS i Windows) a Windows Hello s PRF.

**Registrace nového účtu** v aplikaci na macOS jde jen s bezpečnostním klíčem s `hmac-secret`;
jinak účet založte v prohlížeči (nebo v Androidu) a v aplikaci se přihlaste.

### 4.3 Upozornění, odznak, běh na pozadí

* **Web Push v Electronu nefunguje** (chybí push služba Chromia). Aplikace proto po zavření okna
  **běží dál** v oznamovací oblasti (Windows) / v Docku a na liště nabídek (macOS) se spojením
  otevřeným a upozorňuje **nativně** (macOS UNNotification, Windows toast s AppUserModelID).
  Zprávy pro nepřítomné (away relay) čekají ve schránce na serveru jako na webu; když aplikace
  neběží, nic ji neprobudí. Volba *Po zavření běžet dál*.
* Klik na upozornění přenese okno dopředu a otevře místnost (`client/src/lib/desktop-bridge.ts`
  nahradí v aplikaci `Notification` třídou, která jde přes most).
* **Odznak** s počtem nepřečtených: Dock (macOS), překryvná ikona na hlavním panelu (Windows);
  počet aplikace čte z titulku stránky („(3) M5cet“).
* Upozornění na macOS vyžadují **podepsanou** aplikaci; ad-hoc build je zobrazit nemusí. Přenosná
  verze pro Windows bez zástupce v nabídce Start toasty zobrazit nemusí.

### 4.4 NFC, zařízení, hovory

* **Web NFC v desktopovém Chromiu není**: tag z telefonu nepřečtete, jen čtečkami.
* **Systémová čtečka (PC/SC) — 6.13.1.** Čtečka čipových karet na USB (CCID: ACR122U,
  ACR1252U, ACR1281 …) patří systémové službě čipových karet (macOS CryptoTokenKit s ovladači
  `ifd-ccid` / ACS, Windows `usbccid.sys` a služba Čipová karta, Linux pcscd), takže ji WebUSB
  nikdy neotevře. Aplikace k ní proto jde přes **PC/SC** (`desktop/src/pcsc.ts`,
  `desktop/src/pcsc-backend.ts` s knihovnou **pcsc-mini 0.1.3** — N-API nad `PCSC.framework` /
  `winscard.dll`) a stránce dává úzký most `window.m5desktop.pcsc` (`listReaders`, `connect`,
  `transmit`, `disconnect`, `onChange`; smlouva `client/src/lib/nfc/pcsc-bridge.ts`). V dílně
  NFC je to volba **Systémová čtečka (PC/SC)**, v aplikaci první v seznamu.
  * **Kdo smí:** jen hlavní rámec stránky v okně aplikace na originu zvoleného serveru (tatáž
    kontrola odesílatele jako u ostatních zpráv mostu, `senderPage()`); funkční sandbox, podokna,
    stránky aplikace nic.
  * **Dotaz jednou na server:** první použití ukáže nativní dotaz *„Povolit serveru … používat
    čtečky čipových karet?“* (stránka uvidí názvy čteček a bude si moci vyměňovat příkazy s kartou
    ve čtečce, kterou vyberete). *Povolit* se uloží do šifrovaných nastavení (`safeStorage`,
    pole `pcsc`), *Nepovolit* platí do dalšího načtení stránky (žádná smršť dotazů); odvolání
    i povolení v nabídce **Server › Povolit čtečky čipových karet** — odvolání hned zavře
    spojení stránky a zastaví události. Odebrání serveru odebere i povolení.
  * **Čtečku vybírá uživatel** (nativní výběr se slotem a „s kartou“) — kromě případu, kdy kartu
    drží právě jedna čtečka; čtečka vybraná na stránce zůstane vybraná do dalšího načtení.
    Stránka nemůže tiše jmenovat jinou čtečku (cizí jméno = výběr znovu). Duální čtečka (ACR1281)
    má tři čtečky: *kontaktní*, *bezkontaktní*, *SAM*.
  * **Spojení:** `SCardConnect` ve **sdíleném** režimu (middleware e-ID / tokenů běží dál),
    T=0/T=1, odpojení `LEAVE`; `SCardControl` (escape příkazy čtečky) se **nenabízí**. APDU 4 až
    65 544 B (rozšířené), odpověď do 65 538 B, jedno APDU naráz na kartu, časové limity
    (spojení 10 s, APDU 30 s), limity rychlosti (APDU 400 nárazově / 200 za s, ostatní volání
    30 / 10 za s), nejvýš 4 spojení na stránku; chyby jako stálé kódy (`no-card`, `removed`,
    `busy` = kartu výlučně drží jiný program, `unavailable`, `denied`, `cancelled`, `locked` …).
  * **Konec přístupu:** navigace nebo zavření stránky, odvolání, **zamčení obrazovky**
    (`powerMonitor` lock-screen — do odemčení nic) a ukončení aplikace zavřou všechna spojení.
  * **Identita karty** z ATR (PC/SC Part 3: jméno paměťové karty) a — jen na bezkontaktním slotu —
    z `FF CA 00 00 00` (GET UID); kontaktní kartě se CLA FF nikdy neposílá. Pravidla G-18 (model
    a šablona jen čtou) platí beze změny.
  * **Ověřeno na tomto Macu** (ACR1281 1S Dual Reader, zabalená ad-hoc aplikace, self-test
    `M5CET_SMOKE_PCSC=1`): tři sloty, karta ve slotu 2 — ATR a UID, viz § 9. Hardened runtime
    bez App Sandboxu entitlement `com.apple.security.smartcard` **nepotřebuje** (ten je jen pro
    sandboxované aplikace); CryptoTokenKit/PC/SC v ad-hoc buildu funguje.
* **Web Serial — PN532** na převodníku USB-UART (FTDI / CP210x / CH340 / PL2303) **nebo na modulu
  Bluetooth SPP** (HC-05/06, spárovaném v systému): funguje na obou systémech, včetně emulace
  tagu. 6.13.1: výběr portu ukazuje porty Bluetooth SPP (`allowedBluetoothServiceClassIds`
  + filtr třídy služby) a volbu *Ukázat všechny sériové porty*; první kontakt PN532 probudí
  a u Bluetooth to opakuje, dokud se spojení nerozběhne (`docs/nfc.md` › Readers per platform).
* **WebUSB — CCID (ACR122U, ACR1252U)**: na macOS čtečku drží systémová služba čipových karet
  a `claimInterface` selže — stejně jako v Chromu; na Windows potřebuje WebUSB ovladač WinUSB
  (Zadig) místo `usbccid.sys`. 6.13.1: dílna to řekne slovy a nabídne Systémovou čtečku (PC/SC).
* **Web Bluetooth — PN532 přes BLE** (6.13.1): Electron bez obsluhy `select-bluetooth-device`
  každý `requestDevice()` zruší. Aplikace teď sbírá nalezená zařízení (~2,5 s), pak ukáže
  nativní výběr; nic do 15 s = zrušeno s hláškou; navigace žádost zruší (`desktop/src/bluetooth.ts`).
  Párování (`setBluetoothPairingHandler`, Windows / Linux): potvrzení a porovnání PINu nativně,
  zadání PINu ne — takové zařízení spárujte nejdřív v systému. macOS páruje sám.
* Výběr USB / sériových / HID / Bluetooth zařízení a obrazovky pro sdílení je **nativní dialog**
  (na macOS 15+ systémový výběr obrazovky); povolení kamery, mikrofonu a polohy hlídá systém
  (macOS: lokalizované texty v `Info.plist`, entitlementy hardened runtime).
* Hovory: WebRTC a šifrování médií jsou totéž Chromium jako v Chromu.

### 4.5 Další

* Nabídky, dialogy, lišta a výběr serveru jsou v **9 jazycích** (`desktop/src/i18n.ts`, podle
  `i18n/GLOSSARY.md`); jazyk sleduje jazyk stránky (`<html lang>`), dokud ho stránka neřekne,
  jazyk systému. Kontrola pravopisu: macOS systémová; Windows slovníky Hunspell (Chromium je
  stahuje z CDN Googlu — jen slovníky, žádný text).
* Odkazy mimo server se otevřou v **systémovém prohlížeči po potvrzení**; `javascript:`, `file:`,
  `data:` a neznámá schémata se zahodí; `mailto:` / `tel:` po potvrzení. Nové okno téhož originu
  je okno aplikace bez mostu; dešifrovaný soubor (`blob:`) se otevře v prohlížeči souborů **bez
  JavaScriptu**.
* Odkazy `m5cet://`: `m5cet://<server>/#j=…` (pozvánka, totéž co `https://<server>/#j=…`),
  `m5cet://open?url=<https URL>`, `m5cet://auth/callback?id=…` (přihlášení). Neznámý server se
  otevře jen po potvrzení.
* Spouštění po přihlášení (volitelné), stav okna, jedna instance, ikona v liště s rychlými akcemi.

## 5. Server

Pro aplikaci server nepotřebuje nic kromě 6.13: přibyly trasy **`/api/desktop-auth/*`**
(`server/desktop-auth.ts`, vlastní limity: 30 zahájení / 600 dotazů za 10 minut na adresu, mimo
obecný `API_RATE_LIMIT`) a stránka **`/desktop-signin`** (součást webového klienta). Pokud server
používá `WEBAUTHN_ORIGINS`, nemusí se měnit — aplikace má origin serveru.

## 6. Bezpečnostní model

| Vrstva | Jak |
|---|---|
| Kód klienta | v `app.asar` uvnitř podepsané aplikace; server ho nemůže změnit (§ 4.1) |
| Integrita | pojistky Electronu `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` (hash hlavičky `app.asar` v `Info.plist` / v prostředku `.exe`), aplikace navíc ověřuje SHA-256 každého podávaného souboru |
| Pojistky (fuses) | `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableCookieEncryption` on, `GrantFileProtocolExtraPrivileges` off |
| Ladění | vydání odmítne `--remote-debugging-port`, `--inspect*`, `--js-flags`; DevTools jen v nezabaleném buildu |
| Renderer | `sandbox`, `contextIsolation`, `nodeIntegration: false`, `webSecurity`, bez `<webview>`, bez `remote`; preload vystavuje jen `window.m5desktop` (upozornění, odznak, otevření odkazu po potvrzení, přihlášení přes prohlížeč, verze, stav aktualizací, od 6.13.1 čtečky čipových karet přes PC/SC; seznam ostatních serverů uživatele záměrně ne — stránka jednoho serveru nemá vědět o dalších) a hlavní proces u každé zprávy ověří odesílatele (hlavní rámec okna, origin serveru) |
| Oprávnění | jen origin serveru a jen hlavní rámec: kamera, mikrofon, upozornění, zápis do schránky, poloha, sdílení obrazovky, výběr reproduktoru, celá obrazovka, File System Access, USB / sériová / HID; vše ostatní (čtení schránky, MIDI, …) odmítnuto |
| Čtečky čipových karet (PC/SC, 6.13.1) | jen hlavní rámec stránky na originu serveru; nativní dotaz jednou na server (povolení v šifrovaných nastaveních, odvolání v nabídce), čtečku vybírá uživatel, sdílený režim, bez `SCardControl`, limity velikosti a rychlosti, nic při zamčené obrazovce, spojení končí s načtením stránky (§ 4.4) |
| Navigace | jen origin serveru; jinam po potvrzení do systémového prohlížeče |
| Uložená data aplikace | seznam serverů a volby šifrované `safeStorage` (Klíčenka macOS, DPAPI Windows); data webového klienta v jeho úložišti jako na webu |
| Aktualizace | jen podepsaný build: `electron-updater` ověří SHA-512 a na Windows vydavatele podpisu, na macOS Squirrel.Mac podpis téhož týmu |

**Co aplikace nechrání:** server v režimu *kód ze serveru* (vědomá volba, s pruhem); stránku
přihlášení v prohlížeči (§ 4.2); útočníka s právy uživatele na počítači (může měnit profil,
podvrhnout aplikaci jinou cestou); metadata, která zná server (jako na webu). A podepsání samo
nedokazuje, že build odpovídá zdrojákům — reprodukovatelný build zatím není (F-29).

## 7. Sestavení a podpis

```bash
npm ci && npm run desktop:install          # kořen + desktop/ (Electron, electron-builder)
npm run desktop:build                       # web (npm run build) → aplikace → balíčky pro tento systém
npm run desktop:build -- --mac              # univerzální .dmg + .zip  (desktop/release/)
npm run desktop:build -- --win              # NSIS + .zip pro x64 a arm64 (i na macOS, bez Wine)
npm run desktop:build -- --mac --dir        # jen rozbalená aplikace (rychle)
npm run desktop:start                       # vývoj: nezabalená aplikace
PORT=5181 npm run dev                       # vývojový server (na macOS nikdy port 5000)
npm run desktop:smoke -- --app desktop/release/mac-universal/M5cet.app/Contents/MacOS/M5cet
node desktop/scripts/e2e.mjs                # Playwright: výběr serveru, navigace, okna (nezabalená aplikace)
```

**Podpis a notarizace jen z proměnných prostředí** (nikdy soubor v repozitáři):

| | Proměnné |
|---|---|
| macOS podpis | `CSC_LINK` (+ `CSC_KEY_PASSWORD`) — certifikát *Developer ID Application*, nebo `CSC_NAME` (identita v klíčence) |
| macOS notarizace | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, nebo `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` |
| Windows podpis | `WIN_CSC_LINK` (+ `WIN_CSC_KEY_PASSWORD`), nebo Azure Trusted Signing: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` + `M5CET_AZURE_ENDPOINT`, `M5CET_AZURE_ACCOUNT`, `M5CET_AZURE_PROFILE`, `M5CET_AZURE_PUBLISHER` |
| Aktualizace | `M5CET_UPDATE_GITHUB=owner/repo` (GitHub Releases) nebo `M5CET_UPDATE_URL=https://…` (obecný feed); bez nich build aktualizace nemá |
| Ostatní | `M5CET_DEFAULT_SERVER` (výchozí server), `M5_RELEASE_KEY` (připnutý klíč vydání webu), `M5_BUILD_ID` |

**Bez podpisu** build funguje a hlasitě to řekne: macOS dostane **ad-hoc podpis** (`-`, s
entitlementem `disable-library-validation`, který podepsaný build nemá) — spustí se na Macu,
kde vznikl, jinde ho Gatekeeper odmítne; Windows instalátor je nepodepsaný (SmartScreen). Takový
build **se nikdy sám neaktualizuje**. Certifikáty si nevymýšlejte — patří k účtu Apple Developer
(Developer ID) a k certifikační autoritě / Azure Trusted Signing.

Hardened runtime (macOS) povoluje jen `allow-jit` (V8 a WebAssembly), kameru, mikrofon, polohu
a síťového klienta (`desktop/build/entitlements.mac.plist`); `Info.plist` má lokalizované texty
dotazů na kameru, mikrofon, polohu, Bluetooth a zvuk při sdílení obrazovky (9 jazyků).

**Nativní modul PC/SC (6.13.1).** `pcsc-mini` je závislost `desktop/package.json` (přesně 0.1.3)
a hlavní proces ho při kompilaci nechává vně balíku (`external`); jeho binárky (`addon.node`,
N-API) se **rozbalí z `app.asar`** (`asarUnpack: node_modules/@pcsc-mini/**`). npm instaluje jen
binárku stroje, na kterém běží, proto `desktop/scripts/pcsc-prebuilds.mjs` (volá ho
`build.mjs`) doplní chybějící balíčky cílů — **macOS** `@pcsc-mini/macos-aarch64` +
`macos-x86_64`, **Windows** `@pcsc-mini/windows-x86_64-electron` + `windows-aarch64-electron` —
přes `npm pack` v přesné verzi a s ověřením **sha512 z `desktop/package-lock.json`**. Každý
artefakt nese jen binárky svého systému (`mac.files` / `win.files` vylučují ostatní, ve Windows
i varianty `-node` / `-bun`); obě binárky Windows jsou v obou instalátorech (modul si vybere
podle `process.arch`, ~0,3 MB navíc). Univerzální aplikace pro macOS nese obě binárky v obou
polovinách a slučuje je jako `x64ArchFiles`.

**Pozor na binárku x86_64:** `@pcsc-mini/macos-x86_64` 0.1.3 (sestavená Zigem) není podepsaná
a za jejími load commands nezbývá místo — `codesign` by novým `LC_CODE_SIGNATURE` přepsal prvních
16 bajtů kódu a podepsaná knihovna by při načtení spadla (SIGSEGV; zjištěno spuštěním Intel
poloviny univerzální aplikace pod Rosettou). `desktop/scripts/macho-signable.mjs` proto před
balením odstraní informativní `LC_SOURCE_VERSION` (16 B, za běhu ho nic nečte), aby se podpis
vešel; kód ani data se neposunou. Binárka arm64 podpis už má a nemění se.

Vydání aktualizace: sestavte podepsaný build s `M5CET_UPDATE_GITHUB` / `M5CET_UPDATE_URL`
a nahrajte artefakty **včetně `latest-mac.yml` / `latest.yml` a `.blockmap`** (např.
`npx electron-builder --publish always` v `desktop/` s `GH_TOKEN`, nebo ručně na feed).

## 8. CI

`.github/workflows/desktop.yml` (akce připnuté na SHA jako ostatní workflow):

* **test** (Ubuntu): `vitest` desktopových testů a `tsc -p desktop/tsconfig.json`.
* **macos** (`macos-latest`): univerzální `.dmg` + `.zip`, nahrání artefaktů, smoke test zabalené
  aplikace proti lokálnímu serveru — Apple Silicon nativně, Intel pod Rosettou.
* **windows** (`windows-latest`): NSIS + `.zip` pro x64 a arm64, nahrání artefaktů, smoke test
  zabalené x64 aplikace.

Podpisy z tajemství repozitáře (`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_*`, `WIN_CSC_*`,
`AZURE_*`), proměnné `M5CET_*`; pull requesty z forků tajemství nedostanou a staví nepodepsaně.

## 9. Testy

| Test | Co |
|---|---|
| `test/desktop-router.test.ts` | co je z aplikace a co ze sítě, `/assets` mimo balík, service worker, navigace a SPA, POST jako navigace, `..`, `%2e%2e`, `%2f`, `\`, NUL, query, HEAD, rozsahy (206 / 416), jiné originy, režim kódu ze serveru, dokumenty ze sítě, druhá vrstva `webRequest` |
| `test/desktop-shell.test.ts` | adresa serveru (https, přihlašovací údaje, IDN), navigace a nová okna, oprávnění, odkazy `m5cet://`, kontrola verze, nastavení, odznak, texty v 9 jazycích |
| `test/desktop-web-headers.test.ts` | hlavičky aplikace = hlavičky skutečného serveru |
| `test/desktop-auth.test.ts` | přihlášení přes prohlížeč: šifrování ke klíči aplikace, vazba na id a origin, poškozený / cizí / prošlý výsledek, jednorázovost, tajemství, limity, celý průběh přes HTTP, probuzení odkazem, zrušení |
| `test/desktop-build-config.test.ts` | podpis jen z prostředí, entitlementy, pojistky, cíle, feed aktualizací, texty `Info.plist`, hlavička `app.asar` |
| `test/desktop-pcsc.test.ts` (6.13.1) | most PC/SC s falešným pcsc-mini a falešnými dialogy: odesílatel, dotaz jednou na server (souběžná volání, „nepovolit“ do načtení, bez PC/SC bez dotazu), seznam se sloty, výběr čtečky (jediná s kartou bez výběru, cizí jméno = výběr znovu, zrušení), prázdná čtečka, APDU (rozšířené na hranici, nad ní odmítnuto, cizí handle), limity rychlosti, chyby PC/SC, zaseknutá karta, události (jen změny, jen povoleným), vyjmutí karty, navigace, odvolání, zámek obrazovky, ukončení, self-test; výběr Bluetooth; povolení v nastavení; balení (`asarUnpack`, `x64ArchFiles`, soubory na systém, binárka x86_64 podepsatelná) |
| `desktop/scripts/smoke.mjs` | zabalená (nebo nezabalená) aplikace proti běžícímu serveru: stránka z balíku, API ze sítě, cizí `/assets` 404, most, žádný Node, přibalený service worker, CSP serveru, integrita, architektura; s `M5CET_SMOKE_PCSC=1` (nebo `--pcsc`) i čtečky přes PC/SC — jen čtení (ATR, `FF CA 00 00 00`) přes aplikaci i přes most stránky |
| `desktop/scripts/e2e.mjs` | Playwright (nezabalená aplikace): výběr serveru, odmítnutí http, SPA, okna, navigace, sandbox funkcí |

## 10. Co nebylo ověřeno

* **Windows**: instalátory a zipy pro x64 a arm64 se postavily na macOS (bez Wine; ikona, údaje
  o verzi, prostředek integrity `app.asar` a pojistky zkontrolovány v `.exe`), ale **nespustily
  se na Windows** — to dělá CI (`windows-latest`, x64). arm64 není spuštěn nikde.
* **Skutečné passkeys**: přihlášení přes prohlížeč je otestováno protokolem (testy, endpoint
  v zabalené aplikaci), ne s reálnou passkey v Safari / Chromu; Windows Hello s PRF neověřeno.
* **Upozornění a odznak** na skutečném systému s podepsaným buildem; podepsání, notarizace
  a aktualizace (žádné certifikáty v tomto prostředí).
* Intel Mac: univerzální build ověřen pod Rosettou, ne na fyzickém Intel Macu.
* Čtečky: **ověřena** systémová čtečka PC/SC s ACS ACR1281 1S Dual Reader na Apple Silicon
  (nativně i Intel polovina pod Rosettou; § 4.4). **Neověřeno:** PN532 přes Bluetooth SPP
  a BLE v aplikaci (modul byl vypnutý), MIFARE Classic přes pseudo-APDU PC/SC (žádná karta
  Classic), PC/SC na Windows (balíky x64 i arm64 se postavily s binárkami `windows-*-electron`, ale nespustily se), párování
  Bluetooth na Windows. Sdílení obrazovky v aplikaci.
