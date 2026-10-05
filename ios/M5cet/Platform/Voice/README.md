# Platform/Voice — diktování, předčítání, hlasové zprávy

Port `A/voice/*` kromě `CallAudio` (ten je v `Platform/Calls`); `A/` = `android/app/src/main/java/cz/m5cet/app/`.

| Android | iOS |
|---|---|
| `Voice`, `Speech`, `Dictation`, `DictationMachine` | Speech (`SFSpeechRecognizer`, na zařízení kde to jde), `NSSpeechRecognitionUsageDescription` |
| `SpeakSend` (předčítání) | `AVSpeechSynthesizer` |
| `Audio` (nahrávání hlasových zpráv) | `AVAudioRecorder` / `AVAudioEngine`, `NSMicrophoneUsageDescription` |
| `VoiceFx`, `MicFx`, `FxGate`, `FxTest` | efekty přes `AVAudioEngine` (stejné parametry jako Android) |
| `ServerVoiceConsent` | stejný souhlas, logika v `M5Kit` |
