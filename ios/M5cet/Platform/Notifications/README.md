# Platform/Notifications — upozornění, konverzace, zámek, rozšíření

Port `A/telecom/{Notify, Conversations, ConversationPlan, ReplyReceiver, LockScreen}` a `A/push/{NotifyPrefs,
NotifyTemplate}` (`A/` = `android/app/src/main/java/cz/m5cet/app/`). Testy v `M5cetTests/Notifications`.

| Android | iOS |
|---|---|
| `Notify` | `Notifier` (delegát `UNUserNotificationCenter`, kategorie, `message`, `templated`, `flash`, `push`, `update`, `missedCall`, `clearRoom`, `neutralizeAll`, odznak) |
| `ReplyReceiver` | `Notifier.respond`: `UNTextInputNotificationAction` „m5.reply“ (+ „m5.read“), jen do místnosti, ve které aplikace je, nikdy při zámku |
| `NotifyPrefs` | `NotificationPrefs` (nastavení `notify.*` z designu, šablony operátora SYS `notify-policy`, `PUT /api/account/notify`, vazba zařízení, test, `$notify`) |
| `NotifyTemplate` | `Shared/NotifyTemplate` (sdílené vektory `test/fixtures/notify-templates.json`, UTF-16 jako Java/JS) |
| `LockScreen` | `Shared/LockScreen` (+ iOS: „neutrální text“, když systém ukazuje náhledy vždy) |
| `ConversationPlan`, `Conversations` | `ConversationPlan` (čistá logika) + `Conversations` (Communication Notifications, `INSendMessageIntent`, darované interakce se při zámku mažou, id `conv-` + HMAC, mapování id místnosti serveru → vlákno, SYS `threads`) |
| FCM data + `Notify` při zámku | **`M5cetNotifications`** (NSE): otevře zapečetěné `m5`, podle `lock-state.json` a úrovně soukromí vykreslí text, jinak neutrální |

## Sdílený kód aplikace a rozšíření

`Shared/*.swift` (NotifyTemplate, LockScreen, PushShared — LockMirror, NeutralTexts, NotifyMirror, PushOpener,
PushHandoff, ThreadIds —, PushContent, SysTierReader, NotificationContentFactory, Monogram) se překládá do aplikace
(a testuje v `M5cetTests`) a přes **symlinky** v `ios/M5cetNotifications/Shared/` i do rozšíření (synchronizovaná
složka symlinky následuje — projekt se neměnil). Nový sdílený soubor = soubor sem + symlink tam.

Rozšíření čte jen SYS vrstvu z App Group (`SysTierReader`: `sys.key` rozbalený klíčem `key.sys`, záznamy `config`,
`notify-prefs`, `conversations`, `threads`) a klíč `key.enc` ze sdílené skupiny Keychainu (`cz.m5cet.shared.security`);
nepodepisuje a nic neposílá. Co udělalo, poznamená pro aplikaci (`PushHandoff`, `push-handoff/<id>.json`): zámek a
smazání aplikace provede (zprávu znovu ověří), zobrazené zprávy z check-inu jen potvrdí.

## Soukromí

* Při zámku aplikace (`lock-state.json` / `AppLock.isLocked`) nic nejmenuje osobu ani místnost a nic neukazuje zprávu
  (S11); po zamčení se doručená upozornění přepíšou neutrálním textem pod týmž id (G-22) a smažou se darované konverzace.
* Vlákna (`threadIdentifier`), id konverzací a handle odesílatelů jsou neprůhledné (HMAC s tajemstvím instalace);
  klíč místnosti se s upozorněním neukládá — klepnutí / odpověď ho najde mezi místnostmi aplikace (`room(of:among:)`).
* `notify.lockScreenHide`: iOS nemá viditelnost na zamčené obrazovce po upozorněních; se „Zobrazovat náhledy: Vždy“
  jde text neutrální, jinak náhled na zamčené obrazovce skryje systém (`hiddenPreviewsBodyPlaceholder`).

## Rozhraní pro ostatní

```swift
// Notifier.shared — @MainActor
weak var rooms: (any NotificationRooms)?        // room session: joinedRoomKeys, roomKey(forServerId:), label(ofRoom:),
                                                // reply(roomKey:text:) async -> Bool, markRead(roomKey:), open(roomKey:)
var flashSink: ((String, String, String) -> Bool)?   // flash v aplikaci (title, text, level)
var unreadCount: (() -> Int)?                        // odznak (jinak počet doručených)
func message(roomKey: String, roomName: String, sender: String, text: String, hideContent: Bool)
func templated(_ payload: [String: Any], local: Bool)
func flash(title: String, text: String, level: String, alreadyShown: Bool = false) -> String
func push(title: String, body: String, room: String, url: String)
func missedCall(roomKey: String, who: String, video: Bool, at: Int64)   // zapojeno na CallCenter.onMissed
func clearRoom(_ roomKey: String)               // místnost přečtena
func neutralizeAll() async; func refreshBadge() async; func requestAuthorization() async -> Bool
func settingChanged(_ key: String); func textsChanged()
// Conversations (Notifier.shared.conversations)
func noteServerRoom(roomKey: String, serverId: String)   // místnost zná své id na serveru → vlákna z rozšíření
func roomsGone(_ keys: [String])                         // místnosti opuštěné / smazané
```

`Notifier.install` už propojuje: delegáta, kategorie, `SecurityCenter` (účastník zámku, smazání), `CallCenter.onMissed`,
`DeviceService` (vydání → upozornění, registrace → žádost o oprávnění), `DesignServices` (nastavení `notify.*` /
`conversations.*`, akce `notify.up|down|use|drop|test|sync`, změny nastavení, texty, jméno aplikace, jazyk).
Integrace doplní `rooms`, `flashSink`, `unreadCount`, `prefs.account` (`NotifyAccount`: přihlášení, token relace)
a volání `message` / `clearRoom` / `noteServerRoom` z room session.

## Info.plist / entitlementy (koordinátor)

* `NSUserActivityTypes`: přidat **`INSendMessageIntent`**.
* Entitlement **`com.apple.developer.usernotifications.communication`** (aplikace i rozšíření) — bez něj
  `updating(from:)` selže a jde obyčejné upozornění.
* Volitelně `com.apple.developer.usernotifications.filtering` (rozšíření; schvaluje Apple) — pak by rozšíření mohlo
  vypnutý druh / tiché hodiny zahodit úplně; teď je doručí potichu (`passive`, bez zvuku).

## Omezení oproti Androidu

* Rozšíření nezná jména místností (USER vrstva) — titul bez místnosti; vlákno místnosti ano (SYS `threads`).
* Žádné seznamy zkratek (spouštěč, cíle sdílení): iOS se učí z darovaných interakcí.
* Akcent šablony (barva) iOS nemá; kanály Androidu = kategorie + `interruptionLevel`.
* Simulátor bez podpisu nemá App Group ani Keychain → rozšíření tam vidí jen neutrální text.
