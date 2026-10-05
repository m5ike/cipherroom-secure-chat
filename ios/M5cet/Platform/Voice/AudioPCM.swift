// The pure half of android/app/src/main/java/cz/m5cet/app/voice/Audio.java
// (6.1): 16-bit mono PCM — reading a WAV (the server's Piper voices, a WAV from
// the speech module), mixing stereo down, linear resampling, the duration, and
// a WAV in memory (what the server's transcription reads, what AVAudioPlayer
// plays of a decoded WebM / Ogg voice message). No AVFoundation here: the
// recorder (VoiceRecorder), the AAC encoder (VoiceClipCodec) and the decoder of
// other clients' voice messages build on it. Candidate for M5Kit.

import Foundation

/// 16-bit signed mono samples and their rate.
struct Pcm16: Sendable, Equatable {
    var samples: [Int16]
    var rate: Int

    var durationMs: Int64 { AudioPCM.durationMs(samples.count, rate: rate) }
}

enum AudioPCMError: Error, Equatable, CustomStringConvertible {
    case notWav, notSixteenBit, noData, noSpeech

    var description: String {
        switch self {
        case .notWav: "not a WAV file"
        case .notSixteenBit: "WAV is not 16-bit"
        case .noData: "WAV without data"
        case .noSpeech: "no speech in the audio"
        }
    }
}

enum AudioPCM {
    /// The rate of recordings and of what the recogniser and the server's transcription read.
    static let rate = 16_000

    private static func le32(_ b: [UInt8], _ at: Int) -> Int32 {
        Int32(bitPattern: UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24)
    }

    private static func le16(_ b: [UInt8], _ at: Int) -> Int16 { Int16(bitPattern: UInt16(b[at]) | UInt16(b[at + 1]) << 8) }

    /// A WAV's PCM and rate (16-bit; stereo is mixed down to mono).
    static func readWav(_ b: [UInt8]) throws -> Pcm16 {
        guard b.count >= 44, le32(b, 0) == 0x4646_4952, le32(b, 8) == 0x4556_4157 else { throw AudioPCMError.notWav }
        var at = 12, channels = 1, rate = Self.rate, bits = 16
        while at + 8 <= b.count {
            let id = le32(b, at), len = Int(le32(b, at + 4))
            if id == 0x2074_6d66, at + 24 <= b.count {
                channels = Int(le16(b, at + 10)); rate = Int(le32(b, at + 12)); bits = Int(le16(b, at + 22))
            }
            if id == 0x6174_6164 {
                if bits != 16 { throw AudioPCMError.notSixteenBit }
                // A streamed WAV may say 0 or -1 here (the engine never went back to fill it in): the rest of the file.
                var n = min(len <= 0 ? b.count - at - 8 : len, b.count - at - 8)
                n -= n & 1
                var samples = [Int16](repeating: 0, count: max(0, n / 2))
                for i in 0..<samples.count { samples[i] = le16(b, at + 8 + i * 2) }
                if channels == 2 { samples = mono(samples) }
                return Pcm16(samples: samples, rate: rate)
            }
            if len < 0 { break } // a broken chunk: never walk backwards
            at += 8 + len + (len & 1)
        }
        throw AudioPCMError.noData
    }

    static func readWav(_ d: Data) throws -> Pcm16 { try readWav([UInt8](d)) }

    /// Interleaved stereo → mono ((l + r) / 2, Java's integer division).
    static func mono(_ stereo: [Int16]) -> [Int16] {
        var out = [Int16](repeating: 0, count: stereo.count / 2)
        for i in 0..<out.count {
            let m = (Int(stereo[i * 2]) + Int(stereo[i * 2 + 1])) / 2
            out[i] = Int16(m)
        }
        return out
    }

    /// Linear resampling of 16-bit mono PCM (Android's Audio.resample, sample for sample).
    static func resample(_ pcm: [Int16], from: Int, to: Int) -> [Int16] {
        if from == to || pcm.count < 2 { return pcm }
        let n = pcm.count, m = Int(Int64(n) * Int64(to) / Int64(from))
        var out = [Int16](repeating: 0, count: m)
        for i in 0..<m {
            let src = Double(i) * Double(from) / Double(to)
            let a = Int(src)
            let f = src - Double(a)
            let s0 = Int(pcm[a])
            let s1 = a + 1 < n ? Int(pcm[a + 1]) : s0
            let v = JavaFormat.round(Double(s0) + Double(s1 - s0) * f)
            out[i] = Int16(truncatingIfNeeded: v)
        }
        return out
    }

    static func resample(_ pcm: Pcm16, to: Int) -> Pcm16 { Pcm16(samples: resample(pcm.samples, from: pcm.rate, to: to), rate: to) }

    static func durationMs(_ samples: Int, rate: Int) -> Int64 { Int64(samples) * 1000 / Int64(max(1, rate)) }

    /// A WAV in memory (16-bit mono) — what the server's transcription reads.
    static func wavBytes(_ pcm: [Int16], rate: Int) -> Data {
        var d = Data(capacity: 44 + pcm.count * 2)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let dataLength = UInt32(pcm.count * 2)
        u32(0x4646_4952); u32(36 + dataLength); u32(0x4556_4157); u32(0x2074_6d66); u32(16); u16(1); u16(1)
        u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16); u32(0x6174_6164); u32(dataLength)
        // Apple platforms are little-endian: the samples' memory is the WAV's data as it is.
        pcm.withUnsafeBytes { d.append(contentsOf: $0) }
        return d
    }

    /// RMS level of 16-bit samples as a 0–1 meter (Android: √(Σs²/n) / 8000, at most 1).
    static func level(_ samples: UnsafeBufferPointer<Int16>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Int64 = 0
        for s in samples { sum += Int64(s) * Int64(s) }
        return Float(min(1, (Double(sum) / Double(samples.count)).squareRoot() / 8000.0))
    }

    /// Float samples (-1 … 1) → 16-bit (Android's Math.round(x·32767), clamped).
    static func int16(_ x: Float) -> Int16 {
        Int16(max(-32768, min(32767, Int64(JavaFormat.round(Double(x) * 32767)))))
    }
}
