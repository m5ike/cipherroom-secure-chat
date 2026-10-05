// The containers other clients' voice messages arrive in, taken apart so the
// Opus packets can be decoded by AudioToolbox (VoiceClipCodec). Browsers record
// a voice message with MediaRecorder (client/src/components/AudioRecorder.tsx:
// the first of audio/webm;codecs=opus, audio/webm, audio/ogg;codecs=opus,
// audio/mp4 they support) — Chrome, Edge and Firefox send WebM with Opus,
// Safari MP4 with AAC, a few Ogg with Opus. Android plays all of them with its
// MediaPlayer; AVFoundation opens neither WebM nor Ogg, so iOS demuxes them here:
//
//  - WebM / Matroska (EBML): the first audio track (CodecID, CodecPrivate =
//    OpusHead, rate, channels, CodecDelay) and its frames from SimpleBlocks and
//    BlockGroups — including the live form MediaRecorder writes (Segment and
//    Cluster of unknown size, no Cues) and every kind of lacing;
//  - Ogg: the pages of the first logical stream, packets across page boundaries,
//    the last granule position (the true length);
//  - OpusHead (RFC 7845 § 5.1) and an Opus packet's duration from its TOC byte
//    (RFC 6716 § 3.1).
// Pure (OpusContainersTests: files made by ffmpeg / libopus, a hand-made live
// WebM, laced blocks, broken input).

import Foundation

enum OpusContainerError: Error, Equatable, CustomStringConvertible {
    case notWebM, notOgg, noAudioTrack, unsupportedCodec(String), truncated, badHead

    var description: String {
        switch self {
        case .notWebM: "not a WebM file"
        case .notOgg: "not an Ogg file"
        case .noAudioTrack: "no audio track"
        case .unsupportedCodec(let c): "unsupported codec \(c)"
        case .truncated: "the file ends early"
        case .badHead: "no OpusHead"
        }
    }
}

/// The audio of a container: Opus packets in order and how to decode them.
struct OpusStream: Sendable, Equatable {
    var head: OpusHead
    var packets: [[UInt8]]
    /// Ogg: the last page's granule position (48 kHz samples including the pre-skip); nil when unknown.
    var endGranule: Int64?
}

/// OpusHead (RFC 7845 § 5.1).
struct OpusHead: Sendable, Equatable {
    var channels: Int
    /// Samples (48 kHz) to drop at the start.
    var preSkip: Int
    var inputRate: Int
    /// Q7.8 dB.
    var outputGain: Int
    var mappingFamily: Int

    static func parse(_ b: [UInt8]) -> OpusHead? {
        guard b.count >= 19, Array(b[0..<8]) == Array("OpusHead".utf8) else { return nil }
        let pre = Int(b[10]) | Int(b[11]) << 8
        let rate = Int(b[12]) | Int(b[13]) << 8 | Int(b[14]) << 16 | Int(b[15]) << 24
        let gain = Int(Int16(bitPattern: UInt16(b[16]) | UInt16(b[17]) << 8))
        return OpusHead(channels: max(1, Int(b[9])), preSkip: pre, inputRate: rate, outputGain: gain, mappingFamily: Int(b[18]))
    }

    /// The linear factor of the output gain.
    var gainFactor: Float { outputGain == 0 ? 1 : Float(pow(10, Double(outputGain) / (20 * 256))) }
}

enum OpusPacket {
    /// Samples (at 48 kHz) the packet decodes to; nil for an empty or malformed packet.
    static func samples(_ p: [UInt8]) -> Int? {
        guard let toc = p.first else { return nil }
        let config = Int(toc >> 3)
        let perFrame: Int
        switch config {
        case 0...11: perFrame = [480, 960, 1920, 2880][config & 3]
        case 12...15: perFrame = [480, 960][config & 1]
        default: perFrame = [120, 240, 480, 960][config & 3]
        }
        let frames: Int
        switch toc & 3 {
        case 0: frames = 1
        case 1, 2: frames = 2
        default:
            guard p.count >= 2 else { return nil }
            frames = Int(p[1] & 0x3F)
        }
        let n = perFrame * frames
        return n > 0 && n <= 5760 ? n : nil
    }
}

// MARK: - WebM

enum WebM {
    /// The EBML magic every WebM / Matroska file starts with.
    static func isWebM(_ b: [UInt8]) -> Bool { b.count >= 4 && b[0] == 0x1A && b[1] == 0x45 && b[2] == 0xDF && b[3] == 0xA3 }

    private enum ID {
        static let ebml: UInt32 = 0x1A45DFA3, segment: UInt32 = 0x18538067, tracks: UInt32 = 0x1654AE6B, trackEntry: UInt32 = 0xAE
        static let trackNumber: UInt32 = 0xD7, trackType: UInt32 = 0x83, codecId: UInt32 = 0x86, codecPrivate: UInt32 = 0x63A2
        static let codecDelay: UInt32 = 0x56AA, audio: UInt32 = 0xE1, samplingFrequency: UInt32 = 0xB5, channels: UInt32 = 0x9F
        static let cluster: UInt32 = 0x1F43B675, simpleBlock: UInt32 = 0xA3, blockGroup: UInt32 = 0xA0, block: UInt32 = 0xA1
    }

    /// Masters walked into (their children are read in place).
    private static let masters: Set<UInt32> = [ID.segment, ID.tracks, ID.trackEntry, ID.audio, ID.cluster, ID.blockGroup]

    struct Track: Equatable, Sendable {
        var number = 0
        var type = 0
        var codec = ""
        var codecPrivate: [UInt8] = []
        var rate = 0.0
        var channels = 1
        var codecDelayNs: Int64 = 0
    }

    /// An element's id (with its marker bits, 1–4 bytes).
    private static func readId(_ b: [UInt8], _ at: inout Int) -> UInt32? {
        guard at < b.count else { return nil }
        let first = b[at]
        let len = first.leadingZeroBitCount + 1
        guard len <= 4, at + len <= b.count else { return nil }
        var v: UInt32 = 0
        for i in 0..<len { v = v << 8 | UInt32(b[at + i]) }
        at += len
        return v
    }

    /// A size (marker removed); nil = unknown (all ones). `ok` false when broken.
    private static func readSize(_ b: [UInt8], _ at: inout Int, ok: inout Bool) -> Int? {
        guard at < b.count else { ok = false; return nil }
        let first = b[at]
        let len = first.leadingZeroBitCount + 1
        guard len <= 8, at + len <= b.count else { ok = false; return nil }
        var v = UInt64(first) & (0xFF >> UInt64(len))
        var allOnes = v == (0xFF >> UInt64(len))
        for i in 1..<len {
            v = v << 8 | UInt64(b[at + i])
            if b[at + i] != 0xFF { allOnes = false }
        }
        at += len
        ok = true
        if allOnes { return nil }
        return v > UInt64(Int.max) ? Int.max : Int(v)
    }

    /// A block's track number (a size-style vint).
    private static func readVint(_ b: [UInt8], _ at: inout Int) -> Int? {
        var ok = false
        let v = readSize(b, &at, ok: &ok)
        return ok ? v : nil
    }

    private static func uint(_ b: ArraySlice<UInt8>) -> UInt64 { b.reduce(0) { $0 << 8 | UInt64($1) } }

    private static func float(_ b: ArraySlice<UInt8>) -> Double {
        if b.count == 4 { return Double(Float(bitPattern: UInt32(truncatingIfNeeded: uint(b)))) }
        if b.count == 8 { return Double(bitPattern: uint(b)) }
        return 0
    }

    /// The first audio track and its frames.
    static func demux(_ b: [UInt8]) throws -> (track: Track, frames: [[UInt8]]) {
        guard isWebM(b) else { throw OpusContainerError.notWebM }
        var tracks = [Track]()
        var current: Track?
        var blocks = [(track: Int, data: ArraySlice<UInt8>)]()
        var at = 0
        func commit() { if let c = current { tracks.append(c); current = nil } }
        while at < b.count {
            guard let id = readId(b, &at) else { break }
            var ok = false
            let size = readSize(b, &at, ok: &ok)
            guard ok else { break }
            if id == ID.trackEntry { commit(); current = Track() }
            if masters.contains(id) {
                if id == ID.cluster { commit() }
                continue // walk into it
            }
            guard let size else { break } // an unknown-size element that is no master: give up here
            let end = at + size
            guard end <= b.count else {
                // MediaRecorder's last cluster may be cut off: keep what came whole.
                break
            }
            let data = b[at..<end]
            switch id {
            case ID.trackNumber: current?.number = Int(uint(data))
            case ID.trackType: current?.type = Int(uint(data))
            case ID.codecId: current?.codec = String(decoding: data.prefix(while: { $0 != 0 }), as: UTF8.self)
            case ID.codecPrivate: current?.codecPrivate = Array(data)
            case ID.codecDelay: current?.codecDelayNs = Int64(clamping: uint(data))
            case ID.samplingFrequency: current?.rate = float(data)
            case ID.channels: current?.channels = max(1, Int(uint(data)))
            case ID.simpleBlock, ID.block:
                var p = data.startIndex
                if let n = readVint(b, &p) { blocks.append((n, b[p..<end])) }
            default: break
            }
            at = end
        }
        commit()
        guard let audio = tracks.first(where: { $0.type == 2 }) ?? tracks.first(where: { $0.codec.hasPrefix("A_") }) else {
            throw OpusContainerError.noAudioTrack
        }
        var frames = [[UInt8]]()
        for block in blocks where block.track == audio.number {
            frames.append(contentsOf: try laced(block.data))
        }
        return (audio, frames)
    }

    /// A block's body after the track number: timecode (2), flags (1), then one frame or laced frames.
    static func laced(_ body: ArraySlice<UInt8>) throws -> [[UInt8]] {
        guard body.count >= 3 else { throw OpusContainerError.truncated }
        let flags = body[body.startIndex + 2]
        var at = body.startIndex + 3
        let lacing = (flags >> 1) & 3
        if lacing == 0 { return [Array(body[at...])] }
        guard at < body.endIndex else { throw OpusContainerError.truncated }
        let count = Int(body[at]) + 1
        at += 1
        var sizes = [Int]()
        switch lacing {
        case 1: // Xiph
            for _ in 0..<(count - 1) {
                var n = 0
                while true {
                    guard at < body.endIndex else { throw OpusContainerError.truncated }
                    let v = Int(body[at]); at += 1
                    n += v
                    if v < 255 { break }
                }
                sizes.append(n)
            }
        case 3: // EBML: the first size, then signed differences
            let all = Array(body)
            var p = at - body.startIndex
            guard var first = readVint(all, &p) else { throw OpusContainerError.truncated }
            sizes.append(first)
            for _ in 0..<max(0, count - 2) {
                let start = p
                guard let raw = readVint(all, &p) else { throw OpusContainerError.truncated }
                let len = p - start
                let bias = (1 << (7 * len - 1)) - 1
                first += raw - bias
                guard first >= 0 else { throw OpusContainerError.truncated }
                sizes.append(first)
            }
            at = body.startIndex + p
        default: // fixed
            let rest = body.endIndex - at
            guard count > 0, rest % count == 0 else { throw OpusContainerError.truncated }
            return (0..<count).map { i in Array(body[(at + i * rest / count)..<(at + (i + 1) * rest / count)]) }
        }
        let known = sizes.reduce(0, +)
        let last = body.endIndex - at - known
        guard last >= 0 else { throw OpusContainerError.truncated }
        sizes.append(last)
        var out = [[UInt8]]()
        for s in sizes {
            guard at + s <= body.endIndex else { throw OpusContainerError.truncated }
            out.append(Array(body[at..<(at + s)]))
            at += s
        }
        return out
    }

    /// The Opus stream of a WebM file.
    static func opus(_ b: [UInt8]) throws -> OpusStream {
        let (track, frames) = try demux(b)
        guard track.codec == "A_OPUS" else { throw OpusContainerError.unsupportedCodec(track.codec) }
        var head = OpusHead.parse(track.codecPrivate)
            ?? OpusHead(channels: track.channels, preSkip: 0, inputRate: Int(track.rate), outputGain: 0, mappingFamily: 0)
        // Matroska's CodecDelay (ns) is the pre-skip when the head does not say it.
        if head.preSkip == 0 && track.codecDelayNs > 0 { head.preSkip = Int(track.codecDelayNs * 48_000 / 1_000_000_000) }
        return OpusStream(head: head, packets: frames, endGranule: nil)
    }
}

// MARK: - Ogg

enum Ogg {
    static func isOgg(_ b: [UInt8]) -> Bool { b.count >= 4 && b[0] == 0x4F && b[1] == 0x67 && b[2] == 0x67 && b[3] == 0x53 }

    /// The packets of the first logical stream and its last granule position.
    static func packets(_ b: [UInt8]) throws -> (packets: [[UInt8]], endGranule: Int64?) {
        guard isOgg(b) else { throw OpusContainerError.notOgg }
        var at = 0
        var serial: UInt32?
        var packets = [[UInt8]]()
        var partial = [UInt8]()
        var granule: Int64?
        while at + 27 <= b.count {
            guard b[at] == 0x4F, b[at + 1] == 0x67, b[at + 2] == 0x67, b[at + 3] == 0x53 else { break }
            var g: UInt64 = 0
            for i in 0..<8 { g |= UInt64(b[at + 6 + i]) << (8 * UInt64(i)) }
            let s = UInt32(b[at + 14]) | UInt32(b[at + 15]) << 8 | UInt32(b[at + 16]) << 16 | UInt32(b[at + 17]) << 24
            let segments = Int(b[at + 26])
            guard at + 27 + segments <= b.count else { break }
            var body = at + 27 + segments
            let mine = serial == nil || serial == s
            if serial == nil { serial = s }
            for i in 0..<segments {
                let len = Int(b[at + 27 + i])
                guard body + len <= b.count else { throw OpusContainerError.truncated }
                if mine {
                    partial.append(contentsOf: b[body..<(body + len)])
                    if len < 255 { packets.append(partial); partial = [] }
                }
                body += len
            }
            if mine && g != UInt64.max { granule = Int64(bitPattern: g) }
            at = body
        }
        return (packets, granule)
    }

    /// The Opus stream of an Ogg file (OpusHead, OpusTags, then the audio).
    static func opus(_ b: [UInt8]) throws -> OpusStream {
        let (all, granule) = try packets(b)
        guard let first = all.first, let head = OpusHead.parse(first) else { throw OpusContainerError.badHead }
        let audio = all.dropFirst().filter { !($0.count >= 8 && Array($0[0..<8]) == Array("OpusTags".utf8)) }
        return OpusStream(head: head, packets: Array(audio), endGranule: granule)
    }
}
