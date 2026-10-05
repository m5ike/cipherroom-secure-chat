// The voice changer's effect chain (6.7) — port of
// android/app/src/main/java/cz/m5cet/app/voice/VoiceFx.java (itself
// client/src/lib/voice-fx.ts), with the same presets and numbers
// (test/fixtures/voice-fx.json keeps all three equal). Pure Swift: the tests run
// it on synthetic signals; the app runs it on the microphone (MicFx: voice
// messages, the voice changer's test and — with CallVoiceAudioDevice — calls).
//
//  1. spectral voice — an STFT phase vocoder: the excitation's pitch and the
//     spectral envelope's formants move separately; whisper swaps the excitation
//     for noise under the same envelope;
//  2. robot — a ring modulator;
//  3. echo — a feedback delay;
//  4. gain and a soft limiter.
// While it runs the delay is constant (one STFT frame: 1024 samples at 48 kHz,
// 512 at 16 kHz). Not thread-safe: one instance per audio stream (the audio
// thread owns it). Candidate for M5Kit (no platform code).

import Foundation

final class VoiceFx {
    // MARK: params

    /// The parameters (voice-fx.ts › VoiceFxParams), clamped to their ranges.
    struct Params: Sendable, Equatable {
        let pitch: Double, formant: Double, robot: Double, echo: Double, echoMs: Double, echoFeedback: Double, whisper: Double, gain: Double

        init(pitch: Double, formant: Double, robot: Double, echo: Double, echoMs: Double, echoFeedback: Double, whisper: Double, gain: Double) {
            self.pitch = VoiceFx.clamp(pitch, -12, 12)
            self.formant = VoiceFx.clamp(formant, -12, 12)
            let r = VoiceFx.clamp(robot, 0, 400)
            self.robot = r > 0 && r < 20 ? 0 : r
            self.echo = VoiceFx.clamp(echo, 0, 1)
            self.echoMs = VoiceFx.clamp(echoMs, 40, 1000)
            self.echoFeedback = VoiceFx.clamp(echoFeedback, 0, 0.9)
            self.whisper = VoiceFx.clamp(whisper, 0, 1)
            self.gain = VoiceFx.clamp(gain, -12, 12)
        }

        var neutral: Bool { pitch == 0 && formant == 0 && robot == 0 && echo == 0 && whisper == 0 && gain == 0 }

        func with(_ key: String, _ v: Double) -> Params {
            switch key {
            case "pitch": Params(pitch: v, formant: formant, robot: robot, echo: echo, echoMs: echoMs, echoFeedback: echoFeedback, whisper: whisper, gain: gain)
            case "formant": Params(pitch: pitch, formant: v, robot: robot, echo: echo, echoMs: echoMs, echoFeedback: echoFeedback, whisper: whisper, gain: gain)
            case "robot": Params(pitch: pitch, formant: formant, robot: v, echo: echo, echoMs: echoMs, echoFeedback: echoFeedback, whisper: whisper, gain: gain)
            case "echo": Params(pitch: pitch, formant: formant, robot: robot, echo: v, echoMs: echoMs, echoFeedback: echoFeedback, whisper: whisper, gain: gain)
            case "echoMs": Params(pitch: pitch, formant: formant, robot: robot, echo: echo, echoMs: v, echoFeedback: echoFeedback, whisper: whisper, gain: gain)
            case "echoFeedback": Params(pitch: pitch, formant: formant, robot: robot, echo: echo, echoMs: echoMs, echoFeedback: v, whisper: whisper, gain: gain)
            case "whisper": Params(pitch: pitch, formant: formant, robot: robot, echo: echo, echoMs: echoMs, echoFeedback: echoFeedback, whisper: v, gain: gain)
            case "gain": Params(pitch: pitch, formant: formant, robot: robot, echo: echo, echoMs: echoMs, echoFeedback: echoFeedback, whisper: whisper, gain: v)
            default: self
            }
        }

        /// A value by its name (the fixture's and the settings' keys); nil for an unknown key.
        func get(_ key: String) -> Double? {
            switch key {
            case "pitch": pitch
            case "formant": formant
            case "robot": robot
            case "echo": echo
            case "echoMs": echoMs
            case "echoFeedback": echoFeedback
            case "whisper": whisper
            case "gain": gain
            default: nil
            }
        }
    }

    static let keys = ["pitch", "formant", "robot", "echo", "echoMs", "echoFeedback", "whisper", "gain"]
    static let neutralParams = Params(pitch: 0, formant: 0, robot: 0, echo: 0, echoMs: 250, echoFeedback: 0.35, whisper: 0, gain: 0)

    /// The preset ids, in the order the settings offer them ("custom": the user's own).
    static let presetIds = ["off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom"]

    /// The presets — the same names and numbers as VOICE_FX_PRESETS on the web (in order).
    static let presets: [(String, Params)] = {
        let n = neutralParams
        return [
            ("off", n),
            ("higher", n.with("pitch", 4).with("formant", 3)),
            ("lower", n.with("pitch", -4).with("formant", -3)),
            ("deep", n.with("pitch", -7).with("formant", -5)),
            ("robot", n.with("robot", 70).with("gain", 2)),
            ("echo", n.with("echo", 0.5).with("echoMs", 280).with("echoFeedback", 0.45)),
            ("whisper", n.with("whisper", 1).with("gain", 2)),
            ("anonymous", n.with("pitch", -3).with("formant", -6).with("whisper", 0.35).with("gain", 2)),
        ]
    }()

    static func preset(_ id: String) -> Params? { presets.first(where: { $0.0 == id })?.1 }

    /// Each parameter's range; nil for an unknown key.
    static func limits(_ key: String) -> (Double, Double)? {
        switch key {
        case "pitch", "formant", "gain": (-12, 12)
        case "robot": (0, 400)
        case "echo", "whisper": (0, 1)
        case "echoMs": (40, 1000)
        case "echoFeedback": (0, 0.9)
        default: nil
        }
    }

    /// A preset's parameters; "custom" (or an unknown id) takes the user's own.
    static func paramsFor(_ preset: String, custom: Params?) -> Params {
        if let p = self.preset(preset) { return p }
        return custom ?? neutralParams
    }

    static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { v.isNaN ? lo : max(lo, min(hi, v)) }

    // MARK: FFT

    /// In-place radix-2 complex FFT of one size.
    final class Fft {
        let n: Int
        private let cosT: [Double], sinT: [Double]
        private let rev: [Int]

        init(_ n: Int) {
            precondition(n >= 2 && n & (n - 1) == 0, "FFT size must be a power of two")
            self.n = n
            cosT = (0..<n / 2).map { cos(2 * Double.pi * Double($0) / Double(n)) }
            sinT = (0..<n / 2).map { sin(2 * Double.pi * Double($0) / Double(n)) }
            let bits = n.trailingZeroBitCount
            rev = (0..<n).map { i in
                var r = 0, x = i
                for _ in 0..<bits { r = r << 1 | (x & 1); x >>= 1 }
                return r
            }
        }

        /// Forward (e^-i) or inverse (e^+i, not divided by n).
        func transform(_ re: inout [Double], _ im: inout [Double], inverse: Bool) {
            for i in 0..<n {
                let j = rev[i]
                if j > i { re.swapAt(i, j); im.swapAt(i, j) }
            }
            let sign: Double = inverse ? 1 : -1
            var size = 2
            while size <= n {
                let half = size >> 1, step = n / size
                var start = 0
                while start < n {
                    for k in 0..<half {
                        let wr = cosT[k * step], wi = sign * sinT[k * step]
                        let a = start + k, b = a + half
                        let tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr
                        re[b] = re[a] - tr; im[b] = im[a] - ti
                        re[a] += tr; im[a] += ti
                    }
                    start += size
                }
                size <<= 1
            }
        }
    }

    /// xorshift32 — the same numbers as voice-fx.ts makeNoise for the same seed.
    struct Noise {
        private var s: UInt32
        init(_ seed: Int32) { s = seed == 0 ? 1 : UInt32(bitPattern: seed) }
        mutating func next() -> Double {
            s ^= s << 13
            s ^= s >> 17
            s ^= s << 5
            return Double(s) / 4294967296.0
        }
    }

    /// The STFT frame for a sample rate.
    static func frameSize(for sampleRate: Int) -> Int { sampleRate > 32_000 ? 1024 : 512 }

    // MARK: spectral voice

    final class Spectral {
        let size: Int, half: Int, hop: Int, latency: Int
        private let fft: Fft
        private let win: [Double]
        private var inFifo: [Double], outFifo: [Double], accum: [Double], re: [Double], im: [Double]
        private var lastPhase: [Double], sumPhase: [Double], anaMag: [Double], anaFreq: [Double], synMag: [Double], synFreq: [Double], env: [Double], tmp: [Double]
        private let smoothHalf: Int
        private let follow: Double
        private var rand: Noise
        private var rover: Int
        private var pitchRatio = 1.0, formantRatio = 1.0, whisper = 0.0, level = 1.0, powIn = 0.0, powOut = 0.0, makeup = 1.0
        private var active = false

        init(sampleRate: Int, seed: Int32) {
            let n = VoiceFx.frameSize(for: sampleRate)
            size = n; half = n / 2; hop = n / 4; latency = n
            fft = Fft(n)
            win = (0..<n).map { 0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(n)) }
            inFifo = [Double](repeating: 0, count: n)
            outFifo = [Double](repeating: 0, count: n)
            accum = [Double](repeating: 0, count: 2 * n)
            re = [Double](repeating: 0, count: n)
            im = [Double](repeating: 0, count: n)
            let bins = half + 1
            lastPhase = [Double](repeating: 0, count: bins); sumPhase = lastPhase; anaMag = lastPhase; anaFreq = lastPhase
            synMag = lastPhase; synFreq = lastPhase; env = lastPhase; tmp = lastPhase
            smoothHalf = max(2, Int((200 / (Double(sampleRate) / Double(n))).rounded(.up)))
            rover = n - hop
            rand = Noise(seed)
            follow = 1 / (0.3 * Double(sampleRate))
        }

        func set(pitch: Double, formant: Double, whisper: Double) {
            pitchRatio = pow(2, pitch / 12)
            formantRatio = pow(2, formant / 12)
            self.whisper = VoiceFx.clamp(whisper, 0, 1)
            let on = pitch != 0 || formant != 0 || whisper > 0
            if on && !active {
                for i in lastPhase.indices { lastPhase[i] = 0; sumPhase[i] = 0 }
                for i in accum.indices { accum[i] = 0 }
                level = 1; powIn = 0; powOut = 0; makeup = 1
            }
            active = on
        }

        func process(_ buf: UnsafeMutablePointer<Double>, _ len: Int) {
            let n = size
            for i in 0..<len {
                let x = buf[i]
                inFifo[rover] = x
                var y = outFifo[rover - (n - hop)]
                if active {
                    powIn += follow * (x * x - powIn)
                    powOut += follow * (y * y - powOut)
                    let want = VoiceFx.clamp(((powIn + 1e-9) / (powOut + 1e-9)).squareRoot(), 0.5, 3)
                    makeup += follow * (want - makeup)
                    y *= makeup
                }
                buf[i] = y
                rover += 1
                if rover >= n {
                    rover = n - hop
                    if active { frame() } else { for k in 0..<hop { outFifo[k] = inFifo[k] } }
                    for k in 0..<(n - hop) { inFifo[k] = inFifo[k + hop] }
                }
            }
        }

        private func frame() {
            let n = size, osamp = Double(n / hop)
            let expct = 2 * Double.pi * Double(hop) / Double(n)
            for k in 0..<n { re[k] = inFifo[k] * win[k]; im[k] = 0 }
            fft.transform(&re, &im, inverse: false)
            for k in 0...half {
                let mag = hypot(re[k], im[k])
                let phase = atan2(im[k], re[k])
                var d = phase - lastPhase[k]
                lastPhase[k] = phase
                d -= Double(k) * expct
                d -= 2 * Double.pi * (d / (2 * Double.pi) + 0.5).rounded(.down) // JS Math.round
                anaMag[k] = mag
                anaFreq[k] = Double(k) + osamp * d / (2 * Double.pi)
            }
            smooth(anaMag, &tmp)
            smooth(tmp, &env)
            var peak = 0.0
            for k in 0...half where env[k] > peak { peak = env[k] }
            let floor = peak * 1e-4 + 1e-12
            for k in 0...half { synMag[k] = 0; synFreq[k] = 0 }
            for k in 0...half {
                let j = Int((Double(k) * pitchRatio + 0.5).rounded(.down))
                if j > half { break }
                synMag[j] += anaMag[k] / max(env[k], floor)
                synFreq[j] = anaFreq[k] * pitchRatio
            }
            let w = whisper
            var energyIn = 0.0, energyOut = 0.0
            for k in 0...half { energyIn += anaMag[k] * anaMag[k] }
            for j in 0...half {
                let at = Double(j) / formantRatio
                let a = Int(at.rounded(.down))
                let e = a >= half ? 0 : env[a] + (env[a + 1] - env[a]) * (at - Double(a))
                var d = synFreq[j] - Double(j)
                d = 2 * Double.pi * d / osamp + Double(j) * expct
                sumPhase[j] += d
                let voiced = (1 - w) * synMag[j] * e
                var r = voiced * cos(sumPhase[j]), i = voiced * sin(sumPhase[j])
                if w > 0 {
                    let ph = 2 * Double.pi * rand.next()
                    r += w * e * cos(ph)
                    i += w * e * sin(ph)
                }
                re[j] = r
                im[j] = i
                energyOut += r * r + i * i
            }
            let target = energyOut > 1e-20 ? (energyIn / energyOut).squareRoot() : 1
            level = level * 0.5 + VoiceFx.clamp(target, 0.1, 10) * 0.5
            for j in 0...half {
                let g = (j == 0 || j == half ? 1 : 2) * level
                re[j] *= g
                im[j] *= g
            }
            for j in (half + 1)..<n { re[j] = 0; im[j] = 0 }
            fft.transform(&re, &im, inverse: true)
            let scale = 1.0 / (Double(n) * 1.5)
            for k in 0..<n { accum[k] += win[k] * re[k] * scale }
            for k in 0..<hop { outFifo[k] = accum[k] }
            for k in 0..<n { accum[k] = accum[k + hop] }
            for k in n..<(n + hop) { accum[k] = 0 }
        }

        private func smooth(_ src: [Double], _ dst: inout [Double]) {
            let m = src.count, h = smoothHalf
            var count = 0
            var sum = 0.0
            for k in 0..<min(h, m) { sum += src[k]; count += 1 }
            for k in 0..<m {
                let add = k + h, drop = k - h - 1
                if add < m { sum += src[add]; count += 1 }
                if drop >= 0 { sum -= src[drop]; count -= 1 }
                dst[k] = sum / Double(count)
            }
        }
    }

    // MARK: small units

    /// x · sin(2π f t).
    struct Ring {
        private let rate: Int
        private var phase = 0.0, step = 0.0
        init(rate: Int) { self.rate = rate }
        mutating func set(_ hz: Double) { step = hz > 0 ? 2 * Double.pi * hz / Double(rate) : 0; if hz == 0 { phase = 0 } }
        var on: Bool { step > 0 }
        mutating func next(_ x: Double) -> Double {
            phase += step
            if phase > 2 * Double.pi { phase -= 2 * Double.pi }
            return x * sin(phase)
        }
    }

    /// y = x + mix · d[t-D];  d[t] = x + fb · d[t-D].
    struct Echo {
        private let rate: Int
        private var buf: [Double]
        private var at = 0, delay = 1
        private var mix = 0.0, feedback = 0.0
        init(rate: Int) { self.rate = rate; buf = [Double](repeating: 0, count: Int((Double(rate) * 1.001).rounded(.up)) + 1) }
        mutating func set(mix: Double, ms: Double, feedback: Double) {
            if mix <= 0 && self.mix > 0 { for i in buf.indices { buf[i] = 0 } }
            self.mix = VoiceFx.clamp(mix, 0, 1)
            self.feedback = VoiceFx.clamp(feedback, 0, 0.9)
            delay = Int(VoiceFx.clamp(Double(JavaFormat.round(ms / 1000 * Double(rate))), 1, Double(buf.count - 1)))
        }
        var on: Bool { mix > 0 }
        mutating func next(_ x: Double) -> Double {
            let len = buf.count
            var r = at - delay
            if r < 0 { r += len }
            let d = buf[r]
            buf[at] = x + feedback * d
            at = at + 1 == len ? 0 : at + 1
            return x + mix * d
        }
    }

    /// Above 0.8 the level bends softly toward 1 (never past it).
    static func softLimit(_ x: Double) -> Double {
        let a = abs(x)
        if a <= 0.8 { return x }
        return (x > 0 ? 1.0 : x < 0 ? -1.0 : 0.0) * (0.8 + 0.2 * tanh((a - 0.8) / 0.2))
    }

    // MARK: the chain

    let sampleRate: Int
    private let spectral: Spectral
    private var ring: Ring
    private var echo: Echo
    private(set) var params: Params = VoiceFx.neutralParams
    private var gain = 1.0
    private var work = [Double]()

    init(sampleRate: Int, params: Params?, seed: Int32 = 1) {
        self.sampleRate = sampleRate
        spectral = Spectral(sampleRate: sampleRate, seed: seed)
        ring = Ring(rate: sampleRate)
        echo = Echo(rate: sampleRate)
        set(params)
    }

    /// The delay the chain adds, in samples.
    var latency: Int { spectral.latency }

    func set(_ p: Params?) {
        params = p ?? VoiceFx.neutralParams
        spectral.set(pitch: params.pitch, formant: params.formant, whisper: params.whisper)
        ring.set(params.robot)
        echo.set(mix: params.echo, ms: params.echoMs, feedback: params.echoFeedback)
        gain = pow(10, params.gain / 20)
    }

    /// Mono samples (-1 … 1) changed in place.
    func process(_ buf: UnsafeMutablePointer<Double>, _ len: Int) {
        spectral.process(buf, len)
        let r = ring.on, e = echo.on
        for i in 0..<len {
            var x = buf[i]
            if r { x = ring.next(x) }
            if e { x = echo.next(x) }
            buf[i] = VoiceFx.softLimit(x * gain)
        }
    }

    /// The same on an array.
    func process(_ buf: inout [Double]) {
        let n = buf.count
        buf.withUnsafeMutableBufferPointer { process($0.baseAddress!, n) }
    }

    /// 16-bit PCM (mono, or interleaved channels mixed down and spread back) changed in place.
    func process(_ pcm: UnsafeMutablePointer<Int16>, frames: Int, channels: Int) {
        if work.count < frames { work = [Double](repeating: 0, count: frames) }
        let ch = max(1, channels)
        for f in 0..<frames {
            var s = 0.0
            for c in 0..<ch { s += Double(pcm[f * ch + c]) }
            work[f] = s / Double(ch) / 32768.0
        }
        work.withUnsafeMutableBufferPointer { process($0.baseAddress!, frames) }
        for f in 0..<frames {
            let v = Int16(max(-32768, min(32767, JavaFormat.round(work[f] * 32767))))
            for c in 0..<ch { pcm[f * ch + c] = v }
        }
    }

    /// The same on an array (interleaved).
    func process(_ pcm: inout [Int16], frames: Int, channels: Int) {
        pcm.withUnsafeMutableBufferPointer { process($0.baseAddress!, frames: frames, channels: channels) }
    }

    /// For the echo test (Android's VoiceFxTest drives Echo directly).
    static func makeEcho(rate: Int) -> Echo { Echo(rate: rate) }
}
