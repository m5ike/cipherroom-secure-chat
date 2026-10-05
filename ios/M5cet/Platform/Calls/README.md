# Platform/Calls — WebRTC, CallKit, PushKit (6.14)

Port `A/rtc/Rtc`, `A/chat/{Peer, Calls, CallTrack, CallHistory, ActivityLog}`, WebRTC částí `A/chat/RoomSession`
(peery, signály, datový kanál, `audio-status`, statistiky), `A/contacts/RtcStats`, `A/telecom/{CallRing,
CallLogBridge, M5ConnectionService}`, `A/ui/CallService` a `A/ui/parts/{CallParts, CallLogUi}`
(`A/` = `android/app/src/main/java/cz/m5cet/app/`), s chováním webu (`client/src/App.tsx`, `client/src/lib/rtc.ts`).
UI je v `M5cet/Parts/Calls`, testy v `M5cetTests/Calls`.

| Android | iOS |
|---|---|
| `rtc/Rtc` (továrna, ICE z `/api/turn`, `pending`) | `RtcEngine` + `IceConfig` / `IceConfigCache` |
| `chat/Peer` (spojení, kanál „m5cet“, perfect negotiation) | `RtcPeer` (+ `RtcPeerObserver`, `RtcSerialQueue`) |
| `chat/Calls` + WebRTC části `RoomSession` | `RoomRtc` (jedna na místnost) |
| `chat/CallTrack`, `chat/CallHistory`, `chat/ActivityLog` | `CallTrack`, `CallHistory`, `CallHistoryStore` — **z M5Proto** (jediná implementace; `CallTrack` je tu jen alias téhož typu pro soubory bez `import M5Proto`) — + `AppCallHistory` (adaptér na hlavním aktoru), `CallLogItems` |
| `contacts/RtcStats` | `RtcStats` (`RtcStatsSummary.parse`) |
| `telecom/CallRing` (zvonění upozorněním) | **CallKit**: `CallCenter` (tok) + `CallKitBridge` (`CXProvider`, `CXCallController`) |
| `telecom/CallLogBridge` (systémový záznam hovorů) | `includesCallsInRecents` = nastavení `callLog`, jméno položky `CallNaming` |
| `telecom/M5ConnectionService` (odmítá každé spojení) | není potřeba — hovory místností jdou přes CallKit |
| `ui/CallService` (služba v popředí) | režimy pozadí `voip` + `audio`, `CallAudioSession` |
| FCM (žádné push hovory) | **PushKit** VoIP push → `VoIPPushHandler` → `CallCenter.reportVoIP` |
| `ui/parts/CallParts`, `CallLogUi` | `Parts/Calls/{CallScreen, CallControls, RtcVideoView, CallHistoryView, CallPresentation}` |

## Návrh

```
 room session (M5Kit + lepidlo v aplikaci)          Platform/Calls                         systém
 ─────────────────────────────────────────    ─────────────────────────────    ──────────────────────
 hub: joined / peer-joined / peer-left  ───▶  RoomRtc.addPeer / removePeer      RTCPeerConnection ×N
 hub: signal (Envelopes.openSignal)     ───▶  RoomRtc.receiveSignal ──▶ RtcPeer  (mesh, unified plan)
 RoomRtcLink.sendSignal (sealSignal)    ◀───  RtcPeer: offer/answer/candidate
 onPeerText / files.onBinary            ◀───  RoomRtcLink.received(frame)        datový kanál "m5cet"
 sendHello, flushOutbox                 ◀───  RoomRtcLink.channelOpened
 audio-status (zapečetěné jako zpráva)  ◀──▶  RoomRtcLink.broadcastAudioStatus / RoomRtc.peerAudioStatus
                                              RoomRtc ── CallTrack ──▶ AppCallHistory (trezor "calls")
                                                  │ zvoní / ring over / změna
                                                  ▼
 tlačítka (CallSystem.startCall…)       ───▶  CallCenter ◀──▶ CallKitProvider / CallKitController ◀──▶ CallKit
 PushKit (AppDelegate.PushKitBridge)    ───▶  VoIPPushHandler ──▶ CallCenter.reportVoIP (synchronně)
```

* **Hovory místností nezvoní po síti** (jako Android a web): hovor = zapnutý zvuk v místnosti. Stopy se přidají do
  existujících spojení (perfect negotiation přejedná) a `audio-status` ostatním řekne `live` / `muted` / `off`.
  Cizí `live` je ohlášení — `CallTrack` z toho udělá zvonění a jeden záznam na hovor (odchozí, příchozí, zmeškaný,
  odmítnutý; 20 s milost pro výpadek spojení). Délka = můj čas v hovoru. Hovor neskončí odchodem ostatních (parita).
* **Jeden CallKit hovor na místnost** (`CallCenter`), ať je v ní kolik lidí chce. Zvoní, když `CallTrack` řekne
  „zvoní“, místnost není na obrazovce a nastavení oznámení hovory dovolí (vypínač „Hovory“, tiché hodiny). Max. 2
  skupiny po 1 hovoru (druhá místnost může zvonit jako „čekající hovor“).
  * Přijmout → zvuk místnosti; je-li aplikace zamčená nebo místnost nepřipojená: místnost se připojí a přidá se,
    až je aplikace odemčená a někdo v hovoru je (Android `CallRing.tick`: 3 min, po připojení 20 s ticha → konec).
  * Odmítnout (End při zvonění) → `CallTrack.decline` (odmítnutý). Zvonění bez odpovědi 60 s → `.unanswered`;
    volající zavěsil dřív → `.remoteEnded`; obojí pak zmeškaný hovor. Stejný hovor nezvoní podruhé.
  * Odchozí: tlačítko aplikace → `CXStartCallAction` → zvuk místnosti; „spojeno“ (`connectedAt`), jakmile je v hovoru
    někdo další. Zavěšení aplikací i CallKitem; místnost, která odejde / spadne, hovor ukončí (`.remoteEnded`).
  * Ztlumit → stopa místnosti; Podržet (jiný hovor) → můj mikrofon i ostatní potichu, ostatním `muted`.
  * **CallKit odmítne transakci** (simulátor; region, kde CallKit nesmí být) → hovor běží bez něj („direct“):
    aplikace si zvukovou relaci aktivuje sama (`CallAudioSession.activateDirectly`).
* **Zvuk**: WebRTC s ručním zvukem (`RTCAudioSession.useManualAudio`) — audio unit běží jen v hovoru, který
  aktivoval CallKit (`provider(_:didActivate:)`). `.playAndRecord` + `.voiceChat` (`.videoChat` u videa),
  Bluetooth HFP. Reproduktor podle `calls.speaker` (výchozí zapnuto), video vždy reproduktor; připojená sluchátka,
  Bluetooth, auto nebo AirPlay se nepřebíjí (obrazovka hovoru pak ukáže systémový výběr výstupu).
* **Kamera**: `RTCCameraVideoCapturer`, přední, nejbližší formát k 1280×720, 30 fps; vypnutí kamery = vypnutá stopa
  (černé snímky, bez přejednání — jako web), přepnutí přední/zadní.
* **ICE**: `/api/turn` přes `TurnFetching`; odpověď `pending` (STUN, dokud hub nevidí připojenou místnost) se
  **nikdy necachuje**, `RoomRtc.roomJoined()` → `hubConnected()` zahodí i STUN náhradu; plná odpověď platí `ttl − 60 s`
  (jinak 10 min); selhání se zkusí znovu po 30 s (Android drží záložní STUN 10 min); bez odpovědi veřejný STUN.
  **Skrýt mou IP** (`hideIp`, web 6.12 F-15): `iceTransportPolicy = relay`, jen když server nabízí TURN.
* **Šifrování médií**: DTLS-SRTP mezi zařízeními (parita s Androidem). Prohlížečové šifrování snímků („media“ v hello,
  klíče protokolu 4) aplikace **neohlašuje** — použité WebRTC (stasel 150.0.0 = Google M150) nemá `RTCFrameCryptor`.
  Háček: `MediaFrameProtection` (`RtcEngine.frameProtection`) — sestavení s frame cryptorem (např. fork webrtc-sdk)
  ho implementuje; teprve pak smí room session ohlásit „media“.
* **Jména a soukromí** (`CallNaming`): CallKit ukáže jedno jméno; s „Recents“ zapnutými (`callLog`) ho iOS uloží
  do Nedávných aplikace Telefon (a může je synchronizovat na další zařízení), proto pak platí jméno položky jako na
  Androidu (`calls.logName`: jen aplikace / aplikace · místnost / lidé · místnost). Bez Recents podle úrovně soukromí
  oznámení (0 aplikace, 1 člověk, 2 člověk · místnost). Zamčená aplikace = vždy jen jméno aplikace. **Handle nikdy
  není místnost**: `m5cet-` + 16 hex HMAC-SHA256(sůl instalace, klíč místnosti); zavolání z Nedávných se mapuje zpět
  jen na uloženou místnost a **před vytočením se aplikace zeptá** (jako Záznam na Androidu).
* **Historie** (`AppCallHistory` nad `CallHistoryStore` z M5Proto): stejný JSON jako Android, bajt po bajtu (pořadí klíčů Androidu; čte se tolerantně jako org.json) (`{"c":[{id,key,room,kind,at,sec,video,people,sys?}]}`)
  v uživatelské vrstvě trezoru, záznam `calls`, max. 500 / 90 dní; zamčený trezor → v paměti, sloučí se po odemčení;
  `calls.history` vypnuto → nic; wipe → nic už se neukládá. Řádky v Nedávných aplikace smazat nemůže (iOS to nedovolí).
* **Vlákna**: delegáti WebRTC běží na jeho signálním vlákně; `RtcPeerObserver` z každého callbacku udělá hodnotu
  a pošle ji v pořadí na hlavní frontu (FIFO); vše ostatní je `@MainActor`. Delegát datového kanálu se nastaví hned na
  signálním vlákně, takže se neztratí ani první zpráva. Signály jednoho peeru jdou za sebou (`RtcSerialQueue`) —
  kandidát nepředběhne svou nabídku, spojení se vytvoří až po získání ICE serverů.

## Co implementuje room session (a další oblasti)

Room session (M5Kit `M5Proto`/`M5Net`) WebRTC nezná; lepidlo v aplikaci propojí její `RoomSession` s `RoomRtc`:

```swift
// místnost se připojuje
let rtc = CallSystem.shared.attach(roomKey: key, label: label, link: adapter)   // adapter: RoomRtcLink
// hub
case "joined":      rtc.roomJoined(); for p in peers { rtc.addPeer(id: p.peerId, name: p.name, initiator: true) }
case "peer-joined": /* jen jméno do pendingNames; nový člen nabízí sám */
case "peer-updated": rtc.renamePeer(id:, name:)
case "peer-left":   rtc.removePeer(id:)
case "signal":      let d = Envelopes.openSignal(...)          // {p4:"fk"} je věc souborů, ne RTC
                    if let s = RtcSignal(json: d) { rtc.receiveSignal(s, from: source, name: pendingName) }
// datový kanál
rtc.send(.text(json), to: peerId) / rtc.send(.binary(chunk), to: peerId)   // false = kanál není otevřený (outbox)
await rtc.waitForBuffer(of: peerId)                                         // soubory: > 1 MiB v bufferu čekat
rtc.openPeerIds, rtc.isOpen(peerId)
// zpráva kind "audio-status" od peeru
rtc.peerAudioStatus(status, from: peerId)
// odchod / zámek / wipe
CallSystem.shared.detach(roomKey: key)            // zaznamená otevřený hovor (CallTrack.flush) a vše zavře
```

`RoomRtcLink` (adapter room session → volá ho `RoomRtc`, na hlavním aktoru, v pořadí):

| metoda | room session udělá |
|---|---|
| `rtc(_:sendSignal:to:)` | `Envelopes.sealSignal` → `{type:"signal", target, payload:{sealed}}` (`RtcSignal.json` = `{type,sdp}` / `{candidate,sdpMid,sdpMLineIndex}`) |
| `rtc(_:channelOpenedWith:)` | `sendHello` (caps **bez** „media“), `flushOutbox` — RoomRtc pak ohlásí `audio-status` |
| `rtc(_:channelClosedWith:)` | stav peeru, outbox |
| `rtc(_:received:from:)` | `.text` → `onPeerText`, `.binary` → `files.onBinary` |
| `rtc(_:broadcastAudioStatus:)` | `{kind:"audio-status", id:"aud-…", createdAt, senderId, senderName, status}` zapečetěné jako zpráva všem |

Další rozhraní (`CallContracts.swift`, `IceConfig.swift`, `CallHistory.swift`):

| rozhraní | kdo | co |
|---|---|---|
| `TurnFetching` | síť (M5Net) | `GET /api/turn` → tělo JSON (`IceTurnAnswer`; M5Net má vlastní `TurnAnswer` / `IceServerCache` — sjednotit je úkol do budoucna); `CallSystem.shared.turnSource = …` |
| `CallRoomDirectory` | seznam místností / navigace | `connect(roomKey:)` (VoIP push, přijetí), `isOnScreen`, `open`, `label(ofRoom:)`, `savedRoomKeys()`; `CallSystem.shared.directory = …` |
| `CallEnvironment` | nastavení + design + zámek | `CallSettings` (`calls.speaker`, `callLog`, `calls.logName`, `calls.history`, `hideIp`), `CallPrivacy` (zámek, úroveň soukromí hovorů 0–2, smí zvonit, jméno aplikace), texty designu; `CallSystem.shared.setEnvironment(…)`, po změně `settingsChanged()` |
| `CallHistoryVault` | Platform/Security | trezor, uživatelská vrstva, záznam `calls`: `isUnlocked`, `readCalls`, `writeCalls`, `deleteCalls`; `CallSystem.shared.history.vault = …` |
| `VoIPPayloadOpening` | Platform/Push | otevře VoIP push (podpis serveru, ECIES, deduplikace, expirace) → `VoIPCallInvite`; `CallSystem.shared.voip.opener = …` |
| `CallLogMessageSource` | room session | uložené místnosti a jejich zprávy pro Záznam (nic se nekopíruje) |
| `MediaFrameProtection` | (budoucí sestavení WebRTC) | šifrování snímků — vypnuto |
| `CallCenter.onMissed` | Platform/Notifications | tiché „Zmeškaný hovor“ v rámci úrovně soukromí |
| `VoIPPushHandler.onToken` / `AppModel.voipToken` | síť | VoIP token (hex) do `enroll` / `checkin` (`/api/ios`, pole `voipToken`) |
| `CallSystem.continueUserActivity` | App (scéna) | `INStartCallIntent` z Nedávných → otázka a hovor |

### VoIP push (server + Platform/Push)

Server o hovorech neví (ohlášení je zapečetěný `audio-status` v datovém kanálu). Aby iOS zařízení **mimo aplikaci**
zazvonilo, musí volající room session poslat nepřítomným členům relayovou položku označenou jako hovor a server
z ní udělat VoIP push na iOS zařízení (topic `cz.m5cet.app.voip`). Payload jako řídicí zprávy FCM
(`{"m5":{i,e,iv,ct,s}}`, podpis `m5push/1|deviceId|i|e|iv|ct`, ECIES s klíčem zařízení), obsah:

```json
{"id":"…","kind":"call","exp":1760000060000,"payload":{"room":"<klíč místnosti>","who":"Alice","video":false,"at":1760000000000}}
```

`kind` `"call-end"` = hovor skončil před přijetím. **Každý** VoIP push se nahlásí CallKitu dřív, než handler vrátí:
neotevřitelný → neutrální hovor („M5cet“) hned ukončený (`.failed`); zastaralý (> 60 s), `call-end`, zakázané zvonění
nebo už odmítnutý hovor → nahlásit a hned ukončit; hovor, který CallKit už má → nahlásit znovu tentýž UUID. Server by
proto neměl posílat VoIP push zařízení, jehož uživatel má hovory v oznámeních vypnuté (krátce by se ukázal).
Dokončení PushKitu se zavolá po odpovědi CallKitu, nejpozději po 3 s. Po pushi se místnost připojí (`connect`); když do
30 s nikoho v hovoru neukáže, zvonění skončí (`.remoteEnded`) a Záznam dostane zmeškaný hovor (jen pokud ho místnost
neviděla — jinak ho zaznamená `CallTrack`, jeden záznam na hovor).

### Spuštění a UI

* `App/Bootstrap.swift`: `CallSystem.shared.install(into: model)` → `model.voip` (PushKit se registruje jen s ním).
* Tlačítka (akce designu `call.audio`, `call.video`, `call.end`, `call.mute`, `call.speaker`, `call.camera`,
  `call.switchCamera`): `CallSystem.shared.startCall(roomKey:video:)` (nejdřív oprávnění mikrofonu / kamery),
  `endCall`, `toggleMute`, `toggleSpeaker`, `room.toggleCamera()`, `room.switchCamera()`.
* `Parts/Calls`: `CallScreen` (dlaždice všech v hovoru — video nebo iniciály, ztlumení, stav spojení; můj obraz v rohu;
  místnost, délka, RTT a P2P/TURN; ovládání), `CallHistoryView` (Záznam: filtry, hledání bez diakritiky, dny, opětovné
  zavolání po potvrzení, smazání historie), `.callPresentation()` na kořeni aplikace (obrazovka hovoru, otázka před
  zavoláním z Nedávných). iPad (regular width): až 4 sloupce, větší náhled, ovládání v liště, užší seznam Záznamu.
  Texty jsou z designu (`CallEnvironment.text`), s angličtinou výchozího designu jako zálohou (`CallTexts`).

## Testy (`M5cetTests/Calls`, 79)

`CallTrackTests` (11, = Android), `CallHistoryTests` (7), `CallLogItemsTests` (9, = Android ActivityLogTest),
`CallNamingTests` (5, = Android CallLogBridgeTest + soukromí + handle), `IceConfigTests` (8: `pending` se necachuje,
životnost, hub, souběžné dotazy, relay jen s TURN, konfigurace = Android), `RtcWireTests` (4: signály webu a Androidu,
rámce), `RtcStatsTests` (6, = Android), `CallCenterTests` (22: zvonění → přijetí / odmítnutí / zmeškaný / zavěšení
volajícího, odchozí → spojeno → zavěšení, ztlumení a podržení, odmítnutí CallKitem, reset, soukromí, VoIP push —
neotevřitelný, s místností, skončený, odmítnutý, opakovaný, zastaralý, zamčená aplikace — a token),
**`RtcLoopbackTests` (3: skutečné WebRTC M150 v simulátoru** — dvě místnosti, kanál, text i binární rámce v pořadí,
hovor s přejednáním z obou stran naráz (glare), statistiky, ztlumení, zavěšení, zvonění), `CallKitSimulatorTests` (2:
skutečný CallKit simulátoru), `CallScreenshotTests` (2: obrazovka hovoru a Záznam na iPhonu a v šířce iPadu; snímky
jako přílohy, s `TEST_RUNNER_M5_SNAPSHOT_DIR=<dir>` i do složky).

## Omezení

* **Simulátor**: CallKit nepodepsané aplikaci transakci odmítne (`requesttransaction` chyba 1) → hovory běží
  „direct“; `reportNewIncomingCall` na simulátoru neodpoví vůbec (proto pojistka dokončení PushKitu). Simulátor nemá
  kameru ani VoIP push. Ověřeno jen na simulátoru — **nativní obrazovka CallKitu, zvonění z VoIP pushe, zámek
  obrazovky, Bluetooth / sluchátka, kamera a skutečný zvuk čekají na test na zařízení** (podepsané sestavení s týmem).
* VoIP push vyžaduje změnu serveru a room session (výše) — dokud není, zvoní iOS jen s aplikací v popředí (hub připojený).
* CallKit nesmí být v aplikacích pro čínský App Store — distribuce tam by potřebovala vypnout CallKit i PushKit.
* Kamera na pozadí: iOS ji při odchodu aplikace do pozadí zastaví (zvuk běží dál); obraz v obraze pro videohovory
  (`AVPictureInPictureVideoCallViewController`) zatím není.
* Hovory „hlas ↔ text“ (Android 6.1 `voice/CallAudio`: přepis zvuku peerů, řeč do hovoru) nejsou — patří Platform/Voice;
  `RtcPeer.remoteAudio` je k dispozici.
* Systémový záznam hovorů: iOS ho aplikacím číst ani mazat nedovolí — „Odebrat hovory ze záznamu telefonu“ nemá
  obdobu; Nedávné se vypínají jen pro nové hovory.
