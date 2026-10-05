// Recording a voice message (6.1) — port of Audio.Recorder in
// android/app/src/main/java/cz/m5cet/app/voice/Audio.java: 16 kHz mono 16-bit
// PCM from the microphone until stop(), a level meter, at most an hour. 6.7:
// every buffer passes the voice changer first (MicFx) — what is kept (and sent)
// is the changed voice when it is on; at the end the changer's delay is cut from
// the start and its tail flushed, so the recording lines up with what was said.
// stop() gives the PCM; VoiceClipCodec.clip makes the AAC voice message of it.
//
// The capture goes through AVAudioEngine (MicrophoneTap converts the
// microphone's format to 16 kHz mono 16-bit); the session is VoiceAudioSession's
// (not during a call — the call has the microphone).

import AVFoundation
import Foundation
import M5Core

/// The PCM a recording keeps, through the voice changer (the audio thread appends; thread-safe).
final class RecordingBuffer: @unchecked Sendable {
    static let maxSamples = 60 * 60 * AudioPCM.rate

    private let lock = NSLock()
    private var samples = [Int16]()
    private let fx: MicFx.Stream
    private var levelValue: Float = 0

    init(rate: Int = AudioPCM.rate) { fx = MicFx.Stream(rate: rate) }

    /// One block from the microphone (mono): changed in place by the voice changer, measured, kept.
    func append(_ block: UnsafeMutablePointer<Int16>, count: Int) {
        guard count > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        fx.process(block, frames: count, channels: 1)
        levelValue = AudioPCM.level(UnsafeBufferPointer(start: block, count: count))
        if samples.count < Self.maxSamples { samples.append(contentsOf: UnsafeBufferPointer(start: block, count: min(count, Self.maxSamples - samples.count))) }
    }

    func append(_ block: [Int16]) {
        var b = block
        b.withUnsafeMutableBufferPointer { append($0.baseAddress!, count: $0.count) }
    }

    var level: Float { lock.withLock { levelValue } }
    var count: Int { lock.withLock { samples.count } }

    /// The recording, the voice changer's delay cut from the start and its tail flushed (Android's stop()).
    func finish() -> [Int16] {
        lock.lock(); defer { lock.unlock() }
        let all = samples
        let delay = fx.latency
        if delay == 0 { return all }
        var tail = [Int16](repeating: 0, count: delay)
        fx.process(&tail, frames: delay, channels: 1)
        let skip = min(all.count, delay)
        var out = Array(all[skip...])
        out.append(contentsOf: tail.prefix(all.count - out.count))
        return out
    }
}

@MainActor
final class VoiceRecorder {
    private let session: any VoiceAudioSessionControlling
    private var tap: MicrophoneTap?
    private var buffer: RecordingBuffer?
    private var startedAt: Date?

    init(session: any VoiceAudioSessionControlling) { self.session = session }

    var recording: Bool { tap != nil }
    /// 0 … 1 for a meter.
    var level: Float { buffer?.level ?? 0 }
    var elapsedMs: Int64 { startedAt.map { Int64(Date().timeIntervalSince($0) * 1000) } ?? 0 }

    /// Starts recording; false when the microphone cannot be had (no permission, a call, no input).
    func start() -> Bool {
        guard tap == nil, AVAudioApplication.shared.recordPermission == .granted else { return false }
        do { try session.begin(.record) } catch { return false }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(AudioPCM.rate), channels: 1, interleaved: true) else {
            session.end(.record)
            return false
        }
        let buffer = RecordingBuffer()
        let tap = MicrophoneTap(target: format)
        do {
            try tap.start { b in
                guard let d = b.int16ChannelData else { return }
                buffer.append(d[0], count: Int(b.frameLength))
            }
        } catch {
            M5Log.shared.warn("voice", "recording failed: \(error)")
            session.end(.record)
            return false
        }
        self.tap = tap
        self.buffer = buffer
        startedAt = Date()
        return true
    }

    /// Stops (the microphone is released) and returns the PCM (16 kHz mono).
    @discardableResult
    func stop() -> Pcm16 {
        tap?.stop()
        tap = nil
        if buffer != nil { session.end(.record) }
        let out = buffer?.finish() ?? []
        buffer = nil
        startedAt = nil
        return Pcm16(samples: out, rate: AudioPCM.rate)
    }
}
