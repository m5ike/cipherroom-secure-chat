# Platform/Push — APNs, řídicí zprávy, check-in, aktualizace

Port `A/push/*` a `A/update/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`); protokol, podpisy a ECIES
balíčky jsou v `M5Kit/M5Net` + `M5Crypto`, server je `/api/ios/*` (docs/ios-architecture.md § 4).

| Android | iOS |
|---|---|
| `Push`, `FcmService` (FCM data zprávy) | APNs token (`AppModel.push: RemotePushHandling`, `AppDelegate`), tichý push `content-available` |
| `Control` (podepsané / zapečetěné řídicí zprávy) | tentýž formát, doručený tichým pushem nebo přes relay |
| `Checkin` (+ `Checkin$Job`) | `BGTaskScheduler` s identifikátorem `cz.m5cet.app.checkin` (Info.plist `BGTaskSchedulerPermittedIdentifiers`), check-in při návratu do popředí |
| `NotifyPrefs`, `NotifyTemplate` | texty notifikací z designu; viditelný push otevírá `M5cetNotifications` (NSE) |
| `update/Bundles`, `BundleFile` | balíčky designu (M5PK) stejně — stažení, ověření, rozbalení |
| `update/Releases`, `InstallReceiver` | žádné APK: server hlásí minimální verzi, aplikace odkáže do App Storu / TestFlightu |

Rozšíření `ios/M5cetNotifications` (Notification Service Extension) dešifruje zapečetěný obsah (`m5` v payloadu,
`mutable-content: 1`) a při zámku nechá neutrální text — viz `NotificationService.swift` (TODO pro tuto oblast).
Instalace při startu: `App/Bootstrap.swift` (`model.push = …`, registrace BG úlohy).
