# M5cet pro iPhone, iPad a Apple Watch

Port aplikace pro Android do Swiftu (6.14). Kontrakt — verze, rozvržení, mapování Android → iOS, vlastnictví
složek — je v [`docs/ios-architecture.md`](../docs/ios-architecture.md). Tento soubor popisuje projekt, sestavení,
testy, podpis a distribuci.

## Co kde je

| Cesta | Obsah |
|---|---|
| `M5Kit/` | Swift balíček s veškerou logikou bez UI (`M5Core`, `M5Crypto`, `M5Proto`, `M5Net`, `M5Design`, `M5NFC`, `CArgon2`), testy `swift test` |
| `M5cet.xcodeproj` | projekt Xcode (ručně psaný, formát Xcode 16+, **synchronizované složky**) |
| `M5cet/App/` | vstup aplikace (`M5cetApp`), `AppDelegate` (APNs, PushKit), `AppModel` (stav, odkazy, fáze scény), `AppHooks` (rozhraní pro Platform), `Bootstrap` (kam se Platform při startu zapojí), `DeepLink` (`m5cet://`), zástupná `RootView` |
| `M5cet/Renderer/`, `M5cet/Parts/` | vykreslování designu a nativní části (vlna 2) |
| `M5cet/Platform/<oblast>/` | systémové služby — `Security`, `Push`, `Calls`, `NFC`, `Voice`, `Location`, `Contacts`, `Files`, `Notifications`; v každé `README.md` s třídami Androidu, které se tam portují |
| `M5cet/Resources/` | `Info.plist`, `M5cet.entitlements`, `InfoPlist.xcstrings` (texty oprávnění v 9 jazycích), `Assets.xcassets` (ikona, barvy, značka) |
| `M5cetNotifications/` | Notification Service Extension (zatím neutrální text; dešifrování = vlna 2) |
| `M5cetWatch/` | aplikace pro hodinky (SwiftUI, zástupný seznam) |
| `M5cetTests/` | XCTest testy aplikace (běží v simulátoru, hostované aplikací) |
| `Config/` | `Base.xcconfig` (sdílená nastavení), `Version.xcconfig` (generovaná verze), `Signing.xcconfig.example` |
| `scripts/` | `sync-version.mjs` (verze z `package.json`), `make-icons.mjs` (ikony z ikony Androidu) |

### Cíle a schémata

| Cíl | Typ | Bundle ID | Platforma |
|---|---|---|---|
| `M5cet` | aplikace | `cz.m5cet.app` | iOS / iPadOS 26.0+, iPhone + iPad (`TARGETED_DEVICE_FAMILY = 1,2`) |
| `M5cetNotifications` | Notification Service Extension (vložená do aplikace) | `cz.m5cet.app.notifications` | iOS 26.0+ |
| `M5cetWatch` | aplikace watchOS (vložená do aplikace, společník `cz.m5cet.app`) | `cz.m5cet.app.watchkitapp` | watchOS 26.0+ |
| `M5cetTests` | unit testy (XCTest, hostitel `M5cet.app`) | `cz.m5cet.app.tests` | simulátor iOS |

Schémata (sdílená): **`M5cet`** (sestavení aplikace s rozšířením a hodinkami, testy `M5cetTests`) a **`M5cetWatch`**.
Swift 6 (jazykový režim 6, striktní souběžnost). Závislosti: lokální balíček `M5Kit` (aplikace, rozšíření i hodinky)
a **WebRTC** jen v aplikaci.

### WebRTC

SPM balíček [`stasel/WebRTC`](https://github.com/stasel/WebRTC), přesně **150.0.0** (zapsáno v projektu i v
`M5cet.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`): nezměněný Google WebRTC **M150** —
tentýž milník jako Android (`io.github.webrtc-sdk:android:150.7871.01`), dynamický `WebRTC.xcframework`
(iOS arm64, simulátor arm64 + x86_64), `import WebRTC`, třídy `RTC*`. Licence **BSD-3-Clause** (balíček i WebRTC;
třetí strany uvnitř frameworku) — do „Licencí“ aplikace patří jejich texty.
Proč ne `webrtc-sdk/Specs` (týž fork jako Android): jeho značka 150.7871.01 má `Package.swift` s
`swift-tools-version:5.9`, ale používá `.visionOS(.v26)` (až od 6.2), takže ho SwiftPM nenačte.

## Požadavky

* macOS s **Xcode 26 nebo novějším** (ověřeno na Xcode 27.0 / Swift 6.4), runtime simulátoru **iOS 26+**.
* Node.js 22+ (skripty ve `scripts/`).
* Runtime simulátoru watchOS je volitelný — bez něj jde aplikaci pro hodinky jen sestavit.
* Síť při prvním otevření (Xcode stáhne WebRTC z GitHubu, ~44 MB).

## Otevření, sestavení, testy

```sh
open ios/M5cet.xcodeproj                      # Xcode; schéma M5cet, cíl iPhone nebo iPad simulátor

# logika (macOS)
swift test --package-path ios/M5Kit

# aplikace: sestavení + testy na simulátoru, bez podpisu
xcodebuild -project ios/M5cet.xcodeproj -scheme M5cet \
  -destination 'platform=iOS Simulator,name=iPhone 17' build test CODE_SIGNING_ALLOWED=NO

# sestavení pro zařízení bez podpisu (kontrola, že vše linkuje i pro arm64 zařízení)
xcodebuild -project ios/M5cet.xcodeproj -scheme M5cet -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO

# hodinky (bez runtime watchOS jen sestavení)
xcodebuild -project ios/M5cet.xcodeproj -scheme M5cetWatch -sdk watchsimulator build CODE_SIGNING_ALLOWED=NO
```

Spuštění v simulátoru z příkazové řádky (cesta k `.app` je v `Build/Products/Debug-iphonesimulator` DerivedData,
nebo použijte `-derivedDataPath`):

```sh
xcrun simctl boot "iPhone 17"
xcrun simctl install booted <DerivedData>/Build/Products/Debug-iphonesimulator/M5cet.app
xcrun simctl launch booted cz.m5cet.app
xcrun simctl openurl booted 'm5cet://enroll?server=chat.example.com&code=AB-12'
xcrun simctl io booted screenshot m5cet.png
```

Bez podpisu aplikace v simulátoru nedostane token APNs (chybí entitlement `aps-environment`) — zástupná obrazovka
ukáže „no token“; to je v pořádku.

CI: [`.github/workflows/ios.yml`](../.github/workflows/ios.yml) — `swift test`, kontrola verze, sestavení a testy na
simulátoru iPhonu, sestavení pro zařízení a pro hodinky; nic se nepodepisuje ani nenahrává (jen `.xcresult`
neúspěšného běhu).

## Verze

Verze aplikace je verze z `package.json` (jako u Androidu): `MARKETING_VERSION` = `x.y.z`,
`CURRENT_PROJECT_VERSION` = `x·10000 + y·100 + z` (6.14.0 → 61400). Obojí je v `Config/Version.xcconfig`, který
generuje skript — po změně verze:

```sh
node ios/scripts/sync-version.mjs            # zapíše Config/Version.xcconfig
node ios/scripts/sync-version.mjs --check    # CI: selže, když soubor neodpovídá package.json
```

Rozšíření i hodinky mají stejnou verzi (App Store to vyžaduje); test `testVersionFollowsPackageJson` to hlídá.

## Zdroje

* **Výchozí design** — `default-design.json`, `icons.json`, `themes.json` se při každém sestavení kopírují build
  fází „Copy design assets“ z `android/app/src/main/assets/m5/` do `M5cet.app/m5/` (jeden zdroj pravdy; test
  `testDesignAssetsAreTheAndroidOnes` porovná bajty). Čtení: `Bundle.main.url(forResource: "default-design",
  withExtension: "json", subdirectory: "m5")`.
* **Ikony** — `node ios/scripts/make-icons.mjs` je vykreslí z adaptivní ikony Androidu
  (`res/drawable/ic_launcher_foreground.xml`, barvy z `res/values/colors.xml`): 1024 px pro iOS (světlá, tmavá,
  tónovaná) a watchOS, a `Mark.svg` (značka úvodní obrazovky z `ic_mark.xml`). Výsledky jsou v repozitáři.
* **Barvy** — `AccentColor` = `m5_brand` #E11D48, `LaunchBackground` = `m5_splash` #0E1116.
* **Texty systému** — popisy oprávnění v `Info.plist` (anglicky) a překlady v `InfoPlist.xcstrings` (en, cs, de,
  es, it, fr, sk, sl, fi — slovník `i18n/GLOSSARY.md`). Neutrální text upozornění v
  `M5cetNotifications/Localizable.xcstrings`. Všechno ostatní, co aplikace říká, je z designu.

## Pro další agenty (vlna 2)

* **Soubory se do projektu nepřidávají.** `M5cet/`, `M5cetNotifications/`, `M5cetWatch/` a `M5cetTests/` jsou
  synchronizované složky: nový `.swift` soubor (i v nové podsložce) Xcode sám zařadí do cíle té složky.
  Pozor: **každý jiný soubor** (`.md`, `.json`, `.txt`, i skrytý `.gitkeep`) se zkopíruje jako zdroj do kořene
  balíčku — dva stejně pojmenované = chyba „Multiple commands produce“. Poznámky proto nepište do složek cílů, nebo
  je přidejte do výjimek (`membershipExceptions` v `project.pbxproj` — změna projektu přes koordinátora).
* **M5Kit**: `import M5Core` / `M5Crypto` / `M5Proto` / `M5Net` / `M5Design` / `M5NFC` — produkt `M5Kit` je
  připojen k aplikaci, rozšíření i hodinkám. Hodinky linkují celý produkt, takže **každý cíl M5Kit se musí přeložit
  i pro watchOS** (žádný UIKit, CoreNFC ani WebRTC v M5Kit).
* **WebRTC**: `import WebRTC` jen v cíli `M5cet` (Platform/Calls).
* **Zapojení při startu**: `App/Bootstrap.swift` (jedno místo, řádek na oblast); rozhraní `App/AppHooks.swift`:
  `AppModel.push: RemotePushHandling` (token APNs, tiché push), `AppModel.voip: VoIPPushHandling` (PushKit se
  zaregistruje jen s ním — každý VoIP push musí synchronně nahlásit hovor CallKitu), `AppModel.onScenePhase`,
  `AppModel.onLink` / `takePendingLink()` pro `m5cet://`.
* **Zástupná obrazovka** `App/RootView.swift` je k nahrazení Rendererem.
* **Sdílení s rozšířením**: App Group `group.cz.m5cet.app` (build nastavení `M5_APP_GROUP`, v Info.plist obou cílů
  klíč `M5AppGroup`) a skupina Keychainu `$(AppIdentifierPrefix)cz.m5cet.app`.
* Nový **AID** pro Core NFC → doplnit do `Info.plist`
  (`com.apple.developer.nfc.readersession.iso7816.select-identifiers`); Core NFC jiný SELECT nepustí.
* Nová schopnost (entitlement), nový cíl nebo závislost = změna projektu → koordinátor.

## Podpis: zařízení, TestFlight, App Store

V repozitáři není žádný tým ani certifikát. Tým se zadá jedním ze způsobů:

1. proměnnou prostředí: `M5CET_DEVELOPMENT_TEAM=ABCDE12345 xcodebuild …` (čte ji `Config/Base.xcconfig`),
2. souborem `ios/Config/Signing.xcconfig` (git ho ignoruje) — zkopírujte `Signing.xcconfig.example`,
3. nebo `DEVELOPMENT_TEAM=…` na příkazové řádce `xcodebuild`.

Podpis je automatický (`CODE_SIGN_STYLE = Automatic`); Xcode zaregistruje App ID `cz.m5cet.app`,
`cz.m5cet.app.notifications`, `cz.m5cet.app.watchkitapp` a jejich schopnosti podle entitlementů:
Push Notifications, NFC Tag Reading, App Groups (`group.cz.m5cet.app`), Keychain Sharing, Associated Domains.
Pro sestavení z příkazové řádky přidejte `-allowProvisioningUpdates`.

**Passkeys (Associated Domains)**: entitlement obsahuje `webcredentials:$(M5_WEBCREDENTIALS_DOMAIN)`; doménu serveru,
pro který se sestavuje, nastavte `M5CET_WEBCREDENTIALS_DOMAIN=chat.example.com` (prostředí) nebo
`M5_WEBCREDENTIALS_DOMAIN` v `Signing.xcconfig` (výchozí `m5cet.invalid` = nic). Server musí na
`https://<doména>/.well-known/apple-app-site-association` vracet `{"webcredentials":{"apps":["<TEAMID>.cz.m5cet.app"]}}`.
Na rozdíl od Androidu (jedno APK pro libovolný server) je doména pevná v sestavení — více serverů = více záznamů.

**APNs**: entitlement `aps-environment` je `development`; export pro TestFlight / App Store ho přepíše na
`production`. Server posílá push přes HTTP/2 s klíčem `.p8` (`APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_TOPIC=cz.m5cet.app`, `APNS_ENV`); VoIP push má topic `cz.m5cet.app.voip`. Aby upozornění prošlo rozšířením
`M5cetNotifications`, musí mít `mutable-content: 1`.

**TestFlight / App Store**:

```sh
xcodebuild -project ios/M5cet.xcodeproj -scheme M5cet -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ios/build/M5cet.xcarchive archive -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath ios/build/M5cet.xcarchive -exportPath ios/build/export \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
```

`ExportOptions.plist` (mimo repozitář) s `method` = `app-store-connect`, `teamID` a `destination` = `upload`
nahraje build rovnou do App Store Connect (nebo `.ipa` nahrajte aplikací Transporter / z Organizeru v Xcode).
Předtím v App Store Connect založte aplikaci s bundle ID `cz.m5cet.app`. Číslo buildu musí růst — při opakovaném
nahrání stejné verze zvyšte verzi v `package.json` (nebo jednorázově `CURRENT_PROJECT_VERSION=…` na řádce).
Archivy, `.ipa` a `ios/build/` git ignoruje (`ios/.gitignore`).

**Export šifrování**: `ITSAppUsesNonExemptEncryption = true` — aplikace má vlastní koncové šifrování (AES-GCM, ECDH,
ML-KEM, Ed25519, Argon2id), nejen HTTPS systému, takže nespadá pod výjimku. App Store Connect se u každého buildu
zeptá na šifrování; pro šifrování pro masový trh obvykle stačí sebeklasifikace podle amerických EAR (5D992.c,
roční hlášení BIS), případně dokumentace pro jednotlivé země. Až Apple přidělí kód, lze přidat
`ITSEncryptionExportComplianceCode` do `Info.plist`. Požadavky se mění — ověřte je před odesláním k nahlédnutí.

## Omezení (stav lešení)

* Obrazovky, Platform služby, dešifrování v rozšíření a obsah hodinek přijdou ve vlně 2; teď je zástupná obrazovka.
* Na tomto Macu není runtime simulátoru watchOS — hodinky jsou jen sestavené, nespuštěné.
* NFC jen na iPhonu (iPad a hodinky ho nemají), MIFARE Classic Core NFC nečte; HCE jen s entitlementem (§ 5 kontraktu).
* Polling `.pace` (Core NFC pro karty jen s PACE) by potřeboval formát `PACE` v entitlementu — zatím `TAG` + `NDEF`.
