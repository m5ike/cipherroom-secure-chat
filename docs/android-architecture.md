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
| Integrace | call log (self-managed `ConnectionService` + `CallLog`), notifikace s odpovědí, sdílení do místnosti, konverzační zkratky |

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
Server ověří klíčem uloženým při registraci, čas ±5 min, nonce jen jednou (10 min),
stav zařízení `active`.

### 1.5 Registrace
`POST /api/android/enroll` `{code?, name, model, manufacturer, os, sdk, appVersion,
appCode, locale, signKey, encKey, fcmToken?, time, proof}`, kde `proof` je podpis
`"m5android/enroll/1|"+signKey+"|"+encKey+"|"+time` podpisovým klíčem (důkaz
držení). Odpověď `{deviceId, policy, server:{kid, publicKey}, fcm, pollSeconds}`.
Režim registrace (admin): `open`, `code` (jednorázové/vícenásobné kódy), `closed`.
Odkaz `m5cet://enroll?server=…&code=…&kid=…` (QR z adminu) vyplní vše najednou.

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
`screenshots`. Každý neúspěch (PIN, odmítnutá biometrie) zvýší počítadlo v systémové
vrstvě; po `maxAttempts` aplikace podepíše událost `wipe` (uloží ji mimo mazaná
data), smaže vše a událost odešle, jakmile to jde. Server ji zapíše do auditu
(`security`/`warn`), zobrazí v adminu a spustí alert.

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
