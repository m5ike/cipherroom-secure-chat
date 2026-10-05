// The voice changer on the phone (6.7) — port of
// android/app/src/main/java/cz/m5cet/app/voice/MicFx.java: the one place the
// app's microphone passes before the audio goes on — voice messages, the "speak
// it, send text" recording and the voice changer's test (VoiceRecorder), and
// calls (CallVoiceAudioDevice's capture → CallVoiceBridge.processCapture → a
// Stream here). On only when the operator's module allows it (FxGate) AND the
// user switched it on (voiceFx.on); the preset or custom values (voiceFx.*) are
// VoiceFx's. The Speech framework's dictation listens to the microphone itself
// and only gives text — it does not pass here (as on Android).
//
// The audio threads only read `current` (worked out on the main actor when a
// setting or the gate changes), and each stream keeps its own VoiceFx: once a
// stream went through it, it stays in the chain (transparent when off) so the
// delay never jumps mid-recording or mid-call.

import Foundation
import M5Core
import Synchronization

enum MicFx {
    private struct Shared {
        var params = VoiceFx.neutralParams
        var version = 0
    }

    private static let shared = Mutex(Shared())

    /// The settings a stream follows (the module off or the switch off: neutral).
    static var params: VoiceFx.Params { shared.withLock { $0.params } }

    static var version: Int { shared.withLock { $0.version } }

    /// Whether the voice is being changed now.
    static var active: Bool { !params.neutral }

    /// The user's parameters (voiceFx.preset; "custom" → voiceFx.pitch …): the settings as JSON values.
    static func fromSettings(_ get: (String) -> JSON?) -> VoiceFx.Params {
        let preset = get("voiceFx.preset")?.stringValue ?? "null"
        var custom = VoiceFx.neutralParams
        for k in VoiceFx.keys {
            if let v = get("voiceFx." + k)?.doubleValue { custom = custom.with(k, v) }
        }
        return VoiceFx.paramsFor(preset, custom: custom)
    }

    /// The settings' keys and defaults — the same defaults as the web's DEFAULT_VOICE_FX.
    static let defaults: [(String, JSON)] = [
        ("voiceFx.on", false),             // switched on for this phone (the operator's module must allow it)
        ("voiceFx.preset", "deep"),        // off | higher | lower | deep | robot | echo | whisper | anonymous | custom
        ("voiceFx.pitch", -5.0),           // custom: semitones
        ("voiceFx.formant", -3.0),         // custom: semitones
        ("voiceFx.robot", 0.0),            // custom: ring modulator Hz (0 = off)
        ("voiceFx.echo", 0.0),             // custom: echo mix 0 … 1
        ("voiceFx.echoMs", 250.0),
        ("voiceFx.echoFeedback", 0.35),
        ("voiceFx.whisper", 0.0),          // custom: 0 … 1
        ("voiceFx.gain", 0.0),             // custom: dB
    ]

    /// Works the parameters out again: on only with the gate and the switch.
    static func recompute(switchOn: Bool, gateAllows: Bool, settings: (String) -> JSON?) {
        use(switchOn && gateAllows ? fromSettings(settings) : VoiceFx.neutralParams)
    }

    /// Sets the parameters directly (recompute; the tests).
    static func use(_ p: VoiceFx.Params) {
        shared.withLock { s in
            if s.params != p { s.params = p; s.version += 1 }
        }
    }

    /// One audio stream's processor (a recording, the call's capture); follows the settings live.
    /// Owned by one audio thread.
    final class Stream {
        private let rate: Int
        private var fx: VoiceFx?
        private var seen = -1

        init(rate: Int) { self.rate = rate }

        /// The delay it adds now (0 while it has never been on).
        var latency: Int { fx?.latency ?? 0 }

        /// 16-bit PCM (interleaved channels) changed in place.
        func process(_ pcm: UnsafeMutablePointer<Int16>, frames: Int, channels: Int) {
            let (p, v) = MicFx.shared.withLock { ($0.params, $0.version) }
            if seen != v {
                seen = v
                if fx == nil && !p.neutral { fx = VoiceFx(sampleRate: rate, params: p) }
                else if let fx { fx.set(p) }
            }
            fx?.process(pcm, frames: frames, channels: channels)
        }

        func process(_ pcm: inout [Int16], frames: Int, channels: Int) {
            pcm.withUnsafeMutableBufferPointer { process($0.baseAddress!, frames: frames, channels: channels) }
        }
    }
}
