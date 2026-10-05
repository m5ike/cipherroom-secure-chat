// What the composer needs of Platform/Voice (A/voice: Audio.Recorder, Voice.clip,
// Voice.dictate / stopDictation, textToVoiceMessage, voiceToText, say) — a narrow
// seam the composer and its tests use; VoiceServiceChatVoice puts VoiceService.shared
// behind it. An implementation should be @Observable (dictating / listening drive
// the dictation icon).

import Foundation

/// A finished voice clip (Voice.Clip): the encoded bytes, their type and length.
struct ChatVoiceClip: Sendable {
    let data: Data
    let mime: String
    let durationMs: Int64
    /// The recording itself (16-bit mono) — what voice → text reads; nil for a clip made elsewhere.
    var pcm: Pcm16? = nil
}

/// The microphone (Composer.withMic): allowed, refused now, refused for good (Settings), or none at all.
enum ChatMicAccess { case granted, denied, blocked, none }

@MainActor
protocol ChatVoiceService: AnyObject {
    /// Asks for the microphone when not decided yet.
    func microphone() async -> ChatMicAccess

    /// A voice message (Audio.Recorder; the voice changer in its path): false — another app holds the microphone.
    func startRecording() -> Bool
    var recordingElapsedMs: Int64 { get }
    /// 0–1, for the level bar.
    var recordingLevel: Double { get }
    /// Stops it: the clip (keep), nil when dropped or failed.
    func stopRecording(keep: Bool) async -> ChatVoiceClip?

    /// Dictation into the field (Voice.dictate): `onText(text, final)`; `onEnded(error code or "")`.
    var dictationAvailable: Bool { get }
    var dictating: Bool { get }
    var listening: Bool { get }
    func dictate(onText: @escaping @MainActor (String, Bool) -> Void, onEnded: @escaping @MainActor (String) -> Void)
    func stopDictation()

    /// A text as a voice message's clip (TTS — the phone's or the server's per the voice settings; the server's asks first).
    func textToVoiceMessage(_ text: String, roomKey: String) async -> (clip: ChatVoiceClip?, error: String?)
    /// A recording as text (the phone's recogniser or the server's): text, or an error code ("declined" — the person said no).
    func voiceToText(_ clip: ChatVoiceClip, roomKey: String) async -> (text: String?, error: String?)

    /// Reads a text aloud (msg.speak).
    func say(_ text: String)
}

@MainActor
enum ChatVoiceHub {
    /// Platform/Voice's VoiceService (ChatParts.install gives it the design's words); a test may put its own.
    static var service: any ChatVoiceService = VoiceServiceChatVoice(texts: { $0 })

    static func say(_ text: String) { service.say(text) }
}
