// The voice changer's test (6.7, Settings › Voice changer › Try it) — port of
// android/app/src/main/java/cz/m5cet/app/voice/FxTest.java: four seconds
// recorded through the same path a voice message takes (VoiceRecorder →
// MicFx), then played back here. Nothing is kept or sent; leaving the screen or
// the app stops it and frees the microphone. The recording and the playback are
// an IO (the real one: VoiceRecorder and AVAudioPlayer; a fake in the tests).

import AVFoundation
import Foundation
import M5Core

@MainActor
protocol FxTestIO: AnyObject {
    /// Starts recording (through the voice changer); false when the microphone cannot be had.
    func startRecording() -> Bool
    func stopRecording() -> Pcm16
    /// Plays the recording; false when it cannot.
    func play(_ pcm: Pcm16) -> Bool
    func stopPlaying()
}

@MainActor
final class FxTest {
    static let recordMs: Int64 = 4000

    enum State: String, Sendable { case idle, recording, playing }

    private(set) var state: State = .idle
    private let io: any FxTestIO
    private let scheduler: any DictationScheduler
    private var run = 0
    /// The screen redraws ($voiceFx.testing).
    var onChange: (() -> Void)?

    init(io: any FxTestIO, scheduler: any DictationScheduler = MainQueueScheduler()) {
        self.io = io
        self.scheduler = scheduler
    }

    /// $voiceFx of the settings screen: {allowed, active, testing}.
    func scope(allowed: Bool) -> JSONObject {
        JSONObject([("allowed", .bool(allowed)), ("active", .bool(MicFx.active)), ("testing", .string(state.rawValue))])
    }

    /// Start (when idle) or stop.
    func toggle() {
        if state != .idle { stop(); return }
        guard io.startRecording() else { M5Log.shared.warn("voice", "the test could not record"); return }
        set(.recording)
        run += 1
        let mine = run
        _ = scheduler.post(Self.recordMs) { [weak self] in
            guard let self, mine == self.run, self.state == .recording else { return }
            self.play(mine)
        }
    }

    private func play(_ mine: Int) {
        let pcm = io.stopRecording()
        guard pcm.samples.count >= 1, io.play(pcm) else { set(.idle); return }
        set(.playing)
        _ = scheduler.post(pcm.durationMs + 300) { [weak self] in
            guard let self, mine == self.run, self.state == .playing else { return }
            self.stop()
        }
    }

    /// Stops whatever runs; the microphone is released.
    func stop() {
        run += 1
        if state == .recording { _ = io.stopRecording() }
        if state == .playing { io.stopPlaying() }
        set(.idle)
    }

    private func set(_ s: State) {
        if state == s { return }
        state = s
        onChange?()
    }
}

/// The real IO: the voice message recorder and a player of the PCM.
@MainActor
final class DeviceFxTestIO: FxTestIO {
    private let recorder: VoiceRecorder
    private let session: any VoiceAudioSessionControlling
    private var player: AVAudioPlayer?

    init(recorder: VoiceRecorder, session: any VoiceAudioSessionControlling) {
        self.recorder = recorder
        self.session = session
    }

    func startRecording() -> Bool { recorder.start() }
    func stopRecording() -> Pcm16 { recorder.stop() }

    func play(_ pcm: Pcm16) -> Bool {
        guard let p = try? AVAudioPlayer(data: AudioPCM.wavBytes(pcm.samples, rate: pcm.rate), fileTypeHint: AVFileType.wav.rawValue),
              (try? session.begin(.play)) != nil else { return false }
        player = p
        if p.play() { return true }
        session.end(.play)
        player = nil
        return false
    }

    func stopPlaying() {
        guard let p = player else { return }
        p.stop()
        player = nil
        session.end(.play)
    }
}
