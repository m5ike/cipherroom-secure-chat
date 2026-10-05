# Platform/Voice — diktování, předčítání, hlasové zprávy, měnič hlasu, hlas ↔ text v hovorech (6.14)

Port `A/voice/*` (`A/` = `android/app/src/main/java/cz/m5cet/app/`), **včetně `CallAudio`** (hovory „hlas ↔ text“ a
měnič hlasu v hovorech — `Platform/Calls` je k tomu jen zapojí). Testy v `M5cetTests/Voice`.

| Android | iOS |
|---|---|
| `Voice` (modul: diktát, předčítání, text → hlasová zpráva, hlas → text, pozadí) | `VoiceService` (fasáda, `@MainActor @Observable`) |
| `Speech` (TextToSpeech, jazyk/hlas/rychlost/výška z `voice.*`) | `VoiceSpeech` (`AVSpeechSynthesizer`; `write` pro PCM) |
| `Dictation` (rozpoznávač, na zařízení kde to jde) | `Dictation` + `SpeechRecognizerSystem` (`SpeechAnalyzer` + `SpeechTranscriber` / `DictationTranscriber`, záloha `SFSpeechRecognizer` **jen** s `supportsOnDeviceRecognition` a `requiresOnDeviceRecognition = true`) |
| `DictationMachine` (čistý stavový automat) | `DictationMachine` (1:1, Androidí testy) |
| `SpeakSend`, `ServerVoiceConsent` | totéž (čisté, Androidí testy) |
| `Audio` (záznam 16 kHz, WAV, převzorkování, AAC) | `AudioPCM` (čisté) + `VoiceRecorder` / `RecordingBuffer` / `MicrophoneTap` (`AVAudioEngine`) + `VoiceClipCodec` (AAC/MP4) |
| `VoiceFx`, `MicFx`, `FxGate` | totéž (DSP 1:1 v `Double`, fixture `test/fixtures/voice-fx.json`) + `FxGateLoader` (`/api/client-config`) |
| `FxTest` (4 s nahrát → přehrát) | `FxTest` + `DeviceFxTestIO` |
| `CallAudio` (řeč do hovoru, přepis peerů) | `CallVoiceBridge` + `CallVoiceTaps` + `UtteranceCutter` (`CallAudio.swift`) + **`CallVoiceAudioDevice`** (vlastní `RTCAudioDevice`) |
| `ui/media/AudioBar` (přehrávač v bublině) | `VoicePlayer` (jeden najednou; UI je v Parts) |
| — | `VoiceAudioSession` (kategorie relace mimo hovor; v hovoru ji vlastní CallKit) |

## Formát hlasové zprávy (interop)

**Odesílání = přesně Androidí formát**: PCM 16 kHz mono (syntetizovaný hlas 24 kHz) → **AAC-LC, 48 kbit/s (konstantní),
MPEG-4**, MIME `audio/mp4`, název `hlas-<ms>.m4a` (`VoiceClip.fileName`). AVFoundation ho kóduje nativně; web ho hraje
(`<audio>` s AAC v MP4 umí Chrome, Edge, Safari i Firefox; `validate.ts` `audio/mp4` pouští; Safari sám takto
nahrává), Android ho sám nahrává. Ověřeno: soubor iOS kodéru (+ `Mp4Compact`) přečte `ffprobe` jako
`aac LC 16000 Hz mono 47977 b/s` a `ffmpeg` dekóduje přesně 3,000 s; Androidí MP4 (ffmpeg AAC v MP4) iOS dekóduje a
`AVAudioPlayer` přehraje. `Mp4Compact` odstraní ~23 kB výplně `free`, kterou zapisuje ExtAudioFile (pro krátkou
zprávu víc než zvuk; rozhoduje o vložení vs. přenosu souboru), a posune `stco`/`co64`.

**Příjem**: AAC/MP4 (Android, Safari), MP3/WAV (hlasy serveru) hraje AVFoundation přímo; **WebM s Opusem** (Chrome,
Edge, Firefox — první volba `MediaRecorder` webu) a **Ogg s Opusem** AVFoundation neotevře → `OpusContainers`
(EBML demuxer včetně „live“ souborů MediaRecorderu s neznámou velikostí Segmentu i Clusteru a všech lacingů; Ogg
stránky a granule) + Opus dekodér AudioToolboxu (`kAudioFormatOpus`, na zařízení) → WAV 24 kHz pro `AVAudioPlayer`.
Nic se nepřekódovává pro ostatní — interop se nemění.

## Řeč na text jen na zařízení

Pořadí (`RecognizerPlan.choose`): nainstalovaný `SpeechTranscriber` → nainstalovaný `DictationTranscriber` →
`SFSpeechRecognizer` jen se `supportsOnDeviceRecognition` (požadavek s `requiresOnDeviceRecognition = true`; Apple
ten příznak ctí jen tehdy — proto se rozpoznávač bez podpory na zařízení nepoužije nikdy) → model ke stažení
(`.needsDownload`: `Dictation.installLanguage()` stáhne na žádost uživatele jen model, žádný zvuk) → jinak
`language-not-supported`. Jazyk = `voice.lang` nebo jazyk aplikace jako plný tag (en-US, cs-CZ, de-DE, es-ES, it-IT,
fr-FR, sk-SK, sl-SI, fi-FI). Android bere při chybějícím modelu na zařízení výchozí (síťový) rozpoznávač; iOS ne —
pro takový jazyk je cesta modul řeči serveru (`voice.engine = server`, se `ServerVoiceConsent`).
Chyba „model ke stažení“ se composeru hlásí jako `language-not-installed` (`takeDictationError`).

## Hovory: hlas ↔ text a měnič hlasu

iOS WebRTC (stasel M150, Google ObjC SDK) nemá sink na vzdálené stopě ani háček na zachycený zvuk (Android:
`AudioTrackSink`, `JavaAudioDeviceModule`). Má ale **vlastní audio zařízení** (`RTCAudioDevice`): `CallVoiceAudioDevice`
běží na `VoiceProcessingIO` (potlačení ozvěny), 16 bit mono 48 kHz, a každý buffer pošle přes `CallVoiceTaps`:
mikrofon → měnič hlasu (MicFx) nebo v režimu hlas ↔ text syntetizovaná řeč místo mikrofonu; přehrávání → dělení na
promluvy (700 ms ticha, max 15 s, min 300 ms) → přepis na zařízení → zpráva peeru („🎙 …“ přidá room session), zdroj
v trezoru jako AAC. Spouští se, jen když WebRTC chce a `RTCAudioSession` smí hrát (s ručním zvukem = až po aktivaci
CallKitem), takže relaci dál vlastní CallKit. Ověřeno skutečným WebRTC v simulátoru (`CallVoiceDeviceTests`: tón
projde Opusem a SRTP, robot ho přemění, řeč nahradí mikrofon a vrátí se jako promluva).

**Zapojení (Platform/Calls, `RtcEngine.factory` — jejich soubor):**
`RTCPeerConnectionFactory(encoderFactory: …, decoderFactory: …, audioDevice: CallVoiceAudioDevice.shared)`.
Bez toho hovory jedou na vestavěném zařízení WebRTC jako dosud, jen bez měniče hlasu a bez hlas ↔ text
(`CallVoiceBridge.shared.available == false`).

Přehrávání v hovoru je **směs** všech; kdo mluvil, určí `CallVoicePeers` podle přírůstku `totalAudioEnergy`
(inbound-rtp statistiky, `RoomRtcVoicePeers`) — přesné s jedním protějškem, odhad při souběžné řeči.

## API pro integraci

```swift
let voice = VoiceService.shared
voice.setSettings(<VoiceSettings>)        // voice.*, voiceFx.* (JSON), appLanguage
voice.environment = <VoiceEnvironment>    // server, signedIn, accountGroups, text(key)
voice.server = <VoiceSpeechServer>        // /api/speech/status|tts|stt s bearerem účtu (Android fn/SpeechApi)
voice.configFetcher = <ClientConfigFetching>  // GET /api/client-config (brána měniče hlasu)
voice.install(into: model)                // pozadí → diktát stop, nahrávání pryč (posluchači)
voice.forgetSecrets()                     // zámek: souhlasy se serverem zapomenuty, přehrávání stop
// composer / obrazovky
voice.dictate(sink); voice.stopDictation(); voice.takeDictationError()
await voice.dictation.requestPermissions(); await voice.dictation.availability(); try await voice.dictation.installLanguage()
voice.say(text); voice.speakIncoming(sender:text:); voice.voices(); voice.scope(available:)
voice.startRecording(); voice.finishRecording() -> VoiceClip?; voice.dropRecording()
await voice.textToVoiceMessage(text, room:, ask:); await voice.voiceToText(pcm); await voice.serverVoiceToText(pcm, room:, ask:)
try voice.player.play(id:data:mime:)      // bublina; VoiceClipCodec.decode/playable pro cizí formáty
voice.fxTest.toggle(); voice.voiceFxScope(); voice.recomputeFx()
// hovory
CallVoiceBridge.shared.vault = FileVaultVoiceSources(files: <FileVault>)   // Platform/Files
CallVoiceBridge.shared.start(peers: RoomRtcVoicePeers(room: rtc)) { peerId, text, sourceId in /* room.addTranscript */ }
await CallVoiceBridge.shared.say(text)    // moje zpráva do hovoru → id zdroje
CallVoiceBridge.shared.stop()
```

## Oprávnění a relace

Mikrofon a rozpoznávání řeči se ptají jen na akci uživatele (`Dictation.requestPermissions`, nahrávání). Mimo hovor:
přehrávání/řeč `.playback` + `.spokenAudio` (ztlumí ostatní), nahrávání/diktát `.playAndRecord` (reproduktor,
Bluetooth HFP), deaktivace s `notifyOthersOnDeactivation` po poslední akci. V hovoru se relace nemění; nahrávání a
diktát se nespustí (mikrofon má hovor — `audio-capture`).

## Rozdíly a omezení vs. Android

* `DictationMachine` hlásí chybu, která diktát ukončí, **před** přechodem do IDLE (Android po něm — jeho `Dictation`
  už nemá posluchače, takže composer chybu jako „not-allowed“ nikdy neukázal). Androidí testy procházejí.
* `CallAudio.onCapture` na Androidu porovnává čítač snímků zařízení s délkou řeči — 24 kHz hlas na 48 kHz zařízení
  usekne v půlce; iOS rozhoduje podle pozice v řeči (test v `CallVoiceDeviceTests`).
* Diktát v jazyce bez modelu na zařízení nejde (Android by použil síťový rozpoznávač); ke stažení na žádost.
* Přepis v hovoru přiřazuje mluvčího odhadem při více lidech (směs přehrávání).
* Info.plist: `NSSpeechRecognitionUsageDescription` mluví o diktátu a hlasových příkazech — v hovoru hlas ↔ text se
  přepisuje i řeč ostatních; text by to měl říct (koordinátor).
* Ověřeno v simulátoru (falešné rozpoznávače, skutečné WebRTC se syntetickým zařízením, kodeky na souborech
  ffmpeg/libopus); skutečný mikrofon, `VoiceProcessingIO` s CallKitem, modely Speech a hlasy čekají na zařízení.
