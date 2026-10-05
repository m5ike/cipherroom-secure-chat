# Platform/Calls — WebRTC, CallKit, PushKit

Port `A/rtc/*`, `A/telecom/{CallRing, CallLogBridge, M5ConnectionService}`, `A/ui/CallService` a
`A/voice/CallAudio` (`A/` = `android/app/src/main/java/cz/m5cet/app/`); signalizace a stav hovoru bez UI jsou
v `M5Kit/M5Proto` + `M5Net`, UI hovoru v `Parts`.

| Android | iOS |
|---|---|
| `rtc/Rtc` (peer connections, datový kanál „m5cet“, hovory) | **WebRTC** — SPM `https://github.com/stasel/WebRTC` přesně **150.0.0** (nezměněný Google WebRTC M150 = milník Androidu `io.github.webrtc-sdk:android:150.7871.01`; BSD-3-Clause), `import WebRTC`, třídy `RTC*` |
| `telecom/CallRing` (zvonění, Přijmout / Odmítnout) | **CallKit** `CXProvider` (nativní obrazovka hovoru), VoIP push přes **PushKit** |
| `telecom/M5ConnectionService`, `CallLogBridge` | `CXProviderConfiguration.includesCallsInRecents` = volba „zapisovat do Nedávných“ (Android „záznam hovorů“); čtení záznamu hovorů iOS nedovolí |
| `ui/CallService` (služba v popředí) | režim pozadí `audio` + `voip` (Info.plist), `AVAudioSession` `.playAndRecord` / `.voiceChat` |
| `voice/CallAudio` | směrování zvuku (`AVAudioSession`, `AVRoutePickerView`) |

PushKit se registruje jen tehdy, když je nainstalován `AppModel.voip: VoIPPushHandling` (`App/AppHooks.swift`):
iOS ukončí aplikaci, která **každý** VoIP push synchronně nenahlásí CallKitu (`reportNewIncomingCall`) před `completion`.
Instalace při startu: `App/Bootstrap.swift` (`model.voip = …`).
