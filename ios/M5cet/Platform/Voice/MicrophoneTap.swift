// The microphone as a stream of buffers in the format a consumer wants — the
// one piece of AVAudioEngine input the recorder (16 kHz mono 16-bit, through the
// voice changer) and the recognisers (the Speech framework's format) share.
// The tap runs on the audio thread: it converts (AVAudioConverter), measures the
// level and hands the buffer on; nothing there touches the main actor.

import AVFoundation
import Foundation

final class MicrophoneTap: @unchecked Sendable {
    /// A converted buffer (on the audio thread).
    typealias Sink = @Sendable (AVAudioPCMBuffer) -> Void

    private let engine = AVAudioEngine()
    private let target: AVAudioFormat
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var running = false
    private var levelValue: Float = 0

    init(target: AVAudioFormat) { self.target = target }

    /// The last buffer's level, 0 … 1 (RMS of the converted samples; Android's meter).
    var level: Float { lock.withLock { levelValue } }

    /// Starts the engine and the tap; throws when there is no microphone (or it is busy).
    func start(_ sink: @escaping Sink) throws {
        let input = engine.inputNode
        let natural = input.outputFormat(forBus: 0)
        guard natural.sampleRate > 0, natural.channelCount > 0 else { throw VoiceAudioError.session("no microphone input") }
        guard let conv = AVAudioConverter(from: natural, to: target) else { throw VoiceAudioError.session("no converter to \(target)") }
        lock.withLock { converter = conv; running = true }
        let target = self.target
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(natural.sampleRate / 10), format: natural) { [weak self] buffer, _ in
            guard let self, let out = self.convert(buffer, to: target) else { return }
            let level = Self.rms(out)
            self.lock.withLock { self.levelValue = level }
            sink(out)
        }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            lock.withLock { running = false }
            throw VoiceAudioError.session(error.localizedDescription)
        }
    }

    func stop() {
        let was = lock.withLock { () -> Bool in let r = running; running = false; return r }
        guard was else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    var isRunning: Bool { lock.withLock { running } }

    /// A microphone buffer in the target format (nil when the converter has nothing yet).
    private func convert(_ buffer: AVAudioPCMBuffer, to target: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let conv = lock.withLock({ converter }) else { return nil }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up) + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) var given = false
        var error: NSError?
        let status = conv.convert(to: out, error: &error) { _, inputStatus in
            if given { inputStatus.pointee = .noDataNow; return nil }
            given = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error || out.frameLength == 0 { return nil }
        return out
    }

    /// 0 … 1: Android's √(Σs²/n)/8000 on 16-bit samples, the same on floats (×32768).
    static func rms(_ b: AVAudioPCMBuffer) -> Float {
        let n = Int(b.frameLength)
        guard n > 0 else { return 0 }
        if let d = b.int16ChannelData { return AudioPCM.level(UnsafeBufferPointer(start: d[0], count: n)) }
        guard let f = b.floatChannelData else { return 0 }
        var sum: Float = 0
        for i in 0..<n { sum += f[0][i] * f[0][i] }
        return min(1, (sum / Float(n)).squareRoot() * 32768 / 8000)
    }
}
