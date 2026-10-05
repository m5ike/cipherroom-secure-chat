# M5cet pro iOS — server a konzole (6.14)

Serverová strana aplikace pro iPhone a iPad: API zařízení `/api/ios/*`, push přes **APNs**,
vlastní design (výchozí = design Androidu se vzhledem iOS), záznamy vydání v App Storu /
TestFlightu a stránka **iOS** v konzoli vedle **Android**. Kontrakt portu je v
[`ios-architecture.md`](ios-architecture.md) (§ 4), formáty drátu v
[`android-architecture.md`](android-architecture.md) § 1 — **na iOS platí beze změny**.

## 1. Co je sdílené s Androidem

Kód je společný (`server/mobile/*`), Android ho používá také a jeho API se nezměnilo:

| | sdílené (`server/mobile/`) | jen iOS (`server/ios/`) |
|---|---|---|
| Kryptografie | P1363 podpisy, ECIES, M5PK, M5AB, podepsaná politika (`crypto.ts`) — tytéž řetězce: `m5android/1|…`, `m5android/enroll/1|…`, `m5policy/1|…`, `m5push/1|…`, `m5bundle/1|…`, štítek ECIES `m5cet/android/ecies/1` | podpis záznamu vydání `m5iosrelease/1|…` |
| Klíč serveru | **jeden** podpisový klíč pro obě aplikace (`signing.ts`, `$DATA_DIR/android/signing.key`, `ANDROID_SIGNING_KEY_FILE`) — stejný `kid` a otisk | — |
| Úložiště | `MobileStore` (zařízení, buildy, vydání, příkazy, události, polohy, kódy) | `$DATA_DIR/ios/ios.db` (`IOS_DATA_DIR`), záznamy zařízení a vydání iOS |
| API zařízení | podpis a nonce, `ack`, `notify`, `events`, `message-audit`, `location`, `bundles/:id` (`device-api.ts`) | `info`, `enroll`, `checkin`, `releases/:id` |
| Příkazy | fronta, tvar drátu, TTL, priority (`commands.ts`) | doprava APNs (`ios/commands.ts`, `ios/apns.ts`) |
| Buildy | kompilace, šifrování, podpis, nasazení (`bundle.ts`) | id `ibld_…`, AAD `ios:build:<id>`, aplikace od 61400 |
| Konzole (API) | zařízení, příkazy, události, kódy, design (+ `validate`, `preview`), buildy (`admin.ts`) | přehled, nastavení, vydání, test push, AASA |
| Define | `m5mobile.define` — **jedna sada** pro obě aplikace; iOS čte `GET /api/define?scope=ios` (= hodnoty `android`, tj. mobilních aplikací) | — |
| Notifier | kanál „android“ (id zůstává kvůli nastavení uživatelů) budí **i** propojená iOS zařízení (`ios_…`) přes APNs | — |

## 2. APNs

1. Apple Developer › Certificates, Identifiers & Profiles › **Keys** › „+“ › zaškrtnout
   *Apple Push Notifications service (APNs)* › stáhnout `AuthKey_XXXXXXXXXX.p8` (jen jednou).
2. Na server (mimo repozitář, `chmod 600`, v Dockeru jako volume) a do `.env`:

   ```
   APNS_KEY_FILE=/etc/m5cet/AuthKey_ABCDE12345.p8
   APNS_KEY_ID=ABCDE12345          # 10 znaků, z názvu souboru / stránky klíče
   APNS_TEAM_ID=TEAM123456         # Membership › Team ID
   APNS_TOPIC=cz.m5cet.app         # bundle ID aplikace (výchozí)
   APNS_ENV=production             # production | sandbox
   ```
3. Konzole › **iOS › Push**: stav („ready“ nebo co chybí), přepínač, prostředí, téma, **Test push**
   (tichý ping nebo viditelný flash) s odpovědí Apple (stav, `apns-id`, důvod).

**Sandbox vs. production.** Aplikace podepsaná vývojovým profilem dostává tokeny prostředí
*sandbox*, TestFlight a App Store *production*. Aplikace hlásí své prostředí (`apnsEnv`
v `enroll` / `checkin`, z entitlementu `aps-environment`) a server jí posílá tam; bez hlášení
platí nastavení konzole, jinak `APNS_ENV`.

**Jak server posílá** (`server/ios/apns.ts`): HTTP/2 na `api.push.apple.com` /
`api.sandbox.push.apple.com`, jedno spojení na hostitele, token poskytovatele = JWT ES256
(`{alg, kid}.{iss: team, iat}`) platný nejvýš **50 minut** (Apple: 20–60 min), při
`403 ExpiredProviderToken / InvalidProviderToken` jednou nový. `410 Unregistered`,
`400 BadDeviceToken` a `DeviceTokenNotForTopic` → token se zapomene (`apnsError` u zařízení,
příkaz čeká na check-in, zařízení pošle nový). `429`, `5xx` a přerušené spojení → dva další
pokusy s rostoucí pauzou. Payload nad 4 KiB (VoIP 5 KiB) se vůbec neodešle. Tokeny se do logu
nikdy nepíšou celé.

### 2.1 Co nese push (pro Notification Service Extension)

Řídicí zpráva je **stejná jako u FCM** — ECIES zapečetěná pro jedno zařízení a podepsaná
serverem — v klíči `m5`:

```json
{ "aps": { "alert": { "title": "M5cet", "body": "Nová zpráva" }, "mutable-content": 1, "sound": "default" },
  "m5": { "m5": "1", "i": "cmd_…", "e": "<SPKI b64>", "iv": "<b64>", "ct": "<b64>", "s": "<P1363 b64>" } }
```

| druh | `apns-push-type` | priorita | `aps` |
|---|---|---|---|
| `flash`, `push`, `lock`, `wipe`, `notify` | `alert` | 10 | neutrální `alert` v jazyce zařízení, `mutable-content: 1` (zvuk u `push` a `notify`) |
| `ping`, `status`, `update`, `config` | `background` | 5 | `content-available: 1` |
| `notify` druhu `call` při VoIP tokenu | `voip` (téma `<bundle>.voip`) | 10 | žádné — jen `m5`; aplikace hovor ohlásí CallKitu |

Rozšíření ověří `s` nad `"m5push/1|" + deviceId + "|" + i + "|" + e + "|" + iv + "|" + ct`
připnutým klíčem serveru, otevře ECIES (purpose `push`) a dostane `{id, kind, at, exp, payload}`;
u `notify` je `payload` šablona notifieru (`title`, `body`, `tpl`, `vars`, `room?`, `tag`, `group`, `lang`…).
Apple vidí jen neutrální text („Nová zpráva“, „Příchozí hovor“, „Nové upozornění“,
„Bezpečnostní oznámení“). **Žádné `thread-id`** a **žádné `apns-collapse-id` z místnosti nebo
tagu** — seskupení podle místnosti dělá rozšíření až po dešifrování. `apns-collapse-id` je jen
`m5-status` / `m5-update` / `m5-config` a `m5-notify-<druh>`, když si uživatel seskupuje podle druhu.
`apns-expiration` = vypršení příkazu.

## 3. API zařízení `/api/ios/*`

Tělo se čte surově (podpis kryje přesné bajty). Podepsané požadavky **(s)**: hlavičky
`X-M5-Device`, `X-M5-Time` (ms), `X-M5-Nonce` (16 B base64url), `X-M5-Signature` = ECDSA P-256
P1363 nad `"m5android/1|" + METHOD + "|" + /api/ios/…?dotaz + "|" + time + "|" + nonce + "|" + b64(SHA-256(tělo))`
(cesta váže podpis na API iOS — podpis pro `/api/android` tu neprojde). Čas ±5 min (u `/events`
30 dní), nonce jen jednou.

| | požadavek | odpověď |
|---|---|---|
| `GET /info` | — | `{ok, name, platform:"ios", version, protocol:2, enrollment, server:{kid, publicKey, fingerprint}, apns:{topic, environment, voipTopic}\|null, minAppCode:61400, minBuild, bundleId, store:{appStore, testFlight}}` |
| `POST /enroll` | `{code?, name, model, modelName, idiom, os, osVersion, appVersion, appCode, locale, signKey, encKey, apnsToken?, voipToken?, apnsEnv?, time, proof}` | `{ok, deviceId:"ios_…", policy, policySigned:{at, policy, sig}, pollSeconds, server:{…}, apns, minBuild}` |
| `POST /checkin` (s) | `{appVersion?, appCode?, os?, osVersion?, locale?, apnsToken?, voipToken?, apnsEnv?, state:{battery, charging, network, locked, rooms, bundle:{id, version, state}, push:"apns"\|"poll", lockMode, failedAttempts, storage, permissions, policyAt, biometry}}` | `{ok, time, policy, policySigned, pollSeconds, apns, push:"apns"\|"poll", commands:[wire…], bundle:{id, number, version, size, minAppCode, notes}\|null, release:{…}\|null, minBuild, updateRequired}` |
| `POST /ack` (s) | `{id, ok, result?, error?}` | `{ok, status}` |
| `POST /notify` (s) | `{token, on}` | `{ok, linked}` (401 `signed-out`) |
| `POST /events` (s) | `{events:[{id, type, at, detail}]}` | `{ok, stored}` — `wipe` vyřadí zařízení a smaže jeho tokeny |
| `POST /message-audit` (s) | `{account?, actions:[{action, messageId, room, …}]}` | `{ok, recorded}` |
| `POST /location` (s) | `{points:[{lat, lon, acc, alt?, speed?, heading?, at}]}` | `{ok, stored, minSeconds}` (403 `location-off`) |
| `GET /bundles/:id` (s) | — | soubor M5AB (`application/vnd.m5cet.bundle`), CEK zabalený pro toto zařízení (409, když je aplikace starší než `minAppCode`) |
| `GET /releases/:id` (s) | — | `{ok, release, signed, signature, kid}` |

* `enroll.proof` = P1363 podpis `"m5android/enroll/1|" + signKey + "|" + encKey + "|" + time`.
* `policySigned.sig` je nad `"m5policy/1|" + deviceId + "|" + at + "|" + policy` (JSON řetězec tak, jak přišel);
  aplikace použije jen politiku podepsanou připnutým klíčem a nikdy starší, než má.
* Tokeny: hex (mezery a `<>` z `description` se ignorují). Chybějící pole v `checkin` = beze změny,
  prázdný řetězec = smazat (uživatel vypnul oznámení).
* `appCode` = `CFBundleVersion` = `major·10000 + minor·100 + patch` (6.14.0 → 61400).
* `release` = `{id, version, build, bundleId, channel, store:"appstore"|"testflight", url, notes:{cs, en, …}, minBuild, rollout, mandatory}`;
  podepsaný řetězec `"m5iosrelease/1|" + id + "|" + version + "|" + build + "|" + bundleId + "|" + channel + "|" + store + "|" + url + "|" + minBuild`.
* `minBuild` / `updateRequired`: nejstarší povolený build (nastavení konzole, zvýšené `minBuild`
  zveřejněných vydání kanálu zařízení); aplikace pod ním vyzve k aktualizaci dřív než cokoli jiného.

## 4. Registrace

Stejně jako Android: režim `open` / `code` / `closed` (iOS › Security), kódy se ukážou jednou,
QR kód `m5cet://enroll?server=…&kid=…&code=…` (stejné schéma otevře kteroukoli aplikaci).
Zařízení si při registraci připne klíč serveru — **stejný jako u Androidu** (přehled konzole
ukazuje otisk na obou stránkách).

## 5. Vydání

Žádné binárky — aplikaci instaluje Apple. Vydání je záznam: verze, build (prázdné = z verze),
kanál (`stable` → App Store, `beta` / `dev` → TestFlight), odkaz (jen `https://apps.apple.com`,
`itunes.apple.com`, `testflight.apple.com`; prázdný = odkaz z iOS › Security), poznámky v devíti
jazycích, **minimální build** (starší aplikace musí aktualizovat — dostanou záznam vždy) a
**postupné nasazení** (procento zařízení; stejná zařízení pro stejné vydání). Koncept → *Publish*
(zařízení se starším buildem v rolloutu dostanou příkaz `update`) → *Withdraw*. Verze a build
zveřejněného vydání se nemění; rollout, minimum, odkaz a poznámky ano (záznam se znovu podepíše).

## 6. Design

Vlastní dokument (`$DATA_DIR/ios/design.json`), stejný jazyk designu jako Android (prvky, akce,
výrazy, řetězce, menu, knihovny, assety) a stejné kontroly (F-01: žádné adresy obrázků z dat).
Výchozí design = výchozí design Androidu se **vzhledem iOS**: systémové barvy (modrá #0064e0 —
kontrast 5,4 : 1 pro bílý text, šedé seskupené pozadí, bubliny jako iMessage, přístupné
varianty červené / zelené / oranžové), poloměr 12, přechody iOS, písmo `sans` = SF Pro v aplikaci.
Šablona „iOS“ je první v seznamu vzhledů (`server/ios/assets.ts`: `iosThemes()` a `iosAssets()`
vrací `default-design.json`, `icons.json` a `themes.json` pro aplikaci — pro skript sestavení, ne
pro běžící server; katalog konzole nese šablonu iOS a šablony aplikace). `npx tsx script/ios-assets.ts`
je zapíše do `ios/Design/m5/` (odtud je build fáze „Copy design assets“ kopíruje do aplikace;
`test/ios-assets.test.ts` hlídá, že nejsou zastaralé). **Jen v designu iOS** (nikdy v Androidu):
přepínač Apple Watch v Nastavení › Oznámení (nastavení `watch.on`, výchozí vypnuto, soukromá oblast
`watch.` — akce designu ho nezapne, jen klepnutí uživatele) a texty `watch.*` (hodinky) a `nfc.ios.*`
(systémový list NFC) v devíti jazycích (`IOS_STRINGS`).

Buildy jsou tytéž balíčky M5AB (id `ibld_…`), pro aplikace iOS od **61400** (nebo novější, když to
vyžaduje prvek designu — stejný gating `minAppCode` jako na Androidu). Co iOS neumí (§ 5
kontraktu), se neodmítá, ale konzole to hlásí (*Check for iOS*, `POST /design/validate`,
`/design/preview`): `nfc.emulate` (HCE jen s entitlementem), `nfc.reader usb`, `calllog.system`,
`conversations.settings`, `update.install` (otevře odkaz vydání).

## 7. Příkazy

`ping`, `status`, `flash`, `push`, `update`, `lock`, `wipe`, `config` — stejná sada a stejné
payloady jako Android. Rozdíly: `update` = zkontrolovat balíček designu a záznam vydání (žádná
instalace APK); `lock` a `wipe` jdou jako alert (rozšíření je má zaznamenat — např. příznak ve
sdílené Keychain — a aplikace je provede hned, jak běží; čekají i v odpovědi check-inu, dokud je
zařízení nepotvrdí `ack`); tiché pushe iOS doručuje podle baterie —
co nesmí čekat, jde jako alert. Bez tokenu nebo bez APNs čeká vše na check-in (BGAppRefresh,
`pollMinutes` je jen nejkratší interval — kdy, rozhoduje iOS).

## 8. Konzole

Menu **iOS** vedle **Android**, stejné záložky: Přehled (iPhone / iPad, tokeny APNs, klíč serveru,
App Store / TestFlight, QR), Zařízení, Push (APNs, test push), Design (rámečky iPhone 17 / 17 Pro Max /
SE a iPad mini / Pro 11″ / 13″ se vzhledem iOS — ostrůvek, bezpečná oblast, SF), Define (**stejná
sada jako Android, označeno „shared with Android“**), Buildy, Vydání (záznamy), Bezpečnost (stejná
politika zámku; bundle ID, nejstarší build, odkazy do obchodů, passkeys přes AASA), Události.
Stránka je kód stránky Android (`android-console.js`) na `/api/admin/ios` + `ios-console.js`.

**Práva:** modul **Android** (Moduly a skupiny) platí pro obě mobilní aplikace — stejná práva
`devices`, `push`, `wipe`, `builds`, `releases`, `publish`, `settings` na stejných cestách
(`POST /push/test` potřebuje `push`). Kdo modul nemá, nevidí ani položku iOS v menu a API
odpoví `403 module-denied`. (Vlastní modul `ios` by vyžadoval změnu `client/src/lib/modules.ts`.)

## 9. Passkeys

`/.well-known/apple-app-site-association` = `{"webcredentials":{"apps":["<APNS_TEAM_ID>.<bundle ID>"]}}`
(bez `APNS_TEAM_ID` 404). Aplikace potřebuje entitlement Associated Domains
`webcredentials:<doména>`. nginx: blok `location = /.well-known/apple-app-site-association` je
v `deploy/nginx/m5cet.conf`. Origin WebAuthn aplikace iOS je webový origin — na serveru se nic
dalšího nemění.

## 10. Rozdíly oproti Androidu (souhrn)

| Android | iOS |
|---|---|
| FCM (service account v konzoli) | APNs (`.p8` z prostředí, nikdy v konzoli) |
| `fcmToken` | `apnsToken`, `voipToken`, `apnsEnv` |
| APK v Releases (nahrání, certifikát, stažení) | záznamy vydání s odkazem, minimem a rolloutem |
| `packageName`, certifikáty, assetlinks.json | `bundleId`, `minAppBuild`, odkazy do obchodů, AASA |
| buildy `bld_…`, aplikace od 60000 | buildy `ibld_…`, aplikace od 61400 |
| `sdk`, `manufacturer` | `osVersion`, `idiom` (phone / pad), `modelName` |
| stav `push: fcm \| poll` | `push: apns \| poll`, `policyAt`, `biometry` |
