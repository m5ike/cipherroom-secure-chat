# Platform/Push — APNs, zařízení na serveru, řídicí zprávy, balíčky designu, vydání

Port `A/push/{Push, FcmService, Control, Checkin}`, `A/update/{Bundles, BundleFile, Releases, InstallReceiver}` a
zařízení části `A/net/Server` (`A/` = `android/app/src/main/java/cz/m5cet/app/`). Protokol, podpisy a formáty jsou
v M5Kit (`M5Net`: `DeviceAPIClient`, `DeviceEnrollment`, `Checkin`, `ControlInbox`, `ReleaseWatcher`, `NotifyLink`;
`M5Design`: `BundleVerifier`, `BundleLedger`), server je `/api/ios/*` (`docs/ios-server.md`). Notifikace a rozšíření
jsou v `Platform/Notifications`, testy v `M5cetTests/Push`.

| Android | iOS |
|---|---|
| `Push` (token FCM), `FcmService` | `PushCenter` (`AppModel.push: RemotePushHandling`): token APNs (hex, záznam SYS `push`), prostředí `apnsEnv` z entitlementu `aps-environment` (`ApnsEnvironment`: `development` → `"sandbox"`, `production` → `"production"`, simulátor / bez podpisu = `sandbox`), tichý push → `DeviceService.handle`; nový token (APNs i VoIP) → check-in hned |
| `Control` | `DeviceService.handle(wire:via:alreadyShown:)` nad M5Net `ControlInbox` (podpis připnutým klíčem, ECIES klíčem zařízení, id, deduplikace 300, expirace) + `execute` — `ping`, `status` (+ logy podle `policy.logs`: `LogTail` z `OSLogStore`), `flash`, `push`, `notify`, `update`/`config` (check-in hned), `lock`, `wipe` (nejdřív odpověď, pak `SecurityCenter.wipe`), neznámý druh → odpověď `ok:false` |
| `Checkin` (+ `Job`) | `DeviceService.checkin(_:force:)` (M5Net `Checkin.run`): v popředí nejvýš po 5 min, `force` z pushe; politika → `PolicyStore.adopt` (jedna kopie, ověřil ji `DeviceState`), příkazy, balíček, vydání, `minBuild`/`updateRequired`, události; úloha `BGTaskScheduler` `cz.m5cet.app.checkin` (BGAppRefresh, když má `UIBackgroundModes` `fetch`, jinak BGProcessing s sítí), nejdřív za 12 h s APNs / `pollSeconds` (≥ 15 min) bez — kdy, rozhodne iOS |
| `net/Server` (zařízení) | `DeviceService` přes `DeviceAPIClient` (`/api/ios`): `enroll`, `checkin`, `ack` (neodeslaná odpověď čeká v SYS `acks`), `events` (`DeviceEvents`, SYS `events`, max. 500, dávky 100), `message-audit`, `location`, `notify` (vazba na účet), `bundles/:id`, `releases/:id`; podpisy klíčem z `Keyring` (`DeviceKeys` → `KeyringSigner` / `KeyringAgreement`) |
| `ui/parts/Forms.enrollLink` + `submit` | `DeviceService.takeEnrollLink(_:)` (vyplní `prefill`, `enrollNotice`; odkaz nepřebírá — Renderer ukáže registraci) a `enroll(code:name:)` / `enroll(server:code:name:)`: `/info`, piny (Info.plist `M5ServerKeyPin`, `kid` z QR pro tentýž server), `/enroll`, tentýž klíč v odpovědi, podepsaná politika, první check-in |
| `update/Bundles`, `BundleFile` | `DesignBundleStore` (`BundleLedger` + `BundleVerifier` + `DeviceBundleCrypto`): stažení → ověření → `Vault.seal(.sys, "bundle-<id>")` v `Application Support/m5/bundles/<id>.bin` (jako Android: SYS klíčem, čitelné i při zámku) → zkouška při dalším startu → po 20 s dobrý / návrat; iOS nemá zachycení pádu: zkouška třikrát spuštěná bez 20 s = pád |
| `update/Releases`, `InstallReceiver` | `UpdateNotice`: záznam vydání (`m5iosrelease/1`, ověřený `GET /releases/:id` před nabídnutím odkazu), `mandatory` pod `minBuild` / povinné vydání, odkaz jen `apps.apple.com` / `itunes.apple.com` / `testflight.apple.com`; žádná instalace |
| PushKit (VoIP) | `VoIPInviteOpener` (Calls `VoIPPayloadOpening`, synchronně): obsah buzení při hovoru `{kind:"call"|"call-end", payload:{call, room, who, video, at}}`, `room` (id místnosti na hubu) → uložená místnost přes `NotificationRooms.roomKey(forServerId:)`, deduplikace id zprávy (SYS `seen-voip`) |

## Rozhraní pro ostatní

```swift
// DeviceService (PushCenter.shared?.device) — @MainActor @Observable
var state: DeviceState?; var isEnrolled: Bool; var enrolling: Bool; var enrollError: String?
var prefill: EnrollPrefill?; var enrollNotice: EnrollNotice?; var suggestedServer: String
var deviceStatus: String          // "" | revoked | blocked | wiped … (403 device-…)
var checkingIn: Bool; var lastCheckinAt: Int64; var lastError: String?; var pushMode: String
var policy: NetJSON; var updateRequired: Bool
let update: UpdateNotice; let bundles: DesignBundleStore; let events: DeviceEvents
func takeEnrollLink(_ url: URL) -> Bool
func enroll(code: String, name: String) async -> Bool
func enroll(server: String?, code: String, name: String) async -> Bool
func checkin(_ why: String, force: Bool = false) async -> Bool
func handle(wire: NetJSON, via: String, alreadyShown: Bool = false) async -> DeviceService.Handled
func messageAudit(actions: [NetJSON], account: String?) async throws -> Int64
func uploadLocation(points: [LocationPoint]) async throws -> (stored: Int64, minSeconds: Int64)
func linkNotifications(token: String?, wanted: Bool) async -> NotifyLink.Outcome
weak var location: (any DeviceLocationControl)?   // Platform/Location: policy.location, příkaz "location"
var onCheckin: [() -> Void]; var onEnrolled: [() -> Void]

// DesignBundleStore (device.bundles) — @MainActor @Observable
var design: Design?; var activeId: String; var activeVersion: String; var onTrial: Bool; var revision: Int
var download: Download; var progress: Double; var stagedVersion: String; var scope: [String: Any]  // $update
func onChange(_ observer: @escaping (Design?) -> Void)
func confirmTrial(); func rollback(reason: String) -> Bool; func renderFailed(screen: String, message: String) -> Bool
func installNow()

// UpdateNotice (device.update) — @MainActor @Observable
let currentBuild: Int; var release: ReleaseRecord?; var state: State; var minBuild: Int64
var available: Bool; var mandatory: Bool; var storeURL: URL?; func scope(lang: String) -> [String: Any]  // $update
```

`PushCenter.install` už propojuje: `model.push`, úlohu na pozadí, odkazy, fázi scény, `SecurityCenter.wiper` (podepsané
hlášení o smazání `DeviceWipeReporter`, odstranění při smazání), `CallSystem.shared.voip.opener`, `DesignServices`
(`setDesign`, `onRenderFailure`). Integrace doplní: `DeviceService.location` (Platform/Location), `facts.rooms`,
`device.onCheckin` (Define), `DeviceEvents` jako `SecurityEvents` pro `SecurityCenter` (události zámku na server).

## Info.plist / entitlementy

* `UIBackgroundModes`: **`fetch`** (BGAppRefresh pro check-in; bez něj se použije BGProcessing — `processing` už tam je),
  `remote-notification` (je).
* Volitelně `M5ServerKeyPin` (pin klíče serveru v sestavení, Android `BuildConfig.SERVER_KEY_PIN`) a
  `M5DefaultServer` (server, kterým začíná registrace).

## Omezení oproti Androidu

* iOS nespouští úlohy v čase: check-in na pozadí je jen „nejdřív za“; tiché pushe iOS dávkuje.
* Žádná instalace aplikace (App Store / TestFlight), žádný zachycovač pádů (počítadlo zkoušek místo `onCrash`).
* Zámek a smazání z pushe provede aplikace, až běží (rozšíření je jen poznamená — `PushHandoff`).
