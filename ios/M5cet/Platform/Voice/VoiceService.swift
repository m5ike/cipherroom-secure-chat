// The voice module (6.1 / 6.7) — port of
// android/app/src/main/java/cz/m5cet/app/voice/Voice.java: speech, dictation and
// the conversions between them, all following the voice settings (voice.*):
//
//  - dictate(): the words go into the composer as they come; with
//    voice.dictateSpeak the finished sentence is read back — listening pauses
//    while it is read and comes back afterwards;
//  - speakIncoming(): voice.autoplay reads new messages of the room on screen
//    (dictation pauses for it too);
//  - textToVoiceMessage(): a text as a voice message (the phone's voice into
//    AAC, or the server's speech module when voice.engine = server — after
//    ServerVoiceConsent);
//  - voiceToText() / serverVoiceToText(): recorded PCM as text;
//  - the voice message recorder and player, the voice changer (MicFx + FxGate)
//    and its test.
// Dictation stops for real (DictationMachine) and is reported to every screen
// that shows it (addStateListener); when the app goes to the background
// dictation stops and whoever holds the microphone is told (addBackgroundListener)
// — nothing listens behind the user's back.
//
// Install once: `VoiceService.shared.install(into: model)` (scene phase) and set
// `settings`, `environment`, `server`, `configFetcher` (VoiceContracts.swift).

import AVFoundation
import Foundation
import M5Core
import Observation

/// Where dictated text goes (the composer).
@MainActor
protocol VoiceSink: AnyObject {
    func onText(_ text: String, done: Bool)
    /// The dictation is over; what came is final.
    func onEnded()
}

/// Settings until the app's are wired (and in tests): Android's defaults.
@MainActor
final class DefaultVoiceSettings: VoiceSettings {
    var values: [String: JSON] = [
        "voice.engine": "device", "voice.lang": "", "voice.voice": "", "voice.rate": 1.0, "voice.pitch": 1.0,
        "voice.autoplay": false, "voice.dictateSpeak": false, "voice.dictateSend": false,
    ]
    var appLanguage = "en"

    init() { for (k, v) in MicFx.defaults { values[k] = v } }

    func string(_ key: String) -> String { values[key]?.stringValue ?? "" }
    func number(_ key: String) -> Double { values[key]?.doubleValue ?? 0 }
    func bool(_ key: String) -> Bool { values[key]?.boolValue ?? false }
    func value(_ key: String) -> JSON? { values[key] }
}

@MainActor
@Observable
final class VoiceService {
    static let shared = VoiceService()

    // MARK: parts

    @ObservationIgnored private(set) var settings: any VoiceSettings
    @ObservationIgnored let session: any VoiceAudioSessionControlling
    @ObservationIgnored let speech: VoiceSpeech
    @ObservationIgnored let dictation: Dictation
    @ObservationIgnored let recorder: VoiceRecorder
    @ObservationIgnored let player: VoicePlayer
    @ObservationIgnored let fxTest: FxTest
    @ObservationIgnored let gate = FxGateLoader()
    @ObservationIgnored var environment: (any VoiceEnvironment)?
    @ObservationIgnored var server: (any VoiceSpeechServer)?

    /// GET /api/client-config for the voice changer's gate.
    var configFetcher: (any ClientConfigFetching)? {
        get { gate.fetcher }
        set { gate.fetcher = newValue }
    }

    // MARK: state the screens show

    private(set) var dictating = false
    private(set) var listening = false
    private(set) var speaking = false

    @ObservationIgnored private var sink: (any VoiceSink)?
    @ObservationIgnored private var stateListeners: [(id: Int, run: () -> Void)] = []
    @ObservationIgnored private var backgroundListeners: [(id: Int, run: () -> Void)] = []
    @ObservationIgnored private var nextListener = 0
    @ObservationIgnored private var lastError = ""

    init(settings: any VoiceSettings = DefaultVoiceSettings(), session: any VoiceAudioSessionControlling = VoiceAudioSession.shared,
         recognizers: any RecognizerSystem = SpeechRecognizerSystem(), permissions: any VoicePermissions = SystemVoicePermissions(),
         scheduler: any DictationScheduler = MainQueueScheduler(), fxIO: (any FxTestIO)? = nil) {
        self.settings = settings
        self.session = session
        speech = VoiceSpeech(settings: settings, session: session)
        let s = settings
        dictation = Dictation(system: recognizers, permissions: permissions, session: session, scheduler: scheduler,
                              lang: { VoiceSpeech.localeTag(setting: s.string("voice.lang"), appLanguage: s.appLanguage) })
        recorder = VoiceRecorder(session: session)
        player = VoicePlayer(session: session)
        fxTest = FxTest(io: fxIO ?? DeviceFxTestIO(recorder: recorder, session: session), scheduler: scheduler)
        speech.onStateChange = { [weak self] in self?.changed() }
        fxTest.onChange = { [weak self] in self?.changed() }
        gate.onChange = { [weak self] in self?.recomputeFx(); self?.changed() }
        if let real = session as? VoiceAudioSession {
            real.onInterruption = { [weak self] in self?.background() }
        }
    }

    /// The app's settings (the integration's Settings, read live).
    func setSettings(_ s: any VoiceSettings) {
        settings = s
        speech.settings = s
        dictation.lang = { VoiceSpeech.localeTag(setting: s.string("voice.lang"), appLanguage: s.appLanguage) }
        recomputeFx()
    }

    /// Scene phases: the background stops dictation and tells the recorders (AppModel.onScenePhase).
    func install(into model: AppModel) {
        model.onScenePhase { [weak self] phase in if phase == .background { self?.background() } }
        recomputeFx()
    }

    /// 6.7: several screens follow the voice (the composer, the voice pad). Returns a token for removal.
    @discardableResult
    func addStateListener(_ r: @escaping () -> Void) -> Int {
        nextListener += 1
        stateListeners.append((nextListener, r))
        return nextListener
    }

    func removeStateListener(_ token: Int) { stateListeners.removeAll { $0.id == token } }

    /// Told when the app goes to the background (a recording drops the microphone).
    @discardableResult
    func addBackgroundListener(_ r: @escaping () -> Void) -> Int {
        nextListener += 1
        backgroundListeners.append((nextListener, r))
        return nextListener
    }

    func removeBackgroundListener(_ token: Int) { backgroundListeners.removeAll { $0.id == token } }

    private func changed() {
        dictating = dictation.active
        listening = dictation.listening
        speaking = speech.speaking
        for l in stateListeners { l.run() }
    }

    /// The app went to the background (or an interruption began).
    func background() {
        if dictation.active { stopDictation() }
        if fxTest.state != .idle { fxTest.stop() }
        if recorder.recording { recorder.stop() }
        for l in backgroundListeners { l.run() }
    }

    /// The app locked: the server-voice consents are forgotten (ServerVoiceConsent), playback stops.
    func forgetSecrets() {
        ServerVoiceConsent.reset()
        player.stop()
        background()
    }

    // MARK: dictation

    /// Starts dictation into the sink (partial text, then each finished sentence, then onEnded).
    func dictate(_ s: any VoiceSink) {
        sink = s
        dictation.start(DictationBridge(service: self, sink: s))
        changed()
    }

    /// The bridge from Dictation's listener to the sink (Android's anonymous Dictation.Listener).
    private final class DictationBridge: DictationListener {
        weak var service: VoiceService?
        let sink: any VoiceSink
        init(service: VoiceService, sink: any VoiceSink) { self.service = service; self.sink = sink }

        func onPartial(_ text: String) { if service?.sink === sink { sink.onText(text, done: false) } }
        func onFinal(_ text: String) {
            guard let service, service.sink === sink else { return }
            sink.onText(text, done: true)
            if service.settings.bool("voice.dictateSpeak") { service.say(text) }
        }
        func onState(listening: Bool) { service?.changed() }
        func onLevel(_ level: Float) {}
        func onError(_ code: String) { service?.lastError = code; service?.changed() }
        func onEnded() {
            if service?.sink === sink { service?.sink = nil }
            sink.onEnded()
            service?.changed()
        }
    }

    /// The last dictation error code (the screen says it in words), "" after it was read. iOS adds
    /// "language-not-installed" when the language's model must be downloaded first.
    func takeDictationError() -> String {
        var e = lastError
        if e == "language-not-supported" && dictation.needsDownload { e = "language-not-installed" }
        lastError = ""
        return e
    }

    /// Stops dictation; the last words still come into the sink (then onEnded).
    func stopDictation() { dictation.stop(); changed() }

    /// Stops dictation at once (nothing more comes).
    func abortDictation() { dictation.abort(); changed() }

    // MARK: speaking

    /// Speaks; an active dictation stops listening meanwhile and resumes after.
    func say(_ text: String) {
        let resume = dictation.active
        if resume { dictation.pause() }
        speech.speak(text) { [weak self] _ in
            if resume { self?.dictation.resume() }
            self?.changed()
        }
        changed()
    }

    func stopSpeaking() { speech.stop(); dictation.resume() }

    /// voice.autoplay: a new message in the room on screen is read aloud.
    func speakIncoming(sender: String?, text: String?) {
        guard settings.bool("voice.autoplay"), let text, !text.javaTrimmed.isEmpty else { return }
        say((sender ?? "").isEmpty ? text : sender! + ": " + text)
    }

    /// The voices for the settings ($voices).
    func voices() -> [JSONObject] {
        speech.text = { [weak self] k in self?.environment?.text(k) ?? (k == "voice.defaultVoice" ? "Default voice" : k) }
        return speech.voices()
    }

    /// $voice of the voice screens: {dictating, listening, speaking, available}.
    func scope(available: Bool) -> JSONObject {
        JSONObject([("dictating", .bool(dictation.active)), ("listening", .bool(dictation.listening)), ("speaking", .bool(speech.speaking)),
                    ("available", .bool(available))])
    }

    // MARK: conversions

    /// A text spoken into a voice message: the phone's voice (AAC, nothing leaves the phone) or —
    /// voice.engine = server — the operator's speech module (the server sees the text). Errors (Android's):
    /// "tts-none", "tts-server-off", "tts-failed: …", "declined" (the person said no to the provider).
    func textToVoiceMessage(_ text: String, room: String, ask: ServerVoiceConsent.Ask?) async -> (clip: VoiceClip?, error: String?) {
        if settings.string("voice.engine") == "server" { return await serverVoiceMessage(text, room: room, ask: ask) }
        return await deviceVoiceMessage(text)
    }

    private func deviceVoiceMessage(_ text: String) async -> (clip: VoiceClip?, error: String?) {
        guard let pcm = await speech.synthesize(text) else {
            return (nil, AVSpeechSynthesisVoice.speechVoices().isEmpty ? "tts-none" : "tts-failed")
        }
        do { return (try Self.speechClip(pcm), nil) } catch { return (nil, "tts-failed: \(error)") }
    }

    /// Synthesized speech as a voice message: at most 24 kHz (Android's wavClip), AAC.
    nonisolated static func speechClip(_ pcm: Pcm16) throws -> VoiceClip {
        guard pcm.samples.count >= 1 else { throw AudioPCMError.noSpeech }
        let mono = pcm.rate > 24_000 ? AudioPCM.resample(pcm, to: 24_000) : pcm
        return try VoiceClipCodec.clip(mono)
    }

    private func serverVoiceMessage(_ text: String, room: String, ask: ServerVoiceConsent.Ask?) async -> (clip: VoiceClip?, error: String?) {
        guard let server, !(environment?.server ?? "").isEmpty else { return (nil, "tts-server-off") }
        let status = await server.status()
        guard status.tts, let voice = status.voices.first else { return (nil, "tts-server-off") }
        // 6.12 (G-14): before the text leaves — who reads it, asked once per room.
        let yes = await withCheckedContinuation { k in
            ServerVoiceConsent.check(room, .speak, provider: voice.label, ask: ask) { k.resume(returning: $0) }
        }
        guard yes else { return (nil, "declined") }
        do {
            let audio = try await server.tts(text: text, connector: voice.id, voice: nil)
            if SpeakSendErrors.isWav([UInt8](audio.bytes.prefix(12))) {
                return (try Self.speechClip(try AudioPCM.readWav(audio.bytes)), nil)
            }
            return (VoiceClip(bytes: audio.bytes, mime: audio.mime, durationMs: 0, pcm: nil), nil)
        } catch {
            return (nil, "tts-failed: \(error)")
        }
    }

    /// Recorded PCM → text (the phone's recogniser, on the device); error "recogniser" when it cannot.
    func voiceToText(_ pcm: Pcm16) async -> (text: String?, error: String?) {
        guard let text = await dictation.recognize(pcm) else { return (nil, "recogniser") }
        return (text, nil)
    }

    /// 6.7: recorded PCM → text by the operator's speech module (voice.engine = server). 6.12 (G-14): the
    /// recording leaves only after the person agreed in this room (the transcriber named); "declined" otherwise.
    func serverVoiceToText(_ pcm: Pcm16, room: String, ask: ServerVoiceConsent.Ask?) async -> (text: String?, error: String?) {
        let base = environment?.server ?? ""
        guard let server, !base.isEmpty else { return (nil, "stt-server-off") }
        let status = await server.status()
        let provider = status.transcribers.first?.label ?? base
        let yes = await withCheckedContinuation { k in
            ServerVoiceConsent.check(room, .transcribe, provider: provider, ask: ask) { k.resume(returning: $0) }
        }
        guard yes else { return (nil, "declined") }
        let wav = AudioPCM.wavBytes(pcm.rate == AudioPCM.rate ? pcm.samples : AudioPCM.resample(pcm.samples, from: pcm.rate, to: AudioPCM.rate), rate: AudioPCM.rate)
        do { return (try await server.stt(wav: wav, connector: nil), nil) } catch { return (nil, "stt-failed: \(error)") }
    }

    // MARK: the voice changer

    /// Works the voice changer's parameters out again (a voiceFx.* setting or the gate changed).
    func recomputeFx() {
        let groups = FxGate.groups(signedIn: environment?.signedIn ?? false, accountGroups: environment?.accountGroups ?? [])
        let allowed = gate.allowed(server: environment?.server ?? "", groups: groups)
        let s = settings
        MicFx.recompute(switchOn: s.bool("voiceFx.on"), gateAllows: allowed, settings: { s.value($0) })
    }

    /// The settings screen opened: ask the gate again at once; $voiceFx.
    func voiceFxScope() -> JSONObject {
        let groups = FxGate.groups(signedIn: environment?.signedIn ?? false, accountGroups: environment?.accountGroups ?? [])
        gate.refresh(server: environment?.server ?? "", groups: groups)
        recomputeFx()
        return fxTest.scope(allowed: gate.allowed(server: environment?.server ?? "", groups: groups))
    }

    /// Settings › Voice changer › Reset: the custom values back to the defaults (the caller writes them).
    nonisolated static func customDefaults() -> [(String, JSON)] { MicFx.defaults.filter { $0.0 != "voiceFx.on" && $0.0 != "voiceFx.preset" } }

    // MARK: recording a voice message

    /// Starts recording a voice message (the composer's microphone).
    func startRecording() -> Bool {
        recomputeFx()
        let ok = recorder.start()
        changed()
        return ok
    }

    /// Stops it; the voice message as AAC (nil when nothing was recorded).
    func finishRecording() -> VoiceClip? {
        let pcm = recorder.stop()
        changed()
        guard pcm.samples.count >= AudioPCM.rate / 10 else { return nil }
        return try? VoiceClipCodec.clip(pcm)
    }

    /// Stops and drops it (the composer went away, the app went to the background).
    func dropRecording() {
        _ = recorder.stop()
        changed()
    }
}
