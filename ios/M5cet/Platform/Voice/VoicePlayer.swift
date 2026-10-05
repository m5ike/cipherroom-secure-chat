// Playing voice messages and audio attachments (Android: ui/media/AudioBar's
// MediaPlayer — one plays at a time, the source opened only when played). The
// bubble (Parts) shows play / pause, the position and the time; this is the
// player behind it. Any client's voice message plays: AAC / MP4, MP3, WAV
// natively, WebM / Ogg (Opus) decoded first (VoiceClipCodec.playable). The bytes
// come from the vault already decrypted; nothing is written unprotected.

import AVFoundation
import Foundation
import M5Core
import Observation

@MainActor
@Observable
final class VoicePlayer: NSObject {
    /// The clip playing or paused (the bubble's message id), nil when none.
    private(set) var current: String?
    private(set) var playing = false
    /// Length of the current clip, seconds (0 before it is opened).
    private(set) var duration: TimeInterval = 0

    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private let session: any VoiceAudioSessionControlling
    @ObservationIgnored private var holdsSession = false
    /// Told when a clip ends by itself (the bubble resets).
    @ObservationIgnored var onFinish: ((String) -> Void)?

    init(session: any VoiceAudioSessionControlling) { self.session = session }

    /// The position, seconds.
    var position: TimeInterval { player?.currentTime ?? 0 }
    /// 0 … 1.
    var progress: Double { duration > 0 ? min(1, position / duration) : 0 }

    /// Plays a clip (stopping another one); throws when the audio cannot be opened.
    func play(id: String, data: Data, mime: String?) throws {
        if current == id, let player, !player.isPlaying { resume(); return }
        stop()
        let (bytes, hint) = try VoiceClipCodec.playable(data, mime: mime)
        let p = try AVAudioPlayer(data: bytes, fileTypeHint: hint)
        p.delegate = self
        p.prepareToPlay()
        try session.begin(.play)
        holdsSession = true
        player = p
        current = id
        duration = p.duration
        playing = p.play()
    }

    func pause() {
        player?.pause()
        playing = false
    }

    func resume() {
        guard let player else { return }
        if !holdsSession { try? session.begin(.play); holdsSession = true }
        playing = player.play()
    }

    /// Play / pause of the current clip.
    func toggle() { playing ? pause() : resume() }

    /// Jump to a fraction of the clip (the bubble's seek bar).
    func seek(_ fraction: Double) {
        guard let player, duration > 0 else { return }
        player.currentTime = max(0, min(1, fraction)) * duration
    }

    func stop() {
        player?.stop()
        player = nil
        current = nil
        playing = false
        duration = 0
        if holdsSession { session.end(.play); holdsSession = false }
    }

    private func ended() {
        let id = current
        stop()
        if let id { onFinish?(id) }
    }
}

extension VoicePlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { MainActor.assumeIsolated { self.ended() } }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        let m = error.map { String(describing: $0) } ?? "?"
        DispatchQueue.main.async { MainActor.assumeIsolated { M5Log.shared.warn("voice", "playback: \(m)"); self.ended() } }
    }
}
