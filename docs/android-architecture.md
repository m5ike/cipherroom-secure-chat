# M5cet pro Android — architektura (6.0)

> Stav: **implementováno v 6.0.0** (větev `android_application`). Popisuje nativní
> aplikaci pro Android (Java), která je zároveň *frameworkem* M5cet: vzhled,
> obrazovky, animace, texty a knihovny akcí se řídí z administrace (sekce
> **Android**), každá sestava se zkompiluje, zašifruje, podepíše a zařízení si ji
> bezpečně nainstalují — s návratem k poslední funkční verzi, když selže.

## 0. Shrnutí

| Oblast | Řešení |
|---|---|
| Jazyk | Java 17, bez Kotlinu; Android 10+ (minSdk 29), compileSdk/targetSdk 37 |
| Chat | nativní port protokolu v2 / kryptografie v3 (Argon2id, HKDF, AES-256-GCM, ECDSA/ECDH P-256, sender keys) + WebRTC (DataChannel `m5cet`) |
| Víc místností | jedna `RoomSession` (vlastní WebSocket, klíče, mesh) na místnost, `RoomManager` přepíná, počítá nepřečtené |
| Zámek | biometrie (`BiometricPrompt` + `CryptoObject`) nebo PIN; počítadlo chyb, prodleva, wipe + událost na server |
| Šifrování dat | dvě vrstvy klíčů v Android Keystore (systémová bez uživatele, uživatelská za biometrií/PINem), AES-256-GCM, segmentované soubory, šifrovaná SQLite pole |
| Push | FCM (HTTP v1) datové zprávy šifrované pro zařízení (ECIES P-256) a podepsané serverem; bez FCM úsporné dotazování přes `JobScheduler` |
| Vzhled | nativní renderer stromů `android.*` (obrazovky, šablony, animace, téma) — edituje se v adminu stejně jako webové layouty |
| Aktualizace | balíčky `.m5ab` (podpis ECDSA, šifrování AES-256-GCM, klíč zabalený pro každé zařízení) + APK vydání přes `PackageInstaller` |
| Integrace | call log (`CallLog`; od 6.8 i self-managed `PhoneAccount` jen kvůli označení položek — hovory přes Telecom nejdou), notifikace s odpovědí, sdílení do místnosti, konverzační zkratky |

## 1. Klíče a formáty

Kódování: binární pole v JSON jsou **standardní base64 s paddingem** (jako web);
base64url bez paddingu jen pro identifikátory. Podpisy jsou **ECDSA P-256 /
SHA-256 ve tvaru IEEE P1363** (64 bajtů `r‖s`, base64) — stejně jako WebCrypto.
`kid` klíče = `base64url(SHA-256(SPKI))[0..16]`.

### 1.1 Serverový podpisový klíč
`$DATA_DIR/android/signing.key` (PKCS#8 PEM, 0600), ECDSA P-256. Podepisuje
balíčky, vydání a push zprávy. Veřejný klíč (SPKI base64) a `kid` dostane zařízení
při registraci a **připne si ho** (TOFU; APK může mít otisk zadaný při sestavení).

### 1.2 Klíče zařízení
* **Podpisový** — ECDSA P-256 v Android Keystore (neexportovatelný, StrongBox,
  když je). Podepisuje požadavky na server.
* **Šifrovací** — ECDH P-256; privátní klíč je zašifrovaný systémovou vrstvou
  (Keystore AES-256-GCM). Přijímá zabalené klíče balíčků a push zprávy.

### 1.3 ECIES (server → zařízení)
```
eph      = nový P-256 klíč serveru
shared   = ECDH(eph, encKey zařízení)            (32 B, x-souřadnice)
key      = HKDF-SHA256(shared, salt="m5cet/android/ecies/1", info=purpose+"|"+deviceId, 32 B)
ct       = AES-256-GCM(key, iv 12 B, plaintext, aad="m5cet/android/ecies/1|"+purpose+"|"+deviceId)
wire     = { e: SPKI(eph) b64, iv: b64, ct: b64 }
```
`purpose` = `push` (řídicí zpráva) nebo `bundle|<buildId>` (klíč balíčku).

### 1.4 Podepsané požadavky zařízení
Hlavičky `X-M5-Device`, `X-M5-Time` (ms), `X-M5-Nonce` (16 B b64url),
`X-M5-Signature` = podpis nad
`"m5android/1|" + METHOD + "|" + cesta?dotaz + "|" + time + "|" + nonce + "|" + b64(SHA-256(tělo))`.
Server ověří klíčem uloženým při registraci, čas ±5 min, nonce jen jednou,
stav zařízení `active`. Od 6.7 (audit N12) se nonce spotřebuje až po ověření
podpisu a drží se po celé okno času požadavku (u `/events`, kde čas smí být
až 30 dní starý, tedy 2 × 30 dní; mapa s pevným stropem).

### 1.5 Registrace
`POST /api/android/enroll` `{code?, name, model, manufacturer, os, sdk, appVersion,
appCode, locale, signKey, encKey, fcmToken?, time, proof}`, kde `proof` je podpis
`"m5android/enroll/1|"+signKey+"|"+encKey+"|"+time` podpisovým klíčem (důkaz
držení). Odpověď `{deviceId, policy, server:{kid, publicKey}, fcm, pollSeconds}`.
Režim registrace (admin): `open`, `code` (jednorázové/vícenásobné kódy), `closed`.
Odkaz `m5cet://enroll?server=…&code=…&kid=…` (QR z adminu) vyplní vše najednou.

**Pin klíče serveru (6.7, audit V6 / F-05, `security/ServerPin.java`).** Do
6.6 se porovnával jen řetězec `kid`, který server sám poslal. Teď musí být
klíč P-256 SPKI, `kid` ze serveru musí být kid tohoto klíče a každý pin
(`m5.serverKey` z buildu — kid nebo SHA-256 otisk —, `kid` z QR) musí
označovat **klíč**; `/enroll` musí vrátit tentýž klíč jako `/info`
a `Config.enrolled` cizí kid odmítne. Bez pinu z buildu i z QR zůstává
zápis důvěrou při prvním použití (TOFU). Od 6.7 server posílá i
**podepsanou politiku** `policySigned = {at, policy, sig}` (ECDSA klíčem
Androidu nad `m5policy/1|deviceId|at|JSON`) — viz kap. 3.

### 1.6 Balíček `.m5ab`
```
"M5AB" | u8 verze=1 | u32 BE délka hlavičky N | hlavička JSON (N B) | segmenty
segment i: IV (12 B) ‖ AES-256-GCM(CEK, IV, část i) ‖ tag (16 B)
           aad = "m5bundle/1|"+id+"|"+i+"|"+(poslední?"1":"0"); část = 256 KiB (poslední kratší)
```
Hlavička: `{id, number, version, channel, created, minAppCode, size, sha256, seg,
segments, ctSha256, kid, sig, recipients:[{device, e, iv, ct}]}`.
Podepsaný řetězec: `"m5bundle/1|"+id+"|"+number+"|"+version+"|"+channel+"|"+created+"|"+minAppCode+"|"+size+"|"+sha256+"|"+seg+"|"+segments+"|"+ctSha256`
(`sha256` = otevřeného obsahu, `ctSha256` = všech segmentů tak, jak leží v souboru).
`recipients` podpis nepokrývá — server k jednomu podepsanému balíčku přidává
příjemce (zabalený CEK přes ECIES, purpose `bundle|<id>`) pro každé zařízení.

Otevřený obsah = gzip kontejneru `M5PK`:
```
"M5PK" | u8 verze=1 | u32 BE počet | položky: u16 BE délka cesty | cesta UTF-8 | u32 BE délka | data
```
První položka `manifest.json`: `{format:1, id, number, version, channel, created,
minAppCode, files:{cesta:{size, sha256}}, screens:[…], languages:[…], notes}`.
Další: `theme.json`, `animations.json`, `screens/<id>.json`, `menus/<id>.json`,
`strings/<jazyk>.json`, `lib/<název>.json`, `assets/<název>`.

### 1.7 Vydání APK
Podepsaný řetězec: `"m5release/1|"+id+"|"+versionCode+"|"+versionName+"|"+package+"|"+apkSha256(hex)+"|"+certSha256(hex)+"|"+size`.
Zařízení ověří podpis serveru, SHA-256 staženého APK a že APK je podepsané **stejným
certifikátem** jako nainstalovaná aplikace; teprve pak spustí `PackageInstaller`.

### 1.8 Řídicí zprávy (FCM)
Datová zpráva (všechny hodnoty řetězce): `{m5:"1", i:<id>, e, iv, ct, s}`;
`s` = podpis `"m5push/1|"+deviceId+"|"+i+"|"+e+"|"+iv+"|"+ct`. Otevřený obsah
`{id, kind, at, exp, payload}`. Druhy: `ping` (odpověď stavem), `status` (podrobný
stav + výřez logu), `flash` (krátké upozornění v aplikaci / heads-up), `push`
(notifikace s titulkem a textem, volitelně místnost), `update` (zkontrolovat
balíček a vydání), `lock` (zamknout hned), `wipe` (smazat data), `config`
(obnovit policy). Priorita FCM: `high` jen pro `flash`, `push`, `lock`, `wipe`;
ostatní `normal` (Doze je sdruží — minimum energie). `collapse_key` pro
`status`/`update`/`config`, TTL podle druhu. Bez FCM: `JobScheduler` s omezením
na síť, interval z policy (výchozí 30 min), a `POST /api/android/checkin` vrací
čekající příkazy stejného tvaru.

## 2. Úložiště na zařízení

| Vrstva | Klíč | Chrání |
|---|---|---|
| systémová | Keystore AES-256-GCM `m5.sys` (bez ověření uživatele) → DEK_sys | konfigurace serveru, klíče zařízení, policy, počítadlo pokusů, fronta událostí, balíčky, log |
| uživatelská | DEK_user zabalený (a) Keystore klíčem `m5.bio` s biometrií (per-use `CryptoObject`, zneplatní nový otisk) a (b) KEK z PINu: `HMAC(Keystore m5.pep, PBKDF2-SHA256(PIN, sůl, 210 000))` | místnosti a hesla, zprávy, piny identit, soubory |

* Záznamy: AES-256-GCM, náhodný IV, `aad = účel|tabulka|id` (nelze prohodit).
* Soubory: segmenty 64 KiB, `aad = cesta|index|poslední` (nelze zkrátit ani přeházet).
* Hledání bez odhalení obsahu: slepý index `HMAC-SHA256(HKDF(DEK_user,"index"), hodnota)`.
* Wipe: smazání všech souborů, databází, preferencí a aliasů v Keystore.

## 3. Zámek a ochrana proti hádání

Policy z adminu (`/api/admin/android/config`): `biometric` (`required`/`optional`/`off`),
`pinLength` (4–12), `maxAttempts` (3–20), `wipe` (smazat po vyčerpání),
`backoff` (prodleva od 3. chyby: 30 s × 2^n, max 1 h), `autolockSeconds`,
`screenshots`. Každý neúspěšný PIN zvýší počítadlo v systémové
vrstvě; po `maxAttempts` aplikace podepíše událost `wipe` (uloží ji mimo mazaná
data), smaže vše a událost odešle, jakmile to jde. Server ji zapíše do auditu
(`security`/`warn`), zobrazí v adminu a spustí alert.

Změny 6.7 (audit S10–S14, N18, F-16):

* **Podepsaná politika** (`security/SignedPolicy.java`, `Config.applyServerAnswer`):
  aplikace použije jen politiku podepsanou připnutým klíčem serveru pro toto
  zařízení a ne starší než naposledy použitou (`policyAt`); jinou ignoruje
  (zůstane poslední podepsaná, nebo výchozí hodnoty aplikace);
  `autolockSeconds` nejvýš 24 h. Server 6.7 posílá podepsanou i
  nepodepsanou, takže starší aplikace fungují dál; aplikace 6.7 se starším
  serverem změny politiky nepřijme.
* **Pokus o PIN se počítá první** (`security/LockCounter.java`): zvýší se,
  označí a uloží **před** PBKDF2 / Keystore; zabití aplikace během derivace
  pokus nezruší. Derivace dál běží na UI vlákně.
* **Odmítnutý otisk prstu se nepočítá** (snímač po několika chybách zamyká
  systém); změna PINu vyžaduje současný PIN, počítaný jako pokus.
* **Zamčeno i na pozadí**: `AppLock.isLocked()` platí i na pozadí po uplynutí
  `autolockSeconds`, takže notifikace zpráv zneutrální hned (jen „Nová
  zpráva“, bez odesílatele, místnosti, zkratky a odpovědi); veřejná verze na
  zamčené obrazovce je vždy neutrální a odpověď z notifikace (API 31+) chce
  odemčený telefon.
* **Wipe** (`Wiper.teardown`) zruší i notifikace a zkratky, zastaví
  `CallService` / `LocationService`, HCE kartu a joby; vzdálený wipe ukončí
  proces (`finishAndRemoveTask`, `killProcess`).
* **Argon2id** běží vždy jen jedna derivace naráz (64 MiB).
* Obrazovky `lock` a `enroll` dostávají prázdné `$form`; nový PIN je
  v soukromém poli, ne v `$form`.

Změny 6.12 (F-16; přehled všech oprav 6.12 pro Android viz § 3.1):

* **Zámek zahodí datový klíč.** „Zamknout“ (menu, akce designu `lock.now`,
  příkaz serveru `lock`) i automatický zámek — při návratu z pozadí i když
  jeho čas uplyne na pozadí (časovač a alarm `Conversations`, od 6.12 budí
  telefon `setAndAllowWhileIdle`) — vynulují DEK uživatelské vrstvy
  (`Vault.lock`) a zahodí, co se s ním otevřelo: historii každé místnosti
  v paměti (předtím se uloží ještě s klíčem), uložené místnosti (názvy,
  passphrase), relaci účtu v paměti, propojení lidí, profilovou kartu
  a profily od členů, seznam Historie, souhlasy s řečí serveru
  (`M5.forgetSecrets`), na obrazovce `$form`, obrázky, seznam zpráv, composer
  a konverzaci s asistentem (`MainActivity.forgetUi`, `Parts.forget`).
  Odemčení klíč znovu odvodí. **Během hovoru** se obrazovka zamkne hned,
  klíč zůstane do konce hovoru (kontrola po 15 s); příkaz serveru zamkne
  i hovor.
* **Výchozí režim — příjem i po zamčení** (`chat/LockedRooms`,
  `security/LockBox`). Otevřené místnosti **zůstanou připojené** se svými
  klíči (klíč místnosti, sender keys, identita chatu, piny otevřených
  místností), zprávy dál chodí a oznámení jsou neutrální. Co by se mezitím
  zapsalo do šifrovaných úložišť, jde do **zámkové schránky**: při zámku
  vznikne dočasný pár P-256; soukromý klíč se zašifruje DEK a zapíše
  (`lockbox/<kid>.key`) **dřív, než se DEK vynuluje**, v paměti zůstane jen
  veřejný klíč. Každá položka (zpráva nebo její novější stav, potvrzení
  doručení / přečtení u mých starších zpráv, nový pin, údaj pro obnovení
  spojení, hovor, přijatý soubor) se zapečetí k tomuto veřejnému klíči —
  nový efemérní klíč na položku, ECDH, HKDF-SHA256, AES-256-GCM s AAD
  `m5/lockbox/1|<kid>|<pořadí>` — a připíše se do `lockbox/<kid>.log`
  (synchronizovaný zápis). Soubor, který se dokončí během zámku, se celý
  ověří a zůstane šifrovaný klíčem přenosu (`lockbox/files`), ten jde do
  schránky. **Odemčení** schránku uzavře, soukromý klíč odšifruje DEK,
  položky otevře v pořadí a sloučí: zprávy podle id (nová se připojí, známá
  se nahradí novějším stavem na svém místě; kontroly jako u historie),
  potvrzení zvednou stav mých zpráv, piny „první vítězí“, hovory jednou,
  soubory do trezoru; pak schránku i klíč smaže a místnostem vrátí historii
  (zprávy přijaté během zámku zůstanou živé objekty). Pád během zámku
  schránku nezničí (je na disku) a bez PINu ji nikdo nepřečte; další
  odemčení ji sloučí (dvojí sloučení nic nezdvojí). Zámek během slučování
  počká, až skončí. Zprávy přijaté během zámku jsou do odemčení v paměti
  (klíče místností jsou tam také); historie z doby před zámkem ne.
  Potvrzení „přečteno“ odejdou po odemčení, až se zprávy ukážou (jako dřív).
* **Přísný režim** (*Nastavení › Zabezpečení › Při zamčení odpojit
  místnosti*, `security.lockDisconnect`, výchozí vypnuto): zámek místnosti
  odpojí (`Rooms.disconnectAll`) a zahodí i jejich klíče; zamčená aplikace nic
  nepřijímá. Přihlášenému účtu zprávy podrží server (FCM, neutrální
  oznámení); **bez účtu zprávy poslané během zámku zmeškáte** — tak to říká
  i popis volby.
* **Klíč PINu ve zkontrolovaném hardwaru.** Nový Keystore klíč `m5.pin`
  (HMAC-SHA256, StrongBox, jinak TEE; jeho umístění se ověří přes
  `KeyInfo`) — KEK = HMAC(`m5.pin`, `"m5/pin/2|"` ‖ PBKDF2(PIN)), obal
  `user.pin` verze 2 (`PinWrap`, AAD `m5/user.pin/2`, pole `hw`). Instalace
  z 6.11 (verze 1 s `m5.pep`) se převede **při příštím úspěšném odemčení
  PINem** (stejná sůl, stejný DEK, žádné druhé PBKDF2); `m5.pep` se smaže až
  po zápisu verze 2. Telefon bez bezpečného hardwaru pro klíč nechá verzi 1
  (`hw: "software"`) a *Nastavení › Zabezpečení › Klíč PINu* to ukáže
  (StrongBox / bezpečný hardware / starší způsob / jen software). Pozn.:
  `m5.pep` byl i dřív Keystore klíč, jen bez kontroly, kde leží.
* **Čítač pokusů svázaný s Keystore** (`LockStore`): záznam čítače nese
  generaci a HMAC klíčem `m5.ctr.<generace>`; každý zápis vytvoří klíč další
  generace, zapíše záznam trvale (fsync souboru i adresáře) a teprve pak smaže
  starší klíč. Starší kopie souborů trezoru (nebo smazaný záznam) míří na
  smazaný klíč → **rollback = všechny pokusy vyčerpané** → wipe, nebo hodinová
  blokace podle politiky. Záznam z 6.11 se převezme se svými pokusy a zapečetí
  při dalším zápisu (nejdřív se označí `mig`, takže přerušení mezi kroky není
  rollback); Keystore, který teď neodpoví, nic nerozhoduje (pokus se
  nezapočítá → PIN se neověří). Proti kódu běžícímu jako aplikace to nechrání.
* **Nouzový PIN** (*Nastavení › Zabezpečení*, `security.duress`, výchozí
  vypnuto): nastaví se současným PINem, musí mít délku PINu z politiky a lišit
  se od PINu pro odemčení (a naopak nový PIN nesmí být nouzový). Na obrazovce
  zámku — i během prodlevy — aplikaci smaže stejnou cestou jako vyčerpané
  pokusy (`Wiper`, důvod `duress`) a spustí ji prázdnou bez hlášky „data
  smazána“; server se o smazání dozví. Uložen je jen ověřovač: HMAC(Keystore
  `m5.duress`, PBKDF2(PIN)) se stejnou cenou jako PIN (s nouzovým PINem trvá
  každý pokus zhruba dvojnásob).
* **Oznámení zpráv a zamčená obrazovka telefonu (G-22):** `VISIBILITY_SECRET`
  (na zamčené obrazovce nic, ani „Nová zpráva“), když uživatel zapne
  *Nastavení › Oznámení › Skrýt na zamčené obrazovce* (`notify.lockScreenHide`,
  výchozí vypnuto), a vždy, dokud je zamčená aplikace (i oznámení přepsaná
  při zámku `neutralizeAll`); jinak jako dřív `VISIBILITY_PRIVATE` s neutrální
  veřejnou verzí. Vyzvánění a zmeškaný hovor zůstávají `PRIVATE`
  (`telecom/LockScreen`).

Zbývá (F-16): limit pokusů vynucený bezpečným hardwarem pro vlastní PIN
aplikace Android nenabízí (s rootem / kódem jako aplikace lze PIN dál hádat
přes Keystore); obnova celé databáze Keystore spolu se soubory čítač vrátí;
mezi uplynutím autozámku a doručením alarmu zmrazenému procesu zůstává klíč
v paměti; ve výchozím režimu drží zamčená aplikace klíče otevřených místností
a zprávy přijaté během zámku.

### 3.1 Bezpečnostní opravy 6.12 (mimo protokol 4)

Opravy aplikace, které nezávisí na protokolu 4 (`docs/protocol-v4.md` řeší
kryptografii chatu zvlášť). `A/` = `android/app/src/main/java/cz/m5cet/app/`.
Ověřeno JVM testy, sestavením a lintem — **ne na telefonu**.

| Nález | Co se změnilo | Kde | Co zbývá |
|---|---|---|---|
| F-16 zámek | zámek vynuluje DEK a zahodí, co se s ním otevřelo; výchozí režim dál přijímá do zámkové schránky, přísný (`security.lockDisconnect`) odpojí | `A/security/AppLock.java`, `A/M5.java` (`forgetSecrets`), `A/chat/LockedRooms.java`, `A/security/LockBox.java`, `A/chat/Rooms.java` (`lockReceiving`), `A/chat/History.java` (`saveSession`, `merge`) | viz výše |
| F-16 klíč PINu | `m5.pin` ve StrongBoxu / TEE se zkontrolovaným umístěním, obal v2, převod při odemčení PINem | `A/security/Keystore.java` (`ensurePinKey`), `A/security/PinWrap.java`, `A/security/Vault.java` | hardwarový limit pokusů Android nenabízí |
| F-16 čítač | pečeť klíčem `m5.ctr.<generace>`, rotace při každém zápisu; rollback = vyčerpané pokusy | `A/security/LockStore.java`, `A/security/LockCounter.java` | obnova databáze Keystore rootem |
| F-16 nouzový PIN | volitelný, smaže aplikaci, prázdný start bez hlášky | `A/security/Duress.java`, `A/security/Wiper.java` | server vidí důvod `duress` |
| F-22 | jména normalizovaná (bez bidi / `\p{Cf}`, NFKC, mezery, 48 znaků), podobná jména a smíšená písma s „⚠“, oznámení serveru vždy „Operátor“ | `A/core/Names.java`, `A/ui/parts/People.java`, `A/ui/parts/MessageList.java`, `A/chat/RoomSession.java` (`onServerNotice`); vektory `android/app/src/test/resources/cz/m5cet/app/names-vectors.json` | web musí vektory odpovídat stejně |
| G-14 | `voice.engine=server`: dotaz se jménem poskytovatele jednou na místnost (TTS i přepis), „ne“ nic nepošle, čip „text čte server“ | `A/voice/ServerVoiceConsent.java`, `A/voice/Voice.java`, `A/ui/parts/ComposerVoice.java` | souhlas do zámku / konce procesu |
| G-20 | `copy` / `share` designu s počítaným textem: celý text (skryté znaky viditelně) a potvrzení; nad 2 000 znaků odmítnuto; kopie `IS_SENSITIVE` | `A/ui/DesignShare.java`, `A/ui/Actions.java` | — |
| G-22 | `VISIBILITY_SECRET` pro oznámení zpráv při volbě *Skrýt na zamčené obrazovce* a vždy při zamčené aplikaci; vyzvánění zůstává | `A/telecom/LockScreen.java`, `A/telecom/Notify.java` | odemčená aplikace + systémové „zobrazit vše“ ukáže obsah jako dřív |

Neověřeno (vyžaduje telefon): `KeyInfo` a StrongBox na Fold6, doba tvorby
klíče čítače, `Os.fsync` adresáře na f2fs, převod obalu v1 → v2 na instalaci
6.11, příjem během zámku a sloučení schránky (i po pádu procesu a s přijatým
souborem), přísný režim, odložený zámek během hovoru, `VISIBILITY_SECRET`
v One UI, nouzový PIN, dialog souhlasu s řečí serveru.

## 4. Framework: obrazovky, šablony, animace

Obrazovky `android.*`: `splash`, `lock`, `enroll`, `rooms`, `room`, `message.in`,
`message.out`, `message.sys`, `users`, `users.handle`, `settings`, `call`,
`update`, `about`. Uzel:
```
{ id, el, text?, props?, style?, anim?, if?, each?, as?, on?:{click|longClick:{action, arg?}}, children? }
```
Prvky: `column, row, stack, scroll, list, text, icon, image, button, iconButton,
input, switch, checkbox, badge, avatar, divider, spacer, card, chip, progress, slot`.
`slot` vloží nativní součást (`messages`, `composer`, `roomList`, `roomTabs`,
`userList`, `callControls`, `lockPad`, `logo`, `splashLogo`, `enrollForm`,
`settingsList`, `updateCard`).
Styl: `padding, margin, gap, width, height, weight, align, justify, bg, fg, radius,
border, elevation, size, bold, font, lines, opacity`; barvy tokeny tématu
(`@primary`, `@surface`, `@onSurface`, `@muted`, `@accent`, `@danger`…) nebo `#rrggbb`.
Animace uzlu `anim.enter = {type: fade|slide-up|slide-down|slide-left|slide-right|scale|pop, ms, delay, easing}`.
Text: `{$cesta}`, `{$cesta|filtr:arg}`, `{_'klíč'}`; výrazy (`if`, `each`, hodnoty
začínající `=`): `$cesta`, literály, `! && || == != < > <= >= + - * / % ?: ()`.
Akce: vestavěné v Javě (`screen.open`, `back`, `room.join`, `room.switch`,
`room.leave`, `rooms.connect`, `message.send`, `users.toggle`, `users.dock`,
`users.autoHide`, `call.audio`, `call.video`, `call.end`, `lock.now`, `theme.toggle`,
`lang.set`, `update.check`, `update.install`, `flash`, `url.open`, `copy`, `share`,
`fn.run`, `lib.run`) a knihovny z balíčku (`lib/<název>.json` — posloupnost kroků
`{do, arg?, if?}`).

## 5. Aktualizace a návrat

1. `checkin` (nebo push `update`) ohlásí nový balíček / vydání.
2. Uživatel dostane upozornění; balíček se stáhne (Wi-Fi podle policy).
3. Ověření: podpis hlavičky připnutým klíčem → rozbalení CEK → dešifrování
   segmentů → SHA-256 obsahu → kontrola manifestu (formát, `minAppCode`, hashe souborů).
4. Uložení do `bundles/<id>/` (systémová vrstva), stav `staged`.
5. Aktivace při dalším startu jako `trial`; když se obrazovky nevykreslí nebo
   aplikace spadne do 20 s, **návrat na poslední `good`** a událost `bundle-rollback`.
   Po úspěšném startu `good`; drží se poslední 3.
6. Každý krok jde do šifrovaného logu a jako událost na server.

## 6. Víc místností (web i Android)

Server drží jednu místnost na spojení; klient proto otevírá **jedno spojení na
místnost** (limit 20 spojení z IP). Místnost = `RoomSession` (spojení, klíče,
peers, sender keys, fronta). `RoomManager` drží aktivní místnost, počty
uživatelů a nepřečtených, a přepíná chytře: otevření z notifikace přepne na danou
místnost, po odchodu z aktivní přejde na místnost s nejnovější aktivitou, zprávy
v pozadí zvýší odznak. Připojení výběrem s checkboxy (víc místností naráz).

## 7. Server

`server/android/`: `store.ts` (SQLite `$DATA_DIR/android/android.db`, jinak paměť),
`config.ts` (policy, registrace, FCM, design), `keys.ts`, `crypto.ts` (ECIES, P1363,
balíčky), `bundle.ts` (kompilace + `.m5ab`), `design.ts` (výchozí obrazovky, sanitizace,
katalog), `fcm.ts` (HTTP v1, JWT RS256), `apk.ts` (verze a certifikát z APK),
`routes.ts` (`/api/android/*`), `admin-routes.ts` (`/api/admin/android/*`, modul
`android` v Modules & groups).

## 8. Sestavení, podpis, nasazení

```bash
npm run android:build                         # debug APK + testy Javy
npm run android:build -- --install            # … rovnou do telefonu (adb)
M5_KEYSTORE=m5cet.jks M5_KEYSTORE_PASSWORD=… M5_KEY_ALIAS=m5cet \
npm run android:build -- --release --server https://chat.example.com --server-key <kid>
npm run android:build -- --release --upload https://chat.example.com --token <token operátora>
```

* **JDK 17–25** a **Android SDK** (platforma 37, build-tools) — skript je najde
  sám (`JAVA_HOME`, `ANDROID_HOME`, obvyklé složky), Gradle 9.8 přijde s wrapperem.
* **Podpisový klíč vydání** vytvořte jednou a uschovejte (bez něj už nejde vydat
  aktualizaci, kterou zařízení přijmou):
  `keytool -genkeypair -v -keystore m5cet.jks -alias m5cet -keyalg EC -groupname secp256r1 -validity 10000`.
  První nahrané vydání připne jeho certifikát na serveru (Android › Security,
  `certSha256`); jiný certifikát server i zařízení odmítnou.
* `--server` vloží výchozí adresu serveru, `--server-key` připne **id Android
  klíče serveru** (Android › Overview) — aplikace pak jiný klíč při registraci
  odmítne i bez QR kódu.
* Výstup: `dist/android/m5cet-<verze>-<typ>.apk`, vypíše SHA-256 a otisk certifikátu.
* **Nginx**: nahrání APK je jediný velký požadavek — location
  `/api/admin/android/releases/upload` s `client_max_body_size 300m` je v
  `deploy/nginx/m5cet.conf` i v šabloně instalátoru.
* **FCM** (volitelné, jinak polling): projekt Firebase → přidat aplikaci Android
  s balíčkem `cz.m5cet.app` → stáhnout `google-services.json` a vložit ho v
  Android › Push; Project settings › Service accounts → Generate new private
  key → vložit JSON tamtéž. APK nic z toho neobsahuje.
* **Registrace**: Android › Overview → QR kód (volitelně s kódem z Android ›
  Security), nebo ruční zadání adresy v aplikaci. Adresa v QR je
  `PUBLIC_BASE_URL`, bez ní adresa, na které běží konzole — u konzole na
  vlastním portu (vývoj, SSH tunel) ji tedy nastavte nebo přepište v poli.

## 9. Stav 6.0 a omezení

* Hotové: vše z kapitol 1–8; testy — `test/android-server.test.ts` (server),
  `test/android-console.test.ts` (jazyk náhledu), `test/android-assets.test.ts`
  (vestavěný design), `android/app/src/test` (Java: interop s webem a serverem,
  jazyk výrazů).
* Účty s passkey (Server-enhanced, relay zpráv pro nepřítomné) a přenos velkých
  souborů po kouscích jsou zatím jen ve webovém klientovi; aplikace se připojuje
  do místností Light · P2P a zprávy přijímá, když je připojená.
* Šifrování snímků hovorů (vložené proudy prohlížeče) aplikace neoznamuje:
  hovor s prohlížečem jde přes DTLS-SRTP bez této vrstvy navíc.

## 10. Co přinesla 6.7

Každá oblast 6.7 má svůj soubor designu na serveru
(`server/android/design-67-{presence,location,notify,voice,look,profile}.ts`,
složené v `design-67.ts`) a vlastní i18n.

* **Android 10–12 znovu běží** (audit V5): volání API 30 / 33 jsou ošetřená
  (`ui/SystemBars`, `core/Streams.readAll` místo `readAllBytes`, typované
  `getParcelableExtra` až od 33, `pushDynamicShortcut` a `getCurrentLocation`
  od 30); `lintDebug` 0 chyb (bylo 30). Na zařízení s Androidem 10–12
  neověřeno.
* **Design nevynese zprávy** (F-01, `ui/DesignUrls.java`): počítaný `src`
  obrázku smí být jen `asset:` nebo `data:image/`, vzdálený https obrázek
  jen přesně pevná adresa z designu; `url.open` otevře adresu až po
  potvrzení s ukázaným hostitelem. Server totéž kontroluje při uložení
  (`checkImageSrc` / `checkActionArg` v `design.ts`, hostitelé
  `ANDROID_DESIGN_IMAGE_HOSTS`). Zbývá: `url.open` s adresou poskládanou
  z dat jde pořád jedním potvrzeným klepnutím; `setting.set` / `toggle`
  smí design použít na jakýkoli známý klíč (sledování polohy, hlas přes
  server, emulace NFC); `share` / `copy` berou počítaný text.
* **„Ověřeno“** (F-07, `chat/Verified.java`): P2P podpis klíčem z hello
  připnutým pod jménem peeru; relay: kid podpisu = TOFU pin pro (místnost,
  `senderName`).
* **Model běží pod slepým id místnosti** (`ui/parts/Fn.java`, `r3.…`), ne pod
  čitelným názvem; názvy místností a jména peerů nejdou do logu, který vrací
  příkaz `status` (v ladicím buildu se ale akce designu logují i s
  argumenty).
* **Přítomnost** (`chat/RoomPresence.java`, `chat/Resume.java`,
  `contacts/LastSeen.java`): aplikace hlásí popředí / pozadí, tajemství
  `resume` drží v trezoru (nejvýš 64 místností), takže se po ukončení
  procesu vrátí jako týž člen; tečka a „Naposledy online“ v panelu lidí
  a v detailu osoby.
* **Poloha** (`location/GeoLinks.java`, `ui/parts/PlaceSheet.java`,
  `ui/parts/HoldArea.java`, `ui/bubble/HoldGesture.java`): okno místa
  s navigací (nainstalované aplikace, pak web), odvozem a kopírováním;
  oblast pro podržení vedle bubliny „podržet a číst“. Zpráva s polohou dál
  ukazuje mapu přímo v bublině (na rozdíl od webu).
* **Vzhled** (`ui/look/Menus.java`, `Swipe.java`, `SwipeRow.java`,
  `Palette.java`, `ui/parts/RoomEdit.java`): šest šablon (forest, sunset,
  lavender, mocha, arctic, ink; světlá i tmavá) — `themes.json` jich má 19;
  nabídky s ikonami v barvách designu; prvek designu **`swipe`** (`right`,
  `left` = id menu, `rightColor`, `leftColor`) a akce `room.delete`,
  `room.clone`, `room.edit` s obrazovkou `room.edit`. Výchozí design obaluje
  `rooms.item` prvkem `swipe`; aplikace starší než 6.7 neznámý prvek kreslí
  jako prázdný, proto build, jehož design používá prvek nebo akci 6.7,
  dostane `minAppCode` 60700 sám (`designMinAppCode`,
  `server/android/bundle.ts`) a starší aplikace si nechá build, který má.
* **Profil** (`profile/*`, `ui/parts/ProfileUi.java`): editor v *Nastavení ›
  Uživatel › Veřejný profil*, rámce profilu v místnosti párovým klíčem
  (`ProfileRoom.java`), obrázky zmenšené a bez metadat (`ProfileImages.java`).
  Obrázky, které přijdou od ostatních, aplikace jen normalizuje (formát,
  velikost) — kontrolu pixelů a odstranění metadat jako web nedělá.
* **Upozornění** (`push/NotifyPrefs.java`, `push/NotifyTemplate.java`,
  `telecom/Notify.java`): obrazovka *Nastavení › Oznámení*, šablony
  operátora, úrovně soukromí, tiché hodiny; zařízení se propojí
  s účtem (`POST /api/android/notify`) a server ho budí zapečetěnou řídicí
  zprávou `notify` — do 6.7 se aplikace nepřipojovala jako „away“ a server
  ji nebudil.
* **Hlas** (`voice/DictationMachine.java`, `SpeakSend.java`, `VoiceFx.java`,
  `MicFx.java`, `FxGate.java`, `ui/parts/ComposerVoice.java`): diktování,
  které se zastaví, poslat jako hlas, nadiktovat a poslat text, měnič hlasu
  i pro hovory — viz [`speech.md`](speech.md#dictation-that-stops-speak-and-send-the-voice-changer-67).

## 11. 6.8: místnosti jako konverzace Androidu

Android nemá systémový „deník zpráv“, do kterého by směla psát cizí
aplikace; Signal i WhatsApp proto dělají z rozhovorů **konverzace**:
dlouhodobé zástupce (long-lived shortcut) s osobou (`Person`) a `LocusId`.
Totéž dělá 6.8 pro místnosti (`telecom/Conversations.java`, čistá část
`telecom/ConversationPlan.java`, design `server/android/design-68-conversations.ts`).

* **Které**: každá připojená (vybraná) místnost, nejčerstvější první
  (`setRank`); dynamických nejvýš 8, méně když systém dovolí méně
  (`getMaxShortcutCountPerActivity`). Ikona je monogram jako na webu
  (`contacts/Avatars`), kategorie `cz.m5cet.app.category.ROOM`. Ostatní
  místnosti dostanou zástupce, až k nim přijde oznámení (`pushDynamicShortcut`
  od API 30, na Androidu 10 `addDynamicShortcuts`, dokud je místo).
* **Kde se ukážou**: sekce *Konverzace* v oznámeních (prioritní konverzace,
  widget Konverzace), horní řada nabídky *Sdílet* (`res/xml/shortcuts.xml`:
  share-target `text/plain` → `MainActivity`; sdílený text se vloží do pole
  zprávy té místnosti, neodešle se) a podržení ikony aplikace. Obrázky
  sdílet nejde — obrázek se v aplikaci posílá hned, rozepsanou přílohu
  composer nemá.
* **Oznámení**: zpráva místnosti nese `setShortcutId` + `setLocusId`, je-li
  funkce zapnutá a aplikace **není zamčená** (audit S11 platí dál: zamčená
  aplikace dává jen neutrální oznámení bez zástupce). Oznámení ze serveru
  (`templated`, `BigTextStyle`) konverzací nejsou.
* **Aktualizace**: připojení, odchod, smazání, přejmenování (nový název = nová
  místnost), nová zpráva, zámek, nastavení. Změna toho, co systém ukazuje
  (které místnosti, názvy ↔ neutrální), jde hned (po 1,5 s); jen nové pořadí
  nejvýš jednou za 5 minut a jen v popředí — na pozadí systém volání
  `ShortcutManager` omezuje. Odchod/smazání: zástupce zmizí i z cache
  (`removeLongLivedShortcuts`, API 30); připnutý se přejmenuje a vypne.
* **Soukromí**: id zástupce je `conv-` + HMAC-SHA256 (klíč instalace v systémové
  vrstvě trezoru) názvu místnosti — nic o názvu neprozradí (6.7 mělo
  `room-` + `String.hashCode()`; ty se při první publikaci odstraní). Intent
  zástupce nese jen id. Název místnosti zástupce nese jen když je aplikace
  odemčená, přepínač *Ukazovat názvy místností* je zapnutý a oznámení smí
  místnost jmenovat (úroveň ≥ „místnost“ — SystemUI ukazuje konverzační
  oznámení pod názvem zástupce); jinak „Konverzace 1, 2…“ s číslem místo
  monogramu, číslované podle id (nemění se s aktivitou). Zámek přichází
  i časem na pozadí bez události, proto po odchodu do pozadí běží kontrola
  v čase automatického zámku — časovač a alarm (`Conversations$Alarm`), protože
  zmražený nebo ukončený proces časovač nestihne; nový proces startuje
  zamčený a názvy zneutralizuje sám. Když je volání omezené, zmizí aspoň
  dynamické zástupce (spouštěč, Sdílet).
* **Nastavení** (*Nastavení › Oznámení › Konverzace v Androidu*):
  `conversations.on` (výchozí zapnuto — 6.7 zástupce dělalo také; vypnutí vše
  odebere) a `conversations.names` (výchozí zapnuto). Menu místnosti má
  *Konverzace v telefonu* — akce designu `conversations.settings` (`room`:
  nastavení té konverzace, API 30 `EXTRA_CONVERSATION_ID`; prázdný argument:
  nastavení oznámení aplikace); design, který ji použije, potřebuje aplikaci
  6.8.
* **Bubliny ne**: bublina potřebuje vlastní vložitelnou aktivitu
  (`allowEmbedded`, `resizeableActivity`, `documentLaunchMode`) — aplikace má
  jednu `singleTask` aktivitu, která nese zámek, design i všechny obrazovky.
* **Omezení**: na telefonu nevyzkoušeno (jen testy JVM a build). Oznámení
  zobrazená před zamčením si název ponechají (jako v 6.7). Kdo si v 6.7
  nastavil konverzaci jako prioritní, nastaví ji znovu (nové id). Umře-li
  proces mezi odchodem do pozadí a časem zámku a alarm se zpozdí (Doze),
  zůstanou názvy do doručení alarmu nebo dalšího startu.

## 12. 6.8: hovory v záznamu telefonu a Záznam v aplikaci

Design: `server/android/design-68-calllog.ts` (obrazovka `log`, ikona v liště
místností, položka hlavního menu, řádky v *Nastavení › Hovory*); akce
`calllog.*` dělají z buildu build pro aplikaci 6.8 (`designMinAppCode`).

* **Co hovor byl** (`chat/CallTrack.java`, čistá Java + `CallTrackTest`):
  hovory místností nezvoní po síti — „ozval se“ = něčí `audio-status` přešel
  na `live`. Z vlastního zvuku a ze zvuku ostatních vzniká jeden záznam na
  hovor (ne na peer): **odchozí** (zapnul jsem zvuk, když nikdo jiný nebyl
  v hovoru), **příchozí** (připojil jsem se k probíhajícímu), **zmeškaný**
  (hovor skončil beze mě), **odmítnutý** (odmítl jsem zvonění a nepřipojil
  se). Hovor končí, až v něm 20 s nikdo není — výpadek spojení je pořád týž
  hovor. Délka = můj čas v hovoru. `Calls.track()` volá
  `RoomSession.changed()`; `destroy()` zaznamená otevřený hovor dřív, než
  se vlákno místnosti zastaví.
* **Zvonění** (`telecom/CallRing.java`): hovor, který začne někdo jiný,
  ukáže upozornění na kanálu hovorů s *Připojit se* / *Odmítnout*; po konci
  beze mě zůstane tiché „Zmeškaný hovor“. Řídí se přepínačem „Hovory“,
  tichými hodinami a úrovní soukromí z *Nastavení › Oznámení*; při zamčené
  aplikaci jen jméno aplikace. *Připojit se* funguje jen z upozornění tohoto
  běhu (token v intentu) a jen dokud v hovoru někdo je; místnost na obrazovce
  nezvoní.
* **Záznam hovorů telefonu** (`telecom/CallLogBridge.java`): po zapnutí
  přepínače se aplikace zeptá na `WRITE_CALL_LOG` (odmítnutí přepínač vrátí
  a řekne kde oprávnění povolit; odebrané oprávnění přepínač vypne). Položka
  **nemá číslo** (`NUMBER` prázdné, `PRESENTATION_UNKNOWN`): do 6.7 se psalo
  `m5cet:<místnost>` a aplikace Telefon by při „zavolat zpět“ předala
  Telecomu text, z jehož písmen udělá číslice (`m5cet:team` → 652388326)
  a vytočí je přes SIM. Staré řádky se při startu jednou opraví (bez čísla
  a bez názvu místnosti). Název (`CACHED_NAME`) je výchozí jen jméno
  aplikace — záznam čte každá aplikace s `READ_CALL_LOG`; volitelně
  „aplikace · místnost“ nebo „lidi · místnost“ (`calls.logName`), při
  zamčené aplikaci vždy jen jméno aplikace. Typ, čas, délka, `FEATURES_VIDEO`;
  `NEW = 0` (o zmeškaném hovoru dává vědět aplikace sama).
* **Self-managed účet** (`telecom/M5ConnectionService.java`, `MANAGE_OWN_CALLS`):
  zaregistruje se, aby aplikace Telefon podle CDD 7.4.1.2 u položky ukázala
  jméno aplikace; služba odmítne každé spojení — zvuk hovoru jde dál jen přes
  WebRTC. **Zavolat zpět z aplikace Telefon nejde**: Android 10–16 cizímu
  self-managed účtu vezme handle a vytočí číslo jako běžný hovor (proto
  položka číslo nemá); call-back Androidu 17 (`ACTION_CALL_BACK`) platí jen
  pro hovory přidané přes Telecom (`CallsManager.addCall`), a to tyto nejsou.
  Zavolat znovu jde ze Záznamu v aplikaci (po potvrzení).
* **Záznam v aplikaci** (`chat/ActivityLog.java`, `chat/CallHistory.java`,
  `ui/parts/CallLogUi.java`): hovory z vlastní historie hovorů (trezor,
  uživatelská vrstva, záznam `calls`, nejvýš 500 hovorů / 90 dní,
  `calls.history` ji vypne), zprávy přímo z historie místností (nic se
  nekopíruje). Zapečetěná, „podržet a číst“, mizející a skrytá zpráva ukáže
  jen svůj druh — ani hledání do nich nevidí. Filtr vše / hovory / zprávy /
  zmeškané, hledání bez ohledu na velikost písmen a diakritiku; klepnutí
  otevře místnost (u zprávy na ni posune), tlačítko telefonu zavolá znovu
  po potvrzení. Obrazovka je za zámkem aplikace jako ostatní.
* **Wipe** (`security/Wiper.java` → `CallLogBridge.wipe`): smaže řádky
  aplikace ze záznamu telefonu (podle účtu, staré `m5cet:` a podle řádků
  zapamatovaných v historii), odregistruje účet a smaže historii hovorů.
* Neověřeno na telefonu (jen testy JVM a TS). Co se ukáže v aplikaci Telefon,
  se liší výrobce od výrobce: některá jméno z `CACHED_NAME` neukážou a napíšou
  „Neznámé“ (s ikonou aplikace).
