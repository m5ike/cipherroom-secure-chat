// What the integration provides to Platform/Voice (besides VoiceSettings in
// VoiceSpeech.swift and ClientConfigFetching in FxGate.swift):
//
//  - VoiceEnvironment: the enrolled server, the account (signed in, groups — the
//    voice changer's gate), the design's words;
//  - VoiceSpeechServer: the operator's speech module (Android fn/SpeechApi:
//    GET /api/speech/status, POST /api/speech/tts, POST /api/speech/stt with the
//    account's bearer) — used only with voice.engine = server and only after
//    ServerVoiceConsent;
//  - VoiceSourceVault: where a call transcript's recording is kept (Android
//    FileVault "src-…"), Platform/Security's encrypted files.

import Foundation
import M5Core

@MainActor
protocol VoiceEnvironment: AnyObject {
    /// The enrolled server's base URL ("" when none).
    var server: String { get }
    var signedIn: Bool { get }
    /// The account's groups (the server's summary), for the voice changer's gate.
    var accountGroups: [String] { get }
    /// A design string, nil when the design has none.
    func text(_ key: String) -> String?
}

/// GET /api/speech/status: what the operator's speech module offers this user.
struct SpeechServerStatus: Sendable, Equatable {
    struct Connector: Sendable, Equatable {
        var id: String
        var label: String
    }

    var tts = false
    var voices: [Connector] = []
    var stt = false
    var transcribers: [Connector] = []

    static let none = SpeechServerStatus()

    /// The server's JSON ({tts:{enabled, connectors:[{id,label}]}, stt:{…}}) as Android's SpeechApi reads it.
    static func parse(_ j: JSONObject) -> SpeechServerStatus {
        func connectors(_ o: JSONObject?) -> [Connector] {
            (o?.array("connectors") ?? []).compactMap { c in
                guard let c = c.objectValue, let id = c.string("id") else { return nil }
                return Connector(id: id, label: c.string("label") ?? id)
            }
        }
        let t = j.object("tts"), s = j.object("stt")
        return SpeechServerStatus(tts: t?.bool("enabled") == true, voices: connectors(t), stt: s?.bool("enabled") == true, transcribers: connectors(s))
    }
}

/// The operator's speech module (the integration's HTTP client with the account's bearer).
protocol VoiceSpeechServer: AnyObject, Sendable {
    /// GET /api/speech/status; a failure is `.none`.
    func status() async -> SpeechServerStatus
    /// POST /api/speech/tts {text, connector?, voice?} → the audio ({audioBase64, mime}; mime defaults to audio/mpeg).
    func tts(text: String, connector: String?, voice: String?) async throws -> (bytes: Data, mime: String)
    /// POST /api/speech/stt (?connector=…): a 16 kHz mono 16-bit WAV in, the transcript out (2 min timeout).
    func stt(wav: Data, connector: String?) async throws -> String
}

/// Encrypted files of the vault (Platform/Security): a call transcript's recording.
protocol VoiceSourceVault: AnyObject, Sendable {
    /// Keeps `bytes` under `id` (Android FileVault.Writer); throws when the vault is locked.
    func store(id: String, bytes: Data) throws
}
