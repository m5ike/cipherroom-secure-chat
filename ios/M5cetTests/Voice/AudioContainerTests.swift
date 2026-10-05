// The pure audio helpers (Android's voice/Audio.java on iOS: AudioPCM) and the demuxers of other
// clients' voice messages (OpusContainers): WAV in and out, stereo to mono, resampling, the Opus TOC,
// WebM in every form MediaRecorder writes (known sizes, a live Segment, a live Cluster, laced
// blocks), Ogg, and what broken input does.

import XCTest
@testable import M5cet

final class AudioPCMTests: XCTestCase {
    func testAWavRoundTrip() throws {
        let pcm: [Int16] = [0, 1, -1, 32767, -32768, 1234]
        let wav = AudioPCM.wavBytes(pcm, rate: 16_000)
        XCTAssertEqual(44 + 12, wav.count)
        XCTAssertTrue(SpeakSendErrors.isWav([UInt8](wav)))
        let back = try AudioPCM.readWav(wav)
        XCTAssertEqual(pcm, back.samples)
        XCTAssertEqual(16_000, back.rate)
        // Android's header, byte for byte: RIFF, 36 + n, WAVE, fmt (16, PCM, mono, rate, rate·2, 2, 16), data, n.
        XCTAssertEqual([0x52, 0x49, 0x46, 0x46, 48, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0,
                        0x80, 0x3e, 0, 0, 0x00, 0x7d, 0, 0, 2, 0, 16, 0, 0x64, 0x61, 0x74, 0x61, 12, 0, 0, 0], [UInt8](wav.prefix(44)))
    }

    func testAStereoStreamedWavIsMixedDown() throws {
        // A streamed WAV: the data chunk says 0 (the rest of the file), 22050 Hz stereo, a LIST chunk first.
        var b = [UInt8]()
        func u32(_ v: UInt32) { b += withUnsafeBytes(of: v.littleEndian, Array.init) }
        func u16(_ v: UInt16) { b += withUnsafeBytes(of: v.littleEndian, Array.init) }
        b += Array("RIFF".utf8); u32(0); b += Array("WAVE".utf8)
        b += Array("fmt ".utf8); u32(16); u16(1); u16(2); u32(22050); u32(22050 * 4); u16(4); u16(16)
        b += Array("LIST".utf8); u32(3); b += [1, 2, 3, 0] // an odd chunk and its pad byte
        b += Array("data".utf8); u32(0)
        for (l, r) in [(Int16(100), Int16(300)), (-5, 2), (32767, 32767)] { u16(UInt16(bitPattern: l)); u16(UInt16(bitPattern: r)) }
        let p = try AudioPCM.readWav(b)
        XCTAssertEqual(22050, p.rate)
        XCTAssertEqual([200, -1, 32767], p.samples) // (l + r) / 2, truncated toward zero as Java does
    }

    func testWhatIsNoWav() {
        XCTAssertThrowsError(try AudioPCM.readWav([UInt8](repeating: 0, count: 50)))
        var eight = [UInt8](AudioPCM.wavBytes([1, 2], rate: 8000))
        eight[34] = 8 // 8-bit
        XCTAssertThrowsError(try AudioPCM.readWav(eight)) { XCTAssertEqual($0 as? AudioPCMError, .notSixteenBit) }
    }

    func testResamplingIsAndroidsLinearOne() {
        let up = AudioPCM.resample([0, 100, 200, 300], from: 8000, to: 16000)
        XCTAssertEqual([0, 50, 100, 150, 200, 250, 300, 300], up)
        let down = AudioPCM.resample([0, 10, 20, 30, 40, 50], from: 48000, to: 16000)
        XCTAssertEqual([0, 30], down)
        XCTAssertEqual([1, 2], AudioPCM.resample([1, 2], from: 16000, to: 16000))
        XCTAssertEqual(1000, AudioPCM.durationMs(16000, rate: 16000))
        XCTAssertEqual(1, AudioPCM.int16(0.00002))
        XCTAssertEqual(32767, AudioPCM.int16(2))
        XCTAssertEqual(-32768, AudioPCM.int16(-2))
    }

    func testTheLevelMeter() {
        let loud = [Int16](repeating: 8000, count: 100), quiet = [Int16](repeating: 80, count: 100)
        XCTAssertEqual(1, loud.withUnsafeBufferPointer { AudioPCM.level($0) })
        XCTAssertEqual(0.01, quiet.withUnsafeBufferPointer { AudioPCM.level($0) }, accuracy: 1e-6)
    }
}

final class OpusContainerTests: XCTestCase {
    private func bytes(_ d: Data) -> [UInt8] { [UInt8](d) }

    func testTheTocSaysHowLongAPacketIs() {
        XCTAssertEqual(960, OpusPacket.samples([0xFC]))          // CELT 20 ms, one frame
        XCTAssertEqual(1920, OpusPacket.samples([0xFD, 0, 0]))   // two frames
        XCTAssertEqual(960, OpusPacket.samples([0x08]))          // config 1: SILK NB 20 ms
        XCTAssertEqual(2880, OpusPacket.samples([0x18]))         // config 3: SILK NB 60 ms
        XCTAssertEqual(120, OpusPacket.samples([0x80]))          // config 16: CELT 2.5 ms
        XCTAssertEqual(5760, OpusPacket.samples([0x1B, 0x02]))   // 2 × 60 ms (code 3, 2 frames)
        XCTAssertNil(OpusPacket.samples([0x1B]))                 // code 3 without its count
        XCTAssertNil(OpusPacket.samples([0x1B, 0x03]))           // 180 ms: more than a packet may hold
        XCTAssertNil(OpusPacket.samples([]))
    }

    func testAWebMFileOfFFmpeg() throws {
        let s = try WebM.opus(bytes(AudioFixtures.monoWebM))
        XCTAssertEqual(1, s.head.channels)
        XCTAssertEqual(312, s.head.preSkip)
        XCTAssertEqual(48000, s.head.inputRate)
        XCTAssertGreaterThanOrEqual(s.packets.count, 15) // 0.3 s in 20 ms packets
        XCTAssertTrue(s.packets.allSatisfy { OpusPacket.samples($0) == 960 })
        let (track, _) = try WebM.demux(bytes(AudioFixtures.monoWebM))
        XCTAssertEqual("A_OPUS", track.codec)
        XCTAssertEqual(48000, track.rate)
        XCTAssertEqual(2, track.type)
    }

    func testALiveWebMAsMediaRecorderWritesIt() throws {
        // -live 1: the Segment's size is unknown. MediaRecorder leaves the Clusters' sizes unknown too:
        // rewrite every Cluster's two-byte size as the eight-byte "unknown".
        var b = bytes(AudioFixtures.liveWebM)
        XCTAssertNotNil(b.firstRange(of: [0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]))
        let known = try WebM.opus(b)
        var rewritten = 0
        var i = 0
        while let r = b[i...].firstRange(of: [0x1F, 0x43, 0xB6, 0x75]) {
            let at = r.upperBound
            XCTAssertEqual(0x40, b[at] & 0xC0) // a two-byte size
            b.replaceSubrange(at..<(at + 2), with: [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
            rewritten += 1
            i = at + 8
        }
        XCTAssertGreaterThan(rewritten, 0)
        let live = try WebM.opus(b)
        XCTAssertEqual(known.packets, live.packets)
        XCTAssertEqual(known.head, live.head)
        // Cut off in the middle of a block (the app was closed while recording): the whole blocks remain.
        let cut = try WebM.opus(Array(b.prefix(b.count - 20)))
        XCTAssertEqual(Array(known.packets.dropLast()), cut.packets)
    }

    func testAStereoWebM() throws {
        let s = try WebM.opus(bytes(AudioFixtures.stereoWebM))
        XCTAssertEqual(2, s.head.channels)
        XCTAssertFalse(s.packets.isEmpty)
    }

    func testAnOggFile() throws {
        let s = try Ogg.opus(bytes(AudioFixtures.monoOgg))
        XCTAssertEqual(1, s.head.channels)
        XCTAssertEqual(312, s.head.preSkip)
        XCTAssertEqual(Int64(312 + 14400), s.endGranule) // 0.3 s at 48 kHz after the pre-skip
        XCTAssertTrue(s.packets.allSatisfy { OpusPacket.samples($0) != nil })
        XCTAssertFalse(s.packets.contains { $0.starts(with: Array("OpusTags".utf8)) })
    }

    func testLacedBlocks() throws {
        // Header: timecode 0, flags with the lacing bits; then the laced frames.
        let a: [UInt8] = [1, 2, 3], b: [UInt8] = Array(repeating: 7, count: 300), c: [UInt8] = [9, 9]
        // Xiph: count-1, sizes as runs of 255.
        let xiph: [UInt8] = [0, 0, 0x02, 2, 3, 255, 45] + a + b + c
        XCTAssertEqual([a, b, c], try WebM.laced(xiph[...]))
        // EBML: the first size as a vint (0x83 = 3), then signed differences (+297 as a 2-byte vint, bias 8191).
        let diff = 297 + 8191
        let ebml: [UInt8] = [0, 0, 0x06, 2, 0x83, UInt8(0x40 | (diff >> 8)), UInt8(diff & 0xFF)] + a + b + c
        XCTAssertEqual([a, b, c], try WebM.laced(ebml[...]))
        // Fixed: equal sizes.
        let fixed: [UInt8] = [0, 0, 0x04, 1, 1, 2, 3, 4]
        XCTAssertEqual([[1, 2], [3, 4]], try WebM.laced(fixed[...]))
        XCTAssertThrowsError(try WebM.laced([0, 0, 0x04, 2, 1, 2][...])) // 2 bytes do not split in 3
        XCTAssertThrowsError(try WebM.laced([0, 0, 0x02, 1, 255][...]))  // a size that never ends
        XCTAssertEqual([[5, 6]], try WebM.laced([0, 0, 0x80, 5, 6][...])) // no lacing
    }

    func testWhatIsNotAContainer() {
        XCTAssertThrowsError(try WebM.opus([1, 2, 3, 4])) { XCTAssertEqual($0 as? OpusContainerError, .notWebM) }
        XCTAssertThrowsError(try Ogg.opus([0x4F, 0x67, 0x67, 0x53])) { XCTAssertEqual($0 as? OpusContainerError, .badHead) }
        XCTAssertThrowsError(try Ogg.opus(bytes(AudioFixtures.monoWebM)))
        // A WebM with only a video track.
        XCTAssertThrowsError(try WebM.opus([0x1A, 0x45, 0xDF, 0xA3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x8A,
                                            0x16, 0x54, 0xAE, 0x6B, 0x85, 0xAE, 0x83, 0x83, 0x81, 0x01])) {
            XCTAssertEqual($0 as? OpusContainerError, .noAudioTrack)
        }
        XCTAssertNil(OpusHead.parse(Array("OpusHeaX".utf8) + [UInt8](repeating: 0, count: 11)))
    }
}
