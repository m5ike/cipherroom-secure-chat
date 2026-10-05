# Core — jádro aplikace (6.14)

Port „lepidla“ aplikace pro Android (`A/` = `android/app/src/main/java/cz/m5cet/app/`): `A/M5.java` (singleton
aplikace), správa místností a chatu (`A/chat/Rooms`, zapojení `RoomSession`, `P4*`, `Trust`, `History`, `Resume`,
`LockedRooms`, `Outgoing`, `Files`), účet (`A/account/*`), `MainActivity.scopeFor` + `route` (stav obrazovek),
akce (`A/ui/Actions` a `Parts`) a části `lockPad`, `enrollForm`, `joinForm`, `roomList`, `roomTabs`, `callControls`,
`callVideo`. Logika bez UI je v `M5Kit` (M5Proto `RoomSession`, M5Net `HubConnection`…), systémové služby v `Platform/*`.

```
Core/Models/    kontrakty pro části (tento soubor § Modely) — RoomsModel, RoomModel, ComposerModel, AccountModel,
                FnEngine, MessageFiles, PositionSource, ScreenVariables, ToolsModel, CoreModels (vstup)
Core/Preview/   PreviewCore (jen DEBUG): ukázková data bez enginu
Core/Engine/    AppCore, RoomsController, RoomController (M5Proto RoomSession ↔ M5Net hub), úložiště, zámek, soubory, hovory
Core/Account/   účet: passkeys (AuthenticationServices), trezor slotů v2, obnovovací kód, profil
Core/State/     AppScreenState (ScreenStateProvider), DeviceStatus (zápis do serveru)
Core/Actions/   handlery AppActionRouter (room.*, message.*, call.*, lock.*, account.*…), odkazy, vstup do aplikace
Core/Slots/     lockPad, enrollForm, joinForm, roomList, roomTabs, callControls, callVideo
```

## Modely — kontrakt pro části (chat, people, tools)

Vstup: **`CoreModels.shared`** (`@MainActor @Observable`). Při startu ho `App/Bootstrap.swift` nastaví na skutečné jádro;
DEBUG náhled (`-M5Screen …`, SwiftUI `#Preview`) volá `PreviewCore.install()` → ukázková data. Část nikdy neví, na kterém
běží. Vše je hlavní vlákno a `@Observable`: pohled, který čte `messages` nebo `people`, se překreslí, když se změní.
Operace se vrací hned; protokolová práce běží na aktoru místnosti a vrací se jako stav.

```swift
let core = CoreModels.shared
core.rooms                          // any RoomsModel   — všechny místnosti
core.rooms.active                   // (any RoomModel)? — místnost na obrazovce
core.composer(for: ctx.host)        // ComposerModel    — skladač okna (jeho $form)
core.account                        // any AccountModel — účet, $account, bearer()
core.tools                          // ToolsModel       — dostupnost nástrojů, $voice
core.variables.register("ai", "ai") { … }   // proměnná obrazovky, kterou vlastní část ($ai, $nfc, $log…)
core.fn = MyFnEngine()              // engine příkazů (agent tools)
core.files                          // (any MessageFiles)? — soubory zpráv v trezoru
core.position                       // (any PositionSource)? — poloha
core.userName, core.server          // přezdívka zařízení, origin serveru
```

### `RoomsModel` (Android `Rooms`)

| Člen | Význam (Android) |
|---|---|
| `loaded`, `items: [RoomItem]` | uložené místnosti podle poslední aktivity (`saved()`, `scope()` = `$rooms`; `RoomItem.scope` = `$room` šablony `rooms.item`) |
| `activeKey`, `active`, `open: [any RoomModel]` | místnost na obrazovce; připojené podle aktivity (`connectedSessions` — lišta, swipe mezi místnostmi, přeposlání) |
| `selectedCount`, `connectedCount`, `unreadTotal`, `maxRooms`, `ktAlert` | počty, limit politiky (`rooms.max`), upozornění KT |
| `room(_:)`, `byServerId(_:)`, `saved(_:) -> SavedRoom?`, `card(_:)` | vyhledání, kopie uložené místnosti (formulář úprav), karta NFC |
| `switchTo`, `toggleSelected`, `connectSelected`, `leave` (`""` = aktivní), `forget` | `room.switch`, `room.toggle`, `rooms.connect`, `room.leave`, `room.forget` |
| `join(room:passphrase:userName:) -> key` | formulář připojení (`Rooms.add` + připojit + aktivní) |
| `clone(_:)`, `update(_:room:passphrase:userName:)` | `room.clone`, uložení `room.edit` |
| `setVisible(_:)`, `dismissKtAlert()` | obrazovka místnosti je vidět (nepřečtené, oznámení); `kt.dismiss` |

### `RoomModel` (Android `RoomSession` pro UI)

Stav: `key`, `room`, `label`, `status` (`offline | connecting | joined | mismatch | blocked | full…`), `notice`,
`connected`, `unread`, `lastActivity`, **`messages: [ChatMessage]`** (M5Proto, nejstarší první, ≤ 600, prošlé pryč),
`restores` (kolikrát přišla historie — po odemčení začíná seznam znovu), `historyReady`, `freshId` (poslední živě
přišlá / moje zpráva — posun a animace), `revealRequest` (zpráva, na kterou seznam skočí a blikne — seznam ji vynuluje),
`myId`, `myName`, `myPublicKey`, **`people: [PersonItem]`** (`peopleScope` + důvěra + přítomnost: já, peeři, away,
held; `PersonItem.scope` je celý řádek jako na Androidu), `peers: [PeerRef]` (otevřené kanály — příjemci, zmínky),
`userCount`, `call: CallInfo` (`$call`), `ktAlert`, `scope` (`$room`).

Dotazy: `message(_:)`, `peerName(_:)`, `isHeld(_:)` (P14: text se neukazuje ani necituje), `heldCount(_:)`,
`profile(of:) -> JSONObject?` (co člen sdílí s místností — avatar, přezdívka…), `accountKey(of:)`, `safetyKeys(_:)`,
`safetyNumber(_:)`, `canPrivate(_:)`.

Operace: `send(_ o: Outgoing) -> id` (bublina hned jako „sending“), `sendText(_:replyTo:)`,
`sendFile(vaultId:name:mime:size:_:)` (soubor z trezoru přenosem), `markRead(_ ids:)` (potvrzení přečtení, odznak),
`touch(_ id:, change)` (krok jen tohoto zařízení — zobrazeno, odkryto, otevřená pečeť; uloží se), `hide(_:until:unlock:why:)`,
`deleteLocal(_:)`, `vanished(_:)`, `identityVerified(_:_:)`, `addNote(…)`, `startFnCall(…)`, `fnCallStatus(…)`,
`fnCallProgress(…)`, `addModelAnswer(…)`, `refreshStats()`.

Android nemá úpravy, reakce ani připnutí zpráv ani indikátor psaní — nejsou tedy ani tady (věrný port).

### `ComposerModel` (Android `Composer` bez pohledu + `Parts.*` skladače) — jeden na okno

`text` (vazba pole), `replyTo`, `request: ComposerRequest?` (co má část udělat — `pickPhoto`, `camera`, `pickFile`,
`recordVoice`, `recordText`, `speakAsVoice`, `toggleDictation`, `dictateThenSend`; část ho po převzetí nastaví na `nil`),
`focusRequests` (zvýší se → pole dostane fokus), `revision`, `voiceBusy`, `plan: SendPlan` (z `$form`), `recipientIds`,
`recipientNames`, `scope` (`$composer`), `room`.
Operace: `send()` (`message.send` — `SendPlan.step`, příkaz přes `FnEngine.run`, hlasové kroky → `request`),
`sendSpoken(_:)`, `setReply(_:)`, `clearReply()`, `focus()`, `write(_:)` (`compose write:/kw`), `messageKind(_:)`,
`sendOption(_:)`, `setRecipients(_:)`, `outgoing(_:) -> Outgoing`, `sendBytes(_:name:mime:image:caption:)`
(≤ 96 KiB inline, jinak trezor + přenos), `sendImage(_:)` (≤ 1600 px, JPEG 85→45), `sendFile(at:)`,
`sendVoiceMessage(_:mime:)`, `sendVoiceClip(_:mime:spoken:)`, `sharePosition()`, `compose(_:)`, `suggestions(caret:)`,
`argHint(caret:)`, `forget()`.

### Ostatní

* `AccountModel`: `signedIn`, `username`, `scope` (`$account`), `bearer() async`.
* `FnEngine` (registruje agent tools jako `core.fn`): `commandChars`, `load()`, `forget()`, `suggest(…)`, `hint(…)`,
  `run(room:text:host:) -> Bool`, `modelCard(for:)`. Bez něj se nic nenavrhuje a „/příkaz“ odejde jako text.
* `MessageFiles` (jádro nad `Platform/Files/FileVault`): `store(_:)`, `store(contentsOf:)`, `read(_:)`,
  `temporaryCopy(_:name:)` + `discard(_:)` (share sheet, Quick Look).
* `PositionSource` (jádro nad `Platform/Location`): `permitted`, `recent()`, `current() async` (`{lat, lon, acc, at}`).
* `ScreenVariables`: `register(screen, name) { DesignValue }`, nebo `register(screen, name, window: { host in … })` pro hodnotu
  okna, ve kterém se obrazovka kreslí (`$profile` nad `$form` toho okna). Proměnné částí **přebíjejí** hodnoty jádra
  (`AppScreenState` je skládá přes své), `$users` (`room`, `call`) dělá jen People. Když se `CoreModels.shared` vymění
  (náhled → skutečné jádro), registrace částí se převezmou (`ScreenVariables.adopt`).
* `ToolsModel`: `nfcAvailable`, `voiceAvailable`, `aiAvailable`, `voice` (`$voice`), `toolsScope` (`$tools`).
* `RoomModel.peopleSettling` (RoomSession.peopleSettling): místnost se teprve připojuje, je připojená < 8 s nebo kanál
  peeru ještě není otevřený / bez hello — „napsat přes M5cet“ z kontaktu chvíli počká.

### Co registrují části samy (UI part handles it)

Akce, jejichž stav drží pohled, si části registrují v `AppActionRouter` jedním řádkem v `App/Bootstrap.swift`
(`XxxParts.install(into: model)`) — **za** `CoreInstall.install`, takže jejich registrace nahradí zálohu jádra
(router: pozdější vyhrává).

| Agent | Stav | Akce | Proměnné (`core.variables`) |
|---|---|---|---|
| people | sloučeno (`PeopleParts`) | `people.*` (11), `users.toggle/dock/autoHide`, `msg.info`, `msg.sender`, `profile.*` (8); `router.shownUsername` | `settings.profile`/`profile`, `settings`/`myProfile`, `room`+`call`/`users` |
| nfc | sloučeno (`NfcParts`) | `nfc.read/write/emulate/stop` (`nfc.workbench`, `nfc.builder` kreslí renderer, `nfc.reader` runner) | `nfc`/`nfc` |
| chat | čeká | `msg.quote`, `msg.showHidden`, `msg.mapPreview`, `msg.source` | — |
| tools | sloučeno (`ToolParts`) | `ai.send/stop/clear`, `voice.dictate`, `calllog.*` (6), `voiceFx.test/reset`; `core.fn` = `ToolsFnEngine` | `ai`/`ai`, `log`/`log`, `settings.voiceFx`/`voiceFx`, `voice`…/`voices` |

### Sloty

Jádro registruje: `lockPad`, `enrollForm`, `joinForm`, `roomList`, `roomTabs`, `callControls`, `callVideo`; do doby,
než je zaregistruje chat, zálohy `messages`, `msgBody`, `composer` (šablony designu `message.in/out/sys` nad
`RoomModel.messages`, prosté pole nad `ComposerModel`) a prázdný `userPanel` (`FallbackChatSlots`, jen když slot nikdo nemá).
Části: `messages`, `msgBody`, `msgHold`, `composer` (chat), `userPanel`, `userList` (people), `voicePad`, `aiChat` (tools),
`nfcPanel`, `nfcWork`, `nfcBuilder` (nfc).

**Zámek**: obrazovka zámku je jen designová (route `lock` + slot `lockPad`) — `CoreInstall` vypne vlastní okna
Security (`SecurityCenter.showsWindows = false`, `LockPresenter` to respektuje); zamčená jsou všechna okna (každé okno
iPadu routuje podle `AppRouteState.locked`). Krytí pro přepínač aplikací / nahrávání obrazovky zůstává (`ScreenPrivacy`).

## Akce — pokrytí všech 122 akcí `ActionCatalog`

Test `CoreStateTests.testEveryCatalogueActionHasAnOwner` hlídá, že žádná akce nezůstane bez vlastníka.

| Vlastník | Akce | Co se děje |
|---|---|---|
| **renderer** (`DesignHost.perform`) — 9 | `screen.open`, `back`, `menu.open`, `sheet.open`, `sheet.close`, `flash`, `nfc.workbench`, `nfc.builder`, `update.later` | navigace, překryvy, flash; `update.later` zavře překryv |
| **renderer** (`ActionRunner`) — 12 | `lib.run`, `set`, `setting.set`, `setting.toggle`, `look.set`, `look.reset`, `appearance.reset`, `theme.toggle`, `nfc.reader`, `url.open`, `copy`, `share` | `$form`, nastavení (vedlejší účinky → `onSettingChanged` jádra), vzhled, potvrzení adresy / vypočteného textu |
| **jádro** — místnosti (9) | `room.join`, `room.switch`, `room.toggle`, `rooms.connect`, `room.leave`, `room.forget`, `room.delete`, `room.clone`, `room.edit` | formulář připojení, přepnutí / připojení, výběr, odpojení, zapomenutí (+ historie), kopie, úprava přes `$form.roomEdit` |
| **jádro** — skladač (7) | `message.send`, `message.reply`, `message.copy`, `message.kind`, `message.recipients`, `compose`, `send.option` | `ComposerModel` okna (druhy, příjemci, příkazy, `ComposerRequest` pro foto / soubor / hlas) |
| **jádro** — zprávy (7) | `msg.forward`, `msg.forwardRoom`, `msg.forwardTo`, `msg.map`, `msg.open`, `msg.save`, `msg.share` | přeposlání (list `message.forward`, nebo dialogy u staršího designu), mapa (Apple Maps, `Where`), soubor z trezoru do sdílení |
| **jádro** — hovory (8) | `call.audio`, `call.video`, `call.audioText`, `call.end`, `call.mute`, `call.camera`, `call.switchCamera`, `call.speaker` | `CallSystem` (CallKit, oprávnění), obrazovka `call` |
| **jádro** — zámek a bezpečnost (6) | `lock.now`, `lock.biometric`, `pin.change`, `biometric.toggle`, `wipe.ask`, `kt.dismiss` | `SecurityCenter` (PIN, Face ID / Touch ID, smazání po potvrzení), upozornění KT |
| **jádro** — účet (6) | `account.signin`, `account.signup`, `account.signout`, `account.recovery`, `account.addPasskey`, `account.register` | passkeys s PRF (`SystemPasskeys`), obnovovací kód, registrace (formulář serveru) |
| **jádro** — ostatní (8) | `update.check`, `update.install`, `fn.run`, `voice.speak`, `voice.stop`, `system.settings`, `conversations.settings`, `lang.set` | check-in, `PushUpdates` (odkaz na App Store / TestFlight nebo designový balíček), `/příkaz` do místnosti (jako Android `r.send`), předčítání, Nastavení systému, texty po změně jazyka |
| **People** (zálohu má jádro) — 24 | `people.open/select/all/none/message/call/video/verify/link/unlink/unlinkAll`, `users.toggle/dock/autoHide`, `profile.open/pick/clear/field/sync/save/public/audience`, `msg.info`, `msg.sender` | záloha jádra: příjemci skladače, hovor, ověření bezpečnostního čísla; ostatní jen log |
| **NFC** (zálohu má jádro) — 4 | `nfc.read`, `nfc.write`, `nfc.emulate`, `nfc.stop` | záloha: „NFC tu není“ / zastavení `NfcService` |
| **chat** (čeká; záloha jádra) — 4 | `msg.quote`, `msg.showHidden`, `msg.mapPreview`, `msg.source` | záloha: skok na citovanou zprávu (`revealRequest`), mapa; `msg.showHidden`, `msg.source` jen log |
| **tools** (zálohu má jádro) — 12 | `ai.send/stop/clear`, `voice.dictate`, `voiceFx.test/reset`, `calllog.open/refresh/item/call/clear/system` | záloha: obrazovka `log`, smazání historie hovorů po potvrzení; ostatní log |
| **Platform/Notifications** — 6 | `notify.up/down/use/drop/test/sync` | `DesignNotifyWiring` (jádro je neregistruje) |

Součet: 21 renderer + 51 jádro + 24 People + 4 NFC + 4 chat + 12 tools + 6 Notifications = **122**. Na iOS není
nic, co by nešlo vůbec — rozdíly proti Androidu: `update.install` instaluje aplikaci obchod (otevře se ověřený
odkaz), `system.settings` otevře Nastavení aplikace (iOS nedovolí otevřít konkrétní obrazovku systému).

**Router dál**: `onLink` (m5cet://enroll — předvyplnění a hlášení z `DeviceService`, odkaz na zařízení bere
`ContactsService.install`), `onEnterApp` (načtení místností, účtu, KT, klíčů, audit, check-in, čekající místnost),
`onSettingChanged` (potvrzení, hovory, zámek, duress PIN; zbytek `settingObservers`: poloha, kontakty, hlas),
`shownUsername` — People.

## Buzení při hovoru (6.14, Android `chat/CallWake`)

* **Čistá logika** v M5Proto `Chat/CallWake.swift` (`Sender`, `Inbox`, `parse`, `pushed`, `payload`, `relayFields`,
  `messageId`, `newCallId`) — testy = Android `CallWakeTest` (+ místnost).
* **Odesílatel**: `RoomCore` si z `hello` pamatuje `features ∋ "call-wake"`; `RoomController.broadcastAudio`: přechod
  `off → live` = začínám hovor → `RoomSession.ringAway(video:othersInCall:)` (nikdo jiný v hovoru, away bez otevřeného
  kanálu, max. 50 → jedna položka přes relay, payload `{kind:"call", id:"<callId>:r", …}`, rámec `call:true, callId, video?`);
  `live/muted → off` = zavěsil jsem → `endRing()` (nikdo nepřijal → `:e`, `callEnd:true` těm, kdo jsou pořád away).
  Peer s `audio-status` live/muted = přijato. Video podle hovoru CallKitu (`RoomWire.callWantsVideo`).
* **Příjemce**: položka z fronty (`onRelayDeliver`, před `Payloads.validate`, `seen` + okno proti přehrání) →
  `RoomEvents.callWake` → `RoomController` drží `CallWake.Inbox`: zvonění čeká 30 s, jestli místnost hovor ukáže
  (peer live/muted → `roomInCall`), jinak / konec → zmeškaný hovor do Záznamu a `CallCenter.onMissed`
  (`RoomsController.onCallWakeStep`). Hovor, který už vyzvonil VoIP push, je `CallCenter`ův
  (`CallCenter.pushOwnsCall`) — jeden záznam na hovor.
* **M5Net**: `HubRelay` nesl jen `call` — doplněno `callEnd`, `callId`, `video` s kontrolou jako `frames.ts` (test).

## Profily (Android `profile/Profiles` + `RoomSession.profiles`)

`Core/Account/CoreProfiles.swift` je `PeopleParts.profiles` i výměna profilů v místnostech: karta se otevře jednou
pro účet z části trezoru „card“ (`AccountService.loadCard`, slot v2 + revize), uloží se zapečetěná
(`Profiles.planSave` → PUT / DELETE `/api/profile` → `finishSave` → `saveCard`), veřejné dotazy (`fetchPublic`),
při zamčení se zapomene karta, dotazy i to, co sdíleli ostatní (`ProfileRoom.Cache`). Každá místnost má svůj
`ProfileRoom.Exchange` (oznámení verze, žádost, plný pohled zapečetěný jen pro toho peeru — ratchet / párový klíč,
bez obalu, když je moc velký). `accountKey(of:)` = klíč účtu z attestace hello peeru (Android ho bere z podpisu zpráv
— tentýž klíč).

## Android → Swift

| Android (`A/`) | Swift |
|---|---|
| `M5.java` (singleton, lock/unlock, lifecycle) | `Core/Engine/AppCore.swift` (+ `Core/CoreInstall.swift` = zapojení z `M5.onCreate` / `MainActivity`) |
| `chat/Rooms.java` | `Core/Engine/RoomsController.swift` (uložené místnosti `rooms`, připojení, zámek → schránka, sloučení, resume, KT) |
| `chat/RoomSession.java` (lepidlo; protokol je M5Proto `RoomCore`) | `Core/Engine/RoomController.swift`, `RoomBridge.swift`, `HubFrameBridge.swift`, `RoomSnapshot.swift` (`peopleScope`, `usersScope`) |
| `chat/Peer`, `chat/Calls` (WebRTC) | `Core/Engine/RoomWire.swift` → `Platform/Calls` `RoomRtc` / `CallSystem` |
| `chat/Files.java` | `Core/Engine/RoomFiles.swift`, `CoreFiles.swift` (trezor `FileVault`, schránka zámku) |
| `chat/History`, `Resume`, `LockedRooms`, `Outgoing` | M5Proto (`History`, `LockedRooms`, `SendPlan`) + `RoomsController` / `RoomController` (záznamy `hist-<hash>`, `resume`, `pins`) |
| `chat/CallWake.java` | M5Proto `Chat/CallWake.swift` + `RoomController` (odesílatel, schránka) |
| `chat/P4Device`, KT, `KeyDirectory` | M5Proto `P4Device` + `AppCore.uploadKeys` / `refreshKt`, záznamy `p4.*` |
| `account/Account.java`, `AccountKeys`, `RecoveryCode` | `Core/Account/AccountService.swift` (`account`, `account-roots`, karta, `/api/profile`, `cardRoot`) |
| `account/Passkeys` (Credential Manager) | `Core/Account/Passkeys.swift` (`ASAuthorization` + PRF), `AccountDialogs.swift` |
| `profile/Profiles.java` | `Core/Account/CoreProfiles.swift` |
| `ui/bubble/MessageAudit.java` | `Core/Engine/MessageAudit.swift` (záznam `msg-audit`) |
| `MainActivity.scopeFor` / `route` | `Core/State/AppScreenState.swift` |
| `ui/Actions.java` + akční polovina `ui/parts/Parts` | `Core/Actions/CoreActions.swift`, `CoreDialogs.swift` |
| `ui/parts/LockPad`, `Forms.enroll`, join, `RoomList`, `RoomTabs`, `CallControls`, `CallVideo` | `Core/Slots/LockPadPart.swift`, `CoreSlots.swift` |
| `push/DeviceStatus`, `$define` | `Core/Engine/DeviceStatus.swift` (`PushDeviceAdapter`, `CoreDeviceService`) |
| lepidlo Security / Telecom / Notify / Location / Voice / Updates | `Core/Engine/SecurityBridge.swift`, `Integrations.swift` |

## Zapojeno / čeká

**Zapojeno**: Security (zámek, schránka zámku, záznamy trezoru, identita v Secure Enclave, design jako jediný zámek),
Push (`DeviceService`: zápis, check-in, `$define`, audit zpráv, aktualizace), Calls (dráty, adresář, prostředí, Záznam,
TURN, zdroj pro historii, buzení při hovoru), Notifications, Location, Contacts (`install`, `continueUserActivity`,
`verifiedDevice`, `wipe`), Voice, NFC (`accountRoot`, `forward`, dostupnost), People (profily, `PeopleRoomExtras`,
`peopleSettling`, audit skrytí, proměnné per okno), Watch (čte `CoreModels.shared` — nic dalšího).

**Švy pro Tools** (`CoreInstall.afterParts`, za částmi v `Bootstrap`): `engine.deviceId` (id zařízení ze zápisu),
`engine.roomId` (`RoomModel.serverId` = slepé id místnosti `r3.…`), `engine.usageStore` (`CoreFnUsage`, záznam
`fn-usage`); `ToolsCallLog.shared.messages` = `CoreCallRooms` (historie i nepřipojených místností z trezoru);
`core.fn?.load()` po změně místností (nejvýš jednou za 15 s) a po změně účtu, `forget()` při zamčení; `Texts.setProvider`
z překladače designu (`AppCore.installTexts`, znovu po `lang.set`); `$voice` z `core.tools.voice`; hlasové prostředí
(`CoreVoiceEnvironment`) zná skupiny účtu. Odpověď modelu je od system-messenger (M5Proto `addModelAnswer`), postup
`{p, text}` — `PreviewCore` dělá totéž.

**Čeká**: chat (zálohy výše), zkouška na zařízení (passkeys
s PRF, VoIP push, NFC na kartě), testy toků účtu proti serveru (WebAuthn bez skutečného autentizátoru nejde — jednotkové
testy jdou přes `FakePasskeys`).

## Změny mimo Core (malé, nutné)

* `Platform/Security/LockPresenter.swift`: s `showsWindows = false` zůstanou okna zámku dole (design je jediný zámek).
* `Platform/Calls/CallCenter.swift`: `pushOwnsCall(roomKey:)` (jeden záznam na hovor s VoIP pushem).
* `Renderer/Contracts/ScreenStateProvider.swift` + `Renderer/Shell/DesignHost.swift`: `variables(for:context:host:)`
  s výchozí implementací (proměnné okna).
* `Parts/People`, `Parts/Tools` (+ jejich testy): `Millis.now` → `EpochMs.now` (přejmenované hodiny jádra — `Millis` je
  typ M5Net); `PeopleReach` bere `RoomModel.peopleSettling`.
* M5Kit (s testy): M5Proto `RoomCore+Local` (místní zprávy), `CallWake`, relay s poli navíc; M5Net `HubRelay` (pole buzení).

## Testy

`M5cetTests/Core`: `CoreChatTests` (dva lidé přes hub v paměti: důkaz, protokol 4, potvrzení, odpověď, relay
nepřítomnému, schránka zámku, historie po restartu, hovory, buzení při hovoru), `CoreStateTests` (vlastníci akcí,
route, proměnné, skladač, kódy), `CoreIntegrationTests` (profil v místnosti, přeposlání ověřené klíčem, audit, proměnné
okna, háčky), `CoreServerIntegrationTests` a `CoreScreenshotTests` (jen s `M5_TEST_SERVER`).
