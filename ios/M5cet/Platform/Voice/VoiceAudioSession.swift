// The audio session for the voice features outside calls — speaking (text to
// speech, read-back, autoplay), playing voice messages, recording them,
// dictating — so they coexist with CallKit:
//
//  - a call is active (Platform/Calls: CallKit activated `.playAndRecord` /
//    `.voiceChat`, or the direct fallback did): the session is CallKit's — it is
//    never re-categorised nor deactivated here; speech and playback go out
//    through the call's session; the microphone is the call's, so a recording or
//    a dictation does not start ("audio-capture" — Android's AudioRecord fails
//    the same way while WebRTC holds the microphone);
//  - otherwise each use asks for what it needs — playback: `.playback` /
//    `.spokenAudio`, ducking other audio; recording and dictation:
//    `.playAndRecord` with the speaker and Bluetooth hands-free — and the session
//    is deactivated (other apps' audio comes back) when the last use ends.
// An interruption (a phone call, Siri) ends what records; the owners are told
// (`onInterruption`).

import AVFoundation
import Foundation
import M5Core

/// What the voice features need of the system's audio session (a fake in the tests).
@MainActor
protocol VoiceAudioSessionControlling: AnyObject {
    /// A CallKit (or direct) call owns the session now.
    var callActive: Bool { get }
    func begin(_ use: VoiceAudioUse) throws
    func end(_ use: VoiceAudioUse)
}

enum VoiceAudioUse: String, Sendable, Hashable {
    case speak, play, record, dictate

    var records: Bool { self == .record || self == .dictate }
}

enum VoiceAudioError: Error, Equatable {
    /// A call holds the microphone.
    case inCall
    case session(String)
}

/// Whether a call holds the audio session — Platform/Calls' CallAudioSession (read, never changed here).
@MainActor
protocol VoiceCallState: AnyObject {
    var callActive: Bool { get }
}

/// The real one: CallAudioSession.shared.active.
@MainActor
final class CallsAudioState: VoiceCallState {
    var callActive: Bool { CallAudioSession.shared.active }
}

@MainActor
final class VoiceAudioSession: VoiceAudioSessionControlling {
    static let shared = VoiceAudioSession()

    var calls: any VoiceCallState = CallsAudioState()
    /// An interruption began (a phone call, Siri, an alarm): what records stops.
    var onInterruption: (() -> Void)?

    private var uses: [VoiceAudioUse: Int] = [:]
    private var observer: (any NSObjectProtocol)?

    var callActive: Bool { calls.callActive }

    private init() {
        observer = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
            MainActor.assumeIsolated { if began { VoiceAudioSession.shared.onInterruption?() } }
        }
    }

    /// The category a set of uses needs (pure: the tests check it).
    nonisolated static func category(for uses: Set<VoiceAudioUse>) -> (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions) {
        if uses.contains(where: \.records) {
            return (.playAndRecord, .default, [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
        }
        return (.playback, .spokenAudio, [.duckOthers])
    }

    func begin(_ use: VoiceAudioUse) throws {
        if callActive {
            if use.records { throw VoiceAudioError.inCall }
            uses[use, default: 0] += 1 // CallKit's session carries it as it is
            return
        }
        uses[use, default: 0] += 1
        let (category, mode, options) = Self.category(for: Set(uses.filter { $0.value > 0 }.keys))
        let s = AVAudioSession.sharedInstance()
        do {
            if s.category != category || s.mode != mode || s.categoryOptions != options {
                try s.setCategory(category, mode: mode, options: options)
            }
            try s.setActive(true)
        } catch {
            uses[use, default: 1] -= 1
            throw VoiceAudioError.session(error.localizedDescription)
        }
    }

    func end(_ use: VoiceAudioUse) {
        guard let n = uses[use], n > 0 else { return }
        uses[use] = n - 1
        guard uses.values.allSatisfy({ $0 == 0 }), !callActive else { return }
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { M5Log.shared.warn("voice", "audio session off: \(error.localizedDescription)") }
    }
}
