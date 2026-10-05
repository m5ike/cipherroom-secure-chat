// The seam to the voice (Platform/Voice — VoiceService, built by the services
// agent): what the voice pad, dictation and the voice changer's test need of
// android/…/voice/{Voice, Dictation, Speech, FxTest, MicFx, FxGate}. The app
// sets `ToolParts.voice` to the real service; until then (and in the tests)
// UnavailableToolsVoice says "not available" and does nothing.
//
// @Observable: the parts that read it are drawn again when it changes, and
// ToolParts keeps $voice (core.tools.voice) in step with it.

import M5Design
import Observation

@MainActor
protocol ToolsVoice: AnyObject, Observable, Sendable {
    /// Dictation can run on this device (Dictation.available).
    var available: Bool { get }
    var dictating: Bool { get }
    /// The recognizer hears now (between the start and the end of a sentence).
    var listening: Bool { get }
    var speaking: Bool { get }
    /// Starts dictation (the microphone and speech permission asked when needed): the words as they come, done =
    /// the sentence is final. False when it could not start.
    func dictate(_ sink: @escaping @MainActor (_ text: String, _ done: Bool) -> Void) async -> Bool
    /// Stops dictation (the last words still come to the sink).
    func stopDictation()
    /// Reads a text aloud (dictation pauses meanwhile).
    func say(_ text: String)
    func stopSpeaking()
    /// $voices of voice / settings.voice / dictate.options: [{value, label}] for the setting voice.voice ("" = default).
    func voices() async -> [DesignValue]

    // The voice changer (6.7, Settings › Voice changer).
    /// The operator allows it (FxGate).
    var fxAllowed: Bool { get }
    /// A preset or custom effect is on (MicFx.active).
    var fxActive: Bool { get }
    /// The test: "idle" | "recording" | "playing" (FxTest.state).
    var fxTesting: String { get }
    /// $voiceFx of settings.voiceFx: {allowed, active, testing} (the gate asked again when the screen shows).
    var fxScope: DesignValue { get }
    /// Start (four seconds recorded through the voice-message path, then played back) or stop the test.
    func fxToggleTest()
    /// voiceFx.reset: the custom effect's settings and their defaults (the caller writes them).
    func fxResetCustom() -> [(String, DesignValue)]
}

extension ToolsVoice {
    /// $voice (dictating, listening, speaking, available).
    var scope: DesignValue {
        ["dictating": .bool(dictating), "listening": .bool(listening), "speaking": .bool(speaking), "available": .bool(available)]
    }

    /// $voiceFx of settings.voiceFx (FxTest.scope).
    var fxScope: DesignValue { ["allowed": .bool(fxAllowed), "active": .bool(fxActive), "testing": .string(fxTesting)] }
}

/// No voice in this build yet: nothing is available, nothing happens.
@MainActor
@Observable
final class UnavailableToolsVoice: ToolsVoice {
    var available: Bool { false }
    var dictating: Bool { false }
    var listening: Bool { false }
    var speaking: Bool { false }
    func dictate(_ sink: @escaping @MainActor (String, Bool) -> Void) async -> Bool { false }
    func stopDictation() {}
    func say(_ text: String) {}
    func stopSpeaking() {}
    func voices() async -> [DesignValue] { [] }
    var fxAllowed: Bool { false }
    var fxActive: Bool { false }
    var fxTesting: String { "idle" }
    func fxToggleTest() {}
    func fxResetCustom() -> [(String, DesignValue)] { [] }
}
