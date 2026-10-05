// What the composer needs of Platform/Voice (A/voice: Audio.Recorder, Voice.clip,
// Voice.dictate / stopDictation, textToVoiceMessage, voiceToText, say) — a narrow
// seam: the Voice agent's VoiceService implements it and sets ChatVoiceHub.service.
// Until then BasicChatVoice records voice messages (AVAudioRecorder, AAC in an .m4a
// in the app's temporary area, read and deleted at once) and reads texts aloud
// (AVSpeechSynthesizer); dictation and the server's speech say they are not there.

import AVFoundation
import Foundation
import M5Design
import os

/// A finished voice clip (Voice.Clip): the encoded bytes, their type and length.
struct ChatVoiceClip: Sendable {
    let data: Data
    let mime: String
    let durationMs: Int64
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
    /// The Voice agent's service; BasicChatVoice until it is installed.
    static var service: any ChatVoiceService = BasicChatVoice()

    static func say(_ text: String) { service.say(text) }
}

/// The composer's own voice until Platform/Voice plugs in: recording and reading aloud, nothing else.
@MainActor
final class BasicChatVoice: NSObject, ChatVoiceService {
    private var recorder: AVAudioRecorder?
    private var file: URL?
    private let synth = AVSpeechSynthesizer()
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "voice")

    func microphone() async -> ChatMicAccess {
        guard AVAudioSession.sharedInstance().isInputAvailable else { return .none }
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .blocked
        default: return await AVAudioApplication.requestRecordPermission() ? .granted : .denied
        }
    }

    func startRecording() -> Bool {
        guard recorder == nil else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("m5-rec-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            let url = dir.appendingPathComponent("voice.m4a")
            let r = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
                                                             AVEncoderBitRateKey: 32_000, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue])
            r.isMeteringEnabled = true
            guard r.record() else { try? FileManager.default.removeItem(at: dir); return false }
            recorder = r
            file = url
            return true
        } catch {
            Self.log.notice("the recording did not start")
            return false
        }
    }

    var recordingElapsedMs: Int64 { Int64(((recorder?.currentTime ?? 0) * 1000).rounded()) }

    var recordingLevel: Double {
        guard let r = recorder else { return 0 }
        r.updateMeters()
        let db = Double(r.averagePower(forChannel: 0))
        return max(0, min(1, pow(10, db / 20) * 2))
    }

    func stopRecording(keep: Bool) async -> ChatVoiceClip? {
        guard let r = recorder, let url = file else { return nil }
        let ms = recordingElapsedMs
        r.stop()
        recorder = nil
        file = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        guard keep, let data = try? Data(contentsOf: url) else { return nil }
        return ChatVoiceClip(data: data, mime: "audio/mp4", durationMs: ms)
    }

    var dictationAvailable: Bool { false }
    var dictating: Bool { false }
    var listening: Bool { false }
    func dictate(onText: @escaping @MainActor (String, Bool) -> Void, onEnded: @escaping @MainActor (String) -> Void) { onEnded("") }
    func stopDictation() {}

    func textToVoiceMessage(_ text: String, roomKey: String) async -> (clip: ChatVoiceClip?, error: String?) { (nil, "tts-none") }
    func voiceToText(_ clip: ChatVoiceClip, roomKey: String) async -> (text: String?, error: String?) { (nil, nil) }

    func say(_ text: String) {
        synth.stopSpeaking(at: .immediate)
        synth.speak(AVSpeechUtterance(string: text))
    }
}
