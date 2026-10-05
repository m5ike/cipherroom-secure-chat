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
* `ScreenVariables`: `register(screen, name) { DesignValue }` — proměnné obrazovek, které patří částem.
* `ToolsModel`: `nfcAvailable`, `voiceAvailable`, `aiAvailable`, `voice` (`$voice`), `toolsScope` (`$tools`).

### Co registrují části samy (UI part handles it)

Akce, jejichž stav drží pohled, si části registrují v `AppActionRouter` (`model.design.actions.register([...]) { action, ctx in … }`)
jedním řádkem v `App/Bootstrap.swift` (`XxxParts.install(into: model)`):

| Agent | Akce | Proměnné (`core.variables`) |
|---|---|---|
| chat | `msg.quote`, `msg.showHidden`, `msg.mapPreview`, `msg.map`, `msg.source`, `msg.open`, `msg.save`, `msg.share` | — |
| people | `people.*` (11), `users.toggle`, `users.dock`, `users.autoHide`, `msg.info` (MsgDetails), `msg.sender` (ProfileUi.sender), `profile.open/pick/clear/field/sync/save/public/audience`; `router.shownUsername` | `settings.profile`/`profile`, `settings`/`myProfile`, `users.person` přes `$form.person` |
| tools | `ai.send/stop/clear`, `nfc.read/write/emulate/stop`, `voice.dictate`, `calllog.*` (6), `voiceFx.test/reset` | `ai`/`ai`, `nfc`/`nfc`, `log`/`log`, `settings.voiceFx`/`voiceFx` |

Jádro je registruje taky — jako zálohu, která udělá jen to, co jde bez části (nebo zaloguje), a pozdější registrace části ji
nahradí (router: pozdější vyhrává). Seznam s pokrytím všech 122 akcí je v § Akce.

### Sloty

Jádro registruje: `lockPad`, `enrollForm`, `joinForm`, `roomList`, `roomTabs`, `callControls`, `callVideo`.
Části: `messages`, `msgBody`, `msgHold`, `composer` (chat), `userPanel`, `userList` (people), `voicePad`, `nfcPanel`,
`nfcWork`, `nfcBuilder`, `aiChat` (tools).
