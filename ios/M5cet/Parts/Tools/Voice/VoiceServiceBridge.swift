// The tools on the real voice (Platform/Voice's VoiceService, merged in 6.14):
//
//  - VoiceServiceToolsVoice — ToolsVoice over VoiceService.shared: dictation (the
//    microphone and speech permissions asked on the person's tap), reading aloud,
//    the voices, the voice changer's test and its reset;
//  - the service's integration points this part owns the network of: the
//    operator's speech module (VoiceSpeechServer over FnSpeech, the account's
//    bearer — Android fn/SpeechApi) and the voice changer's gate
//    (ClientConfigFetching: GET /api/client-config);
//  - until the core wires its own: the voice settings read live from the design's
//    settings (VoiceSettings) and the server / account / words (VoiceEnvironment).
// ToolParts.install(into:) sets only what is still unset — whoever wires the
// service with more knowledge (the core) wins.

import AVFoundation
import Foundation
import M5Core
import M5Design
import M5Proto
import Observation

@MainActor
@Observable
final class VoiceServiceToolsVoice: ToolsVoice {
    @ObservationIgnored let service: VoiceService
    /// Dictation has a recognizer on this device for the voice's language (asked again when it changes).
    private(set) var available = false

    init(_ service: VoiceService = .shared) {
        self.service = service
        refreshAvailability()
    }

    /// Dictation.available for the voice's language now (voice.lang changed, the app's language changed).
    func refreshAvailability() {
        let d = service.dictation
        Task { @MainActor [weak self] in
            let ok = await d.available()
            self?.available = ok
        }
    }

    var dictating: Bool { service.dictating }
    var listening: Bool { service.listening }
    var speaking: Bool { service.speaking }

    func dictate(_ sink: @escaping @MainActor (String, Bool) -> Void) async -> Bool {
        guard await service.dictation.requestPermissions() else { return false }
        service.dictate(Sink(sink))
        return true
    }

    func stopDictation() { service.stopDictation() }
    func say(_ text: String) { service.say(text) }
    func stopSpeaking() { service.stopSpeaking() }

    func voices() async -> [DesignValue] { service.voices().map { DesignValue($0) } }

    // The voice changer.
    var fxScope: DesignValue { DesignValue(service.voiceFxScope()) }
    var fxAllowed: Bool { fxScope["allowed"].boolValue ?? false }
    var fxActive: Bool { MicFx.active }
    var fxTesting: String { service.fxTest.state.rawValue }

    func fxToggleTest() {
        if service.fxTest.state != .idle { service.fxTest.toggle(); return }
        let test = service.fxTest
        Task { @MainActor in
            // FxTest records: the microphone first (Android: RECORD_AUDIO, or ask).
            guard await AVAudioApplication.requestRecordPermission() else { return }
            test.toggle()
        }
    }

    func fxResetCustom() -> [(String, DesignValue)] {
        VoiceService.customDefaults().map { ($0.0, DesignValue(json: $0.1)) }
    }

    /// Dictated words into the pad (VoiceSink).
    private final class Sink: VoiceSink {
        let f: @MainActor (String, Bool) -> Void
        init(_ f: @escaping @MainActor (String, Bool) -> Void) { self.f = f }
        func onText(_ text: String, done: Bool) { f(text, done) }
        func onEnded() {}
    }
}

/// The operator's speech module with the account's bearer (VoiceSpeechServer over FnSpeech).
final class ToolsSpeechServer: VoiceSpeechServer, @unchecked Sendable {
    private let transport: any FnTransport
    private let server: @MainActor @Sendable () -> String
    private let bearer: @MainActor @Sendable () async -> String

    init(transport: any FnTransport, server: @escaping @MainActor @Sendable () -> String, bearer: @escaping @MainActor @Sendable () async -> String) {
        self.transport = transport
        self.server = server
        self.bearer = bearer
    }

    private func speech() async -> (FnSpeech, String) {
        let base = await server()
        let b = await bearer()
        return (FnSpeech(api: FnApi(base: base, transport: transport)), b)
    }

    func status() async -> SpeechServerStatus {
        let (s, b) = await speech()
        let st = await s.status(bearer: b)
        return SpeechServerStatus(tts: st.tts, voices: st.voices.map { .init(id: $0.id, label: $0.label) },
                                  stt: st.stt, transcribers: st.transcribers.map { .init(id: $0.id, label: $0.label) })
    }

    func tts(text: String, connector: String?, voice: String?) async throws -> (bytes: Data, mime: String) {
        let (s, b) = await speech()
        switch await s.tts(bearer: b, text: text, connector: connector, voice: voice) {
        case .success(let a): return (a.bytes, a.mime)
        case .failure(let f): throw f
        }
    }

    func stt(wav: Data, connector: String?) async throws -> String {
        let (s, b) = await speech()
        switch await s.stt(bearer: b, wav: wav, connector: connector) {
        case .success(let t): return t
        case .failure(let f): throw f
        }
    }
}

/// GET /api/client-config (the voice changer's gate).
final class ToolsClientConfigFetcher: ClientConfigFetching, @unchecked Sendable {
    private let transport: any FnTransport

    init(transport: any FnTransport) { self.transport = transport }

    func clientConfig(server: String) async throws -> JSONObject {
        switch await FnApi(base: server, transport: transport).json("/api/client-config", bearer: "") {
        case .success(let o): return o
        case .failure(let f): throw f
        }
    }
}

/// The voice settings as the design's settings hold them (read live), the app's language.
@MainActor
final class DesignVoiceSettings: VoiceSettings {
    private weak var services: DesignServices?

    init(_ services: DesignServices) { self.services = services }

    private func get(_ key: String) -> DesignValue? { services?.settings.get(key) }

    func string(_ key: String) -> String { get(key)?.stringValue ?? "" }
    func number(_ key: String) -> Double { get(key)?.numberValue ?? 0 }
    func bool(_ key: String) -> Bool { get(key)?.boolValue ?? false }
    func value(_ key: String) -> JSON? { get(key).map(\.json) }
    var appLanguage: String { services?.lang ?? "en" }
}

/// The enrolled server, the account and the design's words (until the core gives its own).
@MainActor
final class ToolsVoiceEnvironment: VoiceEnvironment {
    private weak var services: DesignServices?

    init(_ services: DesignServices) { self.services = services }

    var server: String { CoreModels.shared.server }
    var signedIn: Bool { CoreModels.shared.account.signedIn }
    /// The account's groups are the core's to know (AccountModel has none yet): the gate then counts "user".
    var accountGroups: [String] { [] }

    func text(_ key: String) -> String? {
        guard let services else { return nil }
        let s = Translator(design: services.design, lang: services.lang).t(key)
        return s.isEmpty || s == key ? nil : s
    }
}
