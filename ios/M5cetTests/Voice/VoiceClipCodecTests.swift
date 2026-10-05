// Voice messages on the wire: what iOS sends is Android's format (AAC-LC, 16 kHz, mono, ~48 kbit/s,
// MPEG-4, audio/mp4, hlas-<ms>.m4a), and iOS plays what every client sends — Android's AAC / MP4,
// Chrome's and Firefox's WebM / Opus (also as MediaRecorder writes it live), Ogg / Opus, WAV — decoded on
// the device (AudioToolbox's Opus decoder). The fixtures are real files of ffmpeg / libopus
// (AudioFixtures.swift).

import AVFoundation
import XCTest
@testable import M5cet

final class VoiceClipCodecTests: XCTestCase {
    private func sine(_ hz: Double, rate: Int, seconds: Double, amp: Double = 8000) -> [Int16] {
        (0..<Int(Double(rate) * seconds)).map { Int16(amp * sin(2 * Double.pi * hz * Double($0) / Double(rate))) }
    }

    /// The strongest of some candidate frequencies.
    private func strongest(_ x: [Int16], rate: Int, among hz: [Double]) -> Double {
        hz.max { tonePower(x[...], hz: $0, rate: Double(rate)) < tonePower(x[...], hz: $1, rate: Double(rate)) }!
    }

    private func rms(_ x: [Int16]) -> Double {
        (x.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(1, x.count))).squareRoot()
    }

    func testAVoiceMessageIsAndroidsFormat() throws {
        let pcm = Pcm16(samples: sine(300, rate: 16_000, seconds: 2), rate: 16_000)
        let clip = try VoiceClipCodec.clip(pcm)
        XCTAssertEqual("audio/mp4", clip.mime)
        XCTAssertEqual(2000, clip.durationMs)
        XCTAssertEqual("hlas-1760000000000.m4a", VoiceClip.fileName(at: 1_760_000_000_000))
        let b = [UInt8](clip.bytes)
        XCTAssertEqual(Array("ftyp".utf8), Array(b[4..<8]))                     // an ISO / MPEG-4 file
        XCTAssertEqual(.mp4, VoiceClipCodec.container(b, mime: nil))
        // The codec, rate and channels as a player sees them.
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID()).m4a")
        try clip.bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(kAudioFormatMPEG4AAC, file.fileFormat.streamDescription.pointee.mFormatID)
        XCTAssertEqual(0, file.fileFormat.streamDescription.pointee.mFormatFlags) // AAC-LC (no HE / SBR flag)
        XCTAssertEqual(16_000, file.fileFormat.sampleRate)
        XCTAssertEqual(1, file.fileFormat.channelCount)
        // 48 kbit/s (constant) for 2 s: about 12 kB of audio and 1 kB of header — no 23 kB `free` padding.
        XCTAssertTrue((11_000...15_000).contains(clip.bytes.count), "\(clip.bytes.count) B")
        XCTAssertNil(b.firstRange(of: Array("free".utf8)))
        // It decodes back to the same tone and length.
        let back = try VoiceClipCodec.decode(clip.bytes, mime: clip.mime)
        XCTAssertEqual(16_000, back.rate)
        XCTAssertEqual(Double(pcm.samples.count), Double(back.samples.count), accuracy: 1100)
        XCTAssertEqual(300, strongest(back.samples, rate: 16_000, among: [200, 300, 400]))
        XCTAssertEqual(rms(pcm.samples), rms(back.samples), accuracy: rms(pcm.samples) * 0.2)
    }

    func testDroppingThePaddingKeepsTheFilePlayable() throws {
        // ffmpeg's MP4 (Android-like): its padding goes, the chunk offsets move, the audio stays the same.
        let original = AudioFixtures.androidM4A
        let compact = Mp4Compact.withoutFree(original)
        let had = [UInt8](original).firstRange(of: Array("free".utf8)) != nil
        XCTAssertEqual(had, compact.count < original.count)
        XCTAssertEqual(try VoiceClipCodec.decode(original, mime: nil).samples, try VoiceClipCodec.decode(compact, mime: nil).samples)
        // A file without padding, and what is no MP4, stay as they are.
        XCTAssertEqual(compact, Mp4Compact.withoutFree(compact))
        XCTAssertEqual(AudioFixtures.monoWebM, Mp4Compact.withoutFree(AudioFixtures.monoWebM))
        // Broken boxes: left alone.
        var broken = [UInt8](original)
        broken[3] = 0xFF
        XCTAssertEqual(Data(broken), Mp4Compact.withoutFree(Data(broken)))
    }

    func testAndroidsVoiceMessagePlays() throws {
        let pcm = try VoiceClipCodec.decode(AudioFixtures.androidM4A, mime: "audio/mp4")
        XCTAssertEqual(16_000, pcm.rate)
        XCTAssertEqual(8000, Double(pcm.samples.count), accuracy: 1100) // 0.5 s
        XCTAssertEqual(300, strongest(pcm.samples, rate: 16_000, among: [200, 300, 440]))
        let (data, hint) = try VoiceClipCodec.playable(AudioFixtures.androidM4A, mime: "audio/mp4")
        XCTAssertEqual(AudioFixtures.androidM4A, data) // played as it is
        let player = try AVAudioPlayer(data: data, fileTypeHint: hint)
        XCTAssertEqual(0.5, player.duration, accuracy: 0.1)
    }

    func testChromesWebMOpusPlays() throws {
        let pcm = try VoiceClipCodec.decode(AudioFixtures.monoWebM, mime: "audio/webm;codecs=opus")
        XCTAssertEqual(48_000, pcm.rate)
        XCTAssertEqual(14_400, Double(pcm.samples.count), accuracy: 1000) // 0.3 s (the last frame padded)
        XCTAssertEqual(440, strongest(pcm.samples, rate: 48_000, among: [300, 440, 660]))
        // ffmpeg's sine: amplitude 1/8 → RMS 0.088 of full scale.
        XCTAssertEqual(2896, rms(Array(pcm.samples[2000..<12000])), accuracy: 600)
        let (wav, hint) = try VoiceClipCodec.playable(AudioFixtures.monoWebM, mime: "audio/webm")
        XCTAssertTrue(SpeakSendErrors.isWav([UInt8](wav.prefix(12))))
        XCTAssertEqual(24_000, try AudioPCM.readWav(wav).rate)
        let player = try AVAudioPlayer(data: wav, fileTypeHint: hint)
        XCTAssertEqual(0.3, player.duration, accuracy: 0.05)
    }

    func testALiveWebMAndAStereoOne() throws {
        let live = try VoiceClipCodec.decode(AudioFixtures.liveWebM, mime: nil)
        XCTAssertEqual(440, strongest(live.samples, rate: 48_000, among: [300, 440, 660]))
        let stereo = try VoiceClipCodec.decode(AudioFixtures.stereoWebM, mime: "audio/webm")
        XCTAssertEqual(660, strongest(stereo.samples, rate: 48_000, among: [440, 660, 880]))
        XCTAssertEqual(14_400, Double(stereo.samples.count), accuracy: 1000)
    }

    func testOggOpusEndsWhereItsGranuleSays() throws {
        let pcm = try VoiceClipCodec.decode(AudioFixtures.monoOgg, mime: "audio/ogg")
        XCTAssertEqual(48_000, pcm.rate)
        XCTAssertEqual(14_400, pcm.samples.count) // the pre-skip off the front, the padding off the end
        XCTAssertEqual(440, strongest(pcm.samples, rate: 48_000, among: [300, 440, 660]))
    }

    func testAWavPlaysAsItIs() throws {
        let wav = AudioPCM.wavBytes(sine(500, rate: 22_050, seconds: 0.2), rate: 22_050)
        let pcm = try VoiceClipCodec.decode(wav, mime: "audio/wav")
        XCTAssertEqual(22_050, pcm.rate)
        XCTAssertEqual(4410, pcm.samples.count)
        XCTAssertEqual(wav, try VoiceClipCodec.playable(wav, mime: nil).data)
    }

    func testWhatIsNotAudio() {
        XCTAssertThrowsError(try VoiceClipCodec.decode(Data([0x1A, 0x45, 0xDF, 0xA3, 0x80]), mime: "audio/webm"))
        XCTAssertThrowsError(try VoiceClipCodec.decode(Data("hello, not audio".utf8), mime: "audio/mp4"))
        XCTAssertThrowsError(try VoiceClipCodec.encodeAAC(Pcm16(samples: [], rate: 16_000)))
        XCTAssertEqual(.mp3, VoiceClipCodec.container(Array("ID3\u{3}".utf8), mime: nil))
        XCTAssertEqual(.aac, VoiceClipCodec.container([0xFF, 0xF1, 0x50], mime: nil))
        XCTAssertEqual(.mp3, VoiceClipCodec.container([0xFF, 0xFB, 0x90], mime: nil))
        XCTAssertEqual(.mp3, VoiceClipCodec.container([0, 0, 0], mime: "audio/mpeg"))
    }

    func testASynthesizedVoiceGoesAt24kHz() throws {
        // Android's wavClip: a voice above 24 kHz is resampled to 24 kHz, then AAC.
        let clip = try VoiceService.speechClip(Pcm16(samples: sine(220, rate: 48_000, seconds: 1), rate: 48_000))
        XCTAssertEqual(24_000, clip.pcm?.rate)
        XCTAssertEqual(1000, clip.durationMs)
        let back = try VoiceClipCodec.decode(clip.bytes, mime: clip.mime)
        XCTAssertEqual(24_000, back.rate)
        XCTAssertThrowsError(try VoiceService.speechClip(Pcm16(samples: [], rate: 24_000)))
    }
}
