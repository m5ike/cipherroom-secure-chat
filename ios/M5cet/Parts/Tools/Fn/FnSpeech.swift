// The server's speech — a port of android/…/fn/SpeechApi.java (the
// server-side part of client/src/lib/speech.ts; server/ai/routes.ts): which
// voices and transcription models this user may use, text to speech, speech to
// text. The web sends these without the account; here they carry it, so the
// account's groups decide. The Voice service (Platform/Voice) calls these when
// the voice settings choose the server's speech — never without the person's
// consent (ServerVoiceConsent).

import Foundation
import M5Core
import M5Proto

struct FnSpeech: Sendable {
    /// A voice or a transcription model: its id (the connector) and label.
    struct Connector: Sendable, Equatable {
        let id: String
        let label: String
    }

    struct Status: Sendable, Equatable {
        let tts: Bool
        let voices: [Connector]
        let stt: Bool
        let transcribers: [Connector]
    }

    static let none = Status(tts: false, voices: [], stt: false, transcribers: [])

    /// Synthesised speech: the bytes and their type (audio/mpeg unless the server says otherwise).
    struct Audio: Sendable, Equatable {
        let bytes: Data
        let mime: String
    }

    let api: FnApi

    /// GET /api/speech/status; a failure is "nothing".
    func status(bearer: String) async -> Status {
        guard case .success(let j) = await api.json("/api/speech/status", bearer: bearer) else { return Self.none }
        let t = j.object("tts"), s = j.object("stt")
        return Status(tts: t?["enabled"] == .bool(true), voices: Self.connectors(t), stt: s?["enabled"] == .bool(true), transcribers: Self.connectors(s))
    }

    private static func connectors(_ o: JSONObject?) -> [Connector] {
        (o?.array("connectors") ?? []).compactMap { $0.objectValue }.compactMap { c in
            guard let id = c.string("id") else { return nil }
            return Connector(id: id, label: c.string("label") ?? id)
        }
    }

    /// POST /api/speech/tts { text, connector?, voice? } (nil: the server's choice).
    func tts(bearer: String, text: String, connector: String?, voice: String?) async -> Result<Audio, FnFailure> {
        var body = JSONObject([("text", .string(text))])
        if let connector { body["connector"] = .string(connector) }
        if let voice { body["voice"] = .string(voice) }
        switch await api.json("/api/speech/tts", bearer: bearer, body: body) {
        case .failure(let f): return .failure(f)
        case .success(let j):
            let b64 = j.string("audioBase64") ?? ""
            if b64.isEmpty { return .failure(FnFailure(200, "", "HTTP 200")) }
            guard let bytes = Data(base64Encoded: b64) else { return .failure(FnFailure(200, "bad-answer", "not base64 audio")) }
            let mime = j.string("mime").flatMap { $0.isEmpty ? nil : $0 } ?? "audio/mpeg"
            return .success(Audio(bytes: bytes, mime: mime))
        }
    }

    /// POST /api/speech/stt: 16 kHz mono 16-bit WAV in (as the web sends it), the transcript out.
    func stt(bearer: String, wav: Data, connector: String?) async -> Result<String, FnFailure> {
        var path = "/api/speech/stt"
        if let connector, !connector.isEmpty { path += "?connector=" + FnCommandsClient.encode(connector) }
        // Transcription takes its time: two minutes before giving up.
        switch await api.call("POST", path, bearer: bearer, body: wav, contentType: "audio/wav", timeout: 120) {
        case .failure(let f): return .failure(f)
        case .success(let j): return .success(j.string("text") ?? "")
        }
    }
}
