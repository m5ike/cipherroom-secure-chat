# M5cet pro iOS, iPadOS a watchOS (6.14) — architektura a kontrakt portu

Cíl: **1:1 port aplikace pro Android** (`android/`, 278 souborů Javy, ~62 000 řádků, verze 6.13.1)
do Swiftu pro **iPhone a iPad** a **zmenšená verze pro Apple Watch**. Stejné funkce, stejný
protokol (testovací vektory web ↔ Android ↔ iOS bajt po bajtu), stejný design řízený serverem,
stejné serverové API (iOS varianta). Kde iOS něco nedovolí, je náhrada nebo poctivé omezení v § 5.

Tento dokument je **kontrakt pro paralelní práci** (agenti vlastní své složky). Změny kontraktu
dělá jen koordinátor.

## 1. Verze a nástroje

| | |
|---|---|
| iOS / iPadOS | **26.0+** (CryptoKit s ML-KEM, SwiftUI 26, Passkeys s PRF) |
| watchOS | **26.0+** |
| Xcode / Swift | Xcode 27, Swift 6 (jazykový režim 6, striktní souběžnost; `@MainActor` pro UI) |
| Bundle ID | `cz.m5cet.app` (jako Android `applicationId`), watch `cz.m5cet.app.watchkitapp` |
| Verze | `CFBundleShortVersionString` = verze z `package.json` (6.14.0), build = `major·10000+minor·100+patch` (61400) — jako Android `versionCode` |
| Podpis | simulátor bez podpisu (`CODE_SIGNING_ALLOWED=NO`); zařízení / TestFlight týmem uživatele (proměnné prostředí, nikdy v repozitáři) |
| Závislosti | jen nutné: **WebRTC** (SPM binární `.xcframework`), Argon2 jako vendorovaný referenční C kód (CC0); vše ostatní Apple frameworky (CryptoKit, Security, LocalAuthentication, CallKit, PushKit, UserNotifications, CoreNFC, AVFoundation, Speech, CoreLocation, Contacts, AuthenticationServices, WatchConnectivity) |

## 2. Struktura `ios/`

```
ios/
  M5Kit/                      Swift package — veškerá logika bez UI, testovaná `swift test` na macOS
    Package.swift
    Sources/CArgon2/          Argon2id (referenční C implementace, CC0)
    Sources/M5Core/           locales, jména, formáty, množná čísla, JSON/base64/hex, čas, texty
    Sources/M5Crypto/         protokol 4 (port client/src/lib/p4 + A/p4), protokol 3 (envelopes, sender keys,
                              zapečetěné zprávy), klíče místnosti (Argon2id/HKDF), ECIES, podpisy, Ed25519, trezor slotů v2
    Sources/M5Proto/          zprávy chatu: payloady, validace, příjemci, potvrzení, historie, outbox, replay,
                              stav místnosti (RoomSession bez UI), soubory (přenos, FileVault formát)
    Sources/M5Net/            hub WebSocket (protokol v2), důkaz na hubu, relay, KT, adresář klíčů, účty a trezor,
                              REST, zařízení: enroll / check-in / podepsaná politika / příkazy / balíčky designu
    Sources/M5Design/         model designu (obrazovky, menu, řetězce, knihovny, akce), Expr, ActionGuard,
                              SettingSchema, ověření a rozbalení balíčku M5PK, týma a vzhled (bez SwiftUI)
    Sources/M5NFC/            šablony APDU, běh šablon, EMV, e-ID (BAC/PACE, MRZ, DG), TLV, zprávy o kartě,
                              Připojka v2, maskování PAN — nezávislé na transportu (CoreNFC je v aplikaci)
    Tests/<Target>Tests/      testy; vektory čtou přímo soubory repozitáře (§ 6)
  M5cet/                      aplikace iOS/iPadOS (SwiftUI) — synchronizované složky Xcode (soubory se nepřidávají do projektu ručně)
    App/                      vstup aplikace, AppDelegate (push), životní cyklus, scéna, iPad multitasking
    Renderer/                 vykreslování designu (port A/ui/Renderer, Ui, Icons, SvgPath, SystemBars) ve SwiftUI
    Parts/                    nativní části (port A/ui/parts/*, bubble/*, look/*, media/*)
    Platform/                 Keychain, Secure Enclave, Vault, AppLock, LockBox, Wiper, biometrie, CallKit, PushKit,
                              APNs, CoreNFC transport, WebRTC, poloha, kontakty, řeč, soubory, sdílení, notifikace
    Resources/                Assets, Info.plist, entitlements, výchozí design (`default-design.json` — stejný soubor jako Android)
  M5cetNotifications/         Notification Service Extension (dešifrování / neutrální text podle zámku)
  M5cetWatch/                 watchOS aplikace (SwiftUI)
  M5cetTests/                 testy aplikace (XCTest; spouští se na simulátoru)
  M5cet.xcodeproj             projekt (synchronizované složky, lokální balíček M5Kit, WebRTC přes SPM)
```

Sestavení a testy (CI i lokálně):
`swift test --package-path ios/M5Kit` · `xcodebuild -project ios/M5cet.xcodeproj -scheme M5cet -destination 'platform=iOS Simulator,name=iPhone 17' build test CODE_SIGNING_ALLOWED=NO` ·
watch: `-scheme M5cetWatch -sdk watchsimulator build` (na tomto Macu není watchOS runtime — jen sestavení).

## 3. Mapování Android → iOS

| Android (`A/` = `android/app/src/main/java/cz/m5cet/app/`) | iOS |
|---|---|
| `A/p4/*` (protokol 4) | `M5Crypto` (CryptoKit: P256, Curve25519 Ed25519, HKDF, AES.GCM, **MLKEM768**); API pojmenované jako `client/src/lib/p4/index.ts` |
| `A/chat/*` (RoomSession, SenderKeys, Envelopes, RoomKeys, Sealed, Verified, Files, Outgoing, History, Resume, P4Room, P4Store, P4Device, P4Relay, Trust, LockedRooms…) | logika `M5Proto` + `M5Net`; perzistence a zámek v `M5cet/Platform`; UI v `Parts` |
| `A/chat/Argon2.java` | `CArgon2` |
| `A/security/*` (Vault, Keystore, AppLock, LockCounter, LockStore, PinWrap, Duress, LockBox, Wiper, Biometric, ServerPin, SignedPolicy, IntentSeal, Ecies, Ec, Crypto, FileVault) | `M5Crypto` (čisté) + `M5cet/Platform/Security` (Keychain, **Secure Enclave** místo StrongBox/TEE, LocalAuthentication, Data Protection) |
| `A/core/*` (Settings, SettingSchema, Locales, Names, Plurals, Formats, Texts, Config) | `M5Core` + `M5Design` (SettingSchema) + `Platform` (úložiště) |
| `A/design/*`, `A/ui/{Renderer,Expr,Actions,ActionGuard,DesignShare,DesignUrls,Ui,Icons,SvgPath,SystemBars}` | `M5Design` (model, Expr, akce, guard) + `M5cet/Renderer` (SwiftUI) |
| `A/ui/parts/*`, `A/ui/bubble/*`, `A/ui/look/*`, `A/ui/media/*` | `M5cet/Parts` |
| `A/fn/*` (funkce / modely, FnHtml, FnView, Suggestions, ArgHint…) | logika `M5Proto` (výstupy, validace) + `Parts/Fn` (UI; `FnHtml` přes uzamčený `WKWebView`) |
| `A/nfc/*` | `M5NFC` (logika) + `Platform/NFC` (CoreNFC transport, UI) |
| `A/net/*`, `A/account/*`, `A/push/*`, `A/update/*` | `M5Net` + `Platform/Push` (APNs, NSE) ; aktualizace = App Store / TestFlight (§ 5) |
| `A/rtc/*`, `A/telecom/*` (Calls, CallRing, Notify, Conversations, CallLogBridge, ConnectionService) | `Platform/Calls` (WebRTC + **CallKit** + PushKit) , `Platform/Notifications`, Siri/Share/Communication Notifications |
| `A/voice/*` | `Platform/Voice` (Speech, AVSpeechSynthesizer, AVAudioRecorder) |
| `A/location/*` | `Platform/Location` (CoreLocation) |
| `A/contacts/*` | `Platform/Contacts` (Contacts framework) |
| `A/profile/*` | `M5Proto` + `Parts` |
| FCM | APNs (server posílá přímo, token `.p8`) — tytéž podepsané a ECIES zapečetěné řídicí zprávy |
| `res/values-*/strings.xml` | `Localizable.xcstrings` jen pro texty systému (oprávnění v Info.plist, název aplikace); vše ostatní z designu |

## 4. Server a konzole

* Zařízení iOS používají **`/api/ios/*`** se stejnou sémantikou jako `/api/android/*`
  (`info`, `enroll`, `checkin`, `ack`, `notify`, `events`, `message-audit`, `location`, `bundles/:id`,
  `releases/:id`) — stejné podpisy požadavků (P-256 P1363), podepsaná politika, ECIES balíčky designu.
  Rozdíly: push **APNs** (token zařízení v `enroll` / `checkin`; server posílá přes HTTP/2 s JWT ES256 z `.p8`
  klíče — `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `APNS_ENV`), **žádné APK** — „vydání“ jsou
  záznamy verzí s odkazem do App Storu / TestFlightu a minimální verzí (aplikace pod minimem vyzve k aktualizaci).
* Konzole: **menu „iOS“ vedle „Android“** se stejným rozvržením (přehled, zařízení, design, buildy designu,
  vydání, push, politika zámku, Define, polohy, příkazy). **Sdílený zdroj:** `m5mobile.define` (Define),
  řetězce a šablony NFC; **vlastní pro iOS:** zařízení, push (APNs), vydání, design (výchozí = výchozí design
  Androidu s vzhledem iOS).
* Design: iOS vykresluje **tentýž formát designu** (prvky, akce, výrazy, řetězce, knihovny) — výchozí
  `default-design.json` je společný; `server/ios/*` může přidat vzhled iOS (téma) a omezit prvky, které iOS
  nemá (§ 5), přes stejné gating (`minAppCode`).

## 5. Platformní rozdíly (náhrady a poctivá omezení)

| Android | iOS |
|---|---|
| Keystore / StrongBox | Secure Enclave (P-256, `kSecAttrTokenIDSecureEnclave`) + Keychain s `kSecAttrAccessControl` (`.biometryCurrentSet` / `.userPresence`), Data Protection `complete` |
| PIN pepper v StrongBox, čítač pokusů | klíč Secure Enclave pro HMAC PINu, čítač v Keychainu (`ThisDeviceOnly`) s generací; nouzový PIN stejně |
| `FLAG_SECURE` | iOS screenshoty nezakáže: obsah se skryje v přepínači aplikací, při nahrávání obrazovky (`UIScreen.isCaptured`) se zobrazí štít; upozornění na screenshot |
| FCM data zprávy | APNs `content-available` (tichý push) + **Notification Service Extension** (zapečetěný obsah, neutrální text při zámku); VoIP hovory přes **PushKit** |
| ConnectionService + systémový záznam hovorů | **CallKit** (nativní obrazovka hovoru, Recents v aplikaci Telefon — volba „zapisovat do Nedávných“ = Android „záznam hovorů“) |
| Čtení záznamu hovorů | není (iOS nedovolí) — Záznam v aplikaci zůstává |
| Konverzace / zkratky | Communication Notifications (`INSendMessageIntent`), Share Extension (volitelně) |
| APK aktualizace ze serveru | App Store / TestFlight; server hlásí minimální verzi |
| NFC čtení (ISO 7816, NDEF, MIFARE) | **CoreNFC jen iPhone** (iPad a hodinky nemají NFC): ISO 7816 s AID v `Info.plist`, NDEF, MIFARE Ultralight / DESFire; **MIFARE Classic ne** |
| HCE (emulace karty, `CardService`) | jen s entitlementem HCE (EHP / EU, iOS 18.1+ `CardSession`) — za kontrolou dostupnosti; jinak skryto |
| Běh na pozadí (socket, poloha) | WebSocket jen v popředí a krátce v pozadí; doručení přes push a relay; poloha `CLLocationManager` s „Always“ jen na žádost |
| Design `swipe`, systémové tlačítko Zpět | gesta SwiftUI; Zpět = navigační gesto |

## 6. Testy a vektory (povinné)

`M5Kit` testy čtou soubory repozitáře (cesta relativně k `#filePath`): `test/vectors/p4.json`,
`test/vectors/nfc-tag-v2.json`, `test/fixtures/android-interop.json`, `android/app/src/test/resources/cz/m5cet/app/**`
(names, vault slots, Locales, plurals…) — **každá sekce bajt po bajtu** jako Android. UI: XCTest na simulátoru
(snímky obrazovek pro kontrolu vzhledu iPhone / iPad).

## 7. Vlastnictví (paralelní agenti)

| Agent | Vlastní |
|---|---|
| **app** (lešení) | `ios/M5cet.xcodeproj`, `ios/M5cet/App`, `ios/M5cet/Resources`, `ios/M5cetTests` (kostra), CI `.github/workflows/ios.yml` |
| **crypto + protokol** | `M5Kit/Sources/{CArgon2,M5Core,M5Crypto,M5Proto}` + jejich testy |
| **síť** | `M5Kit/Sources/M5Net` + testy |
| **design (logika)** | `M5Kit/Sources/M5Design` + testy |
| **NFC (logika)** | `M5Kit/Sources/M5NFC` + testy |
| **server + konzole** | `server/ios/**`, `admin-ui/public/ios-console.js` (+ sdílené části konzole Androidu jen se zachováním chování), testy `test/ios-*` |
| vlna 2 | `M5cet/Renderer`, `M5cet/Parts`, `M5cet/Platform/*`, `M5cetNotifications`, `M5cetWatch` — přidělí koordinátor |

`Package.swift` mění jen koordinátor (agent, který potřebuje novou závislost cíle, to uvede ve zprávě).
