# Changelog

Všechny významné změny tohoto projektu jsou dokumentovány v tomto souboru.

Formát vychází z [Keep a Changelog](https://keepachangelog.com/cs/1.1.0/) a
projekt používá [Semantic Versioning](https://semver.org/lang/cs/).

## [6.6.0] – 2026-10-04

**Hloubkové čtení EMV a e-ID s PACE, výpisy karet v šesti formátech
a formátované HTML z funkcí.** Čtečka ve webu i v aplikaci pro Android přečte
z platební karty i historii transakcí, čítače a všechny soubory a z e-ID /
e-pasu každou datovou skupinu, kterou smí číst běžná čtečka, s obrázky
a bezpečnostními objekty; doklad otevře přes PACE (CAN nebo MRZ) nebo BAC —
pořád jen ke čtení, vlastní karta či doklad. Jakékoli čtení se dá převést na
výpis (HTML, objekt, řádky, JSON, text, CSV); funkce mohou posílat
sanitizované HTML (`m5.out.html`). Nové nástroje vizuálního tvůrce NFC.EMV
a NFC.e-ID a z nich příkazy `/emv`, `/emv-history` a `/eid`; klíč dokladu
zadává držitel na svém zařízení a na server nejde. Aplikace pro Android sama
odpovídá na NFC požadavek modelu.

### Přidáno
- **Hloubkové čtení EMV** (`client/src/lib/nfc/cards/emv.ts`). Po SELECT
  každé aplikace (nově až 8, `maxApps` 1–16) **GET DATA** — ATC, poslední online
  ATC, čítač pokusů o PIN, záznam a formát logu (9F4D / 9F4F) a několik
  zůstatkových / vydavatelských objektů; **log transakcí** (`history`) se čte
  ještě **před** GET PROCESSING OPTIONS ze souboru, který karta uvede, a každý
  záznam se dekóduje podle formátu logu karty (datum, čas, částka, měna, země,
  typ, obchodník, ATC, výsledek); po záznamech z AFL **hloubkové čtení**
  (`deep`) zkusí každý krátký soubor SFI 1–30 (nejvýš 240 READ RECORD navíc).
  Výsledek nese navíc AIP, AFL, odpovědi GET DATA, formát a soubor logu,
  historii, každý přečtený záznam (SFI, číslo, hex), příznak `deep` a počet APDU.
- **Hloubkové čtení e-ID / e-pasu** (`mrtd.ts`, `asn1.ts`, `sm.ts`). Před
  otevřením EF.CardAccess (protokoly, které čip ohlásí); přes secure messaging
  EF.COM (skupiny, verze LDS a Unicode), **EF.SOD** (otisky skupin, algoritmus,
  certifikát podepisovatele dokladu), DG1, **DG2 se všemi obličeji**, DG5
  (portrét), DG7 (podpis), DG11 (další osobní údaje), DG12 (údaje o dokladu,
  skeny), DG13, DG14 (bezpečnostní protokoly), DG15 (klíč aktivní autentizace),
  DG16 (osoby k vyrozumění); DG3 / DG4 jen jako „chráněno (EAC)“. Každá celá
  skupina se porovná s otiskem v EF.SOD (`hashOk`, `security.passive`). Obrázky
  jako `images[]` (JPEG / PNG k zobrazení, JPEG 2000 ke stažení), surové soubory
  jako `raw[]` (`EF.SOD.bin`, `document-signer.cer`, `DG*.bin`…), seznam všech
  zkoušených souborů se stavem a velikostí. Volby `readPhoto` a `all`.
- **PACE** (`pace.ts` — `establishPace`, `aes.ts`, `ec.ts`, `sm.ts`): PACE
  s CAN nebo MRZ — ECDH generic mapping na standardizovaných parametrech 12, 13,
  15, 16, 17 a 18 (NIST P-256/384/521, brainpoolP256/384/512r1), secure
  messaging AES-128/192/256 (`aesChannel`) nebo 3DES (kanál BAC s nulovým SSC).
  Nabídne-li EF.CardAccess variantu, kterou čtečka umí, zkusí nejdřív PACE;
  jinak, nebo když PACE selže, BAC s MRZ. Samotný CAN otevře doklad s PACE
  (pole CAN v pracovišti stačí samo). Bajtově ověřeno proti ukázkovým příkladům
  ICAO 9303-11 (dodatky G.1 a I.1) a BSI TR-03110 EAC2
  (`test/fixtures/pace-vectors.json`).
- **Aplikace pro Android — hloubkové čtení a PACE**: nativní čtečka
  (`nfc/EmvReader.java`, `MrtdReader.java`) čte EMV do hloubky (historie, GET
  DATA, každý soubor) a e-ID každou skupinu s obrázky a kontrolou otisků proti
  EF.SOD; doklad otevírá přes PACE (`PaceProtocol.java`, `Pace.java`,
  `Aes.java`, `EcCurve.java`, `AesSm.java` — port webové implementace na
  stejných vektorech) nebo BAC. Pracoviště v aplikaci čtení ukáže (historie
  jako tabulka, GET DATA, záznamy; držitel vedle obličeje, DG11 / DG12, všechny
  obrázky, bezpečnostní objekty a soubory); operace se jmenuje *Read document
  (PACE / BAC)*.
- **Aplikace pro Android odpovídá na NFC požadavek modelu**
  (`ui/parts/NfcModelSheet.java`, `nfc/ModelNfc.java`, `ModelNfcDevice.java`,
  `ReaderMode.java`; interakce `nfc` přes `fn/Run.java` a `ui/parts/Fn.java`):
  zespodu panel s tím, co model chce, výzvou přiložit kartu k zadní straně
  telefonu, odpočtem a tlačítkem *Zrušit* (odpověď `timeout` „Cancelled“).
  Čte vestavěným NFC telefonu, nebo USB čtečkou, kterou uživatel už povolil
  v pracovišti; Bluetooth a sériová čtečka dostanou `unsupported`, zápis
  a emulace `denied`, `raw-apdu` / `select-aid` a další čtení mimo seznam pro
  model `unsupported`. Při vypnutém NFC odpověď `unsupported` a panel nabídne
  nastavení NFC.
- **Klíč dokladu se zadává na zařízení**
  (`client/src/lib/nfc/document-key.ts`): čtení e-ID bez klíče (bez `can`,
  `mrz` i trojice `documentNumber` + `dateOfBirth` + `dateOfExpiry`) se nejdřív
  zeptá držitele na CAN / MRZ — ve webu v dialogu interakce
  (`handleFnInteraction` v `App.tsx`), na Androidu v panelu NFC — a klíč
  použije jen pro toto čtení.
- **Výpisy karet** (`client/src/lib/nfc/card-report.ts`): jakékoli čtení (EMV,
  e-ID, prostý sken) jako `html` | `object` | `array` | `json` | `text` | `csv`,
  popisky česky, anglicky nebo německy, PAN maskovaný (není-li `fullPan`),
  každý text z karty escapovaný; obrázky k zobrazení zvlášť od souborů ke
  stažení (`emv-history.csv`, `emv-records.txt`, bezpečnostní objekty, JPEG
  2000); samostatný HTML dokument se styly.
- **Pracoviště NFC — Celý výpis**: po čtení EMV nebo e-ID výpis tak, jak ho
  ukáže chat, s exportem *HTML výpis*, JSON, CSV, Text a tlačítkem pro každou
  přílohu — vše v prohlížeči.
- **`m5.out.html(html, { title })`** — formátované HTML ve výstupu funkce
  (`client/src/lib/fn-html.ts`, `FnHtml.tsx`): jen dokumentový markup (nadpisy,
  odstavce, seznamy, tabulky, `details`, obrázky jako `data:image`, odkazy
  http(s) / mailto), třídy jen `m5h-*`, `style` jen neškodné vlastnosti; čistí ho
  server i každý prohlížeč a vykresluje se jako prvky DOM. Konzole ho ukazuje
  ve výsledcích běhů týmž sanitizérem (`window.M5Html`).
- **Aplikace pro Android vykreslí výstup `html`**: týž sanitizér přenesený do
  Javy (`fn/FnHtml.java`, bajtově shodný výsledek) a uzamčené WebView
  (`fn/FnHtmlView.java`) — vypnutý JavaScript, zablokovaná síť, žádné soubory,
  CSP jen pro obrázky `data:` a vlastní styl, odkazy otevírá aplikace ven.
- **SDK** (JS i Python): `m5.nfc.emv.read({ maxApps, history, deep })`,
  `emv.report`, `emv.format`, `emv.history`; `m5.nfc.eid.read({ …, all })`,
  `eid.report`, `eid.format`, `eid.images`; `m5.nfc.format`, `m5.nfc.outputs`,
  `m5.nfc.document`. `*.report` přečte, naformátuje a s `send: true` výpis hned
  ukáže; vrací `{ ok, status, message, format, result, title, summary, data,
  images, files, history, photo, outputs }`.
- **Vizuální tvůrce**: skupiny **NFC.EMV** (*EMV: read everything*, *EMV →
  format*, *EMV: transaction history*) a **NFC.e-ID** (*e-ID: read
  everything*, *e-ID → format*, *e-ID: pictures*), ve skupině NFC *Card →
  format* a *Show card report*, v Output *Send HTML*.
- **Příkazy `/emv`, `/emv-history`, `/eid`** (balíčky `nfc-emv`,
  `nfc-emv-history`, `nfc-eid`, toky z `script/gen-nfc-flows.ts`): celé čtení
  karty jako výpis v chatu, historie transakcí jako tabulka a celé čtení
  dokladu (`/eid` nemá formulář na serveru: čte hned, s limitem 90 s, a na CAN
  / MRZ se zeptá zařízení). Instalují se **vypnuté**, viditelnost *caller*.
- **`/help nfc`** a **`/help html`**, tlačítko *NFC cards* pod `/help`; lekce
  tutoriálu **17 · Formatted HTML**, **18 · NFC card reports**, **19 · Reading a
  card (EMV, e-ID)**.

### Změněno
- `host-nfc.ts` propustí nová pole čtení s rozpočty: EMV nejvýš 16 aplikací,
  256 prvků, 60 záznamů logu, 32 odpovědí GET DATA a 320 záznamů (hex ≤ 1 024
  znaků) na aplikaci; e-ID nejvýš 12 obrázků (≤ 400 000 znaků base64 každý,
  1 400 000 celkem) a 32 surových souborů (≤ 400 000, 1 200 000 celkem),
  textová pole oříznutá.
- Pracoviště čte EMV až z 8 aplikací (dřív 4) a e-ID přijme samotný CAN;
  operace čtení dokladu se jmenuje *Read document (PACE / BAC)*.
- Vykonavatel ve webu (`web-executor.ts`), který odpovídá na NFC příkazy
  modelu, předá čtečce každou volbu: u EMV `maxApps` (výchozí 8, dřív 4),
  `history` a `deep`, u e-ID klíč, `readPhoto` a `all`.
- Typy `EmvApp`, `EmvData`, `MrtdData`, `MrtdAccessArgs` (`client/src/lib/nfc/command.ts`)
  mají nová pole; `OUTPUT_TYPES` má `html`.
- Vestavěné balíčky 1.3.0 (balíčky NFC 1.0.0). Bundle sandboxu ve vývoji se
  přestaví i při změně klientských souborů, které přibaluje (výpisy karet,
  sanitizér HTML). Verze 6.6.0 (package.json); instalátor zůstává 3.2.0.

### Opraveno
- Uvnitř 3DES secure messagingu (BAC i PACE s 3DES) platí stavové slovo, které
  čip chránil v DO'99' — skutečný stav příkazu; čip může venku odpovědět 9000,
  když soubor chybí (6A82) nebo ho chrání EAC (6982) (`bac.ts`, jako
  `Bac.java` v aplikaci pro Android).

### Bezpečnost
- **HTML z funkce je cizí vstup.** Peer může poslat zprávu s výstupy, proto ho
  čistí server, příjemce při přijetí i každé vykreslení; nikdy `innerHTML`,
  žádné skripty, styly, formuláře, rámy ani obsluhy událostí, obrázky jen
  vložená data.
- **Pořád jen ke čtení.** EMV: GET DATA a READ RECORD, nikdy VERIFY, `GENERATE
  AC`, kryptogram, transakce ani zápis. e-ID: jen klíčem, který držitel opíše
  z dokladu; DG3 / DG4 se nečtou.
- **Pasivní autentizace je jen kontrola otisků** proti EF.SOD — podpis EF.SOD
  ani certifikát podepisovatele se neověřují (žádný seznam CSCA), AA / CA se
  neprovádí. Výsledek neříká, že je doklad pravý.
- **Klíč dokladu se neposílá.** CAN / MRZ, na které se zařízení zeptá, zůstane
  na zařízení a použije se jen pro dané čtení; na server nejde a mezi vstupy
  běhu není (`/eid` už nemá formulář na serveru). Aplikace pro Android pole po
  zadání vymaže a CAN ve zprávách odpovědi maskuje. Předá-li model `can` /
  `mrz` sám, pocházejí z jeho vlastních vstupů.
- **Model dostane, co přečetl**: celý PAN (maskuje až výpis) a u e-ID osobní
  údaje a obrázky. Vstupy a výstupy běhu (u `/eid` výpis s fotografií) leží ve
  `functions.db` do `FUNCTIONS_RUNS_DAYS` (výchozí 30 dní) a vidí je operátor
  s přístupem k běhům.
- **Model na Androidu jen čte**: zápis a emulace karty `denied`, surové APDU
  (`raw-apdu`, `select-aid`) a ostatní čtení mimo seznam pro model
  `unsupported`.

### Testy
- `test/nfc-emv-deep.test.ts`, `test/nfc-mrtd-deep.test.ts` (simulovaný čip),
  `test/nfc-pace.test.ts` (AES / CMAC, křivky, ukázkové příklady ICAO a BSI,
  simulovaný čip s PACE), `test/nfc-document-key.test.ts`,
  `test/nfc-card-report.test.ts`, `test/fn-html.test.tsx`,
  `test/console-html-output.test.ts`, `test/nfc-builtins.test.ts`; rozšířené
  `functions-nfc`, `functions-builtins`, `functions-tutorial` a
  `nfc-workbench`. Android: `PaceTest`, `EmvDeepTest`, `MrtdDeepTest`,
  `ModelNfcTest`, `FnHtmlTest` (shoda s `fn-html.ts` na sdílených případech),
  rozšířený `RunTest`.

### Známá omezení
- Pasivní autentizace porovnává jen otisky: podpis EF.SOD ani podepisovatel
  proti seznamu CSCA se neověřují a AA / CA se neprovádí.
- DG3 / DG4 (otisky prstů, duhovka) vyžadují EAC a nečtou se.
- PACE: DH mapping, Integrated Mapping, CAM a jiné křivky než standardizované
  parametry 12, 13, 15–18 čtečka neumí (takový doklad otevře jen BAC s MRZ,
  nabízí-li ho).
- Na Androidu model čte jen vestavěným NFC telefonu nebo povolenou USB
  čtečkou — Bluetooth ani sériová čtečka pro model nejde.
- Výstupy běhu (výpis včetně fotografie) se drží v historii běhů na serveru.
- Zatím nic nebylo přečteno ze skutečné karty ani dokladu na zařízení: PACE,
  BAC a hloubkové čtení EMV / e-ID jsou ověřené jen ukázkovými příklady ze
  specifikací a simulovanými čipy v testech, panel modelu na Androidu jen
  jednotkovými testy (`ModelNfcTest`).

## [6.5.0] – 2026-10-04

**Čtení EMV karty a e-ID / e-pasu v nástroji NFC a plynulejší běh
`/příkazů`.** Nástroj NFC (web i Android) čte platební kartu (EMV) a
elektronický pas či občanku (e-ID, MRTD) — vždy jen jako čtečka, veřejná /
držitelova data, bez PINu, kryptogramu, transakce a bez zápisu; e-ID / e-pas se
otevře jen přístupem řízeným samotným dokladem (BAC) z MRZ nebo CAN, které
držitel zadá. V chatu se spuštění `/příkazu` modelu ukáže okamžitě jako vlastní
bublina odesílatele a výsledek nahradí indikátor na místě.

### Přidáno
- **Plynulý běh `/příkazu` (web i Android).** Spuštění chatovacího `/příkazu`
  (volání modelu) se hned ukáže jako **vlastní bublina odesílatele**: bublina
  jemně pulzuje a pod dotazem je vycentrovaný třítečkový indikátor s názvem
  modelu. Jakmile model odpoví, indikátor se **na místě** nahradí výsledkem
  (odpověď jen pro volajícího rovnou v bublině) nebo krátkým stavovým štítkem
  (odpověď šla do místnosti jako vlastní zpráva, nebo chyba). `FnMeta` má nově
  pole `query` / `pending` / `status`; i18n klíče `functions.running` a
  `functions.sentToRoom`.
- **Čtení EMV karty (jen ke čtení, vlastní karta).** `PPSE → SELECT AID → GET
  PROCESSING OPTIONS → READ RECORD`; rozparsuje AIDy, štítky aplikací, PAN
  (maskovaný), platnost, držitele, zemi vydavatele, pořadové číslo PANu, ATC,
  čítač pokusů o PIN a celý strom tagů. Nikdy PIN, nikdy kryptogram ani
  transakce, nikdy zápis — stejné bajty, jaké přečte bezkontaktní terminál.
  Operace pracoviště „Read card data"; `m5.nfc.emv.read()` ve Functions
  (výsledek `.emv`).
- **Čtení e-ID / e-pasu (MRTD, ICAO 9303).** BAC — přístup řízený samotným
  dokladem, klíč z MRZ (číslo dokladu + datum narození + platnost) nebo z CAN,
  který držitel zadá — pak DG1 (údaje MRZ) a DG2 (fotografie) přes zabezpečené
  zprávy (secure messaging). Vlastní doklad držitele, jen ke čtení. DES/3DES +
  retail MAC + odvození klíče BAC + secure messaging jsou bajtově shodné
  s ukázkovým příkladem ICAO 9303 (jednotkové testy). Operace pracoviště „Read
  document (BAC)"; `m5.nfc.eid.read({ mrz | documentNumber+dateOfBirth+dateOfExpiry | can, readPhoto })`
  (výsledek `.mrtd` s `mrzInfo` a fotografií).
- **apduTemplates — op i apdu šablony.** `m5mobile.define.apduTemplates` zná
  nově dva druhy položek: **op šablony** `{ label, op:"emv-read"|"eid-read", args? }`
  (celé dynamické čtení) a **apdu šablony** `{ label, apdu }` (surové SELECTy pro
  APDU konzoli). V konzoli (Android › Define) tlačítko **Load standard EMV /
  e-ID templates** sestaví a uloží standardní sadu
  (`client/src/lib/nfc/apdu-templates.ts`) jedním klikem — nahradí případnou
  stávající `apduTemplates` po potvrzení, ostatní definice ponechá.

### Změněno
- `m5.nfc` má nově obory `emv` a `eid` (JS i Python); op id na drátě jsou
  `emv-read` a `mrtd-read`.
- Verze 6.5.0 (package.json); instalátor zůstává 3.2.0.

### Opraveno
- Konzole na úzké obrazovce: řádek statistik Functions (`white-space:
  nowrap`) roztahoval stránku do šířky — pod 820 px přetékala vodorovně;
  panely rozvržení pod sebou už nedrží svou minimální šířku, tabulky v nich
  se posouvají uvnitř; na telefonu se horní lišta zalomí (titulek, pod ním
  nástroje a účet), nadpisy skupin menu jsou přes celý řádek a tabulky
  přenesené Telefonie se posouvají. Na 390, 760 i 1024 px žádná stránka
  konzole nepřetéká.
- Rozvržení: zvětšení panelu klávesnicí (Shift+→) nepřekročí šířku řádku
  (jako tažení myší) a respektuje minimum panelu.
- Testy: E2E přenosu souborů (`two-peers`, `relay-files`) ukládají soubor
  tlačítkem *Uložit* v patičce bubliny (od 6.2 tam není odkaz
  `a[download]`); `nfc-workbench` odpovídá na `/api/define` sám, místo
  pokusu o spojení na `localhost:3000`.

### Bezpečnost
- **Jen ke čtení, žádné klonování.** EMV i e-ID / e-pas se pouze čtou: žádný
  PIN (čítač pokusů o PIN se jen přečte, nikdy neověřuje), žádný kryptogram ani
  transakce (`GENERATE AC` se nespouští), žádný zápis a žádné klonování.
- **BAC je přístup řízený samotným dokladem.** e-ID / e-pas otevře jen ten, kdo
  doklad fyzicky drží a přečte jeho MRZ nebo CAN — není to čtení cizího pasu „ze
  vzduchu".
- **Držitel čte svou vlastní kartu / doklad, model dostane jen data zpět.**
  `m5.nfc.emv` / `eid` nikdy nedostanou klíč ani PIN; server ořízne, co se vrací
  (host-nfc: jen držitelova / veřejná pole, fotografie omezená).

## [6.4.1] – 2026-09-30

**Žádné osiřelé passkeye, nové uživatelské jméno a název klíče.** Registrace
v aplikaci pro Android končila chybou „origin android:apk-key-hash:… not
allowed“: správce hesel passkey vytvořil, ale server certifikát ladicího
buildu nezná (neznal žádný — `assetlinks.json` vracel 404 „No Android app
is known“), takže ho odmítl a passkey zůstal ve správci hesel k ničemu.

### Opraveno
- Aplikace pro Android posílá s každým požadavkem účtu SHA-256 svého
  podpisového certifikátu (`X-M5-App-Cert`). Každý endpoint, který začíná
  obřad passkeye (`register/check`, `register/start`, `register/options`,
  `signin/options`, `passkeys/options`, `recovery/start`), odpoví
  `403 app-not-trusted`, když by server původ té aplikace odmítl — **dřív,
  než passkey vznikne**. Aplikace místo toho ukáže dialog s certifikátem
  a návodem (Konzole › Android › Security › Passkeys on Android › Trust).
  Audit zapíše `account.app-not-trusted`.
- `register/verify` označí odmítnutý původ kódem `origin-not-allowed`
  a hláška o osiřelém passkeyi jmenuje passkey tak, jak ho ukazuje správce
  hesel (aby šel najít a smazat).

### Změněno
- **Uživatelské jméno** účtu z registrace: `XXXX-XXXX-XXXX-XXXX`, X náhodně
  z `0-9 a-z A-Z` (62¹⁶, ≈ 95 bitů), jedinečné bez ohledu na velikost
  písmen. Anonymní „Vytvořit účet“ beze změny.
- **Název passkeye** (co ukazuje správce hesel): `ISO2-scramble(Jméno-Příjmení-Mobil)`,
  např. `CZ-Mi3ale-Ko38a-7a73kassa` — mobil jako národní číslo, latinka
  převedená na ASCII, scramble náhodně přesune asi 20 % znaků (pomlčky
  zůstávají). Handle uživatele zůstává uživatelské jméno; název žije jen ve
  správci hesel, server z něj nic neukládá.
- Verze 6.4.1 (versionCode 60401).

## [6.4.0] – 2026-09-30

**Registrace a passkeys na Androidu.** Nový registrační formulář (web
i Android) vytvoří účet s passkeyem ze jména, země, mobilu a e-mailu —
server ověří číslo (musí jít o mobil), doménu e-mailu (existuje a má MX)
a že e-mail ani mobil ještě nejsou zaregistrované; osobní údaje přitom
nikdy neukládá v čitelné podobě. A proč na Androidu nešlo přihlášení
passkeyem: produkční proxy blokuje `/.well-known/assetlinks.json` (HTTP 403)
a telefon běží s buildem podepsaným ladicím certifikátem, který server
nezná — aplikace i konzole to teď přesně řeknou a konzole nabídne opravu.

### Přidáno — web i Android
- **Registrace** (menu *Registrace* pro nepřihlášené, tlačítko v okně
  Připojení na webu a v *Nastavení › Uživatel* na Androidu, ⋮ menu místnosti
  a seznamu místností): jméno, příjmení, **země** (vyhledávací výběr podle
  názvu, kódu i předvolby, bez ohledu na diakritiku), **mobil** (s předvolbou
  země) a **e-mail**. Kontroly v obou klientech (sdílený modul
  `client/src/lib/registration/form.ts`) a znovu na serveru: platné číslo,
  a to mobil (ne pevná linka, VoIP ani placená linka — plná metadata
  libphonenumber), e-mail syntakticky i přes DNS (doména existuje, má MX
  a nejde o null MX), jedinečnost e-mailu i mobilu.
- Server vygeneruje **uživatelské jméno** (od 6.4.1 `XXXX-XXXX-XXXX-XXXX`,
  ≈ 95 bitů), vyžádá **passkey** (PRF → kořen účtu → klíče, stejně
  jako „Vytvořit účet“), zaregistruje účet, uloží profil šifrovaně do
  **trezoru** a srovná a synchronizuje data zařízení s novým účtem.
- API: `GET /api/account/countries`, `POST /api/account/register/check`,
  `POST /api/account/register/start` (ověří znovu; výzva nese otisky
  kontaktů), `register/verify` je uloží a jedinečnost ověří ještě jednou
  (souběh → 409 `taken`). Anonymní „Vytvořit účet“ zůstává beze změny.

### Přidáno — passkeys na Androidu
- Aplikace při selhání passkeye kvůli neověřené doméně (WebAuthn
  `SecurityError`, „The incoming request cannot be validated“) ukáže dialog
  *Server tuto aplikaci nepotvrdil* s adresou serveru, balíčkem a SHA-256
  podpisového certifikátu (Kopírovat). Při každém check-inu hlásí serveru
  svůj certifikát.
- Konzole › Android › Security › **Passkeys on Android**: kontrola celého
  řetězce jako z telefonu — co by server vrátil, co vrací veřejná adresa
  `assetlinks.json` z internetu (stav, typ obsahu, otisky), co vidí Google
  (Digital Asset Links), známé certifikáty (vydání / env / důvěryhodné)
  a certifikáty hlášené telefony; verdikt, rady a blok pro nginx.
  Certifikát telefonu jde jedním klikem **označit jako důvěryhodný pro
  passkeys** (`androidConfig().passkeyCertSha256` — jen `assetlinks.json`
  a WebAuthn origin aplikace, nikdy kontrola vydání APK).
- `update.sh` po každé aktualizaci ověří veřejné `assetlinks.json` a když
  ho proxy blokuje, vypíše přesný blok `location =` pro nginx. Aktualizaci
  nikdy neshodí.

### Změněno
- Verze 6.4.0 (versionCode aplikace 60400). Instalátor 3.2.0.
- Trezor účtu má nový šifrovaný slot `registration` (soubor, databáze
  SQLCipher, `GET/PUT /api/account/vault`) — ukládání profilu z předvoleb ho
  nepřepíše.
- Přírůstky designu Androidu v `server/android/design-64-registration.ts`
  (menu, texty). Vestavěný design aplikace je obsahuje; zařízení, které má
  nainstalovaný build designu z konzole, je uvidí až po publikování nového
  buildu (Android › Builds).

### Bezpečnost
- Jméno, země, telefon ani e-mail nejsou na serveru v čitelné podobě: účet
  nese jen HMAC-SHA256 normalizovaného e-mailu a mobilu (náhodný pepř
  v `registration.json`, 0600, nebo `REGISTRATION_PEPPER`), profil je
  zašifrovaný klientem. Audit zapisuje jen názvy polí a kódy chyb.
- Kontrola jedinečnosti je věštírna („je tento e-mail registrovaný?“), proto
  má vlastní limit (20 dotazů / 10 min / adresa) a zapisuje se do auditu.
- Certifikát důvěryhodný pro passkeys otevírá passkeys serveru každé
  aplikaci s tím podpisem — konzole to před potvrzením řekne; do vydání APK
  se nepromítne.

## [6.3.0] – 2026-09-30

**NFC, celý.** Nástroj NFC ve webu i v aplikaci Android čte, zapisuje a
emuluje karty přes vybranou čtečku (interní, USB, Bluetooth) a nese vlastní
šifrovanou **kartu M5Cet** se záznamy (záloha passkey a identity, jednorázová
i běžná zpráva, server a místnost, externí klíč, kontakt, Wi-Fi, přihlášení
k URL). Model ve Functions umí přes `m5.nfc` ovládat čtečku volajícího
obousměrně. Jen standardní operace nad kartami, které držíte — žádné
prolamování neznámých klíčů; EMV a e-ID jen veřejná data.

### Přidáno — web i Android
- **Výběr čtečky**: interní anténa (WebNFC / `NfcAdapter`), USB PC/SC (CCID —
  ACR122U, ACR1252U…), Bluetooth (PN532 / bridge), na webu i sériová (PN532).
- **Technologie karet**: M5Cet karta, připojka, NDEF (Type 1–5), MIFARE
  Classic 1K/4K/Mini, Ultralight, NTAG 213/215/216, DESFire EV1/2/3, ISO-DEP,
  ISO/IEC 14443 A/B, ISO/IEC 15693, FeliCa, EMV (veřejné), e-ID/MRTD (veřejné).
  Souvislý sken ukáže UID, typ a veřejný záznam; „Spustit funkci" nabídne
  přesně operace daného typu.
- **Operace**: čtení UID a veřejných dat, NDEF čtení/zápis/uzamčení; MIFARE
  Classic čtení/zápis/dump/obnova s vaším **slovníkem klíčů**; Ultralight/NTAG
  stránky, heslo, čítač; DESFire seznam aplikací a souborů + čtení/zápis
  s klíčem; ISO 15693 bloky; FeliCa systémy; EMV veřejná data (PPSE, štítky,
  maskovaný PAN); e-ID typ dokumentu; **změna UID** na magic kartách;
  APDU konzole. Co daná čtečka neumí, je zřetelně vypnuté, ne předstírané.
- **Karta M5Cet**: šifrovaný kontejner záznamů na NFC tagu (NDEF externí typ
  `m5cet.cz:card`), každý záznam zvlášť AES-GCM — klíč z **PINu (6–18 číslic,
  externí, otevře na jakémkoli zařízení)** nebo z **účtu/passkey (interní, jen
  vaše zařízení)**. Jednorázový záznam se po zobrazení z karty smaže. Čtení
  vypíše záznamy s akcí zobrazit / uložit / spustit. **Vizuální builder**
  vytváří a upravuje karty (přidání záznamů, typ šifrování, jednorázovost,
  velikost vs. kapacita tagu). Formát je bajtově shodný na webu i v Androidu
  (ověřeno testem).
- **Functions `m5.nfc`**: objekt (reader/enum/card/scan/read/write/emulate +
  `m5.nfc.m5` pro kartu M5Cet), JS i Python. Volání se stane **NFC interakcí**
  běhu (stejný kanál jako dotazy a formuláře): model čeká, příkaz dojde
  k volajícímu, jeho zařízení ho provede a vrátí výsledek — i z běhu spuštěného
  webhookem (server může iniciovat). Uzly ve vizuálním builderu, balíčky
  `nfc-scan` / `nfc-uid` / `nfc-open` a ukázkové modely.

### Přidáno — Android
- Nástroj NFC přepracován do plné parity s webem: abstrakce čtečky (interní +
  USB host PC/SC + rozhraní pro BLE), detekce technologie, čtení/zápis/emulace,
  `M5Card.java` jako bajtově shodný port formátu, builder karet, HCE emulace
  karty M5Cet i připojky. Původní připojka (čtení/zápis/emulace) zůstává
  kompatibilní s webem.

### Přidáno — Define (`m5mobile.define`)
- **Typované proměnné a konstanty** definované jednou v konzoli
  (Android › *Define*) a předané všem běhům jako živé hodnoty pod
  `m5mobile.define.<název>`: skalár (`string`, `text`, `integer`, `float`,
  `boolean`, `bytes`, `script`, `enum`) i dynamický typ (`object`, `array`,
  `class`) do libovolné hloubky. **GUI builder**: vlevo navigátor (název +
  ikona typu, proměnná / konstanta), vpravo obsah — přejmenování, změna typu,
  rozsah (`android`/`web`/`both`), max. velikost; skalár jako input nebo
  textarea (nad 512 znaků), dynamický typ jako rekurzivní builder (klíč, typ
  hodnoty, max. velikost). Uloženo jako JSON přes `PUT /api/admin/define`,
  validováno sdíleným modulem (`client/src/lib/define/schema.ts`).
- Hodnoty dostane **Web** (`GET /api/define?scope=web`, `window.m5mobile.define`
  a hook `useDefine()`), **Android** (`app().define`, v obrazovkách
  `define.<název>`, sync při check-inu, cache ve vaultu) i **Functions** (Modely,
  balíčky a nástroje — `m5mobile.define.<název>` v JS i Pythonu). Podrobně
  `docs/define.md`.
- **Šablona aplikace (APDU)**: u karet ISO-DEP a EMV je vedle *Vybrat aplikaci*
  tlačítko s ikonou plné šipky dolů, které rozbalí menu operátorových šablon
  (`m5mobile.define.apduTemplates`, pole `{ label, apdu }`). Vybraná šablona
  pošle APDU přes ISO-DEP a ukáže odpověď — na telefonu (PopupMenu) i na webu
  (dropdown, který ji načte a spustí v APDU konzoli).

### Opraveno
- **Zápis karty M5Cet funguje na jakémkoli tagu** s dostatkem paměti, ne jen na
  už zformátovaných NDEF tazích: na Androidu i webu se zápis nově řídí podle
  technologie — **MIFARE Classic** (MAD + NDEF, klíče `D3F7…` / factory),
  **Ultralight** a formátovatelné tagy — s typovanými chybami (jen ke čtení,
  málo paměti, chybí klíč, nepodporováno) místo tichého selhání. WebNFC zapíše
  na jedno přiložení.

### Změněno
- Verze 6.3.0 (versionCode aplikace 60300). Instalátor 3.1.0.
- Přírůstky designu Androidu po oblastech v `server/android/design-63-nfc.ts`.
- `npm run android:release` (podepsané vydání) a `update.sh --android`
  (sestaví podepsané vydání pro Android po úspěšné aktualizaci serveru —
  vyžaduje Android SDK a keystore; selhání jen varuje).

### Bezpečnost
- Model nikdy nedostane ani nepošle klíč či PIN karty: chráněná karta se
  používá přes `secretRef` (jméno, které zařízení vyřeší lokálně), server
  odstraní tajné argumenty na vstupu i výstupu. `m5.nfc` je pod přístupovými
  právy modulu NFC jako `m5.telephony`.
- Klíč karty M5Cet se neukládá; PIN se nikam nezapisuje. Kód nedělá obnovu
  neznámých klíčů (nested/darkside/hardnested) ani klonování platebních karet;
  EMV a e-ID jsou jen veřejná data.

## [6.2.0] – 2026-09-30

**Bubliny, které řeknou všechno.** U každé zprávy je ikona (i) s detailem:
datum a čas, velikost, druh, příjemci a **všechny stavy s časem** (odesílá,
ve frontě, uloženo na serveru šifrovaně, doručeno, přečteno, zobrazeno,
vypršelo…), potvrzení od každého příjemce zvlášť. Zprávu jde **skrýt**
(15 min – do dalšího přihlášení) nebo **smazat** ze svého pohledu — server se
dozví jen *že* se to stalo (audit, kategorie `message`), nikdy obsah. Poloha
má **náhled mapy s ulicemi** a špendlíkem, přílohy náhledy a patičku
s uložením, sdílením a přeposláním. Aplikace pro Android dostala panel lidí
jako na webu, propojení s kontakty telefonu, nový vzhled se šablonami
a opravy registrace QR kódem, passkeys a obrazovky PIN.

### Přidáno — web i Android
- **Detail zprávy** (ikona (i) v bublině): datum a čas, odesílatel, příjemci,
  velikost (text / soubor), druhy (klikací, mizející, zapečetěná, soukromá,
  přeposlaná, odpověď, výstup funkce, přepis), expirace a **časová osa** —
  společný slovník obou klientů: `created`, `encrypted`, `sent`, `received`,
  `decrypted`, `displayed`, `queued`, `stored` (uloženo na serveru,
  šifrovaně), `forwarded`, `delivered`, `read` a nově `revealed` (klikací
  zpráva zobrazena), `opened` (zapečetěná otevřena), `expired` (mizející /
  TTL), `hidden`, `unhidden`; potvrzení doručení a přečtení u každého
  příjemce zvlášť.
- **Skrýt a smazat** v detailu: skrýt na 15 min, 1 h, 8 h, 1 den nebo do
  dalšího přihlášení (web: host do dalšího načtení stránky; Android: do
  dalšího odemčení); smazat (po potvrzení) odstraní bublinu z tohoto
  zařízení i uložené historie — ostatním zůstává. „Zobrazit skryté (n)“
  v místnosti. Obojí se zapíše do auditu: `POST /api/chat/message-audit`
  (web, s tokenem účtu, když je přihlášený) a `POST
  /api/android/message-audit` (podepsané klíčem zařízení) — akce, id zprávy,
  hash místnosti, druhy, vlastní / cizí, konec skrytí; **nikdy text**.
- **Náhled mapy** ve zprávě s polohou: dlaždice s ulicemi vystředěné na
  polohu, špendlík uprostřed s popiskem „Aktuální poloha: <jméno>“, souřadnice
  ± přesnost, atribuce, volitelně šedě; klepnutí otevře celou mapu. Dlaždice
  jdou přes server (`GET /api/map/tile/{z}/{x}/{y}`, mezipaměť na disku
  a v paměti, `Cache-Control: private`), takže poskytovatel mapy nevidí
  adresu klienta a CSP webu zůstává `img-src 'self'`.
- **Média v bublině**: video přímo v bublině, zvuk, náhled textu / Markdownu
  (první řádky), PDF (Android: první strana přes PdfRenderer — na Androidu
  11+ v anonymní paměti, nikdy na disku; web: karta s Otevřít / Uložit),
  obrázky jako dosud. **Patička příloh**: ikona typu, název, velikost
  a tlačítka uložit, sdílet (systémové sdílení / Web Share, jinak nabídka) a
  přeposlat.
- **Konzole**: karta **Map preview** v *Client & addons* (poskytovatel
  dlaždic, subdomény, atribuce, zoom, velikost, barva špendlíku a popisku,
  popisek, souřadnice, šedé dlaždice, doba v mezipaměti) s živým náhledem;
  nová kategorie auditu **message** ve filtru Auditu. Politika `map` je
  součástí konfigurace klienta (`client/src/lib/client-config.ts`,
  `MapPreviewPolicy`) a platí pro web i Android. Admin služba přeposílá
  `/api/map/tile/*` hlavní službě (náhled v konzoli na ADMIN_PORT).
- **Layout builder**: nové uzly zpráv `map` (`map-box`, `map-tile`,
  `map-pin`, `map-caption`, `map-coords`, `map-attribution`), `attach-video`,
  `attach-pdf`, `attach-text`, patička `files` (`file`, `file-save`,
  `file-share`, `file-forward`), `hidden-tag`; v chatu `show-hidden`;
  v okně detailu `size`, `expires`, `msginfo-receipts`, `msginfo-manage`.

### Přidáno — Android
- **Panel lidí jako na webu**: monogram (nebo fotka propojeného kontaktu),
  jméno a `@účet`, ikona stavu (online, light = host bez účtu přes P2P, dnd =
  v hovoru, away = server drží zprávy, připojuje se, offline), štít ověření,
  signál (4 čárky z RTT spojení WebRTC), **zaškrtávátko** komu jde příští
  zpráva a řádek *Vybrat vše* / *Zrušit výběr*. Klepnutí na člověka otevře
  detail: účet, peer id, stav, jak dlouho je připojený, spojení (přímo /
  TURN, kandidáti, RTT, kodeky, DTLS a SRTP), otisky klíčů a bezpečnostní
  číslo s ověřením; akce soukromá zpráva, hovor, video, ověřit, propojit
  s kontaktem.
- **Propojení s kontakty telefonu**: u kontaktu se přidá pole M5cet
  s uživatelským jménem (vlastní typ účtu a sync adapter,
  `vnd.cz.m5cet.message` / `vnd.cz.m5cet.call`). *Zpráva přes M5cet* /
  *Volat přes M5cet* v aplikaci Kontakty najde člověka přihlášeného v některé
  z připojených místností a otevře **soukromou zprávu jen jemu**, nebo zahájí
  hovor; když není online, řekne to. Jen pro lidi s účtem, jen pro jména
  propojená v této aplikaci; nastavení *Lidé a kontakty* (vypnutí odstraní
  řádky i účet, wipe také).
- **Vzhled** (Nastavení › Vzhled, s živým náhledem): 13 šablon z webu, u
  každé **6–8 barevných variant** (kontrast hlídaný pro světlý i tmavý tón),
  9 písem, 5 velikostí, pohyb (vypnuto / jemný / normální / živý + rychlost),
  tlačítka (plná / tónová / obrysová / textová; zaoblená / pilulka / hranatá;
  odezva vlnka / zmenšení / žádná; haptika). Změny se projeví hned, bez
  restartu obrazovky. Klidnější výchozí barvy, ploché horní lišty s linkou,
  avatar místnosti v liště.
- **Nástroje (kladívko)** jako kompaktní plovoucí okno přichycené dole nad
  řádkem zprávy; po klepnutí na nástroj zmizí, klepnutí mimo nebo Zpět ho
  zavře (nastavení vrátí list zespodu).
- **Tlačítko Odeslat** ukazuje, komu zpráva půjde: celá místnost = odznak
  skupiny, jen vybraní = jiná barva a odznak jedné postavy; tři tečky v rohu
  a jednorázová nápověda „Podržením zobrazíte další volby“.
- **Mikrofon vedle Odeslat nahrává hlasovou zprávu** (jako web); diktování
  má vlastní ikonu v poli zprávy (podržení = jeho nastavení). Po povolení
  mikrofonu nebo fotoaparátu akce pokračuje sama (`withPermission`), chyby
  (žádný mikrofon, odepřeno, zablokováno, obsazeno, příliš krátké) jsou vidět.
- **Klávesnice PIN**: všech deset číslic s písmeny jako na telefonu (2 = ABC
  … 9 = WXYZ), každá klávesa jiná barva; Nastavení › Zabezpečení › *Míchat
  klávesy PIN* (`security.shufflePin`) — číslice nejsou v pořadí a po každém
  ťuknutí se přemíchají (proti pohledu přes rameno a otiskům na skle).
- **Obrazovka PIN**: klávesy se velikostí přizpůsobí místu (40–84 dp, i
  krycí displej Fold6, rozdělená obrazovka, na šířku hlavička vedle
  klávesnice), karta s tečkami, zatřesení při chybě, podržení ⌫ smaže vše.
- **Passkey účet vázaný na telefon**: poskytovatel bez PRF (např. Samsung
  Pass) dostane náhodný kořen uložený v uživatelské vrstvě trezoru (přežije
  odhlášení); v Nastavení › Uživatel obnovovací kód a přidání passkeye s PRF.

### Opraveno
- **Aplikace Android padala při spuštění** (6.1.0): obsluha příkazů `fn`
  četla aplikaci dřív, než ji aktivita nastavila (NullPointerException
  v `Fn.commands()`), a Android se vracel na plochu.
- **Registrace QR kódem** (`m5cet://enroll?server=…&kid=…`): když byla
  aplikace otevřená, odkaz přišel přes `onNewIntent` a pole formuláře zůstala
  prázdná. Odkaz teď rozebere testovaný parser, formulář převezme novější
  vyplnění, ukáže klíč serveru z QR a bez kódu zaostří jeho pole; už
  registrované zařízení to řekne.
- **„Tento passkey není na serveru registrovaný“**: registrace skončila před
  `/register/verify`, když passkey při vytvoření nedal PRF — v telefonu zůstal
  osiřelý passkey. Teď následuje ověření jen pro PRF (jako web), jinak účet
  vázaný na telefon; registrace se vždy dokončí nebo řekne přesně co dál;
  osiřelý passkey nabídne *Vytvořit účet*.
- Po odemčení vypadal účet jako odhlášený (stav se četl ze zamčeného trezoru);
  `Account.restore()` se po odemčení nevolal.
- Mikrofon a fotoaparát po povolení oprávnění nic neudělaly (aplikace neměla
  obsluhu výsledku).
- Výběr šablony vzhledu se neukládal (`appearance.preset` chybělo mezi
  výchozími klíči); každá změna vzhledu restartovala aktivitu.
- Úchyt listů byl neviditelný (spacer nekreslil pozadí), řádky s `wrap` se
  nezalamovaly.
- Web: tlačítko (i) nešlo stisknout (hlavička bubliny ležela nad ním);
  vložený zvuk z `data:` URL by v produkční CSP nehrál; uložená historie
  držela jen posledních 12 kroků časové osy (teď první + nejnovější, 200).
- Android: `readAllBytes`/`transferTo` (API 33) v přehrávání médií na
  Androidu 10–12.

### Bezpečnost
- Audit skrytí / smazání nese jen metadata (akce, id zprávy, hash místnosti,
  druhy, konec skrytí); web posílá místnost jako její slepé id. Obsah zprávy
  ani soubor server nikdy nedostane.
- Dlaždice mapy jen přes server; v telefonu jen v paměti (dlaždice prozrazuje,
  kde někdo byl); nginx (repo i instalátor) má pro `/api/map/tile/` vypnutý
  access log. Poskytovatel dlaždic je https (http jen pro tento stroj),
  bez přihlašovacích údajů.
- Kontakty: řádky M5cet obsahují jen uživatelské jméno; zařízení reaguje jen
  na jména propojená v aplikaci; wipe (i vzdálený) je odstraní.
- Debug build dovolí snímky obrazovky jen se značkou v soukromých souborech
  aplikace (`run-as`); release na ni nehledí.

### Změněno
- Verze 6.2.0 (versionCode aplikace 60200).
- Design aplikace Android: přírůstky 6.2 po oblastech v
  `server/android/design-62-{fixes,people,bubbles,look}.ts`, spojené v
  `design-62.ts`.

## [6.1.0] – 2026-09-30

**Konzole po svém.** Boční menu se sbalí na šířku ikon, stránky konzole
(Přehled a všechny záložky Functions) si každý administrátor uspořádá —
po odemčení zámku přesouvá panely, mění jim velikost, zalamuje je do řádků,
skrývá a zarovnává; zamčením se rozvržení uloží do jeho nastavení na
serveru a jde kdykoli vrátit. Functions dostaly IDE na celou obrazovku,
statistiky schované do jednoho řádku a ikony. Chat umí potvrzení doručení
a přečtení mezi připojenými a polohu ve zprávě, aplikace pro Android
passkeys.

### Přidáno
- **Menu sbalitelné na ikony** (tlačítko vedle loga, `.shell--collapsed`,
  64 px): názvy položek v tooltipu, odznaky jako malá čísla v rohu ikony, na
  úzké obrazovce řádek ikon. Tooltipy konzole (`data-tip`) místo `title`.
- **Rozvržení stránek** (`admin-ui/public/panel-layout.js`,
  `window.M5Layout`): Přehled a záložky Functions (Packages, Builder,
  Models, Schedules, Webhooks, Runs, Tutorial) skládají karty do panelů.
  Zámek (horní lišta, u Functions vedle záložek) je odemkne: přesun tažením
  za lištu panelu nebo šipkami, šířka a výška za kraje a roh (dvojklik
  vrátí výchozí), nový řádek, vyplnit / pevná šířka, skrýt a vrátit,
  zarovnání (nahoru, na střed, dolů, stejná výška), rozestupy; klávesnice
  (←/→, Shift+←/→, Alt+↑/↓). *Lock & save* uloží, *Cancel* / Esc zahodí,
  *Reset* vrátí výchozí. Pod 820 px jsou panely pod sebou.
- **Nastavení administrátora**: `GET` / `PUT /api/admin/me/prefs`
  (`{ prefs }`, objekt do 64 kB, `admin-prefs.json` v adresáři administrace,
  `0600`); v konzoli `M5Console.pref` / `setPref` se zrcadlem v
  `localStorage`. *Console settings* (ikona v horní liště): menu na ikony,
  trvale otevřené statistiky Functions, *Reset all page layouts*.
- **Ikony konzole** (lucide, ISC): `admin-ui/public/console-icons.js`
  (`window.M5Icons`, `M5Console.icon`) generuje
  `node script/gen-console-icons.mjs`.
- **Functions**: IDE na celou obrazovku (Fullscreen API, jinak přes okno;
  Esc), editor na celou výšku; statistiky schované do horního řádku —
  najetím, kliknutím nebo Enterem se otevřou přes obsah, připínáček je
  nechá otevřené; ikony na záložkách a tlačítkách (editor, tvůrce, modely,
  plány, běhy, tutoriál); detail běhu v panelu vedle seznamu; webhooky se
  souhrnem v dlaždicích, endpointy jako karty (adresa, režim, log, zpětné
  volání), modely bez webhooku s *Create*, log volání s metodou a stavem;
  formulář nového plánu v panelu; lekce tutoriálu jako kroky.
- Testy: `/api/admin/me/prefs` (`test/admin-roles.test.ts`), E2E konzole
  6.1 (menu, tooltip, odemčení, přesun, skrytí, zarovnání, uložení, obnova
  po novém načtení, reset, statistiky, celá obrazovka).

### Android a klient (6.1)
Aplikace pro Android dostala všechny funkce webu z chatu.
- **Uživatel a passkey** — Nastavení › Uživatel: přihlášení a odhlášení
  účtu passkeyem (Credential Manager, `android:apk-key-hash`,
  `/.well-known/assetlinks.json`), odhlášení všude, informace o klíči
  (otisk, identita) a o spojení (protokol, místnosti).
- **Stavové ikony zpráv** — odesílá, odesláno, uloženo, přeposláno,
  doručeno, přečteno; potvrzení doručení a přečtení mezi připojenými
  (zapečetěný `receipt` párovým klíčem) a přes relay pro nepřítomné.
- **Přílohy** — obrázek, fotoaparát, soubor, hlasová zpráva; velké soubory
  po kouscích (šifrovaný přenos, `FileVault` — segmenty AES-GCM), obrázky
  v bublině, ostatní jako karta s uložením.
- **Poloha** — sdílení polohy jako příloha i v hlavičce zprávy (`loc`);
  bublina má vpravo dole pin, klepnutí otevře mapu (geo:, jinak
  OpenStreetMap); průběžné trasování na server (politika `location`).
- **Druhy zpráv** — klikací (`tap`, podržením se odkryje), mizející
  (`vanishSeconds`, odpočet na každém zařízení), zapečetěná (`sealed`,
  kód `XXXX-XXXX-XXXX`), individuální (výběr příjemců, soukromá zpráva).
- **Příkazy a modely** — `/` příkazy, `@` lidé, `#` tagy (znaky určuje
  operátor); příkaz běží na serveru, výstupy (text, tlačítka, formuláře,
  zvuk, obrázky, soubor) se vykreslí v bublině, živé otázky modelu; balík
  `cz.m5cet.app.fn` (shoda s webem ověřená vektory).
- **Hovory** — audio i video (přepnutí kamery, reproduktor), na podržení
  tlačítka hovoru volba **audio ↔ text**: odeslané zprávy se převedou na
  řeč do streamu, přijatý zvuk se přepíše na text; u bubliny ikona zdroje
  přehraje původní zvuk.
- **Rychlé nástroje (kladívko)** — AI asistent (server, streamovaná
  odpověď, výběr modelu; není end-to-end šifrovaný a říká to), Hlas
  (TTS/STT, jazyky, hlasy, pitch a rychlost, diktování s autoplay, převod
  diktátu zpět na řeč), NFC (čtení a psaní karet, emulace jako Type 4 tag),
  Vzhled (šablony a akcenty z webu, světlý/tmavý, hustota, velikost písma,
  tvar bublin).
- **Diktování a hlasové odesílání** — mikrofon na řádku zprávy (podržení
  otevře nastavení diktování), volba u tlačítka Odeslat: text jako hlasová
  zpráva, nebo řeč přepsaná na text.
- Vše přidáno do **Android › Design** (nové obrazovky, listy nástrojů,
  prvky select/slider/segmented, akce a texty ve třech jazycích).

### Změněno
- Verze 6.1.0 (versionCode aplikace 60100).
- Vizuální tvůrce je rozvržení (paleta · plátno · inspektor) místo pevné
  mřížky; dlouhý panel se posouvá uvnitř sebe a nenatahuje plátno.
- Ovládání rozvržení a nastavení konzole není „akce“ — auditor si svou
  konzoli uspořádá také.

### Opraveno
- Lišta rozvržení nevypisuje „null“; popover nastavení se zavře Esc i při
  změně stránky; dlaždice veřejné adresy webhooků nepřetéká; vyhledávání v
  nápovědě editoru se nezmenšuje; celá obrazovka Functions nenatahuje řádky.
- README uvádělo verzi 4.14.0.

## [6.0.0] – 2026-09-29

**M5cet pro Android** — nativní aplikace v Javě, která je zároveň
**frameworkem** řízeným z konzole: vzhled, obrazovky, animace, texty a
knihovny akcí se sestaví do zašifrovaného a podepsaného balíčku, zařízení
ho ověří, nainstaluje a při chybě se vrátí k poslední funkční verzi. Otevření
chrání biometrie nebo PIN s wipe po opakovaných chybách, všechna data v
telefonu jsou šifrovaná klíči z Android Keystore, server řídí zařízení
zprávami přes Firebase Cloud Messaging. Na webu i v telefonu jde být ve
**víc místnostech naráz** a seznam lidí jde přilepit k okraji a schovat.
Funkce dostaly **administraci jako SDK** (`m5adm`) s řízením místností a
**telefonii** (`m5.telephony`) včetně telefonního mostu do místnosti.

### Přidáno
- **Aplikace pro Android** (`android/`, Java 17, Android 10+, `npm run android:build`):
  - chat protokolem v2 / šifrováním v3 nad WebRTC (DataChannel `m5cet`):
    Argon2id (vlastní implementace, vektor RFC 9106), HKDF, AES-256-GCM,
    ECDSA/ECDH P-256 (P1363), zapečetěné signály, perfect negotiation,
    podepsaný hello, párové klíče, klíče odesílatelů s forward secrecy,
    soukromé zprávy, kontrola identit (TOFU), obrázky do 512 KiB;
  - **víc místností naráz** — každá se svým spojením, výběr zaškrtnutím,
    odznaky počtu lidí a nepřečtených zpráv, lišta místností, přejetí mezi
    nimi, otevření místnosti z notifikace, po odchodu přechod na nejaktivnější;
  - **panel lidí** volně nebo přilepený vlevo, vpravo, dole; připnout nebo
    automaticky schovat za úchyt (`users.handle`), přetažením k okraji přilepit;
  - **zámek**: biometrie (`BiometricPrompt` s `CryptoObject`) nebo PIN;
    počítadlo chyb (PIN i odmítnutý prst), rostoucí čekání, po posledním
    pokusu **wipe** všech dat a klíčů s podepsanou událostí na server,
    automatické zamčení, zákaz snímků obrazovky;
  - **šifrovaná data**: systémová vrstva (Keystore `m5.sys`) a uživatelská
    (biometrický klíč a PIN s pepřem v Keystore), AES-256-GCM vázané na
    záznam, šifrovaný log, historie zpráv, vypnuté zálohy;
  - **řídicí zprávy** ping, status, flash, push, update, lock, wipe, config —
    přes FCM (Firebase se inicializuje nastavením ze serveru, APK nemá
    `google-services.json`) nebo check-inem přes `JobScheduler`;
  - **framework**: nativní renderer stromů obrazovek (sestaví se jednou,
    pak se jen napojují data), jazyk výrazů a šablon, 30+ akcí v Javě,
    knihovny akcí, téma, animace, texty cs/en/de, menu, ikony lucide
    kreslené nativně, obrázky a písma z balíčku;
  - **aktualizace**: balíčky `.m5ab` (ověření podpisu, rozbalení klíče,
    dešifrování, kontrola hashů a manifestu, zkušební běh, návrat na
    poslední funkční), vydání APK (podpis serveru, hash, stejný certifikát,
    `PackageInstaller`);
  - **systém**: hovory ve službě na popředí a v systémovém záznamu hovorů,
    notifikace zpráv s přímou odpovědí a zkratkou konverzace, sdílení textu
    do místnosti, animovaný splash (systémový i designový), odkaz
    `m5cet://enroll` z QR kódu.
- **Server** (`server/android/`): registrace zařízení (open, kódy, closed)
  s důkazem držení klíče, **podepsané požadavky** (čas, nonce), check-in,
  potvrzení příkazů, události (i podepsané před wipe); **buildy** (design →
  kontejner M5PK → gzip → AES-256-GCM po segmentech → podpis ECDSA, klíč
  obsahu zapečetěný a zabalený pro každé zařízení, soubor k nasazení pro
  vybraná zařízení); **vydání APK** (balíček, verze a certifikát přečtené z
  APK, připnutý certifikát, podepsaný manifest); **řídicí zprávy** šifrované
  (ECIES P-256) a podepsané, FCM HTTP v1 bez SDK (servisní účet zapečetěný),
  priority a slučování pro baterii; audit a alerty bezpečnostních událostí.
- **Konzole › Android**: přehled, zařízení (stav, řídicí zprávy, příkazy,
  události, blokace), push (hromadně, nastavení FCM, test), **Design** —
  builder obrazovek se stromem, inspektorem a **živým náhledem telefonu**
  (světlý/tmavý, cs/en/de), téma, animace, texty, menu, knihovny, assety —,
  buildy, vydání, zabezpečení (policy zámku, check-in, aktualizace,
  registrace, kódy s QR), události. Modul `android` v Modules & groups s
  právy `devices`, `push`, `wipe`, `builds`, `releases`, `publish`, `settings`.
- **Web**: seznam lidí (widget příjemců) přilepený k okraji — vlevo, vpravo,
  dole — nebo plovoucí; připnout nebo automaticky schovat za úchyt s
  animací; přetažením k okraji přilepit; rozvržení `widget.handle` v
  Layout builderu, nastavení operátora `widgetSlideMs` a `widgetSlideEasing`.
- **Web: víc místností naráz** (`client/src/lib/room-hub.ts`) — místnosti na
  pozadí běží bez vykreslování se stejným protokolem jako ta na obrazovce
  (podepsané hello, párové klíče a klíče odesílatelů, kontrola zpráv),
  počítají lidi a nepřečtené a po přepnutí předají zprávy; výchozí limit 8.
  **Lišta místností** nad chatem (rozvržení `room.bar`): stav, odznak lidí a
  nepřečtených, přepnutí klepnutím nebo `Alt`+←/→, × odpojí (na obrazovku
  přijde nejaktivnější místnost), + připojí další na pozadí. Zpráva na
  pozadí ukáže upozornění (klepnutí přepne) a „(n)“ v titulku. Okno
  Místnost: zaškrtávátka u uložených připojení a *Připojit vybrané (n)*,
  odznaky lidí a nepřečtených. Modul `rooms` (*Several rooms*) v Modules &
  groups; Layout builder má v sekci App 10 rozvržení.
- **m5adm — administrace jako SDK** (také `m5.adm`, JavaScript i Python):
  `overview`, `rooms`, `connections`, `traffic` (i `watch`), `modules`,
  `groups`, `users`, `passkeys`, `queue`, `audit`, `commands`, `push`,
  `admins`, `info()`. Konvence: `list` → seznam, `get` → objekt nebo `null`,
  `set(id | null, obj)` → id nebo `-1` (důvod v logu běhu), `delete` → bool.
  Místnosti jako objekty `m5room` s `wall_msg`, `user_msg`, `user_flash`,
  `disconnect`, `block`, `unblock`, `connect`, `log`, `refresh`, `save`,
  `forget`; `rooms.list` filtruje podle členů (`room_username`,
  `system_username`, `system_passkey_id`, `system_group`, `room_id`,
  `room_label`, `room_tag`; vzory `preg_match`, `{ match: "any" }`).
  Grant dává jen vlastník (Functions › model › *Beyond the caller*: role a
  oblasti). Tvůrce: skupina *Administration* (Find rooms, Room, Room action,
  Save room record, Room statistics, Administration call, Audit line).
- **Řízení místností**: záznam místnosti (`$DATA_DIR/room-registry.json`:
  popisek, poznámka, štítky, limit členů, blokace s důvodem a časem,
  připnuté oznámení), který hub vynucuje při vstupu (`room-blocked`,
  `room-full`); **oznámení operátora** — rámec `server-notice` (`wall`,
  `message`, `flash`, `wake`), web i Android je ukážou jako *Oznámení ·
  operátor*, připnuté i každému, kdo přijde. Konzole › Místnosti: Flash a
  Odpojit u člena, oznámení, zavřít / otevřít, popisek a limit, odpojit
  všechny, zapomenout. API `/api/admin/rooms/registry[/:id]`,
  `/api/admin/rooms/:id` (+ `notice|disconnect|block|wake`),
  `?members=full`, `DELETE /api/admin/users/:id/passkeys/:cid`,
  `POST /api/admin/audit/entries`.
- **m5.telephony** (JavaScript i Python): `call` s obsluhou jménem
  (asynchronně) nebo funkcí (běh čeká, `on_answer` vrací logiku živého
  hovoru), `wait`, `say`, `hangup`, `steer`, `calls.*`, `actions.*` (say,
  play, pause, gather, record, redirect, hangup), `sms`, `whatsapp`,
  `viber`, `messenger`, `messages.get`, `lookup` (offline číslovací plán
  všech zemí + data poskytovatelů), `hlr`, `did.*`, `log`, `providers()`.
  Poskytovatelé Twilio, Telnyx, Vonage, HLR-Lookups.com a Meta. Každý hovor
  a zpráva má vlastní webhooky `/wh/tel/<token>/…` s kontrolou podpisu;
  příchozí na půjčená čísla `/wh/tel/in/<poskytovatel>`.
- **Telefonní most**: `did.allocate({ room, member, minutes, mode, language })`
  půjčí číslo s 5místným kódem; volající zadá kód a `#` (3 pokusy), zvuk
  přijde přes `/media/tel/<token>` a člen dostane kartu hovoru (rozvržení
  `phone.bridge`): *Přijmout zvukem* v prohlížeči, nebo *Textem* — přepis
  řeči přes AI a řeč a odpovědi čtené hlasem; `auto` přejde na text po 8 s.
  Není koncově šifrovaný (karta to říká). Android ukazuje hovory a přepisy.
- Vestavěné balíčky `tel-call` (`/call`), `tel-sms` (`/sms`),
  `tel-whatsapp`, `tel-viber`, `tel-messenger`, `tel-lookup` (`/lookup`),
  `tel-hlr` (`/hlr`), `tel-did` (`/phone-bridge`) — toky s formulářem,
  instalované **vypnuté** (stojí peníze). Tvůrce: skupina *Telephony*.
  Konzole › Telephony & SIP: karta *m5.telephony* (`GET /api/admin/telephony/sdk`).
- `/help adm` a `/help telephony`.
- `npm run android:build` (debug/release, testy Javy, SHA-256 a certifikát,
  `--install`, `--upload`), `npm run android:assets`; testovací vektory z
  kódu webu a serveru (`script/android-vectors.ts`) a testy Javy, které je
  ověřují bajt po bajtu.

### Změněno
- Verze 6.0.0 (versionCode aplikace 60000).
- Telephony & SIP: nová práva `message`, `lookup`, `hlr`, `did`; běh, který
  nikdo nespustil (webhook, plán, API), potřebuje grant modelu. Placené
  operace jednoho modelu omezuje `TELEPHONY_FN_RATE` (30 za minutu).
- Nové proměnné: `TELEPHONY_DID_POOL`, `TELEPHONY_DID_ASSIGN`,
  `TELEPHONY_DB_FILE`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_WHATSAPP_FROM`,
  `TWILIO_MESSENGER_PAGE_ID`, `TELNYX_WHATSAPP_FROM`, `VONAGE_WHATSAPP_FROM`,
  `VONAGE_VIBER_FROM`, `VONAGE_MESSENGER_PAGE_ID`, `VONAGE_MESSAGES_SANDBOX`,
  `HLRLOOKUPS_API_KEY/SECRET`, `META_PAGE_ID/TOKEN/GRAPH_VERSION`,
  `ROOM_REGISTRY_FILE`, `FUNCTIONS_ADM_KEY_FILE`; `M5CET_ENV_FILE`
  (`none` = žádný `.env`, tak startují E2E testy). `PUBLIC_BASE_URL` je pro
  m5.telephony povinná.
- Layout builder: sekce App má 11 rozvržení (`phone.bridge`), celkem 48.
- Nginx (repo i instalátor): WebSocket `/media/tel/` pro zvuk telefonního mostu.
- Widget příjemců: `locked` se převádí na `dock` (okraj) a `autoHide`;
  tlačítko zámku v hlavičce je volba okraje; `$locked` a `toggleLock`
  v rozvrženích z doby před 6.0 fungují dál.
- Nginx (`deploy/nginx/m5cet.conf` i šablona instalátoru): location pro
  `/api/admin/android/releases/upload` s tělem do 300 MB.
- Katalog ikon: `panel-bottom`.

### Opraveno
- Po přepnutí místnosti nebo uloženého připojení se pozdní zavření starého
  WebSocketu počítalo jako výpadek: obnova nahradila nový socket (4001) a
  jeho zavření spustilo další — smyčka skončila na limitu `/ws` (429).
  Události socketu, který už neplatí, se teď ignorují.
- Seznam příkazů (`/api/functions/commands`) se načítal znovu při každé
  změně stavu spojení a mohl vyčerpat limit API; teď jen při změně účtu.
- Při přepínání se místnost odcházející z obrazovky mohla v liště ukázat
  dvakrát.
- E2E test konzole odpovídá dialogu přístupu k modulům z 5.2 a čeká na
  ukončení serverů (na masteru od 5.2 selhával).
- Konzole vypisovala text „null“ (form builder, nový model, lišta tvůrce,
  chyba kompilace bez uzlu).
- Archiv layoutů značil nové stromy starší verzí.
- Test výstupů funkcí hlásil chybu načítání rámu sandboxu.

### Bezpečnost
- Zařízení podepisuje každý požadavek klíčem, který neopustí Keystore;
  server hlídá čas a jednorázový nonce; zablokované, vyřazené a vymazané
  zařízení nic nedostane.
- Balíčky jsou podepsané serverem a šifrované zvlášť pro každé zařízení;
  aplikace je nepřijme bez platného podpisu připnutého klíče ani s
  nesouhlasným hashem; APK jen se stejným certifikátem, jaký má aplikace.
- Řídicí zprávy jsou šifrované pro jedno zařízení a podepsané (FCM ani
  nikdo po cestě nevidí obsah); opakování a prošlé zprávy se zahazují.
- Servisní účet FCM a klíče buildů jsou zapečetěné hlavním klíčem úložiště;
  nahrání APK čte tělo až po ověření tokenu operátora.
- Wipe po vyčerpání pokusů smaže data i klíče a nahlásí se serveru
  (audit `security`, alert) i když zařízení bylo mezitím offline.
- m5adm: grant jen od vlastníka; podepsaný krátkodobý token funkce s rolí a
  oblastmi, vynucený v operátorském API cestu po cestě, vlastní limit
  požadavků, audit `fn:<model>/<volající>`; povolený model smí měnit jen
  vlastník.
- m5.telephony: webhooky s tokenem pro každý hovor a zprávu a kontrolou
  podpisu poskytovatele; kód mostu jen 3 pokusy, zadané číslice se do logu
  zapisují maskované; most není koncově šifrovaný a klient to říká.

### Kompatibilita
- Protokol a šifrování chatu se nemění: web (4.x–6.0) a aplikace jsou v
  místnosti rovnocenní. Účty s passkey a přenos velkých souborů po kouscích
  jsou v aplikaci 6.0 zatím jen na webu.

### Známá omezení
- m5.telephony je ověřené proti napodobeným API poskytovatelů (čísla v
  testech jsou vymyšlená) — skutečný hovor zatím testovaný nebyl.
- Zvuk telefonního mostu převezme jen web; Android ukáže hovor a přepis.
- Když se přesměrování půjčeného čísla u poskytovatele nepovede (Vonage bez
  rozpoznané země čísla, chybějící oprávnění), most zapíše varování a
  webhook čísla je třeba nastavit v konzoli poskytovatele.
- Vyzvánění u Twilio může být asi o 5 s delší než `timeout`.

## [5.3.0] – 2026-09-29

Příkazy jako **rozhovor**: model má **vstupní body** pro start, odpověď na
svou zprávu, tlačítka, formuláře, chyby a libovolný počet webhooků, zná
celou **historii volání** (`m5.model`) a jeho výsledek může být **seznam
výstupů** — text, zvuk, tlačítka, formuláře i kód pro prohlížeč.

### Přidáno
- **Vstupní body modelu** (*Functions › Models › Entry points*): každý typ
  volání má svou funkci v balíčku modelu (`soubor#funkce`, výběr ze
  skutečně exportovaných funkcí):
  - **execute** — start: `/příkaz` v chatu, konzole, API, plán;
  - **response** — někdo **odpověděl** na zprávu modelu (dostane `text`,
    `message` a vstupy přečtené z odpovědi jako argumenty příkazu);
  - **button** — kliknutí na tlačítko modelu (`name`, `data`, `event`);
  - **form** — odeslaný formulář modelu (`name`, `values`, `event`);
  - **error** — jiný vstupní bod selhal (výjimka, časový limit, neplatný
    výsledek) nebo prohlížeč nedokázal výsledek zobrazit (`error`,
    `failed`, `source`); jeho odpověď se ukáže místo holé chyby, jeho
    vlastní chyby se jen logují (nic se necyklí);
  - **webhook** — příchozí HTTP volání; **webhooků může být víc**, každý
    s vlastní automaticky vytvořenou URL (kopírovat v seznamu), funkcí,
    režimem, kontrolou HMAC a logem.

  execute, response, button, form a error jsou jedinečné. Ke každému řádku
  patří jeho **Inputs** (kontrolované a typované; u webhooku pole JSON těla —
  `application/json`, nové typy `object` a `array`).
- **`m5.model`** — „sezení zpracování“ modelu: `calls` (každé volání
  `{ type, parms, result, status, err_msg, http }`, `calls[0]` je vždy
  první — execute nebo webhook), `current`, `last`, `first`, `call`,
  `chain`, `endpoints`, `type` a vlastní **`m5.model.session`** a
  **`m5.model.cache`** jen pro toto sezení. `http` u webhooku nese URL
  (token maskovaný), metodu, GET a POST.
- **Výsledek jako seznam**: vstupní funkce vrací jeden výstup nebo **pole
  výstupů** — každá položka se zobrazí, přehraje nebo spustí samostatně;
  vadná položka neshodí ostatní, zaloguje se a předá se vstupnímu bodu
  **error**. Stejné pravidlo kontroluje server i prohlížeč
  (`client/src/lib/fn-outputs.ts`).
- **Nové výstupy**: `m5.out.audio`, `m5.out.video`, `m5.out.flash`,
  `m5.out.window`, **`m5.out.button`** / `buttons` (titulek, name, data,
  třídy, barvy, ikona, potvrzení, jednou), **`m5.out.form`** (panely
  v řádcích nebo sloupcích, popisky nad nebo vedle, text, textarea,
  číslo, posuvník, telefon, e-mail, URL, heslo, datum, čas, datum a čas,
  měsíc, barva, **maska**, **select a multiselect s ikonami**, radio,
  checkbox, přepínač, skryté, statický text, oddělovač) a **`m5.out.js`**.
- **Kód v prohlížeči** (`m5.out.js`, `m5.browser.run`): běží v izolovaném
  rámu `/fn-sandbox.html` (neprůhledný origin — žádný přístup k aplikaci,
  úložišti ani klíčům) s API `m5.args`, `m5.root`, `m5.flash`,
  `m5.send` (→ button), `m5.submit` (→ form), `m5.log`, `m5.play`;
  `hidden: true` = efekt, který proběhne jednou. **`m5.browser`**: `run`,
  `play`, `flash`, `open` (odeslané hned během běhu).
- **Knihovna výstupů v aplikaci** (`client/src/components/fn/`): každá
  položka má vlastní ochranu (error boundary a try/catch), zvuk a video
  přes blob, notifikace (flash) jednou u nové zprávy, soubory jako stažení,
  tlačítka v řadě, formulář s kontrolou (povinné, e-mail, čísla, maska,
  vzor), vlastní výběr s ikonami a klávesnicí. Zprávy příkazů do
  místnosti nesou výstupy šifrovaně (velká média zůstanou volajícímu).
- **Odpověď na zprávu modelu** v chatu spustí jeho vstupní bod response
  (v místnosti odejde i jako běžná zpráva, u výsledku jen pro volajícího
  zůstane u něj).
- `POST /api/functions/event` — response, button, form, error a log
  z aplikace (stream jako `/run`); konzole: `/admin/functions/event`,
  `/admin/functions/exports`, `/admin/functions/chains`,
  `DELETE /admin/functions/webhooks/:model/:endpoint`.
- **Konzole**: editor vstupních bodů s výběrem funkcí a vstupy u každého
  řádku; interaktivní tlačítka, formuláře a „Reply“ ve zkušebních bězích
  (i u konceptů, tutoriálu a vizuálního tvůrce); dialog se sezením
  (`m5.model.calls`); záložka **Tools** v editoru — **Form builder**
  (GUI s náhledem a kódem v JS i Pythonu), **Button**, **Browser
  JavaScript** a kostry vstupních funkcí; nové šablony v našeptávači.
- **Vizuální tvůrce**: tok může mít **víc funkcí** (záložky execute,
  response, button, form, error, webhook…) v jednom souboru; nové uzly
  *Play sound*, *Button*, *Form* (form builder v inspektoru), *Browser
  code*, *Entry point data*, *Model session*; *Remember* umí
  „conversation“ (`m5.model.session`/`cache`); *Create model…* z funkcí
  udělá vstupní body.
- **Vestavěné příkazy 1.1.0**: `/help` s tlačítky témat a novými tématy
  (`endpoints`, `results`, `buttons`, `forms`, `browser`, `model`),
  odpověď na zprávu vybere téma; `/dns`, `/whois`, `/web`, `/mail` a
  `/domain` se ptají formulářem, mají tlačítka (jiný typ záznamu, záznamy,
  bezpečnost, znovu), odpověď s jinou doménou a přátelský vstupní bod
  error. Starší instalace se při startu aktualizují.
- **Tutoriál**: lekce 10–16 — seznam výsledků, tlačítka, formuláře,
  `m5.model` a odpovědi, kód v prohlížeči, vstupní bod error, Python.

### Změněno
- Model ukládá vstupní body (`endpoints`); `entry` a `inputs` jsou
  vstupní bod execute a `executors.webhook` první webhook — starší modely
  se načtou beze změny chování, webhooky si ponechají URL.
- Text zprávy v rozvržení je `<div>` (výstupy mají nadpisy a tabulky);
  výchozí rozvržení je archivované pro slučování.
- Běh ukládá své sezení a volání (`chainId`, `callId`, `endpoint`); sezení
  se uklízejí s běhy (`FUNCTIONS_RUNS_DAYS`).
- CSP aplikace povoluje rámy jen z vlastního originu (`frame-src 'self'`,
  kvůli `/fn-sandbox.html`).

### Opraveno
- Výstupy příkazů se v chatu zobrazovaly jen jako Markdown — obrázky,
  soubory, notifikace a okna se ztrácely; teď se vykreslí všechny typy.
- `m5.caller.send` s neplatným výstupem ho tiše zahodil; teď se zaloguje a
  dostane ho vstupní bod error.
- Plain objekt se známým `type` se omylem bral jako výstup i u dat — teď
  jen s klíčem svého typu (`{ type: "flash", text }`).
- Konzole ve výsledku zkušebního běhu neukázala odpověď vstupního bodu
  error.
- Konzole vypisovala text „null“ — ve form builderu u vybraného pole, pod
  editorem nového modelu (bez tlačítka Delete), v liště vizuálního tvůrce u
  role viewer a u chyby kompilace bez uzlu.
- Archiv layoutů označil nové stromy zpráv verzí 5.2.0 místo 5.3.0.

### Bezpečnost
- Kód z funkcí běží v prohlížeči jen v izolovaném rámu s vlastní CSP
  (`sandbox allow-scripts`, bez `allow-same-origin`); s aplikací mluví
  jen omezenou sadou zpráv s limitem počtu.
- Tlačítka, formuláře i odpovědi prochází stejnou kontrolou přístupu
  k modulu a modelu jako příkaz; ID sezení má 96 náhodných bitů; výstupy
  od ostatních v místnosti se znovu kontrolují (typy, velikosti, třídy
  a barvy tlačítek, pole formulářů).
- Hlášení z prohlížeče (chyby, logy) mají limit na sezení a minutu.

## [5.2.0] – 2026-09-29

Nástroje konzole jako **moduly s řízeným přístupem**, **webhooky s plným
logem a replayem**, opravené spouštění příkazů `/` v chatu a vestavěné
příkazy **`/help`**, **`/whois`**, **`/dns`**, **`/web`**, **`/mail`**
a **`/domain`**.

### Přidáno
- **Nástroje jako moduly** (*Modules & groups*): *Functions*, *AI & speech*
  (`ai` a `speech`), *Telephony & SIP*, *Layout builder* a *Menu builder*
  mají každý svůj řádek s nastavením:
  - **výchozí přístup** `allow` / `deny` — pro ty, kdo nejsou v žádné
    skupině modulu;
  - **přístup skupin** `allow` / `deny` a **přístupové skupiny** — jejich
    členové mají přístup povolený, nebo naopak zakázaný;
  - **hlavní skupina** `mod-<modul>` se všemi právy — vznikne sama, když
    chybí (při startu služeb i při otevření stránky);
  - **granty** skupin: jen části modulu, se zástupnými znaky a odebráním
    přes `-`. *Functions*: `model:dns*`, `package:net*`, `*check`,
    `-model:whois`, `run`, `edit`, `publish`, `webhooks`. *AI*:
    `provider:openai`, `model:anthropic/claude*`, `-provider:elevenlabs`,
    `chat`, `settings`, `playground`. *Speech*: `provider:local`,
    `model:local/piper-cs*`, `tts`, `stt`. *Telephony & SIP*:
    `sms`, `call`, `number:+420*`, `settings`, `test`. *Layout / Menu
    builder*: `edit`, `publish`, `history`;
  - **log** přístupů: vše / jen odmítnutí / vypnuto;
  - **„Test access“** vysvětlí rozhodnutí pro uživatele, správce konzole
    (`admin:jméno@role`) nebo hosta.

  Členy skupin mohou být uživatelé aplikace i správci konzole
  (`admin:jméno`); skupiny `admin`, `admin-owner`, `admin-operator`
  a `admin-auditor` jsou vestavěné. Konzole schová nástroje, ke kterým
  správce přístup nemá; **vlastník konzole se nikdy nezamkne**.
- **Rychlé a logované kontroly** (`server/access.ts`): rozhodnutí se
  kešuje podle konfigurace a skupin, práva jsou předkompilované vzory.
  Kontrolují se API aplikace i konzole: běh a seznam příkazů Functions
  (i webhooky), modely a poskytovatelé AI a řeči (seznam i volání), SMS
  a hovory telefonie podle čísla, zápisy v Layout a Menu builderu.
- **Log přístupů** (`server/access-log.ts`): povolení i odmítnutí
  s modulem, subjektem, důvodem, právem, cestou a IP; denní soubory
  `$DATA_DIR/access/access-RRRR-MM-DD.jsonl` (zápis po dávkách,
  `ACCESS_LOG_DAYS`, výchozí 30; `ACCESS_LOG=0` vypne). V konzoli karta
  s filtry, statistikou a živým obnovováním; `GET /admin/access/log`,
  `GET /admin/access/me`, `POST /admin/access/explain`.
- **Přepínače služeb** *AI*, *Speech* a nově **Functions** přímo
  v *Modules & groups* (a v hlavičce konzole *Functions*):
  `GET /api/admin/modules/state`, `PUT /api/admin/modules/switches`.
- **Webhooky** (konzole *Functions › Webhooks*):
  - seznam endpointů všech modelů — zapnutí, URL, nová URL (rotace
    tokenu), **režim** `sync` / `async` (202 s adresou stavu) / `auto`
    (odpoví do `WEBHOOK_AUTO_WAIT_MS`, výchozí 25 s, jinak 202), zpětné
    volání (`?callback=` nebo `X-Callback-URL`, přes ochranu SSRF),
    HMAC podpis a úroveň logu (`full` / bez těl / `off`);
  - **plný log** každého volání: metoda, cesta, dotaz, hlavičky (tajné
    maskované), tělo do 256 kB, **rozparsované proměnné** (JSON, formulář,
    multipart se soubory, XML, text, binární data), odpověď s hlavičkami
    a tělem, běh, doba a chyba; filtry a statistiky;
  - **replay** na publikované verzi i na **konceptu** a „Debug in the
    editor“ — vstupy volání se otevřou v testovacím formuláři balíčku;
    „Copy as curl“;
  - **asynchronní volání**: `GET …/runs/:runId` vrátí stav, výstupy
    a otázky, na které běh čeká, a `POST …/runs/:runId/answer` na ně
    odpoví; tělo může být i `{"inputs": {…}}` jako u API.
- **Aktivační znaky psaní zprávy** (*Modules & groups › Message input*):
  `/` příkazy, `@` zmínky (lidé v místnosti), `#` štítky — lze přidat
  další znaky (např. `!` pro příkazy) a předvolené štítky. `@jméno` a `#štítek`
  se ve zprávách zvýrazní; klik na štítek filtruje konverzaci.
- **Vestavěné balíčky** (`server/functions/builtins`), nainstalované při
  prvním startu (`FUNCTIONS_BUILTINS=0` vypne) a v galerii *Functions ›
  Packages*:
  - **`/help`** — návod: syntaxe, všechny příkazy, které smí volající
    spustit, s parametry, výchozími hodnotami a příklady, webhooky a API,
    štítky; `/help dns` vysvětlí jeden příkaz, `/help ?` nabídne výběr;
  - **`/whois`** — držitel domény nebo IP přes RDAP (registrátor, data,
    stav, name servery, DNSSEC, abuse);
  - **`/dns`** — záznamy `full`, A, AAAA, CNAME, MX, NS, TXT, SOA, CAA,
    SRV, PTR;
  - **`/web`** — analýza stránky: stav, rychlost, server a technologie,
    bezpečnostní hlavičky, meta a SEO, robots.txt, sitemap, odkazy,
    sociální sítě;
  - **`/mail`** — MX a poskytovatel, SPF, DKIM, DMARC, MTA-STS, TLS-RPT,
    BIMI, skóre a doporučení;
  - **`/domain`** — celkový obraz domény: registrace, DNS, web, hosting,
    e-mail, sociální sítě a odkazy;
  - sdílená knihovna **`netkit`** (`pkg:netkit`). Bez zadaného vstupu
    ukáže příkaz formulář.
- SDK: **`m5.functions.list()`** a **`m5.functions.get()`** — příkazy,
  které smí volající spustit (JS i Python).

### Změněno
- Seznam příkazů v chatu se obnovuje (každou minutu, po návratu na
  záložku a před odesláním neznámého příkazu); našeptávač řekne, když je
  služba Functions vypnutá nebo žádný příkaz není k dispozici.
- Příkaz s viditelností „místnost“ se bez příjemců spustí aspoň lokálně.
- Pravidla modulů mají nový tvar (`defaultAccess`, `groupAccess`,
  `grants`, `log`); stará pravidla se načtou beze změny chování.
- Běhy funkcí a log webhooků se uklízejí po `FUNCTIONS_RUNS_DAYS`
  (výchozí 30 dní).

### Opraveno
- **`/` v chatu nespouštěl příkazy**: služba Functions byla ve výchozím
  stavu vypnutá a konzole neměla přepínač; seznam příkazů se nikdy
  neobnovil.
- Webhooky dostávaly **prázdné tělo** — globální parsery JSON a formulářů
  ho spotřebovaly dřív (HMAC podpis tak nešlo ověřit).
- Úklid starých běhů funkcí se nikdy nespouštěl.

### Bezpečnost
- Webhooky: token se porovnává v konstantním čase, v logu je maskovaný
  (i v cestě); `Authorization`, `Cookie` a podpisy se v logu maskují
  a funkci se `Authorization` a `Cookie` nepředávají. Zpětné volání prochází
  stejnou ochranou SSRF jako `m5.http`. Seznam příkazů pro klienty
  neobsahuje tajné údaje.
- Odmítnutí přístupu jsou vždy v logu (pokud ho modul nevypne).
- Práva kombinují akci a položku (`chat provider:local` neotevře ostatní
  poskytovatele, `run model:dns*` ostatní příkazy); konzole Functions
  kontroluje balíček či model u každé změny, běhu, plánu i replaye.
- Pravidla nástrojových modulů, skupiny se správci konzole a přepínače
  služeb smí měnit jen vlastník, resp. správce s právem `settings`/`edit`
  daného nástroje; `/admin/plugins` hlídá modul AI.
- Token webhooku, tajemství HMAC a API token vidí jen ten, kdo smí webhooky
  modelu měnit; tajné hlavičky (i `X-Gitlab-Token`, `Stripe-Signature`…)
  se maskují v logu i v uložených vstupech běhu, token ve `statusUrl`
  odpovědi 202 také. Úroveň logu `meta` neukládá výstupy.
- „Copy as curl“ uvozuje všechny hodnoty pro shell (tělo volání mohl
  poslat kdokoli, kdo zná URL). Webhook odpovídá jen na otázky vlastních
  běhů. Vypnutý modul Functions zastaví i API `/api/functions/call`.

## [5.1.0] – 2026-09-28

Konzole *Functions* přepracovaná pro pohodlné psaní i **skládání** funkcí,
a **řeč zdarma a offline** přímo na serveru.

### Přidáno
- **Profesionální editor kódu** (CodeMirror 6, `admin-ui/src/m5-editor.ts`,
  přibalený do `admin-ui/public/vendor/m5-editor.js` — konzole smí skripty jen
  ze své adresy): barevné zvýraznění JavaScriptu a Pythonu (klíčová slova,
  definice a volání funkcí, proměnné, vlastnosti, řetězce, čísla, komentáře;
  volání `m5.*` zvlášť), **našeptávač** SDK (`m5.` → objekty, `m5.ai.` →
  metody se signaturou a nápovědou; vloží šablonu s poli k vyplnění, Tab mezi
  nimi, a doplní `await`, když chybí), jména vstupů modelu po `inputs.`,
  **šablony** (execute, if, for, try, HTTP JSON, tabulka, prompt, AI, řeč,
  počítadlo…), nápověda při najetí myší a podpis volání při psaní, kontrola
  syntaxe a varování u asynchronního volání bez `await` (s opravou jedním
  klikem), hledání a nahrazení, skládání bloků, více kurzorů, formátování
  (Shift+Alt+F), Ctrl+S uloží, Ctrl+Enter spustí. Panel nápovědy
  (SDK · Šablony · Příklady) s hledáním; stavový řádek.
- **Vizuální tvůrce** (záložka *Builder*, `admin-ui/public/functions-builder.js`,
  kompilátor `server/functions/flow.ts` sdílený serverem i prohlížečem):
  plátno s **uzly** (vstupy, hodnoty, výsledek, if/porovnání/logika, šablona
  textu, text, data — pole, objekty, seznamy, mapování, filtr, řazení —,
  výpočty, výraz a blok kódu, výstupy text/Markdown/kód/JSON/tabulka/obrázek/
  soubor/flash, dotaz na volajícího, session a cache, HTTP, DNS, AI chat,
  řeč → text a text → řeč, hash, HMAC, kódování, id, QR a čárové kódy, log,
  čas, volající, čekání) a **dráty** mezi porty. Tok se přeloží do čitelného
  JavaScriptu nebo Pythonu (větve If obalí jen to, co na nich visí); náhled
  kódu živě. Běh z tvůrce **trasuje** každý uzel, takže hodnota nebo chyba
  se ukáže přímo na plátně a dráty „tečou“. Paleta s hledáním a tažením,
  rychlé přidání uzlu dvojklikem nebo puštěním drátu do prázdna (rovnou se
  zapojí), inspektor nastavení a hodnot vstupů, zpět/znovu, duplikace,
  srovnání rozložení, přiblížení, kontrola chyb s odkazem na uzel. Tok se
  uloží do balíčku (`flow.m5flow.json` + vygenerovaný kód) a **„Create
  model…“** balíček publikuje a vytvoří/aktualizuje model se vstupy podle
  uzlů Input. Příklady: Hello, QR, větvení, Fetch JSON, Speak, AI, počítadlo.
  „Eject to code“ převede tok na běžný balíček.
- **Živé běhy z konzole**: `POST /admin/functions/run` s `live: true` vrátí
  hned `runId`; `GET /admin/functions/runs/:id/live` (SSE) přehraje události
  od začátku (logy, výstupy, průběh, otázky, výsledek) a `POST
  /admin/functions/runs/:id/answer` odpoví na `m5.prompt` / `m5.form` —
  konzole ukáže otázku jako kartu s volbami nebo formulářem.
- **Konzole Functions**: přehled nahoře (balíčky, modely, plány, běhy a chyby
  za 24 h, průměrná doba), dialogy místo `prompt()` (nový balíček s volbou
  šablony nebo toku, publikace s náhledem verze, nový soubor, mazání),
  filtr balíčků, domovská stránka, odkazy balíček ↔ tok ↔ model, typovaný
  testovací formulář modelu, kopírování URL webhooku a ukázky `curl`,
  řazení vstupů, předvolby cronu, filtr běhů podle stavu a modelu
  s automatickým obnovováním, detail běhu se vstupy a hodnotami uzlů,
  přehrávač u zvukových výstupů, zvýrazněný kód ve výstupech a lekcích.
- **Řeč zdarma a offline** (`server/ai/local-speech.ts`, poskytovatel
  „Built-in speech“): **sherpa-onnx** (nativní, Apache-2.0, volitelná
  závislost `sherpa-onnx-node`) spouští **Whisper** (tiny, base, small,
  large-v3 turbo; 99 jazyků vč. češtiny) a hlasy **Piper** (čeština — Jirka,
  slovenština, angličtina US/UK, němčina, polština, francouzština,
  španělština, italština, ukrajinština). Modely se stahují jedním klikem
  v *AI & speech → Speech* (průběh, velikost, odebrání, „▶ Try“) do
  `$DATA_DIR/ai/speech-models`, samy se přidají k poskytovateli a stanou se
  výchozími, když žádný není. Vstup WAV (jiné formáty přes `ffmpeg`), výstup
  WAV; volání jednoho modelu jdou za sebou, `SPEECH_THREADS` (výchozí 2).
- **Bezplatné předvolby řeči**: **Groq** (free tier, Whisper large-v3 turbo),
  **Speaches** (self-hosted faster-whisper + Piper/Kokoro), **Kokoro-FastAPI**
  (self-hosted hlasy) a **whisper.cpp server**; karta „More free speech“.
- Aplikace i konzole posílají nahrávku k přepisu jako **16kHz mono WAV**
  (převod v prohlížeči), takže ji přečte každý model.

### Změněno
- Funkce spuštěná z konzole se pro vrstvu AI počítá i jako přihlášený
  uživatel (skupina „user“), takže může použít poskytovatele otevřené
  přihlášeným; přepínače a limity platí dál.
- Druh modelu se u přidávaných poskytovatelů odhaduje i pro řeč (whisper,
  piper, kokoro… → přepis / syntéza).
- Instalátor doinstaluje `bzip2`, obraz Dockeru ho má také (rozbalení modelů).

### Opraveno
- Záložka **Runs** ukazovala „[object Promise]“ (asynchronní vykreslení);
  seznam se teď načítá do hotového rámu.
- Markdown ve výstupech: nadpis nebo seznam na prvním řádku bloku se
  vykreslí správně.

## [5.0.0] – 2026-09-28

**M5cet Functions** — programovatelné moduly (celý framework funkcí,
`docs/functions-architecture.md`, etapy 2–6). Operátor napíše model
v JavaScriptu nebo Pythonu, publikuje ho a v chatu ho kdokoli spustí přes
`/klíčové-slovo` (jako roboti v messengerech), případně přes webhook, plán
nebo API. Protokol, šifrování ani data účtů se nemění; server nikdy nečte
místnost — dostane jen to, co klient u příkazu pošle, a výstup do místnosti
šifruje klient. Model hrozby: skripty píše důvěryhodný operátor, hranicí je
oddělený proces a interpret ve WASM (ne obrana proti autorovi).

### Přidáno
- **Sandbox a runner** (`server/functions/`): každý běh dostane vlastní
  **oddělený proces** (`dist/sandbox.cjs`) s interpretem ve WebAssembly —
  **QuickJS** pro JavaScript (ES2023, moduly, `async/await`, přerušení podle
  času, limit paměti), **Pyodide** pro Python (CPython 3.14, standardní
  knihovna). Smyčka, přetečení paměti ani pád tak neohrozí hlavní službu:
  runner hlídá čas i paměť a proces v případě potřeby ukončí. Interpret ve
  WASM nevidí hostitele; skripty píše důvěryhodný operátor, takže hranicí je
  proces a interpret, ne obrana proti autorovi.
- **SDK `m5`** stejné v obou jazycích (v Pythonu `snake_case`): `sys`, `run`,
  `caller` (`send`, `flash`), `log` (živě v konzoli), `out`
  (text, markdown, code, table, json, image, file, flash), `session` a
  `cache` s TTL, a čisté pomocníky `codec` (base64/32/58, hex, url, html,
  csv, komprese), `id` (uuid, uuid7, ulid, nanoid, slug) a `crypto` (hash,
  hmac, hkdf, pbkdf2, scrypt, AES-GCM, náhoda) — počítané uvnitř procesu,
  jednou pro oba jazyky.
- **Balíčky, verze a modely** (SQLite `$DATA_DIR/functions/functions.db`):
  koncept (upravitelný) → publikovaná verze (neměnná, otisk obsahu),
  importy mezi soubory i balíčky s pevnou verzí; model = vstupní bod +
  schéma vstupů (typy, validace, koerce) + limity + executory + skupiny +
  klíčové slovo; revize modelu jako historie.
- **Konzole — IDE** (`admin-ui`, sekce *Functions*): editor souborů balíčku
  s panelem SDK, uložení konceptu, publikace verze, zkušební běh s výstupy
  a živými logy; správa modelů (klíčové slovo, vstupní bod přes výběr
  balíček\@verze:soubor, schéma vstupů, viditelnost v místnosti / jen
  volajícímu, skupiny, zapnutí) se zkušebním během; seznam běhů.
- **Chat**: napsání `/` ukáže **našeptávač** dostupných příkazů s popisem a
  nápovědou argumentů (šipky, Enter/Tab, Escape). Klient přeloží argumenty na
  vstupy (`klíč=hodnota` i poziční), spustí model na serveru a výstup buď
  pošle do místnosti jako běžnou šifrovanou zprávu (příznak `fn`), nebo ukáže
  jen volajícímu; v obou případech se vykreslí jako **Markdown** přímo
  v bublině (nadpisy, tučné, **tabulky**, kód).
- **Živá interakce**: funkce se za běhu zeptá volajícího — `m5.prompt`
  (tlačítka volby nebo text) a `m5.form` (formulář) — a **čeká** na odpověď
  (čekání se nepočítá do výpočetního limitu; hlídač se pauzuje). Klient ukáže
  otázku v plovoucí kartě, odpověď pošle přes `POST /api/functions/runs/:id/events`
  a běh pokračuje; když volající odejde, otázky se zruší. Streamovaný běh
  (`POST /api/functions/run` se `stream:true`, SSE) doručuje průběh, otázky a
  výstupy živě. Přepínač modulu `functions` (`ENABLE_FUNCTIONS`).
- **Plány (cron)**: model může běžet podle **cronu** (`*/15 * * * *`,
  `@daily`, názvy měsíců/dnů, časové pásmo). Scheduler v hlavní službě spouští
  splatné plány jednou za minutu; v konzoli je záložka *Plány* (přidat, zapnout,
  spustit teď, smazat). Naplánovaný běh nemá interaktivního volajícího, výstup
  jde do záznamu běhu (pro periodickou práci).
- **Trvalé `on_event`**: `m5.webhook.create({ durable: true })` uloží webhook
  do úložiště; příchozí `POST /hooks/r/:token` po skončení běhu (i po restartu)
  spustí **`on_event`** modelu v uloženém sessionu se stavem, který funkce
  odložila do `m5.session`.
- **API tokeny**: model lze zpřístupnit jako `POST /api/functions/call/:id`
  s `Authorization: Bearer <token>` (executor „api“); vrací výstupy jako JSON,
  token se ukáže v konzoli.
- **Plné crypto** (`m5.crypto`): vedle rychlých primitiv (hash, HMAC, AES-GCM,
  odvození klíčů) i **JWT/JWS** (podpis, ověření, dekódování; HS/RS/ES/PS),
  **X.509** (parsování a ověření certifikátu), **OpenPGP** (šifrování,
  dešifrování, podpis, ověření, generování klíčů – OpenPGP.js) a **OpenSSH**
  klíče (parsování, otisky – sshpk). Tyto větší operace běží u hostitele
  (`await`).
- **Kódy** (`m5.codes`): QR, Micro QR, rMQR, Aztec, Data Matrix, PDF417,
  MaxiCode, Han Xin, DotCode, Code 128/39/93, EAN/UPC, ITF… do SVG nebo PNG
  (bwip-js) — `m5.codes.qr(text)`, `m5.codes.barcode(typ, text)`.
- **Webhooky**: model může být dosažitelný **příchozím webhookem** —
  `POST /hooks/m/:model/:token` spustí model s tělem jako vstupy a vrátí jeho
  výstupy jako JSON (mimo E2EE, pro integrace); v konzoli se zapne přepínačem
  a ukáže se URL (token jako schopnost v URL, volitelně HMAC podpis). Uvnitř
  běhu `m5.webhook.create()` vytvoří URL vázanou na běh a `m5.webhook.wait()`
  na ni **počká** (živé pokračování; `POST /hooks/r/:token` ji doručí).
- **Síť** (`m5.http`, `m5.dns`): funkce může volat HTTP zvenčí (bez CORS,
  hlavičky, JSON, `body`, časový limit, limit velikosti, přesměrování) a
  překládat DNS — vše přes hostitele s **ochranou proti SSRF**: jen `http(s)`
  a nikdy na privátní, loopback, link-local ani metadatovou adresu (kontrola
  na první i každé přesměrované adrese, spojení připnuté na ověřenou IP proti
  DNS rebindingu). Vývojový přepínač `FUNCTIONS_HTTP_ALLOW_LOCAL=1` guard
  vypne (jen pro místní testy). První kus etapy 4.
- **Sestavení**: `npm run build` staví i `dist/sandbox.cjs` a kopíruje běhové
  balíčky do `dist/node_modules` (ovladač SQLCipher, Pyodide, QuickJS WASM),
  takže je má i instalace bez `node_modules` a obraz Dockeru s jen `dist`.

- **AI ve funkcích** (`m5.ai`, etapa 5): funkce zavolá model instance —
  `m5.ai.chat({ messages, model?, system?, reasoning?, json? })` (vrátí text,
  tokeny, cenu), `m5.ai.models()`, `m5.ai.tts` a `m5.ai.stt`. Volání jde přes
  vrstvu AI z 4.14 jako volající „function“, takže se řídí přepínačem, skupinami
  a rozpočty a zapíše se do žurnálu; navíc má **rozpočet na běh** (strop tokenů).
- **Agenti** (`m5.ai.agent(cíl, { tools, maxSteps, approve })`): smyčka, v níž
  model volí nástroje (funkce v sandboxu), sandbox je spustí a výsledky vrací
  modelu, dokud nedá odpověď nebo nedojdou kroky. Nástroj označený `approve`
  se před spuštěním zeptá volajícího (`m5.prompt`). V JS i Pythonu, bez nutnosti
  nativního volání nástrojů u poskytovatele.

- **Pro autora** (etapa 6): **šablony** balíčků (Hello JS/PY, HTTP fetch, QR,
  AI asistent) — nový balíček lze založit z šablony; **export a import**
  balíčku jako přenosný bundle `.m5pkg` (všechny publikované verze + soubory),
  v konzoli tlačítka Import/Export; **interaktivní tutoriál** v konzoli (lekce
  v Markdownu vedle editoru: „vlož ukázku → spusť → kontrola“, od `m5.out`
  přes vstupy, session/cache, HTTP, kódy a prompt až po AI a Python). Volitelný
  trusted runtime (npm/PyPI v nsjail) se po zvoleném modelu hrozby nepoužívá.

### Opraveno
- Ovladač SQLCipher se teď dostane do `dist/node_modules`, takže úložiště
  a žurnál AI přežijí i výchozí instalaci a obraz Dockeru (dřív běžely jen
  v paměti, když se `node_modules` po sestavení mazal).

## [4.14.0] – 2026-09-24

AI a řeč od základu — první etapa frameworku funkcí
(`docs/functions-architecture.md`). Protokol, šifrování ani data účtů se
nemění.

### Přidáno
- **Vrstva AI a řeči** (`server/ai/`): adaptéry **Anthropic** (Messages API,
  stream, adaptivní uvažování s `effort` u Claude 5, rozpočet uvažování u
  starších modelů, seznam modelů s jejich schopnostmi), **OpenAI-kompatibilní**
  (OpenAI, Open WebUI, Perplexity se zdroji, llama.cpp, GPT4All, Hugging Face,
  jiné servery; syntéza a přepis řeči), **Ollama** (NDJSON, `think`),
  **ElevenLabs** (hlasy účtu). Odmítnutý parametr se vynechá a zkusí znovu;
  časový limit do první odpovědi a na ticho během streamu; zrušení s klientem.
- **Poskytovatelé** v konzoli: klíče zašifrované master klíčem úložiště a
  svázané s poskytovatelem (`$DATA_DIR/ai/config.json`), nikdy zpět do
  konzole; adresa; **skupiny**, které je smí používat; test; **modely** od
  poskytovatele nebo jménem (zapnutí, jméno, uvažování, obrázky, ceny).
  Klíče z proměnných prostředí (jako dřív) se ukážou jako poskytovatelé
  „z prostředí“.
- **Limity**: tokeny a USD za měsíc pro server (výchozí **0 tokenů = asistent
  vypnutý**, dokud je vlastník nenastaví), volání a tokeny na uživatele a den,
  nejdelší odpověď a konverzace; konzole se počítá, ale neblokuje.
- **Žurnál volání** (`$DATA_DIR/ai/journal.db`, SQLite; bez ovladače v
  paměti): odkud, kdo, model, výsledek, doba, doba do prvního kousku, tokeny,
  cena; obsah jen při dočasném *content logging* vlastníka (pak se smaže);
  retence 30 dní; filtry, živý proud, detail, CSV, souhrny.
- **Konzole › AI & speech** (`admin-ui/public/ai-console.js`): přepínače a
  souhrn měsíce, poskytovatelé a modely, **zkušebna** (stream, uvažování,
  zdroje, tokeny, cena, požadavek jak odešel), test řeči (syntéza, přepis
  nahrávky nebo souboru), volání, výchozí modely a pokyny asistenta, limity,
  žurnál. API `/admin/ai*` (klíče, adresy, ceny, limity a obsah: vlastník).
- **Asistent v aplikaci** (`AiPanel`, rozvržení `panel.ai`): modely podle
  skupin účtu, úroveň uvažování, odpověď psaná průběžně jako **Markdown**
  (`lib/markdown.ts`, `components/Markdown.tsx` — bez HTML, odkazy jen
  https / mailto), uvažování, zdroje, zastavení, vložení do zprávy, kopírování;
  stav, když použít nejde (vypnuto, žádný model, jen pro přihlášené, bez
  limitu); odmítnutí v jazyce uživatele. API `POST /api/ai/chat` (SSE).

### Změněno
- `/api/ai/status` a `/api/speech/status` podle přihlášeného účtu a skupin;
  `/api/ai/complete` a `/admin/plugins`, `/admin/plugins/switches` zůstávají.
- Manifest `/api/modules` hlásí AI a řeč podle přepínače z konzole a
  nastavených modelů (dřív jen podle `ENABLE_AI=1` v prostředí).
- Admin služba předává roli administrátora (`res.locals.adminRole`).
- Konektory `server/plugins/{registry,routes,connectors}` nahradily adaptéry
  v `server/ai/`.

### Kompatibilita
- Po aktualizaci je asistent vypnutý, dokud vlastník nenastaví měsíční limit.
- Hosté asistenta používají jen se skupinou *Guests* u poskytovatele.

## [4.13.0] – 2026-09-24

Layout builder pro celou aplikaci. Protokol, šifrování ani data účtů se
nemění; klienti 4.0 a 4.13 se v místnosti potkají.

### Přidáno
- **Okno Místnost, okna, dialogy a panely jako rozvržení** (36 nových,
  celkem 44; `client/src/lib/layouts/{windows,room,dialogs,account,settings,tools,share,phone,connections}.ts`):
  okno panelu a velké okno nastavení, záložky a obsah okna Místnost,
  „nejdřív se přihlaste“, odznak přihlášeného, informace o účastníkovi,
  o zprávě, kontrola verzí, účet, passkey, historie chatu, profil,
  nastavení, soukromí, šifrování, oznámení, analytika, zabezpečení
  místnosti, důvěra, lidé, hlasový a video hovor, soubory, poloha, řeč,
  podrobnosti spojení, telefonie, sdílení a pozvánky, Moje připojení
  (seznam, úprava, statistiky a log, nastavení). Komponenty drží stav a
  logiku, rozvržení dostane data a akce (kontrakty). Aplikace kreslí
  rozvržení operátora pro přihlášeného diváka (`LayoutProvider`).
- Builder: **sekce** záložek (App, Room window, Windows, Dialogs & parts,
  Panels); **náhled** oken a panelů jejich skutečnými komponentami s
  ukázkovými daty (`layout-preview-parts.tsx`, `layout-samples.tsx`), stavy
  po klepnutí si náhled „doklikne“ sám; bez volání serveru.
- **Varianty** rozvržení pro skupiny uživatelů a šablony vzhledu (první
  vyhovující; nejvýš 8 na rozvržení, 40 celkem); v náhledu „jako kdo“.
- **Historie** uložených verzí (`layout-history.json`, posledních 50,
  ~12 MB) s rozdíly (proti předchozí nebo dnešní) a **návratem**;
  `GET /admin/layout/history[/:id[/diff]]`, `POST …/:id/restore`.
- **Archiv vydaných výchozích stromů** (`server/layout-archive.json`,
  `script/archive-layouts.ts`) a **třícestné sloučení** vlastního rozvržení
  s novým výchozím po aktualizaci (`layout-merge.ts`): bez konfliktu samo
  při načtení, jinak nabídka v builderu se seznamem konfliktů;
  `POST /admin/layout/merge`.
- **Vložení HTML** jako prvků palety (`html-to-tree.ts`,
  `POST /admin/layout/from-html`): nebezpečné a neznámé se vynechá a vypíše.
- **Kontrola přístupnosti** (`layout-a11y.ts`): návrh (alt, názvy
  ovládacích prvků, popisky polí, klávesnice, tabindex, nadpisy, duplicitní
  id, odkazy) i vykreslený náhled (přístupný název, kontrast WCAG proti
  skutečnému pozadí); souhrn pod náhledem a čipy ve stromu.
- Prvky **tabulka** (sekce, řádek, buňka) a **video**; ikona s velikostí;
  další události (mousedown/up, drag…, wheel, scroll, touch, load, error).
- Šablonovací jazyk: **filtry nad výrazem v závorce**
  (`{=('acc.signedInAs'|t|replace:'{name}':$userName)}`); číslice za tečkou
  jsou krok cesty (`$x.0.1`).

### Změněno
- Šablony a výrazy se **překládají na funkce** a strom rozvržení také
  (`LayoutView`): rychlejší vykreslení, neměnné části se nevytvářejí znovu.
- Výchozí stromy se staví až při prvním použití (úvodní obrazovka 8 ze 44).
- Katalog ikon 239; `script/gen-menu-icons.mjs` čte ikony ze stromů
  rozvržení a z map ikon komponent.
- Kontrola `target="_blank"` bere `rel="noreferrer"` jako `noopener`
  (podle HTML).

### Přístupnost
- Přístupný název dostalo šest polí: klíč místnosti v úpravě připojení,
  text SMS, odkaz pozvánky, výběr serverového hlasu, název passkey a
  obnovovací kód; ve zprávách pole kódu zapečetěné zprávy.

### Ověření
- DOM i volané akce starých a nových komponent porovnány krok za krokem
  (všechny převedené komponenty, cs / en, část de; jediný rozdíl jsou nové
  přístupné názvy). `test/layout-parts.test.tsx` kreslí každé rozvržení
  oken, dialogů a panelů v každé situaci náhledu a jazyce: bez chyby
  rozvržení, bez sítě, s přístupnými názvy.

## [4.0.6] – 2026-09-24

Oprava modulů AI a řeči. Protokol, šifrování ani data účtů se nemění.

### Opraveno (`server/plugins/*`)
- **Anthropic** vracel `400: temperature is deprecated for this model` —
  konektor posílal vždy `temperature: 0.7`, což modely vydané po Claude
  Opus 4.6 (např. `claude-sonnet-5`) odmítají. Parametry vzorkování
  (`temperature`) se posílají jen na vyžádání; parametr, který model
  odmítne, se zkusí jednou znovu bez něj. Z odpovědi se berou jen textové
  bloky (ne thinking), výchozí `max_tokens` 1024. `ANTHROPIC_BASE_URL`
  volitelně.
- **HuggingFace** (text i přepis řeči) hlásil `fetch failed`: volal
  `api-inference.huggingface.co`, který zanikl (doména se už nepřekládá).
  Text jde přes Inference Providers — OpenAI kompatibilní
  `https://router.huggingface.co/v1/chat/completions` (model může nést
  poskytovatele nebo politiku: `…:novita`, `…:cheapest`, `…:fastest`),
  přepis přes `https://router.huggingface.co/hf-inference/models/<model>`.
  `HF_BASE_URL` volitelně.
- **OpenAI**: u api.openai.com `max_completion_tokens` (novější modely
  `max_tokens` odmítají), u kompatibilních serverů dál `max_tokens`;
  `temperature` jen na vyžádání. Ollama: `options.temperature` a
  `num_predict`.
- Chyby: místo holého `fetch failed` důvod (DNS, odmítnuté spojení, časový
  limit, TLS certifikát) a hostitel; u poskytovatele jeho vlastní zpráva.
  Každé volání má limit 60 s.

### Přidáno
- Konzole › AI & speech: **přepínače modulů AI a Speech**
  (`PUT /admin/plugins/switches`, operátor). Uloženo v
  `$DATA_DIR/plugins.json` (`PLUGINS_SETTINGS_FILE`), čte ho aplikace i
  admin služba; `ENABLE_AI` / `ENABLE_SPEECH` (1/0) mají přednost a konzole
  to ukáže. Panel se načte po otevření; test konektoru vrací dobu odezvy.

## [4.0.5] – 2026-09-24

Layout builder jako GUI designer. Protokol, šifrování ani data účtů se
nemění. Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html#layout-builder),
[`docs/layout-builder.md`](docs/layout-builder.md).

### Rozvržení jako data (`client/src/lib/layout-tree.ts`, `client/src/lib/layouts/*`, `client/src/components/LayoutView.tsx`)
- Lišta nahoře, okno chatu, příchozí / odchozí / systémová zpráva, pole pro
  psaní a widget příjemců (panel i minimalizované tlačítko) jsou **stromy
  prvků**, které kreslí `LayoutView`. Výchozí stromy vykreslují **stejný DOM**
  jako dřívější JSX — ověřeno porovnáním starých a nových komponent ve 248
  situacích, hlídáno 31 snímky (`test/layout-snapshots.test.tsx`).
- Prvek má tag, text (šablona), atributy (šablona nebo výraz po `=`), CSS,
  styl se stavy (hover / click / focus / current), CSS z dat, podmínku,
  opakování se svým rozsahem (`$p`, `$iterator`), události → akce s
  argumentem, ref, živou část aplikace (slot) nebo šablonu (block).
- Každé rozvržení má **kontrakt** (hodnoty, akce, živé části, refy);
  komponenty si nechávají stav a chování (tažení widgetu, časovače zpráv,
  zapečetění), rozvržení jen kreslí.
- Šablonovací jazyk: podmínka `a ? b : c`, filtr `t` (`{$state|t:'msginfo.state.'}`),
  vykreslení jako prostý text, rychlá cesta pro `{$x}` / `$x` / `!$x`.

### Konzole › Layout builder (`admin-ui/public/layout-builder.js`)
- Záložky rozvržení (+ šablony, + *Texts & behaviour*), **paleta** 28 prvků
  (panel, area, row, column, grid, list, group, text, heading, paragraph,
  label, link, icon, image, audio, logo, avatar, HTML, separator, button,
  input, text area, select, option, form, živé části, šablony), **strom**
  s přetahováním (i z palety), nástroji pro vybraný prvek (skrýt, posunout,
  duplikovat, zabalit, rozbalit, uložit jako šablonu, smazat), zpět / znovu,
  kopírovat / vložit mezi rozvrženími, export / import.
- **Vlastnosti s našeptáváním**: tag, třídy, které styly aplikace opravdu
  mají (čtou se z buildu), atributy podle tagu a jejich hodnoty (typy inputu,
  role, target, autocomplete…), 114 vlastností CSS s hodnotami, proměnné,
  akce, živé části, refy. Plovoucí nápověda (hodnoty, akce, filtry, makra,
  výrazy, prvky).
- **Náhled je aplikace sama**: `layout-preview.html` (druhý vstup buildu) se
  skutečnými komponentami, CSS a šablonami vzhledu a ukázkovými daty;
  varianty, šablona, tón, jazyk, šířka; klepnutí vybere prvek, režim
  *click tries it* náhled ovládá; chyby výrazů u prvků.
- **Šablony prvků**: uložit vybraný prvek, vložit propojeně (s `$arg`) nebo
  jako kopii, upravit ve vlastní záložce.
- Uloží se jen rozvržení odlišná od výchozích (`layouts.<id> = { tree, rev }`)
  a šablony (`blocks`); builder upozorní, když aktualizace aplikace změnila
  výchozí stav, ze kterého návrh vznikl.
- Dřívější barvy komponent, krátké texty, includes a chování zpráv jsou na
  záložce *Texts & behaviour*; starý panel z `legacy-tools.js` je pryč.

### Server
- `GET /admin/layout` vrací i katalog (paleta, atributy, CSS, třídy z
  `dist/public/assets/*.css`, ikony, rozvržení s výchozími stromy, kontrakty
  a variantami); `PUT /admin/layout` přijme tělo do 4 MB.
- Admin služba podává náhled `/layout-preview.html` (`frame-ancestors 'self'`)
  a `/assets/*` z buildu aplikace.
- Validace `layout-tree.ts` (server i klient): známé prvky a tagy, žádné
  `on*`, `style`, `srcdoc`, `formaction`, bezpečné adresy (i při vykreslení),
  CSS bez `url()` a výrazů, limity (2 500 prvků, hloubka 40, 60 šablon).

### Sdílené (`admin-ui/public/builder-kit.js`)
- Menu builder a Layout builder sdílejí pole formulářů, výběr barev a ikon,
  editor stylů se stavy, plovoucí nápovědu a našeptávač.
- Katalog ikon 207 (+ ikony zpráv, lišty, psaní a widgetu); přejmenované
  ikony lucide (`smile` → `face-slightly-smiling`) se najdou i pod starým jménem.

### Opraveno
- Levý sloupec Menu builderu na středně širokých obrazovkách překrýval náhled
  pod sebou.

### Testy
- `layout-tree` (validace, adresy, CSS, limity, výchozí stromy projdou
  validací beze změny a používají jen svůj kontrakt), `layout-view`
  (šablony jako text, podmínky, opakování, typované atributy, události,
  refy, sloty, šablony, bezpečné HTML, styly, ikony, režim náhledu),
  snímky výchozích rozvržení, `layout-config` (rozvržení a šablony). E2E:
  paleta, výběr v náhledu, našeptávání tříd / CSS / textu / akcí, přetažení,
  šablona v jiném rozvržení, uložení — a aplikace kreslí uložené rozvržení
  (nové tlačítko v ní opravdu otevře emoji); auditor jen čte.

## [4.0.0] – 2026-09-24

Identita a přihlášení, moduly pro skupiny a menu jako data. **Nekompatibilní
změna:** Server-enhanced vyžaduje přihlášení passkey a registrace/přihlášení
mají nový krok (důkaz globálního klíče). Signalizační protokol a šifrování
místností se nemění. Dokumentace (HTML + PDF):
[`docs/site/`](docs/site/index.html#prihlaseni).

### Identita (`server/accounts/username.ts`, `store.ts`, `routes.ts`, `client/src/lib/account.ts`)
- **Uživatelské jméno** účtu: jedinečné, vygenerované serverem při registraci
  (`slovo-slovo-xxxx`, konec z abecedy bez záměn), uložené v passkey
  (`user.name`, `displayName`, `user.id` = UTF-8 jméno). U nových účtů je to
  **ID účtu** — primární klíč relací, trezoru, databáze, fronty i auditu.
  Jméno v místnosti je jen přezdívka; hello nese i uživatelské jméno a detail
  uživatele ho ukazuje.
- **Light · P2P** bez účtu: jméno relace z přezdívky (`tomas-k-7k3q`).
- **Globální klíč**: kořen z PRF (pro tentýž passkey vždy stejný) → nový
  **důkaz klíče** `HKDF(kořen, "m5cet:key-proof:v1")`; server drží jen
  `SHA-256` (`keyVerifier`). `register/verify` bez důkazu → `400 no-key`.
- **Přihlášení krok za krokem**: passkey (neznámý → `404 unknown-passkey` s
  doporučením registrace), globální klíč (`signin/verify` vydá **zamčený**
  token, `POST /api/account/unlock` ho odemkne; jiný klíč → token zrušen,
  `403 wrong-key`), databáze, trezor, server a verze, nastavení, push,
  automatické připojení. Okno Spojení ukazuje průběh; selhání databáze nebo
  klíče uživatele odhlásí.
- **Audit** všeho v kategorii `account`: `register`, `register.failed`,
  `signin.unknown-passkey`, `signin.rejected`, `signin.passkey-ok`,
  `signin.wrong-key`, `signin.unlocked`, `recovered` a hlášení klienta
  `client.signin-complete|signin-failed|database-locked|version-mismatch…`.
- **`/signin` a `/signup`**: otevřou okno Spojení a spustí přihlášení, resp.
  registraci — po registraci je uživatel rovnou přihlášený a aktivovaný.
- Účty z doby před 4.0 si ponechávají své ID jako uživatelské jméno (bez
  přejmenování); hash důkazu klíče se uloží při jejich prvním přihlášení.

### Server-enhanced jen s passkey
- Vytvořit passkey a přihlásit se jde **jen v okně Spojení**. Jinde (okno
  Místnost › Server-enhanced, Moje připojení, profil, test upozornění, …) jsou
  volby neaktivní a karta *Vyžaduje přihlášení passkey* vede do okna Spojení.
- Nepřihlášená aplikace nezakládá anonymní relaci úložiště ani se nepřipojí
  na server ručně; uchování chatu `server` se přepne na `session`.

### Ochrana navigace (`client/src/lib/nav-guard.ts`)
- Během spojení: zpět, obnovení (F5, Ctrl/Cmd+R) a klávesové zkratky historie
  otevřou okno *„Prosím nejprve se odpojte z místnosti.“* (Odpojit / Zůstat);
  zavření karty a nová adresa → dialog prohlížeče (`beforeunload`).

### Kontrola verzí (`client/src/lib/integrity.ts`, `IntegrityCheck.tsx`, `vite.config.ts`)
- Sestavení zapíše `/version-manifest.json` (verze, build, protokol, build
  service workeru, knihovny, soubory se SHA-256); `sw.js` zná svůj build.
- Aplikace porovná, co opravdu běží (verze, build, protokol, knihovny,
  načtené soubory, service worker): po startu, při návratu do okna, každých
  10 minut, při oznámení nové verze a při přihlášení. Nesoulad → okno se
  seznamem a **Opravit**: smaže Cache Storage, service worker, uložené
  konfigurace, relace a IndexedDB (identita zařízení zůstane; volitelně i
  vzhled a jazyk), `POST /api/clear-site-data` (`Clear-Site-Data: "cache"`) a
  načte vše znovu ze serveru. Nahrazuje dosavadní pruh „nová verze“.

### Moduly a skupiny (`client/src/lib/modules.ts`, `server/client-config.ts`, konzole *Modules & groups*)
- 14 modulů (hovory, video, soubory, poloha, řeč, AI, telefonie, NFC,
  pozvánky, uložená připojení, upozornění, analytika, vzhled, Edit Mode):
  zapnuto pro všechny, jen pro skupiny, nebo vypnuto. Skupiny `guest`,
  `user` a vlastní skupiny správce s uživatelskými jmény jako členy (klientům
  se členové neposílají; účet zná své skupiny z `/api/account/me`).
- Aplikace schová menu, panely a ovládání modulu, který uživatel nemá;
  server odmítne jeho endpointy (`403 module-disabled`).

### Menu builder (`client/src/lib/menu-config.ts`, `menu-template.ts`, `menu-style.ts`, `MainMenu.tsx`, `server/menu-config.ts`, konzole `menu-builder.js`)
- Menu je data: ☰ tlačítko, panel, **sekce, položky** (panel, funkce, odkaz),
  **HTML** s proměnnými, **oddělovače**, **řady** a **speciální tlačítka**
  (uživatel, Vzhled, Edit Mode, světlý / tmavý, oznámení, účet, Smazat vše a
  odejít, verze). Výchozí konfigurace vykreslí **stejné DOM** jako menu 3.3
  (ověřeno ve všech pěti režimech zobrazení).
- Každý prvek: modul, situace (přihlášen, připojen, telefon…), skrytí;
  styl (zarovnání, obtékání, barvy textu / pozadí / ikony / rámečku, písmo,
  velikost, dekorace, odsazení, zaoblení, stín…) a totéž pro stavy hover,
  click, focus a current.
- **Šablonovací jazyk** podobný Latte: `{$session.current_username}`,
  `{=výraz}`, `{if}`, `{ifset}`, `{foreach}`, `{var}`, `{icon …}`, `{_'klíč'}`,
  22 filtrů; výstup je bezpečný strom prvků (nikdy `innerHTML`), odkazy jen
  `https:` a cesty webu, `data-action="panel:…|fn:…"`.
- Konzole: strom s **přetahováním** (i Alt+↑/↓), přidávání, duplikace,
  skrytí, mazání, zpět / znovu, export / import JSON, výběr ikon (128 ikon
  lucide), editor stylů se stavy, plovoucí **nápověda** (proměnné, filtry,
  makra, příklady — klepnutím vloží), **živý náhled** panelu i lišty.
- `GET /api/menu-config`, `GET|PUT /api/admin/menu-config`,
  `POST /api/admin/menu-config/render`; `$DATA_DIR/menu-config.json`
  (`MENU_CONFIG_FILE`); audit `admin.menu-config`.

### Opraveno
- Konzole *Modules & groups* se ptala admin služby na `/api/modules`
  (404); stav serverových modulů teď přichází s `/api/admin/client-config`.

### Testy
- Jednotkové: uživatelská jména, důkaz klíče a zamčené relace, kroky
  přihlášení a chyby (neznámý passkey, špatný klíč, databáze), moduly a
  skupiny, šablonovací jazyk, konfigurace menu (validace, úložiště, routy,
  náhled), menu z konfigurace (styly, HTML, oddělovače, speciální tlačítka,
  bezpečnost HTML). E2E: `/signup`, `/signin`, neznámý passkey na jiném
  serveru, zamčení Server-enhanced, ochrana navigace, kontrola verzí,
  moduly a skupiny v konzoli, Menu builder (přetažení, klávesnice, styly a
  stavy, HTML s nápovědou, uložení) a totéž menu v aplikaci.

## [3.3.0] – 2026-09-24

Nové okno Místnost a sdílení uložených připojení. Protokol, šifrování ani
data se nemění. Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html#okno-mistnost).

### Okno Místnost (`client/src/components/RoomDialog.tsx`, `client/src/room.css`)
- Typ připojení je **záložka v záhlaví okna** místo názvu *Místnost*:
  *Light · P2P* a *Server-enhanced* (na úzkém displeji *P2P* / *Server*),
  šipky přepínají (WAI-ARIA tabs).
- **Light · P2P**: jméno, room ID a klíč (s okem pro zobrazení).
- **Server-enhanced**: uložená připojení ve vzhledu *Moje připojení*, ale
  **bez tlačítek** — vybírají se klepnutím, vybrané je orámované a
  zaškrtnuté; výchozí první, pak naposledy použitá. *Jiná místnost* ukáže
  pole pro ruční zadání; nepřihlášený vidí výzvu k přihlášení a pole.
- **Ozubené kolo** otevře *Moje připojení* nad oknem Místnost; po zavření se
  seznam obnoví a nově vytvořené připojení je vybrané. Bez připojení nabídne
  *Vytvořit připojení* rovnou s formulářem.
- **Vždy viditelné**: Připojit / Reconnect (podle výběru *Připojit · název*),
  Odpojit, Sdílet místnost.
- **Během spojení nic nepřepnete** (záložka, ostatní záznamy, pole); po
  Odpojit jsou znovu k výběru. Reconnect obnoví totéž spojení.
- Šablony iOS 27 (kapslový segmentový ovladač, vložené řádky, modrá
  fajfka) a Windows 11 (SelectorBar s akcentovou pilulkou, proužek výběru).

### Sdílet připojení (`SharePanel.tsx › ShareConnection`)
- Nové tlačítko **Sdílet** u každého připojení v *Moje připojení* (mezi
  hvězdičkou a košem) otevře okno *Sdílet připojení*: stejná pozvánka jako v
  okně Místnost (kód 12 číslic, počet použití, platnost), ale bez nutnosti
  spojení, s kartou připojení, volbami jako řadou tlačítek a **jménem pro
  pozvaného**.
- Připojení na **jiném signalizačním serveru** předá server v zapečetěné
  pozvánce (`SharePayload.server`, jen čisté `wss://`); pozvaný se tam
  připojí, jen když to správce tohoto serveru povoluje.

### Okna
- Okna se skládají nad sebe: Escape zavře jen horní, další okno ztmaví
  obrazovku jen trochu; všechna se vykreslují do `<body>` (sklo iOS 27 pod
  nimi už neposune pevně umístěný obsah).

### Opraveno
- Obnovení stránky a Reconnect vracely uložené připojení s jiným serverem na
  tento server — relace si teď pamatuje server i připojení.
- Pozvánka přijatá po spojení s jiným serverem zůstala na něm.
- Uložené připojení s režimem *light* po připojení skrylo *Moje připojení* a
  přepínač v záhlaví.

### Testy
- Komponenta okna Místnost a skládání oken (jsdom), pozvánka se serverem a
  jménem, relace se serverem; E2E: výběr připojení v okně, zámek během spojení,
  přidání přes ozubené kolo, sdílení připojení až po připojení hosta kódem.

## [3.2.0] – 2026-09-23

Uložená připojení pro přihlášené uživatele, nové šablony celého GUI (iOS 27,
Windows 11 a pět studiových), jejich konfigurace v administraci a rychlejší
načítání. Protokol ani šifrování se nemění — **klienti 3.1 a 3.2 se v
místnosti potkají**. Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html).

### Uložená připojení (`client/src/lib/connections.ts`, `components/ConnectionsPanel.tsx`)
- Přihlášený uživatel v režimu Server-enhanced si v menu *Moje připojení*
  ukládá, upravuje a maže připojení: **místnost, klíč** (zobrazit, vygenerovat
  ~140 bitů), **jméno**, **obslužný server**, režim, historie chatu, **mizení
  zpráv (TTL)**, relay pro nepřítomné, upozornění, automatické znovupřipojení
  a strategie udržování spojení; název a barva.
- **Výchozí připojení**, **připojení po přihlášení** (nebo k naposledy
  použitému), znovupřipojení po výpadku, po návratu stránky a sítě, přepínač
  připojení v záhlaví, dotaz před přepnutím, *Uložit aktuální místnost*.
- **Statistiky** (připojení, čas online, zprávy, soubory a data, obnovy,
  selhání, chyby, nejvíc lidí) a **log** s filtry, exportem JSON bez klíče a
  vymazáním.
- **Jiný obslužný server**: ze seznamu správce nebo vlastní `wss://`, když to
  správce dovolí. Cizí server nedostane token účtu, úložiště, relay ani
  neposílá administrátorské příkazy.
- Vše zapečetěné **klíčem trezoru účtu** v prohlížeči — nová část trezoru
  `connections` (`PUT /api/account/vault`, ≤ 1,5 MB); server zná jen šifrovaný
  blok a počet. Dokud se trezor nenačte, klient ho nepřepíše.

### Šablony vzhledu (`client/src/themes.css`, `lib/theme-catalog.ts`)
- **iOS 27**: Liquid Glass (průsvitné vrstvy, světelná hrana), bubliny jako
  iMessage, kompozér jako kapsle, zelené přepínače, ikony menu na barevných
  čtverečcích, spodní listy na telefonu; světlý i tmavý tón.
- **Windows 11**: Mica, akrylové nabídky, Fluent ovládací prvky, elevace,
  akcentová linka fokusu, proužek výběru v menu, Segoe UI Variable, tenké
  ikony; světlý i tmavý tón.
- **Studio**: Aurora, Nord, Sakura, Ocean, Graphite. Celkem 13 šablon ve
  třech rodinách, každá dál s 6 barevnými variacemi a 4 rozvrženími.
- **Tón** automaticky podle systému (mění se za běhu), světlý nebo tmavý;
  **styl ikon** outline / thin / bold / duotone / badge nebo podle šablony.
- Šablona se použije ještě před prvním vykreslením (žádné probliknutí).

### Administrace — Client & addons (`server/client-config.ts`)
- Nový panel konzole: využití uložených připojení; zapnutí, statistiky a
  logy, výchozí automatické připojení, vlastní servery, limity (připojení na
  účet, řádky logu), **seznam dalších signalizačních serverů**; povolené
  šablony, výchozí šablona, tón a ikony, **zámek šablony**.
- `GET /api/client-config` (veřejné, nic tajného), `GET|PUT
  /api/admin/client-config` (čtení auditor, změna operátor, audit
  `admin.client-config`), soubor `$DATA_DIR/client-config.json` nebo
  `CLIENT_CONFIG_FILE`. Klienti si změnu vezmou do 5 minut nebo po obnovení.

### Optimalizace
- Build **předkomprimuje** assety (brotli + gzip): hlavní JS 484 kB → 122 kB
  po síti. Server je posílá sám, nginx přes `gzip_static on;`. Soubory s
  hashem v názvu mají roční `immutable` cache, HTML a service worker dál
  `no-store`.
- Chat se nepřekresluje každou sekundu: časovač míří jen na nejbližší
  expiraci zprávy; řádky zpráv jsou memoizované.
- Odvozené klíče v LRU cache; konfigurace layoutu se čte znovu jen při změně
  souboru; stejná konfigurace klienta nevyvolá nové vykreslení.

### Testy
- Unit: model připojení (úpravy, limity, jiné servery, statistiky a
  ohraničený log, načtení z trezoru, dávkové ukládání), politika správce,
  úložiště konfigurace a jeho API, část trezoru `connections`. E2E: uložení a připojení,
  statistiky a log se dvěma účastníky, na serveru jen zapečetěný blok,
  automatické připojení po načtení; konzole *Client & addons*.

## [3.1.0] – 2026-09-23

Zapracované návrhy z roadmapy 3.0: forward secrecy a párové klíče, slepá ID
místností, Argon2id, E2EE hovorů, více instancí serveru, binární přenos
souborů přes relay, účty s více passkeys a obnovou, role v administraci,
neměnný audit, zálohy, metriky a alerty. **Klienti 3.0 a 3.1 se v místnosti
nepotkají** (jiné klíče i ID místnosti) — po nasazení obnovte všechna okna.
Dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html).

### Kryptografie v3 (`client/src/lib/envelope.ts`, `kdf.ts`, `sender-keys.ts`)
- **Argon2id** (64 MiB, 3 průchody, WASM) místo PBKDF2 — ve **Web Workeru**,
  stránka nezamrzne. CSP povoluje `'wasm-unsafe-eval'`.
- **Slepé ID místnosti** `r3.<HKDF>`: server název místnosti nezná; historie
  na serveru se čte pod slepým ID (se zpětnou cestou pro data 3.0).
- **Klíče odesílatele s ratchetem** (forward secrecy): řetěz HMAC, klíč zprávy
  se po použití zahodí, rotace po 500 zprávách, hodině nebo odchodu člena;
  **vyloučení člena** z vlastních zpráv bez změny hesla.
- **Párové klíče** (ECDH P-256 + HKDF, podepsané `hello`): soukromé zprávy
  jsou zapečetěné jen pro vybrané příjemce.
- **Identita svázaná s účtem**: klíč zařízení podepsaný klíčem účtu
  (Ed25519 odvozený z kořene účtu); pinování podle účtu, ne jména.
- **Bezpečnostní čísla s QR kódem** (zobrazení i skenování kamerou) a
  potvrzení „ověřeno“; zprávy ukazují, čím byly zapečetěné.
- Obálky v2 (fronta z 3.0) se dál otevřou.

### Soubory a hovory
- **Binární rámce** pro kusy souborů (DataChannel i server): o třetinu méně
  dat než base64 v JSON; schopnost si strany sdělí (`caps`, `features`),
  starší klient dostane JSON.
- **Šifrovaný relay souborů, když P2P selže** (striktní NAT bez TURN) — dřív
  aplikace přenos rovnou odmítla. Odesílatel se **řídí limity**, které server
  ohlásí (80 % rozpočtu), takže ho relay neodmítne ani neodpojí.
- **E2EE hovorů**: každý rámec zvuku a obrazu je v workeru
  (`RTCRtpScriptTransform`) zapečetěný AES-GCM klíčem páru pro daný směr;
  hlavička kodeku zůstává čitelná a autentizovaná (připraveno pro SFU). Panel
  hlasu ukazuje, zda byla za poslední sekundu zapečetěná každá zpráva.
- **TURN s krátkodobými přístupy** (`TURN_SECRET`, TURN REST API).

### Protokol a více instancí (`server/cluster/*`, `server/signaling/cluster.ts`)
- **Cluster přes Redis pub/sub** (`REDIS_URL`): místnost se rozprostře přes
  instance — členství, signály, relayované soubory (binárně i JSON), žádosti o
  opakování, `resume` na jiné instanci, odvolání relací a stav nepřítomnosti.
  Zprávy clusteru podepsané HMAC (`CLUSTER_SECRET`), padělky se zahodí.
  Vlastní RESP klient bez závislostí (TLS, AUTH, reconnect, resubscribe).
- Účty ve sdíleném adresáři: instance si načtou, co zapsala jiná.
- Limity brány spojení z prostředí (`WS_CONNECTS_PER_MINUTE`,
  `WS_CONNECTIONS_PER_CLIENT`, `WS_CONNECTIONS_TOTAL`).

### Fronta a doručování
- **Trvalá evidence relayovaných zpráv** (`relay_ledger`): účtenky fungují i po
  restartu. Odesílatel a stav položky jsou v DB **zapečetěné** master klíčem.
- **Neutrální text probuzení** push — žádné jméno ani místnost na zamčené
  obrazovce.

### Účty
- **Více passkeys na účet** a **obnovovací kód** (130 bitů): kořen účtu je
  zapečetěný pro každý passkey i pro kód; ztráta zařízení už neznamená ztrátu
  trezoru a databáze.
- **Relace přežijí restart** (hash tokenu na disku), klouzavá platnost 12 h,
  nejdéle 7 dní, **seznam zařízení** s odhlášením.

### Administrace a provoz
- **Role** vlastník / operátor / auditor, jmenné tokeny (`ADMIN_TOKENS`,
  správa v konzoli), **přihlášení do konzole passkey**; auditor jen čte.
- **Neměnný audit**: hash řetěz přes záznamy + podepsané kontrolní body
  (Ed25519), ověření z konzole.
- **Zálohy** (online backup SQLite, kopie šifrovaných DB, manifest se SHA-256,
  rotace; `BACKUP_DIR`), kontrola integrity, `VACUUM`.
- **Prometheus `/metrics`** (`METRICS_TOKEN`) a **alerty** s webhookem
  (`ALERT_WEBHOOK_URL`, prahy `ALERT_<PRAVIDLO>`), stav clusteru v konzoli.

### Klient
- `App.tsx` rozdělený do modulů (panely, ovládání hovorů, dialog, pomocné
  funkce); **error boundary** kolem aplikace i každého dialogu.
- **Menší bundle**: dialogy se načtou až při otevření, React ve vlastním
  chunku, KDF worker 216 → 29 kB; hlavní chunk 685 → 440 kB.
- Dlouhé konverzace: vykreslí se posledních 200 zpráv (další na požádání),
  zprávy mimo obrazovku se nepočítají (`content-visibility`).
- **Kompletní i18n** hlášek chatu (cs/en/de) + test úplnosti překladů.

### Testy a nástroje
- Fuzz/property testy (rámce, binární kusy, RESP, payloady, metadata souborů),
  zátěžový skript `npm run load-test`, test upgradu dat z 3.0, E2E: soubory
  přes relay, šifrovaný hovor, obnova účtu kódem, role v konzoli, cluster s
  reálným Redisem. Celkem 795 unit a 48 E2E testů.

### Opraveno
- Worker „background tick“ vznikal z `blob:` URL, kterou produkční CSP tiše
  blokovala — skrytá záložka neudržovala spojení (od 2.11.0).
- Do hovoru, ke kterému se připojil druhý ten, kdo spojení nezahajoval, nešel
  jeho zvuk (chyběla renegociace) — nyní „perfect negotiation“.
- Dva E2E testy sdílely port 5931 a při paralelním běhu mluvily s cizím
  serverem.

### Upgrade z 3.0
1. `git pull`, `npm ci` (nová závislost `hash-wasm`), `npm run build`.
2. nginx: CSP `script-src 'self' 'wasm-unsafe-eval'` (viz
   `deploy/nginx/m5cet.conf`); `nginx -t && systemctl reload nginx`.
3. Volitelně: `TURN_SECRET`, `METRICS_TOKEN`, `ALERT_WEBHOOK_URL`, `BACKUP_DIR`,
   `ADMIN_TOKENS`, pro více instancí `REDIS_URL` + `CLUSTER_SECRET`.
4. Restart; otevřená okna obnovit (klient 3.0 se s 3.1 nepotká).

## [3.0.0] – 2026-09-23

Profesionální komunikační platforma: nový protokol, nové šifrování, nová
fronta zpráv a úplně nová administrace s živým sledováním provozu a
auditem. **Nekompatibilní se staršími klienty** — viz „Upgrade“ níže.
Kompletní dokumentace (HTML + PDF): [`docs/site/`](docs/site/index.html).

### Protokol v2 (signalizace, `server/signaling/*`)
- **Každý rámec se validuje** do přesného tvaru s limity (`frames.ts`);
  přeposílané rámce server skládá z ověřených polí, nikdy nerozprostírá, co
  klient poslal. Chyby mají kódy (`invalid-frame`, `unknown-type`,
  `too-large`), rámec nad 256 KB zavře spojení (1009).
- **Rate-limity po třídách** (token bucket na socket: signalizace, relay,
  účtenky, presence, úložiště, proxy + bajtový limit, heartbeat, příkazy);
  kdo je opakovaně překračuje, je odpojen (1008). **Brána spojení** při
  upgradu: počet otevřených za minutu a naráz na adresu i celkem (429/503).
- **Kontrola Origin** při upgradu (`ALLOWED_ORIGINS` pro výjimky).
- **Peer ID přiděluje server.** Obsazené ID už nejde převzít (dřív šlo
  přesměrovat cizí signalizaci); stejný klient se po výpadku vrátí se svým
  ID díky jednorázovému `resume` tajemství.
- **Pseudonymy účtů v místnosti** (`refs.ts`): místnost nevidí ID účtu, ale
  HMAC odkaz platný jen pro ni — nejde spojit osobu napříč místnostmi ani
  zjistit, zda účet existuje. Tajemství je trvalé (`signaling.secret`).
- **Rámec `auth`**: přihlášení/odhlášení bez opuštění místnosti (dřív
  opětovný `join` shodil všem WebRTC spojení). **Odvolání relace** (odhlášení,
  smazání účtu, zásah admina) platí okamžitě i na otevřených socketech
  (`account-revoked`).
- **Heartbeat** (ping/pong) odhalí mrtvá TCP spojení — „přítomný“ uživatel
  za nimi už nezadržuje doručení přes relay. **Zpětný tlak**: pomalý příjemce
  nedostane další kusy souborů, zaseknutý je odpojen.
- **Proxy souborů**: chunky, konec i opakování smí posílat jen odesílatel;
  `proxy-need` jde jen odesílateli, odmítnutí příjemce ruší přenos jen pro
  něj; po odpojení odesílatele se jeho přenosy ukončí.
- Operátorské příkazy se doručí **hned**, je-li zařízení připojené.

### Šifrování v2 (`client/src/lib/envelope.ts`, `identity.ts`)
- **Klíče podle účelu**: heslo → NFC → PBKDF2-SHA256 **600 000** iterací →
  HKDF: zprávy, signalizace, soubory (klíč **pro každý soubor**), kontrolní
  hodnota klíče.
- **Associated data všude**: místnost + ID zprávy, odesílatel + příjemce
  signálu, přenos + pořadí + počet chunků. Šifrový text nejde přesunout
  jinam (jiná místnost, jiná zpráva, jiná pozice v souboru).
- **Zapečetěná signalizace**: SDP a ICE jdou přes server šifrované a
  svázané s odesílatelem i příjemcem — server nemůže podvrhnout DTLS
  otisky a posadit se doprostřed hovoru. Nezapečetěné signály se odmítají.
- **Identita zařízení** (ECDSA P-256, neexportovatelný klíč v IndexedDB):
  zprávy a soubory jsou **podepsané uvnitř šifrování**; TOFU pinování
  jméno → klíč, varování „jiný klíč než dříve“, bezpečnostní čísla (60 číslic).
- **Soubory**: podepsaný otisk celého souboru (SHA-256 přes otisky chunků)
  v koncovém rámci, kontrola před předáním; validace metadat před alokací
  (strop 2 M chunků); **bezpečný MIME** — HTML/SVG z chatu už nepoběží jako
  stránka v originu aplikace (dřív XSS přes `blob:` URL).
- **Ochrana proti replay** (ID zpráv), **kontrola klíče** mezi peery (hláška
  „jiné heslo“ místo nečitelných zpráv).
- **Zapečetěné zprávy**: kód 12 znaků (≈ 59 bitů, dřív 6 ≈ 30 bitů), bez
  modulo biasu, 600 000 iterací, normalizace při zadávání.
- **Historie pro server bez passkey** se šifruje už v prohlížeči klíčem,
  který nikdy neopustí zařízení; do žádného úložiště mimo prohlížeč nejde
  text ani kód zapečetěné zprávy.
- Obálky v1 jdou dál přečíst (zprávy z fronty z doby před upgradem).

### Fronta zpráv pro offline účty (`server/accounts/mailqueue.ts`)
- Tabulka v SQLite místo JSON souboru přepisovaného celý: **pořadí** (seq
  na účet a místnost), **deduplikace**, **lease** (doručení nemaže — jen
  potvrzení; po odpojení se lease hned uvolní), **kvóty** (na účet i na
  odesílatele), **expirace**, **dead-letter** s důvodem a obnovou z admina.
  Bez úložiště funguje stejně v paměti (`memqueue.ts`).
- **Účtenky jen pro skutečně relayované zprávy** a jen jejich odesílateli
  (dřív šlo podvrhnout „přečteno“ nebo vložit cizí položky do schránky).
- Odmítnutí je obecné — neprozradí jména ani existenci účtů.
- Staré schránky se při startu převedou do fronty.

### Administrace (nová konzole `/console/`)
- **Živý provoz**: každý rámec a požadavek (metadata — nikdy obsah), filtry,
  pauza, detail, graf propustnosti; **spojení** s adresou (/24), klientem,
  bajty, odpojením; **místnosti** (jako hash).
- **Audit**: bezpečnost, účty, komunikace (volitelné, výchozí vypnuto),
  úložiště, admin, síť, systém — úrovně, filtry, zdroj paměť/databáze,
  export CSV (s ochranou proti vzorcům) a JSON. Každý zásah operátora se
  zapisuje.
- **Uživatelé a passkeys**: databáze, trezor, fronta, relace, detail s
  passkeys a historií; odhlásit všude, smazat (s potvrzením ID).
- **Fronta**, **úložiště** (globální DB, tabulky, index šifrovaných DB),
  **systém** (RSS, heap, event loop p99, CPU, zdroje, grafy 30 min),
  **retence**, **příkazy a push**; zachovány nástroje layout builderu,
  telefonie a AI.
- Token jen v paměti (volitelně session storage), **nikdy v localStorage**
  (starý klíč se maže); striktní CSP bez inline skriptů.

### Bezpečnost serveru
- Log požadavků **bez těl odpovědí** (dřív se logovaly i session tokeny).
- Limity **před** parsery těl; vlastní limity pro trezor, úložiště, admin
  (počítá se hlavně odmítnutý token), sdílení.
- **Push endpointy jen známých služeb** (FCM, Mozilla, Windows, Apple;
  `PUSH_ENDPOINT_HOSTS`) — konec SSRF do interní sítě.
- Produkční **CSP `script-src 'self'`**, `object-src 'none'`; chyby 500 bez
  interních detailů; řádné ukončení na SIGTERM.
- `/api/transfers/stats` a `/api/events/recent` jen s admin tokenem.
- Varování, když chybí `WEBAUTHN_RP_ID` / `PUBLIC_BASE_URL`.

### Opraveno
- Admin služba zapisovala příkazy do vlastní (prázdné) fronty — ke klientům
  se nikdy nedostaly. Stav s živými daty teď spravuje hlavní služba, admin
  služba přeposílá (`MAIN_URL`).
- Obnovená historie označovala vlastní starší zprávy jako cizí.
- Úložiště: 18 oprav (limity, kvóty, povýšení session → účet v transakci,
  držitelé klíčů po zařízeních, ID relací jen jako HMAC, …) — `docs/storage.md`.

### Upgrade
- Klienti 2.x se po nasazení sami nabídnou k obnovení (kontrola buildu).
  Klient 2.x v místnosti s klientem 3.0 zprávy neotevře a spojení odmítne
  (nezapečetěná signalizace) — obnovte všechna okna.
- nginx: přidejte blok `location /api/admin/` z `deploy/nginx/m5cet.conf`.
- Admin služba potřebuje `MAIN_URL`, pokud hlavní služba neběží na
  `127.0.0.1:$PORT`.

## [2.11.0] – 2026-09-23

Okno, které se vrátí přesně tam, kde bylo — a chat, ve kterém je jen to, co
si lidé napsali. Viz [`docs/lifecycle-and-notices.md`](docs/lifecycle-and-notices.md).

### Přidáno
- **Hooky na pozastavení a probuzení aplikace.** Přepnutí záložky, přepnutí
  do jiné aplikace, `freeze`/`resume`, back/forward cache, zahození stránky
  i výpadek sítě — všechno se sjednotí do jednoho *pozastaveno* a jednoho
  *obnoveno* (`lib/lifecycle.ts`), s rozumnými odklady (přeblik na jinou
  záložku na dvě vteřiny nic nehlásí, `freeze` se hlásí okamžitě).
- **Při pozastavení** se uloží stav a u přihlášeného uživatele jde na server
  rámec `presence: away` — server od té chvíle zprávy přebírá a drží, i když
  socket ještě žije (pozastavená stránka nemusí spustit nic). Ostatní v
  místnosti vidí `peer-away`.
- **Při probuzení** se spojení vrátí do stejného stavu: pokud socket nepřežil,
  znovu se připojí do téže místnosti; jinak pošle `presence: back`, dostane
  vše, co server mezitím nasbíral, potvrdí to a odesílatelé vidí *doručeno*.
  Je to **totéž sezení** — data ani nastavení se nezahazují.
- **Flash oznámení**: systémové zprávy se nově zobrazují nahoře nad chatem —
  jedna naráz, max dva řádky, fade-in, 10 s, fade-out, kliknutím zavřít a
  hned naskočí další z fronty (s počtem čekajících). Nastavitelné je
  umístění, doba, animace, ikona, velikost písma, zaoblení, barvy i písmo.
- **Fronta odchozích zpráv pro light režim**: když nikdo není online, zpráva
  neselže — čeká zašifrovaná ve frontě, bublina má stav *odesílá se*
  (světlejší čárkované pozadí a ikona) a odeslání se zkouší při otevření
  kanálu, po návratu do okna a jednou za minutu. Limity: 200 zpráv, 60
  pokusů, 24 h, respektuje TTL zprávy.
- **Tik na pozadí** z Web Workeru (jednou za minutu) pro skrytou stránku:
  všimne si mrtvého socketu a zkusí frontu. Dokumentace poctivě popisuje, co
  prohlížeč umožňuje a co ne (zamrzlá stránka nespustí nic — od toho je Web
  Push).

### Změněno
- **V chatu jsou nově jen zprávy lidí.** Systémová hlášení jdou do flash
  oznámení; přepínač *Vzhled → Zobrazení → Oznámení → „Systémové zprávy i v
  chatu"* je vrátí i do konverzace v časové posloupnosti.
- Server ukládá zprávu pro away účet i tehdy, když jeho socket ještě žije —
  dřív by ji poslal na pozastavenou stránku, která ji nemusí zpracovat.

## [2.10.0] – 2026-09-22

Server konečně má vlastní úložiště — a každý uživatel v něm svou šifrovanou
databázi. Viz [`docs/storage.md`](docs/storage.md).

### Přidáno
- **Globální SQLite databáze** pro server: registrovaní uživatelé, jejich
  passkeys (jen veřejný klíč), **index všech šifrovaných databází** (kdo je
  vlastní, jak je klíčovaná, kdy vyprší, jak je velká), tabulka logů a
  ladění a tabulka všech přenosů — detailně. Sloupce `detail` u logů i
  přenosů jsou zapečetěné master klíčem, místnost jen jako hash.
- **SQLCipher databáze pro každého uživatele.** Přihlášený passkeyem: klíč
  se počítá z passkey (PRF → HKDF) v prohlížeči, server ho drží jen v paměti
  po dobu sezení — po restartu i po odhlášení je soubor neotevíratelný.
  Data jsou perzistentní a mažou se jen na příkaz uživatele.
- **Dočasné úložiště pro nepřihlášené** v režimu server-enhanced: klíč
  vygeneruje server na začátku sezení a drží ho zabalený master klíčem, data
  žijí **jeden den** a tlačítko „Smazat vše a odejít" je smaže hned.
- **Převod po registraci passkey**: data z dočasné databáze se překopírují do
  nové, klíčované passkeyem, původní se i s klíčem smaže a prohlížeč dostane
  id nové databáze, kam od té chvíle zapisuje.
- **Sada API funkcí pro celé úložiště** (`/api/storage/*`): stav, relace,
  otevření databáze klíčem, převod, souhrn, hodnoty, zprávy, místnosti,
  schránka, události, logy, přenosy a smazání všeho. Úplně stejné operace
  jdou i **přes signalizační WebSocket** (`{"type":"storage","op":…}`) —
  bez dalšího spojení a bez round tripu navíc.
- Operátorské pohledy za admin tokenem: `GET /api/admin/storage` (index,
  uživatelé, statistiky), `…/logs`, `…/transfers`.
- Proměnné `STORAGE_DIR` a `STORAGE_MASTER_KEY`; bez druhé se vygeneruje
  `storage.key` (0600) v adresáři úložiště.

### Opraveno
- **Vytvoření účtu a přihlášení passkeyem.** Klíč se nově odvodí **dřív**,
  než účet na serveru vznikne, takže po neúspěchu nezůstane osiřelý účet.
  Passkey bez rozšíření PRF (řada USB klíčů, starší platformy) teď dostane
  jasnou hlášku, co s tím — dřív skončil obecnou chybou. Trezor a databáze
  navíc používají dva nezávislé klíče odvozené z téhož PRF tajemství.

### Změněno
- Trezor přihlášeného uživatele se ukládá do jeho SQLCipher databáze (pořád
  zapečetěný prohlížečem — tedy dvojitě), soubor vedle indexu účtů slouží už
  jen jako záloha pro server bez úložiště.
- Přenosy se zapisují do serverové tabulky (směr, transport, stav, bajty,
  chunky, zopakované chunky); chybějící chunky se hlásí do logu.
- Nová **volitelná** nativní závislost `better-sqlite3-multiple-ciphers`
  (SQLCipher) — instalace kvůli ní nespadne. Když modul chybí, server běží
  dál a `GET /api/storage/status` hlásí `available: false`.

## [2.9.0] – 2026-09-22

Konverzace, která může zůstat — a uživatel, za kterého server odpoví.
Viz [`docs/accounts-away.md`](docs/accounts-away.md).

### Přidáno
- **Data a historie chatu** (Menu → Spojení): tři volby — *nové připojení
  smaže chat a logy* (výchozí), *chat a logy do konce sezení* (šifrovaně
  v prohlížeči, tlačítko **Odhlásit — smazat sezení a data**), *chat a logy
  na serveru* (zašifrované passkeyem, vyžaduje registrovaný passkey).
- **Účet ověřený passkeyem** (`/api/account/*`): server ověřuje podpis
  WebAuthn (ES256 / Ed25519 / RS256, rpId, origin, UV, čítač) vlastním kódem
  nad `node:crypto` — bez nové závislosti. Klíč z rozšíření **PRF** zapečetí
  profil i historii, takže server drží jen šifrový text a metadata.
- **`/signin`**: návštěva se pokusí přihlásit uloženým passkeyem, dešifruje
  data, nahraje je do aplikace a cestu hned uklidí zpět na `/`. Sem míří i
  probouzecí push.
- **Odznak „přihlášen"** vedle loga s ikonou odemčeného klíče; po kliknutí
  okno účtu: přihlašovací údaje, velikost sezení na serveru, datum vzniku a
  posledního přihlášení, počet a velikost zpráv, čekající schránka, zařízení
  pro upozornění a **serverový log aktivity** (přihlášení, dešifrování,
  načtení a uložení dat, away, relay, push).
- **Stav away a relay**: přihlášenému uživateli, který se odpojí, zůstane
  místo v místnosti. Ostatní posílají dál — server šifrový text uloží,
  odpoví za něj (`stored`) a zkusí probudit prohlížeč push zprávou. Po
  návratu doručí vše najednou, klient potvrdí a odesílatel vidí *doručeno*
  (a *přečteno*, pokud je potvrzování zapnuté). Stav zprávy je i značkou
  v bublině a s časy v detailu zprávy.
- Seznam **Příjemci** je nově ukotvený **vpravo u tlačítka menu** (ne vlevo
  pod logem, a pod stavovou lištou, aby nepřekrýval Odpojit — výšku lišty
  měří aplikace), jeho tlačítko jde přetáhnout kamkoli a pozice se pamatuje
  (u přihlášeného uživatele i na serveru). Away účastníci jsou v seznamu
  vidět a dají se vybrat jako příjemci.
- Instalátor dává službě zapisovatelný `StateDirectory=m5cet`
  (`DATA_DIR=/var/lib/m5cet`), aby účty přežily restart pod
  `ProtectSystem=strict`.

### Opraveno
- **„File transfer failed: Missing chunks at end-of-transfer."** Tři příčiny,
  všechny se projevily až na konci jinak zdravého přenosu:
  - Příjemce zpracovával rámce **souběžně** — každý se dešifruje asynchronně
    a přichází ve vlastním volání handleru, takže první chunky předběhly
    `meta` (a spadly jako „unknown transfer") a `end` předběhl poslední
    chunky. Rámce se nově řadí do fronty podle `transferId`.
  - Odesílatel **tiše zahazoval** chunk, jehož `send()` prohlížeč odmítl
    (plná fronta, v Chrome 16 MiB). Nově počká, až se buffer vyprázdní, a
    zkusí to znovu (6 pokusů); když to nejde, přenos skončí chybou, místo
    aby dorazil děravý soubor. Čekání na buffer se navíc nevzdává po 1,5 s.
  - Když se chunk přesto ztratí (kanál se rozpadl a vrátil, výpadek relay),
    příjemce si o chybějící části **řekne** (`file-need` / `proxy-need`) a
    odesílatel je zopakuje — až tři kola, pak teprve chyba (nově s počtem
    chybějících částí). Viz [`docs/files.md`](docs/files.md).
- **Přenos přes server relay vůbec nedoručoval.** Server přeposílal jen
  `proxy-end`; `proxy-meta` a `proxy-chunk` si nechával pro sebe (a ukládal
  je oříznuté na 256 znaků). Nově přeposílá všechny rámce a těla chunků
  neukládá vůbec — jen počítá, co prošlo, kvůli limitu.

### Změněno
- `POST /api/passkey/profile` (neautentizované úložiště profilu podle id
  credentialu) **je pryč**; nahradil ho účet s ověřeným podpisem. Profil se
  ukládá do trezoru účtu.
- Retenční úklid maže i nedoručené položky schránky (`RELAY_RETENTION_DAYS`,
  výchozí 30) a staré záznamy auditu účtů.
- Psát jde i tehdy, když je protějšek ve stavu away (dřív bylo tlačítko
  Odeslat zašedlé, dokud nikdo nebyl připojený).

## [2.8.1] – 2026-09-22

Operátorské cesty hlavní služby za admin tokenem, retence, která opravdu
běží a maže. Viz [`docs/api.md`](docs/api.md) (Push, Retence).

### Zabezpečení
- **`POST /api/push/test` už nerozešle push bez autentizace.** Bez tokenu jen
  self-test: `{ id }` = vlastní id odběru z `/api/push/subscribe`, pevný text,
  jen na tuto subskripci (`404` neznámé id). Broadcast všem (`{ broadcast: true }`,
  i požadavek bez `id`) jen s `Authorization: Bearer $ADMIN_API_TOKEN`.
  Dřív požadavek bez `id` poslal text volajícího na cizí zařízení. Navíc
  limit 10 testů / min na IP.
- **`GET|POST /api/admin/retention*` vyžadují admin token** (`503` bez
  nastaveného `ADMIN_API_TOKEN`, `401` bez tokenu / se špatným, s
  `WWW-Authenticate: Bearer`).
- Kontrola tokenu v konstantním čase je jeden sdílený helper
  (`server/admin-auth.ts`) pro admin službu i hlavní službu. Routy zůstávají
  v hlavní službě, protože push subskripce, settings, audit, consent i event
  ring žijí v její paměti — admin proces má vlastní prázdné kopie.

### Opraveno
- Retence se **spouští sama**: `unref` timer v hlavní službě každých
  `RETENTION_SWEEP_MINUTES` (výchozí 60, 1–1440; nová proměnná, i v
  instalátoru). Dřív jen ručně přes neautentizovaný endpoint.
- Settings sync se maže podle `SETTINGS_RETENTION_DAYS` (dřív omylem podle
  `DATA_RETENTION_DAYS`).
- Prošlé události se opravdu mažou z ringu (`EVENT_RETENTION_DAYS`); dřív se
  cutoff spočítal a nepoužil.
- Vyprázdněné per-device audit logy se odstraní celé.
- `GET /api/admin/retention` vrací i plán a poslední sweep (`lastSweep`,
  `nextSweepAt`, `intervalMinutes`); ruční sweep už nepřeskakuje „not due".
- Komentář v `server/retention.ts` sliboval 24h výchozí hodnotu; skutečné
  výchozí hodnoty jsou 30/60/90/7/30 dní — opraveno.
- Tlačítko *Test web push* posílá jen vlastní id; bez odběru poradí povolit
  notifikace, po `404` (restart serveru) zapomene neplatné id.

## [2.8.0] – 2026-09-22

Vzhled, mobilní layout, Edit Mode, druhy zpráv, telefonie a admin layout
builder. Wire formát zpráv je zpětně kompatibilní (nová pole jsou volitelná).

### Přidáno
- **Obrazovka Vzhled** (*☰ → Vzhled*, nahoře v menu rychlý přístup):
  šablona, 71 Google Fonts + systémová písma (rozhraní / zprávy / kód, velikost,
  tloušťka, řádkování, prostrkání; Google až po souhlasu), paleta 116 barev +
  vlastní barva s kontrastem (akcent, bubliny, zaoblení, pozadí), zobrazení
  a zařízení, editor. Viz [`docs/appearance.md`](docs/appearance.md).
- **Edit Mode** (přepínač ✓/✗ ve Vzhledu i nahoře v menu): výběr libovolného
  prvku Ctrl + pravým tlačítkem nebo dlouhým stiskem; inspektor ve Shadow DOM
  (selektor, stavy :hover/:active/:focus/:visited/::before…, zařízení,
  !important, řádky i zdroj, zdrojový kód tříd, přidání/odebrání tříd, box
  model); trvalé uložení, export/import, `?nostyles`.
- **Mobilní layout podle zařízení a prohlížeče** (`data-os/-browser/-form/-input`):
  iOS klávesnice (visual viewport), spodní panely, 16px pole, 44px cíle,
  celá obrazovka, instalace, `theme-color`.
- **Verze a build v aplikaci** (patička menu, Vzhled → Zobrazení,
  `/api/health`) a upozornění „nová verze — Obnovit" pro karty otevřené před
  nasazením (`dist/public/build.json`).
- Druhy zpráv: klikací (odkrytí podržením), mizející (4 s – 2 h, teploměr na
  okraji) a zapečetěné (vlastní kód); hlasové zprávy s přepisem; AI panel;
  NFC workbench; PassKey profil na serveru; plovoucí widget příjemců
  (ukotvení, nastavení); info o zprávě s auditní stopou; odpověď a přeposlání;
  avatary a styl bubliny pro každého uživatele.
- Telefonie: SMS a hovory přes Twilio / Telnyx / Vonage (Vonage Voice JWT),
  SIP trunky (perzistentní + `SIP_TRUNKS` v `.env`), webhooky
  `/wh/{provider}/{typ}` s ověřením podpisů, konzole v adminu.
- Admin **Layout / template builder** (styly komponent, šablony se zástupnými
  parametry a includes, živý náhled); systémové zprávy s monochromatickým
  logem, plným datem a sbalováním.
- `TRUST_PROXY`: reálné IP klientů za reverzní proxy (rate limit na
  návštěvníka, ne na nginx).

### Opraveno
- Bezpečné okraje (výřez, home indikátor) se na iPhonu nikdy neuplatnily.
- Vonage klíč: poškozený / neúplný PEM se hlásí srozumitelně (dřív 502
  `DECODER routines::unsupported`).
- Dev server za doménou: 403 na `/@fs/…`, pád po zamítnutém požadavku.
- Detekce změn konfiguračních souborů podle obsahu (ne mtime).
- `/api/turn` bez TURN serveru vracel 404 (červená chyba v konzoli).

## [2.7.0] – 2026-09-21

Relace, pozvánky, úplné smazání stop, menu pod ikonou a nové šablony.
Wire formát zpráv beze změny. Podrobně
[`docs/session-and-sharing.md`](docs/session-and-sharing.md).

### Přidáno
- **Šifrovaná session cache** (`lib/session-cache.ts`): jméno, room ID, klíč
  místnosti a požadovaný stav; AES-GCM pod neexportovatelným klíčem
  v IndexedDB, šifrovaný text v `sessionStorage`. Platí do zavření karty,
  po hodině nečinnosti se smaže. Po reloadu se aplikace sama připojí.
- **Vynucený požadovaný stav**: „Připojit" → aplikace spojení drží a po výpadku
  zkouší znovu s prodlevou; pokusy se logují (*Spojení → Pokusy o spojení*).
  „Odpojit" je dostupné i během navazování a zapisuje se synchronně.
- **Pozvánka odkazem + 12místný kód `XXXX-XXXX-XXXX`** (*Místnost → Sdílet*):
  klíč rozdělený mezi fragment URL, server a kód; 5 špatných kódů odkaz zničí,
  limit X připojení, platnost 1 h – 7 dní, zneplatnění. `GET` od robotů
  a náhledů nic nespotřebuje; příjemci se odkaz ihned smaže z adresy.
  Sdílení: WhatsApp, Telegram, Viber, Signal, Messenger, iMessage, SMS, e-mail,
  QR (lokálně), kopírování, systémový dialog. Endpointy `/api/share/*`.
- **„Smazat vše a odejít"** na konci menu: smaže úložiště, IndexedDB, cache,
  service worker, push, cookies a serverová data zařízení, pak `/goodbye`
  s hlavičkou `Clear-Site-Data`.
- **Šablony** Midnight, Paper a Kontrast (celkem 6), ke každé **6 barevných
  variací** a **4 rozvržení** (klasické, široké, kompaktní, soustředěné).
- Modální okna se zavírají klávesou Escape.

### Změněno
- **Menu se otevírá ikonou ☰** (tři čáry) jako výchozí; dřívější uložená volba
  se jednou převede, ostatní režimy zůstávají v Nastavení.
- Pokus o připojení, který skončí výjimkou, už smyčku opakování neukončí.

### Bezpečnost — co je potřeba vědět
- Klíč místnosti se nově **ukládá** (šifrovaně, jen po dobu života karty).
  Do 2.6.0 se neukládal vůbec. Nechrání před kódem běžícím v originu stránky
  ani před forenzním čtením profilu prohlížeče.
- **Historii prohlížeče web smazat neumí.** „Smazat vše a odejít" odstraní vše
  ostatní a do historie nic tajného nedává.
- Pozvánky jsou v paměti serveru — restart je zneplatní.
- Nová závislost `uqr` (QR, MIT, bez závislostí), načítaná až na vyžádání.

### Otestováno
- 139 unit testů (nově session cache, pozvánky klient + server), **20 e2e
  testů** ve skutečných prohlížečích, třikrát po sobě bez selhání: reload →
  automatické připojení, „odpojen" přežije reload, celý tok pozvánky včetně
  špatného kódu a limitu použití, úplné smazání po „Smazat vše a odejít".
- **Neověřeno:** deep linky do messengerů na reálných zařízeních,
  `Clear-Site-Data` v Safari a Firefoxu, chování při zavření karty na iOS.

## [2.6.0] – 2026-09-21

Větev `clean-installation`: nová instalační sada, oprava odesílání souborů,
přepracované menu a kompozér, úklid repozitáře. Wire formát beze změny.

### Přidáno
- **Instalační sada** `install.sh` / `update.sh` / `uninstall.sh` +
  `installer/lib/` (bash ≥ 3.2). Zjistí systém, doinstaluje závislosti,
  průvodce v textu nebo `whiptail`/`dialog` (cs/en), bezobslužný režim
  a soubor odpovědí. Dva způsoby nasazení — **native** (systemd / proces)
  a **docker** — přepínatelné za běhu. Volby v `.m5cet/install.conf`, tajemství
  v `.env`; zálohy a **automatický rollback** při neúspěšné aktualizaci;
  `--repair`, `--doctor`. Podrobně [`INSTALL.md`](INSTALL.md).
- Generovaný web Nginx omezuje WebSocket spojení na klienta — změřeno 60
  souběžných upgradů: 20 × `101` + 40 × `503` přes proxy, 60 × `101` přímo na
  aplikaci (jejíž vlastní WS limiter se nespouští).
- Server: proměnná `HOST` — nativní instalace může poslouchat jen na loopbacku.
- Menu seskupené do čtyř skupin (místnost / komunikace / nástroje / aplikace)
  a **uživatelský prvek** (avatar + jméno → profil) v liště i mobilním panelu.
- `docs/modes.md`: režimy Light / Server-enhanced, jejich parametry a soubory,
  odpověď na otázku Firebase (hlavní aplikace ho nepoužívá).
- E2E test dvou peerů (`test/e2e/two-peers.test.ts`) — první test pokrývající
  `App.tsx`; unit test `linkify`; CI joby `installer` a `e2e`.

### Opraveno
- **„File exceeds inline cap of 512.0 kB; use chunked transfer."** Tlačítka
  Soubor/Obrázek u zprávy uměla jen inline cestu. Větší soubory se nyní
  pošlou automaticky šifrovaně po částech.
- **Chunked odesílání padalo po posledním chunku**: `useRef`/`useEffect` byly
  volány uvnitř asynchronního handleru za `await`. Karta přenosu zůstávala
  „běží" a hláška o úspěchu se nezobrazila.
- Bez připojeného peera se přenos nespustí — dřív spadl do serverové „proxy"
  cesty, která data nedoručuje, a přesto hlásil úspěch.
- Mobilní stavový štítek ukazoval první písmeno interního stavu („i").
- E2E sada: tři chybné testy (očekávání 60 znaků v poli s limitem 42; test
  „linkify", který si odkaz `javascript:` vložil sám; test API proti
  statickému serveru).

### Změněno
- Kompozér je jedna lišta s ikonami a **kulatým tlačítkem Odeslat 40 px**
  místo bloku vysokého 56 px (na mobilu přes celou šířku).
- `Dockerfile.admin` odstraněn: admin běží ze stejného image s jiným
  `command` a své GUI servíruje sám; odpadl i kontejner `admin-ui` (nginx).
- Výchozí větev instalátoru je `master` (dřív zastaralá feature větev).
- Kořen repozitáře má tři dokumenty (`README`, `INSTALL`, `CHANGELOG`);
  `KNOWLEDGE_BASE` a `CLIENT_OPTIMIZATIONS` přesunuty do `docs/`, `DEPLOYMENT`
  sloučen do `docs/deployment.md`, pravidla z `WORKFLOW` do vývojářského
  průvodce, `PROGRESS` zrušen.

### Odebráno
- Nepoužité obaly šablony: `QueryClientProvider`, `TooltipProvider`, `Toaster`
  a hash router s jedinou trasou. S nimi 9 balíčků (runtime závislosti
  **16 → 8**), `components/ui`, `use-toast`, `queryClient`, `utils`,
  `calls.ts`, `shared/schema.ts`, `server/storage.ts`, `components.json`,
  mrtvé Tailwind tokeny. **JS 495 → 373 kB** (gzip 153 → 113), CSS 39,7 → 33,7 kB.
- Jednorázové skripty `merge-and-tag-v2.4.1.sh`, `notes-to-patch.sh`, `.memory/`.

### Bezpečnost
- Instalátor nezapisuje tajemství do compose souboru ani do chybových hlášek;
  konfiguraci parsuje proti seznamu klíčů, nikdy ji nenačítá přes `source`.
- ⚠️ Commit `fb31919d` (2.5.0) omylem zahrnul `browser-only-firebase/conf.json`
  a úpravu `app.js` se skutečnou webovou konfigurací Firebase a byl odeslán do
  veřejného repozitáře. Nejde o serverové tajemství, ale zveřejnění nebylo
  záměrné — doporučeno omezit API klíč na referrery domény / zapnout App Check.

### Otestováno
- `tsc` čisté · 106 unit testů · 10 e2e testů · guard 8/8 · build OK ·
  `shellcheck` čistý. Instalátor: viz „Co je ověřeno" v `INSTALL.md`.
- Vzhled: desktop a 375 px ve všech třech tématech.
- **Neověřeno:** unit pod skutečným systemd, certbot/TLS, ufw/firewalld,
  dnf/yum/pacman/zypper/apk; skutečný hovor mezi dvěma zařízeními.

## [2.5.0] – 2026-09-21

Modernizace toolchainu, úklid závislostí a oprava regresí z větve
`empero-ai-updates`. Wire formát (salt `CipherRoom:v1:`, obálka
`{ iv, ciphertext }`) se **nemění** — klienti 2.4.x a 2.5.0 spolu komunikují.

### Opraveno
- **Šifrovací jádro (`client/src/lib/crypto.ts`) bylo na větvi nefunkční.**
  Přepsaná verze volala `deriveKey` s nevyřešeným `Promise` místo
  `CryptoKey` (odvození klíče vždy selhalo), `decryptEnvelope` obsahoval
  `new Uint8Array.from(...)` (vždy `TypeError`), IV se serializovalo jako
  text místo 12 B base64, dekódování rozbíjelo UTF-8 a `encryptEnvelope`
  vracel `{ ...envelope, iv, ciphertext }` — tedy **plaintext vedle
  ciphertextu**. Cache klíčů byla navíc klíčovaná jen názvem místnosti, takže
  změna passphrase se 5 minut neprojevila. Obnovena ověřená implementace
  z `master`; cache odstraněna (klíč se odvozuje jednou za join, ne za zprávu).
- **`connection-keeper.ts`**: přepsaná verze měla 9 chyb `tsc` a logické
  vady (backoff `Math.min(initial, initial·2ⁿ)` je vždy `initial`, ignorovaná
  `options.strategy`, neodchycená výjimka z `new WebSocket()`, zmizelý export
  `STRATEGIES`). Obnoveno z `master`. **Dopad za běhu byl nulový:** `App.tsx`
  modul jen importuje kvůli typům a `createConnectionKeeper` nikde nevolá —
  signalizační socket, heartbeat i reconnect má napsané vlastní (viz Známé
  mezery níže).
- **`Permissions-Policy`**: hodnota `camera=(), microphone=(), geolocation=()`
  zakazovala funkce i vlastnímu dokumentu — hovory, STT a sdílení polohy tak
  nemohly fungovat (ověřeno v prohlížeči: `allowsFeature()` → `false`).
  Nově `(self)`; cizí iframy zůstávají blokované.
- **Start na macOS**: `listen({ reusePort: true })` končil `ENOTSUP`. Volba
  odstraněna — server drží místnosti v paměti procesu, sdílení portu mezi
  procesy by navíc rozdělilo peery jedné místnosti.
- **`.tsx` testy se nikdy nespouštěly**: `"jsx": "preserve"` + transformace
  Vite 8 (oxc) → chyba při importu. Nastaveno `react-jsx`, do
  `vitest.config.ts` přidán `@vitejs/plugin-react`. Tím vyšly najevo a byly
  opraveny dvě skutečné chyby v `MainMenu`:
  - tlačítka v režimu `icons-text` neměla na úzkém viewportu přístupný název
    (popisek je `hidden sm:inline`, `aria-label` chyběl),
  - do portálovaného speed-dial panelu se nedalo dostat klávesnicí (šipky
    obsluhoval jen `<ul>`), `Home`/`End` padaly na záporném indexu.
- `test/transfer-card.test.tsx`: řetězec ukončený typografickou uvozovkou `”`.
- `scripts/pre-commit-check.sh`: `\s` v `awk` není POSIX a BSD awk (macOS) ho nezná →
  na macOS kontrola 3 vždy selhala a negativní kontroly 4–5 procházely
  naprázdno. Přepsáno na `[[:space:]]`, rozsah zúžen na konkrétní pravidlo,
  ověřeno negativním testem. Hook `.githooks/pre-commit` je nově spustitelný.
- `test/e2e/ui-smoke.test.ts`: `app.get("*")` v Express 5 vyhazuje výjimku,
  testovací server tedy nikdy nenaběhl. Nahrazeno `app.use("/{*path}")`.
- `script/build.ts`: `optionalDependencies` nebyly mezi externals, nativní
  addon `bufferutil` se tak přibaloval do bundlu, kde nemůže fungovat.

### Změněno
- **Node.js ≥ 22** (`engines`), Docker a CI na **24 LTS** (Node 20 je EOL).
- TypeScript 5.6 → **7.0** (odstraněno `baseUrl`; typy bajtů zpřesněny na
  `Uint8Array<ArrayBuffer>`), Vite 8.3, Vitest 5, `@vitejs/plugin-react` 6,
  React 19.3, lucide-react 1.x, esbuild 0.28.2, Express 5.2, Helmet 8.3 aj.
- `dotenv` nahrazen vestavěným `process.loadEnvFile()` (`server/env.ts`);
  skutečné prostředí má dál přednost před `.env`.
- **Base64 kodek sjednocen** do `lib/crypto.ts` (dříve 3 kopie). Používá
  nativní `Uint8Array.toBase64/fromBase64`, jinak blokový fallback. Změřeno
  (Node 24, 32 KiB chunk): kódování 2,3×, dekódování 32× rychlejší; výstup
  bajtově shodný. Viz `CLIENT_OPTIMIZATIONS.md`.
- Build: oba server bundly jedním voláním esbuild, souběžně s Vite; klient
  minifikuje oxc. Do bundlu nově patří i `helmet`.
- Docker: runtime image už **neobsahuje `node_modules`** (bundly jsou
  soběstačné — ověřeno spuštěním v prázdném adresáři), běží jako `USER node`.
  `docker-compose.yml` bez zastaralého klíče `version`.
- `tsBuildInfoFile` přesunut do `node_modules/.cache/tsc/`.

### Odebráno
- 44 nepoužívaných shadcn/ui komponent (zůstávají `card`, `toast`, `toaster`,
  `tooltip`) a hook `use-mobile`. Obnova: `npx shadcn add <název>`.
- 58 nepoužívaných balíčků — runtime závislosti **68 → 16**, dev 25 → 19,
  instalovaný strom (lockfile) **562 → 349** balíčků: mj.
  `@supabase/supabase-js`, `passport`, `express-session`, `better-sqlite3`,
  `drizzle-*`, `zod`, `recharts`, `framer-motion`, 25× `@radix-ui/*`.
  S nimi `drizzle.config.ts` a skript `db:push` (schéma nemá žádné tabulky).
- Produkční CSS **78,2 → 39,7 kB** (gzip 13,9 → 8,6 kB): Tailwind skenoval
  i nepoužité komponenty.

### Bezpečnost
- `.dockerignore` nově vylučuje `.env` — dříve se `ADMIN_API_TOKEN`, VAPID
  privátní klíč a TURN přihlašovací údaje dostávaly do build vrstvy image.
- Regresní testy wire formátu: obálka smí obsahovat jen `iv` + `ciphertext`,
  IV má přesně 12 B, UTF-8 a 512 kB příloha projdou beze ztráty.
- `KNOWLEDGE_BASE.md` přepsán: původní text uváděl jako referenci smyšlený
  kód (odvození klíče bez PBKDF2, opakované IV, prohozené VAPID klíče).

- Admin API: porovnání Bearer tokenu je nově v konstantním čase
  (`timingSafeEqual` nad SHA-256), dříve prosté `!==`.

### Známé mezery (zjištěno při revizi, **neopraveno** — vyžadují rozhodnutí)
- **Rate limit WebSocket upgradu nefunguje.** `app.use("/ws", limiter)` je
  Express middleware, ale upgrade obsluhuje `ws` na události `upgrade` —
  změřeno: 45/45 spojení přijato při limitu 30/min. REST limiter funguje.
- **Chybí `trust proxy`.** Za Nginx (doporučené nasazení) je `req.ip` adresa
  proxy, takže všichni uživatelé sdílejí jeden kbelík 100 požadavků / 15 min.
- **Proxy přenos souborů nedoručuje data.** Server `proxy-meta` / `proxy-chunk`
  jen uloží (zkrácené na 256 znaků) a nikomu nepřepošle; rozesílá pouze
  `proxy-end` / `proxy-cancel`. Bez otevřeného DataChannelu soubor nedorazí.
- **Admin příkazy nepřekročí hranici procesu.** Fronta je Map v paměti admin
  procesu; hlavní služba (jiný proces / kontejner) ji nevidí. Totéž platí pro
  `/admin/clients` a `/admin/logs/recent`.
- **Neautentizované endpointy** hlavní služby: `POST /api/push/test`,
  `GET|POST /api/admin/retention*`; `GET /api/turn` vydává statické TURN údaje.
- **TOFU otisky jsou klíčované podle `peerId`**, které se při každém připojení
  generuje náhodně → každá relace je „první použití"; při neshodě se uložený
  otisk navíc přepíše.
- `connection-keeper.ts` není zapojený; UI uvádí max. backoff 30/15/8 s, běžící
  kód v `App.tsx` má strop 120 s a nemá inactivity timeout.
- CSP obsahuje `script-src unsafe-inline unsafe-eval`.
- Retence se nespouští sama (žádný timer), události nemaže nikdy.

### Záměrně neprovedeno
- **Tailwind 3.4 → 4** (a s ním `tailwind-merge` 3): mění výchozí hodnoty
  (barva borderu, ring, názvy stínů) napříč třemi tématy; bez vizuálních
  regresních testů to nelze ověřit. Tailwind 3.4 je dál udržovaný.

### Otestováno
- `npm run check` čistý · `npm test` 9 souborů / **95 testů** (dříve 65
  spustitelných, z toho 17 padalo) · `npm run check:menu` 8/8 · `npm run build` OK.
- Smoke produkčních bundlů: `/api/health`, statika, hlavičky, WS
  `hello → joined → pong`; admin `401` bez tokenu, `200` s tokenem, `400` pro
  příkaz mimo allowlist.
- V prohlížeči: nativní base64 cesta, round-trip šifrování, Permissions-Policy.
- **Neověřeno:** sestavení Docker image (daemon nebyl k dispozici), Playwright
  e2e (Chromium není nainstalován), reálný hovor mezi dvěma zařízeními.

## [2.4.2] – 2026-07-29

### Opraveno
- `MainMenu` (speed-dial): menuitems se po kliknutí nereagovaly na
  dotykových zařízeních / úzkých viewportech. Capture-phase listener
  `pointerdown` v `SpeedDial` zavíral portálovaný panel dříve, než
  React stihnul doručit `onClick` handlery. Přidán `panelRef` pro
  portálovaný container a do listeneru přidána kontrola
  `panelRef.current?.contains(target)`, takže klik uvnitř portálu
  nechal panel otevřený a forwardoval do Reactu.

### Přidáno
- `.github/workflows/ci.yml` — 4-job pipeline (typecheck, custom
  guard `pre-commit-check.sh`, vitest s `.tsx` soubory, build
  smoke + explicit aggregate gate) pro všechny PR a push na
  master / release / feature větve.
- `vitest.config.ts` — rozšíření `include` o `.tsx` soubory
  (`{ts,tsx}`) a přidání `node_modules/**` do `exclude`.

## [2.4.1] – 2026-07-29

### Přidáno
- Speed-dial panel pro `MainMenu`: integrace `createPortal(...)` z
  `react-dom` pro render plovoucího menu do `document.body`,
  `position: fixed !important` + `z-index: var(--z-menu)` (10000)
  v `index.css`. Tím panel uniká ze stacking-contextu rodičů
  (`.app-shell isolation: isolate`, `.app-header backdrop-filter`,
  `.toolbar overflow: hidden`).
- Nové CSS tokeny v `:root`: `--z-shell`, `--z-header`,
  `--z-menu-toggle`, `--z-menu-overlay`, `--z-menu`.
- Pre-commit guard `scripts/pre-commit-check.sh` — sedm invariant
  + „Known gaps" reminder sekce, brání regresi fixu.
- Vite hook `.githooks/pre-commit` — tenký wrapper na guard.
- Tři nové invariant testy v `test/main-menu.test.tsx`:
  panel v portálu, `--z-menu >= 9999`, `.menu-panel { position: fixed }`.

### Změněno
- `package.json` — přidány skripty `check:menu`,
  `check:menu:verbose`.
- `client/src/components/MainMenu.tsx` — reindent těla panelu
  o +2 mezery pro konzistenci s novou strukturou v portálu.
- `client/src/index.css` — `.menu-panel { contain: layout style }`
  (bez `paint`), `overflow: visible` pro panel.

## [2.1.0-rc.1] – 2026-05-08

Release-hardening kandidát na M5cet 2.1. Zaměřuje se na komentáře, dokumentaci
v češtině, robustnější instalátor a testovací smoke checks. Bez API breaking
změn vůči `2.0.x`.

### Přidáno
- `CHANGELOG.md` (tento soubor) s historií iterací M5cet.
- `INSTALL.md` — rozšířený průvodce instalací, aktualizací, testováním
  a odinstalací pro Linux / Docker / Debian-Ubuntu / generic.
- Rozšíření `install.sh`:
  - `--update` (alias pro upgrade z aktuální installace, vyvolá
    `clone_or_update_repo` a `start_app`),
  - `--test` (alias pro `--doctor`),
  - `--gui` (interaktivní textové menu, vhodné pro správce bez paměti všech flagů),
  - `--version`.
- Modulové hlavičky / JSDoc komentáře pro:
  - `client/src/App.tsx` (popis architektury + JSDoc nad
    `deriveRoomKey` / `encryptEnvelope` / `decryptEnvelope`),
  - `server/index.ts`, `server/routes.ts`, `server/static.ts`,
    `client/src/components/Modal.tsx`, `shared/schema.ts`.
- Plně český `README.md` s Mermaid diagramy (architektura,
  message flow, WebRTC signaling, admin API, install/update/test flow).
- Doplnění `docs/` o `security-model.md`, `troubleshooting.md`,
  `developer-guide.md`, `deployment.md`.

### Změněno
- `package.json` → verze `2.1.0-rc.1`, popis aktualizován na "M5cet …".
- `package-lock.json` synchronizován na `2.1.0-rc.1`.

### Bezpečnost
- Komentář u `deriveRoomKey` upozorňuje, že salt prefix `CipherRoom:v1:` je
  součástí formátu klíče a jeho změna je breaking migrace.
- Komentář u `encryptEnvelope` zdůrazňuje zákaz cachování IV.
- Admin příkazy zůstávají chráněné token autentizací (`ADMIN_API_TOKEN`)
  a allowlist (`ADMIN_COMMAND_ALLOWLIST`). Žádný path k arbitrary remote
  code execution nebyl přidán.

### Otestováno
- `npm ci` — 469 packages, ok.
- `npm run check` — `tsc` čistý, bez chyb.
- `npm run build` — Vite + esbuild, výstup `dist/index.cjs` ~851 kB,
  `dist/admin.cjs` ~796 kB.
- Smoke test hlavní služby: `GET /api/health` → `{ok:true,…}`, `GET /` → 200.
- Smoke test admin služby: `GET /admin/health`, `/admin/metrics` (s/bez tokenu),
  `/admin/clients`, `/admin/modules`, `/admin/commands/audit`,
  `/admin/plugins/debug`, `/admin/logs/recent`, enqueue safe + reject unsafe.
- `bash -n install.sh` — syntaktická kontrola ok.
- `docker compose config -q` — ok (vyžaduje docker, ověřeno v dry-run).

## [2.0.0] – 2025

### Přidáno
- Real-time / admin / media moduly: konekční keeper, push, audio+video volání,
  speech (TTS/STT/revoice), chunked šifrovaný file transfer, admin API + GUI,
  whitelisted klientské příkazy, mapy/lokace, Web NFC, dokumentace
  prohlížečových omezení.
- Interaktivní `install.sh` s plnou Linux/Docker podporou, doctor módem,
  detekcí starých instalací, zálohou `.env` / `data/` / `docker-compose.yml`
  a Nginx konfigurací.
- Rebrand CipherRoom → M5cet, full-screen layout, témata / i18n / TTL /
  privacy panely.

## [1.0.0] – dřívější

- Bezpečný E2E šifrovaný P2P chat na bázi WebRTC DataChannel a WebSocket
  signalingu. Žádná persistence zpráv na serveru.
- Browser-only Firebase WebRTC chat varianta.
- Production hosting konfigurace (DigitalOcean, Railway, Render, Fly.io,
  Nginx + TLS).

[2.7.0]: https://github.com/m5ike/cipherroom-secure-chat/compare/v2.4.2...HEAD
[2.4.2]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v2.4.2
[2.1.0-rc.1]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v2.1.0-rc.1
[2.0.0]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v2.0.0
[1.0.0]: https://github.com/m5ike/cipherroom-secure-chat/releases/tag/v1.0.0
