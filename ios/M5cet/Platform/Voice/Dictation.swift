// Speech to text (6.1 / 6.7) with the phone's recogniser — port of
// android/app/src/main/java/cz/m5cet/app/voice/Dictation.java, driven by the
// same DictationMachine (it keeps listening until stop(); a stop always ends it).
//
// ON THE DEVICE ONLY. M5cet never sends audio to Apple's servers:
//   1. SpeechAnalyzer + SpeechTranscriber (iOS 26) where the language has a model
//      — always on the device;
//   2. SpeechAnalyzer + DictationTranscriber (iOS 26, the keyboard's dictation
//      models — more languages) — on the device;
//   3. SFSpeechRecognizer only when `supportsOnDeviceRecognition` is true, with
//      `requiresOnDeviceRecognition = true` (the request honours that flag only
//      when the recogniser supports it — so a recogniser without on-device
//      support is never used: it would go to the network);
//   4. otherwise "language-not-supported" (fatal for the machine). A language
//      whose model is supported but not downloaded yet is reported as such
//      (`availability` → .needsDownload; `installLanguage` downloads it from
//      Apple on the person's request — only the model comes down, no audio goes up).
// Android picks the on-device recogniser when there is one and otherwise the
// phone's default one (Google's, which may use the network); iOS has no such
// fallback by design — the operator's speech module (voice.engine = server, with
// ServerVoiceConsent) is the way for a language this iPhone cannot do.
//
// Languages: voice.lang or the app's language as a full tag (VoiceSpeech.localeTag:
// en-US, cs-CZ, de-DE, es-ES, it-IT, fr-FR, sk-SK, sl-SI, fi-FI). Which of the 9
// have an on-device model depends on the iOS version and the device; the
// settings screen shows `availability` per language.
//
// recognize() transcribes recorded PCM (voiceToText, a call's audio) the same way.

import AVFoundation
import Foundation
import M5Core
import Speech

// MARK: - choosing the recogniser (pure)

/// What this iPhone can do for a language.
struct RecognizerFacts: Sendable, Equatable {
    var transcriberSupported = false
    var transcriberInstalled = false
    var dictationSupported = false
    var dictationInstalled = false
    /// SFSpeechRecognizer(locale:) exists and supportsOnDeviceRecognition.
    var legacyOnDevice = false
}

enum RecognizerKind: String, Sendable, Equatable {
    /// SpeechAnalyzer + SpeechTranscriber.
    case transcriber
    /// SpeechAnalyzer + DictationTranscriber.
    case dictation
    /// SFSpeechRecognizer with requiresOnDeviceRecognition.
    case legacyOnDevice
}

enum RecognizerPlan: Sendable, Equatable {
    case ready(RecognizerKind)
    /// A model that can be downloaded (the person decides).
    case needsDownload(RecognizerKind)
    case unsupported

    /// The installed model first (SpeechTranscriber, DictationTranscriber, then the legacy on-device
    /// recogniser); a downloadable one next; never a recogniser that would use the network.
    static func choose(_ f: RecognizerFacts) -> RecognizerPlan {
        if f.transcriberSupported && f.transcriberInstalled { return .ready(.transcriber) }
        if f.dictationSupported && f.dictationInstalled { return .ready(.dictation) }
        if f.legacyOnDevice { return .ready(.legacyOnDevice) }
        if f.transcriberSupported { return .needsDownload(.transcriber) }
        if f.dictationSupported { return .needsDownload(.dictation) }
        return .unsupported
    }

    var availability: String {
        switch self {
        case .ready: "ready"
        case .needsDownload: "download"
        case .unsupported: "unsupported"
        }
    }
}

/// The system's answers (the Speech framework; a fake in the tests).
@MainActor
protocol RecognizerSystem: AnyObject {
    func facts(for locale: Locale) async -> RecognizerFacts
    /// Downloads the model of `kind` for the locale (Apple's asset server; no audio is sent).
    func install(_ kind: RecognizerKind, locale: Locale) async throws
    /// A session of `kind` (Speech framework); nil = cannot.
    func session(_ kind: RecognizerKind, locale: Locale, events: any DictationEvents, level: @escaping @Sendable (Float) -> Void) -> (any DictationSession)?
    /// Recorded PCM → text with `kind`; nil when it cannot, "" when it heard nothing.
    func recognize(_ kind: RecognizerKind, pcm: Pcm16, locale: Locale) async -> String?
}

/// The permissions dictation needs (asked only on the person's action).
@MainActor
protocol VoicePermissions: AnyObject {
    var microphone: VoicePermission { get }
    var speech: VoicePermission { get }
    func requestMicrophone() async -> Bool
    func requestSpeech() async -> Bool
}

enum VoicePermission: String, Sendable { case granted, denied, undetermined }

@MainActor
final class SystemVoicePermissions: VoicePermissions {
    var microphone: VoicePermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        default: .undetermined
        }
    }

    var speech: VoicePermission {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: .granted
        case .denied, .restricted: .denied
        default: .undetermined
        }
    }

    func requestMicrophone() async -> Bool { await AVAudioApplication.requestRecordPermission() }

    func requestSpeech() async -> Bool {
        await withCheckedContinuation { k in SFSpeechRecognizer.requestAuthorization { k.resume(returning: $0 == .authorized) } }
    }
}

// MARK: - Dictation

/// What a dictation tells its screen (Android Dictation.Listener).
@MainActor
protocol DictationListener: AnyObject {
    func onPartial(_ text: String)
    func onFinal(_ text: String)
    func onState(listening: Bool)
    func onLevel(_ level: Float)
    func onError(_ code: String)
    /// The dictation is over (stopped, aborted, or given up) — the text is final.
    func onEnded()
}

@MainActor
final class Dictation: DictationMachineListener, DictationEngine {
    private var machine: DictationMachine!
    /// Held until the dictation ends (Android holds its listener too).
    private var listener: (any DictationListener)?
    private var wasListening = false
    private let system: any RecognizerSystem
    private let permissions: any VoicePermissions
    private let session: any VoiceAudioSessionControlling
    /// The language of the next session (VoiceSpeech.localeTag).
    var lang: () -> String
    /// The plan of each language, once asked.
    private var plans: [String: RecognizerPlan] = [:]
    /// The language's model must be downloaded first (the last start failed for that).
    private(set) var needsDownload = false

    init(system: any RecognizerSystem, permissions: any VoicePermissions, session: any VoiceAudioSessionControlling,
         scheduler: any DictationScheduler = MainQueueScheduler(), lang: @escaping () -> String) {
        self.system = system
        self.permissions = permissions
        self.session = session
        self.lang = lang
        machine = DictationMachine(engine: self, scheduler: scheduler, lang: "", listener: self)
    }

    /// Dictating (from start until the text is finished).
    var active: Bool { machine.active }
    var listening: Bool { machine.listening }
    var state: DictationMachine.State { machine.state }

    /// For the settings: what this iPhone can do for the language (asks the system once per language).
    func availability(_ tag: String? = nil) async -> RecognizerPlan {
        let t = tag ?? lang()
        if let p = plans[t] { return p }
        let p = RecognizerPlan.choose(await system.facts(for: Locale(identifier: t)))
        plans[t] = p
        return p
    }

    /// Whether dictation can run at all for the language (Android: SpeechRecognizer.isRecognitionAvailable).
    func available(_ tag: String? = nil) async -> Bool {
        if case .ready = await availability(tag) { return true }
        return false
    }

    /// Downloads the language's model (the person asked for it).
    func installLanguage(_ tag: String? = nil) async throws {
        let t = tag ?? lang()
        guard case .needsDownload(let kind) = await availability(t) else { return }
        try await system.install(kind, locale: Locale(identifier: t))
        plans[t] = nil
        needsDownload = false
    }

    /// Asks for the microphone and speech recognition (on the person's action); true when both are granted.
    func requestPermissions() async -> Bool {
        if permissions.microphone != .granted, !(await permissions.requestMicrophone()) { return false }
        if permissions.speech != .granted, !(await permissions.requestSpeech()) { return false }
        return true
    }

    /// Starts dictation (continuous until stop()); a running one is aborted first.
    func start(_ l: any DictationListener) {
        if machine.active {
            let old = listener
            listener = nil
            machine.abort()
            old?.onEnded()
        }
        listener = l
        wasListening = false
        needsDownload = false
        machine.setLang(lang())
        machine.start()
    }

    /// Stops listening while the app speaks; resume() starts again.
    func pause() { machine.pause() }
    func resume() { machine.resume() }
    /// Stops, the last words still come (then onEnded).
    func stop() { machine.stop() }
    /// Stops at once (unfinished words dropped).
    func abort() { machine.abort() }

    // MARK: DictationMachineListener

    func onText(_ text: String, fin: Bool) {
        if fin { listener?.onFinal(text) } else { listener?.onPartial(text) }
    }

    func onState(_ state: DictationMachine.State) {
        let x = listener
        let on = state == .listening
        if on != wasListening { wasListening = on; x?.onState(listening: on) }
        if state == .idle {
            listener = nil
            x?.onEnded()
        }
    }

    func onError(_ code: String) {
        M5Log.shared.warn("voice", "dictation: \(code)")
        listener?.onError(code)
    }

    // MARK: DictationEngine

    func start(lang: String, events: any DictationEvents) throws -> any DictationSession {
        let s = DictationRun(events: events)
        Task { @MainActor [weak self] in await self?.run(s, lang: lang) }
        return s
    }

    /// One session: the permissions, the call, the plan, then the recogniser.
    private func run(_ s: DictationRun, lang: String) async {
        guard !s.over else { return }
        if permissions.microphone != .granted || permissions.speech != .granted { s.fail("not-allowed"); return }
        if session.callActive { s.fail("audio-capture"); return }
        let plan = await availability(lang)
        guard !s.over else { return }
        switch plan {
        case .unsupported: s.fail("language-not-supported")
        case .needsDownload:
            needsDownload = true
            s.fail("language-not-supported")
        case .ready(let kind):
            do { try session.begin(.dictate) } catch { s.fail("audio-capture"); return }
            let audio = session
            if s.over { audio.end(.dictate); return }
            s.onOver = { audio.end(.dictate) }
            let level: @Sendable (Float) -> Void = { [weak self] v in Task { @MainActor in self?.listener?.onLevel(v) } }
            guard let inner = system.session(kind, locale: Locale(identifier: lang), events: s, level: level) else {
                s.fail("audio-capture")
                return
            }
            s.attach(inner)
        }
    }

    // MARK: recorded audio

    /// Transcribes PCM (16-bit mono) on the device; nil when it cannot, "" when it heard nothing.
    func recognize(_ pcm: Pcm16, lang tag: String? = nil) async -> String? {
        let t = tag ?? lang()
        guard permissions.speech == .granted, case .ready(let kind) = await availability(t) else { return nil }
        return await system.recognize(kind, pcm: pcm, locale: Locale(identifier: t))
    }
}

/// A session handed to the machine at once, while the real one starts (asynchronously) behind it.
@MainActor
final class DictationRun: DictationSession, DictationEvents {
    /// The machine's events of this session (held here, as Android's recogniser holds its listener).
    private var events: (any DictationEvents)?
    private var inner: (any DictationSession)?
    private var stopWanted = false
    private(set) var over = false
    var onOver: (() -> Void)?

    init(events: any DictationEvents) { self.events = events }

    func attach(_ s: any DictationSession) {
        if over { s.abort(); return }
        inner = s
        if stopWanted { s.stop() }
    }

    /// It could not start: the error, then the end.
    func fail(_ code: String) {
        guard !over else { return }
        events?.error(code)
        end()
    }

    func stop() {
        stopWanted = true
        if let inner { inner.stop() } else if !over { end() }
    }

    func abort() {
        let i = inner
        inner = nil
        i?.abort()
        finish()
    }

    private func finish() {
        guard !over else { return }
        over = true
        onOver?()
        onOver = nil
    }

    // Events of the inner session, passed on.
    func ready() { if !over { events?.ready() } }
    func partial(_ text: String?) { if !over { events?.partial(text) } }
    func fin(_ text: String?) { if !over { events?.fin(text) } }
    func error(_ code: String?) { if !over { events?.error(code) } }
    func end() {
        guard !over else { return }
        let e = events
        finish()
        e?.end()
    }
}

// MARK: - the Speech framework

@MainActor
final class SpeechRecognizerSystem: RecognizerSystem {
    func facts(for locale: Locale) async -> RecognizerFacts {
        var f = RecognizerFacts()
        if SpeechTranscriber.isAvailable, let l = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            f.transcriberSupported = true
            f.transcriberInstalled = await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == l.identifier(.bcp47) }
        }
        if let l = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            f.dictationSupported = true
            f.dictationInstalled = await DictationTranscriber.installedLocales.contains { $0.identifier(.bcp47) == l.identifier(.bcp47) }
        }
        if let r = SFSpeechRecognizer(locale: locale) { f.legacyOnDevice = r.supportsOnDeviceRecognition }
        return f
    }

    private func module(_ kind: RecognizerKind, _ locale: Locale, progressive: Bool) -> (any SpeechModule)? {
        switch kind {
        case .transcriber: SpeechTranscriber(locale: locale, preset: progressive ? .progressiveTranscription : .transcription)
        case .dictation: DictationTranscriber(locale: locale, preset: progressive ? .progressiveLongDictation : .longDictation)
        case .legacyOnDevice: nil
        }
    }

    func install(_ kind: RecognizerKind, locale: Locale) async throws {
        guard let m = module(kind, locale, progressive: true) else { return }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [m]) {
            try await request.downloadAndInstall()
        }
    }

    func session(_ kind: RecognizerKind, locale: Locale, events: any DictationEvents, level: @escaping @Sendable (Float) -> Void) -> (any DictationSession)? {
        if kind == .legacyOnDevice {
            guard let r = SFSpeechRecognizer(locale: locale), r.supportsOnDeviceRecognition else { return nil }
            let s = LegacyDictationSession(recognizer: r, events: events, level: level)
            return s.start() ? s : nil
        }
        guard let m = module(kind, locale, progressive: true) else { return nil }
        let s = AnalyzerDictationSession(module: m, events: events, level: level)
        s.start()
        return s
    }

    func recognize(_ kind: RecognizerKind, pcm: Pcm16, locale: Locale) async -> String? {
        if kind == .legacyOnDevice { return await LegacyDictationSession.recognize(pcm, locale: locale) }
        guard let m = module(kind, locale, progressive: false) else { return nil }
        return await AnalyzerDictationSession.recognize(pcm, module: m)
    }
}

/// PCM as one AVAudioPCMBuffer (16-bit mono).
private func pcmBuffer(_ pcm: Pcm16) -> AVAudioPCMBuffer? {
    guard let f = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(pcm.rate), channels: 1, interleaved: true),
          let b = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: AVAudioFrameCount(max(1, pcm.samples.count))) else { return nil }
    b.frameLength = AVAudioFrameCount(pcm.samples.count)
    pcm.samples.withUnsafeBufferPointer { b.int16ChannelData![0].update(from: $0.baseAddress!, count: $0.count) }
    return b
}

/// A buffer converted to another format (nil when it cannot).
private func converted(_ b: AVAudioPCMBuffer, to f: AVAudioFormat) -> AVAudioPCMBuffer? {
    if b.format == f { return b }
    guard let conv = AVAudioConverter(from: b.format, to: f),
          let out = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: AVAudioFrameCount(Double(b.frameLength) * f.sampleRate / b.format.sampleRate + 1024)) else { return nil }
    nonisolated(unsafe) var given = false
    var err: NSError?
    let st = conv.convert(to: out, error: &err) { _, s in
        if given { s.pointee = .endOfStream; return nil }
        given = true
        s.pointee = .haveData
        return b
    }
    return st == .error ? nil : out
}

/// SpeechAnalyzer on the microphone: volatile results are the partial text, final ones the sentences.
@MainActor
final class AnalyzerDictationSession: DictationSession {
    private let module: any SpeechModule
    private weak var events: (any DictationEvents)?
    private let level: @Sendable (Float) -> Void
    private var mic: MicrophoneTap?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzer: SpeechAnalyzer?
    private var task: Task<Void, Never>?
    private var over = false

    init(module: any SpeechModule, events: any DictationEvents, level: @escaping @Sendable (Float) -> Void) {
        self.module = module
        self.events = events
        self.level = level
    }

    func start() {
        task = Task { @MainActor [weak self] in await self?.run() }
    }

    private func run() async {
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else { fail("language-not-supported"); return }
        let (stream, cont) = AsyncStream.makeStream(of: AnalyzerInput.self)
        input = cont
        let analyzer = SpeechAnalyzer(modules: [module])
        self.analyzer = analyzer
        let mic = MicrophoneTap(target: format)
        self.mic = mic
        let level = self.level
        do {
            try await analyzer.prepareToAnalyze(in: format)
            try mic.start { buffer in
                cont.yield(AnalyzerInput(buffer: buffer))
                level(MicrophoneTap.rms(buffer))
            }
            try await analyzer.start(inputSequence: stream)
        } catch {
            fail("audio-capture")
            return
        }
        if over { return }
        events?.ready()
        do {
            try await consume(module)
        } catch {
            if !over { events?.error("client") }
        }
        if !over { over = true; mic.stop(); events?.end() }
    }

    private func consume(_ m: any SpeechModule) async throws {
        if let t = m as? SpeechTranscriber {
            for try await r in t.results { if over { return }; deliver(String(r.text.characters), final: r.isFinal) }
        } else if let d = m as? DictationTranscriber {
            for try await r in d.results { if over { return }; deliver(String(r.text.characters), final: r.isFinal) }
        }
    }

    private func deliver(_ text: String, final: Bool) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if final { events?.fin(t) } else { events?.partial(t) }
    }

    private func fail(_ code: String) {
        guard !over else { return }
        over = true
        mic?.stop()
        input?.finish()
        events?.error(code)
        events?.end()
    }

    /// Stop listening; what was heard is finalised, then the results end (→ end()).
    func stop() {
        guard !over else { return }
        mic?.stop()
        input?.finish()
        let a = analyzer
        Task { try? await a?.finalizeAndFinishThroughEndOfInput() }
    }

    func abort() {
        guard !over else { return }
        over = true
        mic?.stop()
        input?.finish()
        let a = analyzer
        Task { await a?.cancelAndFinishNow() }
        task?.cancel()
    }

    /// Recorded PCM → text (the final results joined).
    static func recognize(_ pcm: Pcm16, module: any SpeechModule) async -> String? {
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]),
              let source = pcmBuffer(pcm), let buffer = converted(source, to: format) else { return nil }
        let (stream, cont) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [module])
        let collect = Task { () -> [String] in
            var out = [String]()
            if let t = module as? SpeechTranscriber {
                for try await r in t.results where r.isFinal { out.append(String(r.text.characters)) }
            } else if let d = module as? DictationTranscriber {
                for try await r in d.results where r.isFinal { out.append(String(r.text.characters)) }
            }
            return out
        }
        do {
            try await analyzer.start(inputSequence: stream)
            cont.yield(AnalyzerInput(buffer: buffer))
            cont.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            let parts = try await collect.value
            return parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
        } catch {
            collect.cancel()
            return nil
        }
    }
}

/// SFSpeechRecognizer on the device only (requiresOnDeviceRecognition): it ends after a pause (one final
/// result), and the machine starts the next session — as Android's recogniser does.
@MainActor
final class LegacyDictationSession: DictationSession {
    private let recognizer: SFSpeechRecognizer
    private weak var events: (any DictationEvents)?
    private let level: @Sendable (Float) -> Void
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private var mic: MicrophoneTap?
    private var over = false

    init(recognizer: SFSpeechRecognizer, events: any DictationEvents, level: @escaping @Sendable (Float) -> Void) {
        self.recognizer = recognizer
        self.events = events
        self.level = level
    }

    /// The request for this recogniser: on the device only (never the network), partial results.
    nonisolated static func configure(_ r: SFSpeechRecognitionRequest) {
        r.requiresOnDeviceRecognition = true
        r.shouldReportPartialResults = true
        r.addsPunctuation = true
        r.taskHint = .dictation
    }

    func start() -> Bool {
        Self.configure(request)
        guard recognizer.supportsOnDeviceRecognition, request.requiresOnDeviceRecognition else { return false }
        // SFSpeechAudioBufferRecognitionRequest.append may be called from any thread (the audio thread here).
        let request = VoiceUncheckedBox(self.request)
        let mic = MicrophoneTap(target: AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!)
        self.mic = mic
        let level = self.level
        do {
            try mic.start { buffer in
                request.value.append(buffer)
                level(MicrophoneTap.rms(buffer))
            }
        } catch { return false }
        let ref = WeakSession(self)
        task = Self.task(recognizer, request.value) { text, final, code in
            DispatchQueue.main.async { MainActor.assumeIsolated { ref.session?.handle(text: text, final: final, code: code) } }
        }
        DispatchQueue.main.async { MainActor.assumeIsolated { if let s = ref.session, !s.over { s.events?.ready() } } }
        return true
    }

    private final class WeakSession: @unchecked Sendable {
        weak var session: LegacyDictationSession?
        init(_ s: LegacyDictationSession) { session = s }
    }

    /// The recognition task, its handler made outside the main actor (the recogniser calls it on its queue).
    nonisolated private static func task(_ r: SFSpeechRecognizer, _ request: SFSpeechRecognitionRequest,
                                         _ handler: @escaping @Sendable (String?, Bool, String?) -> Void) -> SFSpeechRecognitionTask {
        r.recognitionTask(with: request) { result, error in
            handler(result?.bestTranscription.formattedString, result?.isFinal ?? false, error.map { errorCode($0) })
        }
    }

    private func handle(text: String?, final: Bool, code: String?) {
        guard !over else { return }
        if let code {
            over = true
            mic?.stop()
            events?.error(code)
            events?.end()
            return
        }
        if final {
            over = true
            mic?.stop()
            events?.fin(text)
            events?.end()
        } else {
            events?.partial(text)
        }
    }

    func stop() {
        guard !over else { return }
        mic?.stop()
        request.endAudio()
    }

    func abort() {
        guard !over else { return }
        over = true
        mic?.stop()
        task?.cancel()
    }

    /// The recogniser's errors as the web's codes (DictationMachine.fatal decides).
    nonisolated static func errorCode(_ e: any Error) -> String {
        let n = e as NSError
        if n.domain == "kAFAssistantErrorDomain" {
            switch n.code {
            case 1110: return "no-speech"            // no speech detected
            case 216, 301: return "aborted"           // cancelled
            case 1700: return "not-allowed"           // not authorised
            case 1101, 1107: return "busy"
            default: return "error-\(n.code)"
            }
        }
        if n.domain == SFSpeechErrorDomain { return "error-\(n.code)" }
        return "client"
    }

    /// Recorded PCM → text, on the device.
    nonisolated static func recognize(_ pcm: Pcm16, locale: Locale) async -> String? {
        guard let r = SFSpeechRecognizer(locale: locale), r.supportsOnDeviceRecognition, let buffer = pcmBuffer(pcm),
              let f = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(pcm.rate), channels: 1, interleaved: false),
              let floats = converted(buffer, to: f) else { return nil }
        let request = SFSpeechAudioBufferRecognitionRequest()
        configure(request)
        request.shouldReportPartialResults = false
        request.append(floats)
        request.endAudio()
        return await withCheckedContinuation { (k: CheckedContinuation<String?, Never>) in
            let once = OnceBox()
            _ = r.recognitionTask(with: request) { result, error in
                if let result, result.isFinal { if once.take() { k.resume(returning: result.bestTranscription.formattedString) } }
                else if let error {
                    if once.take() { k.resume(returning: errorCode(error) == "no-speech" ? "" : nil) }
                }
            }
        }
    }
}

/// A value handed to another thread whose type does not say it may be (the API documents it may).
final class VoiceUncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// A flag that is taken once (thread-safe).
final class OnceBox: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func take() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
}
