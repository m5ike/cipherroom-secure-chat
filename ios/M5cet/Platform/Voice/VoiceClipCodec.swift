// Voice messages as bytes (6.1 / 6.14).
//
// SENDING — the format is Android's, exactly (voice/Audio.encodeAac, Voice.clip,
// ui/parts/Composer.sendVoice): 16-bit mono PCM at 16 kHz (a recording; 24 kHz
// for a synthesized voice) encoded as AAC-LC, 48 kbit/s, in an MPEG-4 file —
// MIME audio/mp4, name "hlas-<ms>.m4a". Every client plays it: Android records
// it itself, the web's <audio> plays AAC in MP4 in Chrome, Edge, Safari and
// Firefox (validate.ts lets audio/mp4 through; Safari's own MediaRecorder sends
// the same), and AVFoundation encodes it natively — no transcoding, no new
// format, no interop break.
//
// RECEIVING — what the others send: AAC / MP4 (Android, Safari), WebM with Opus
// (Chrome, Edge, Firefox — MediaRecorder's first choice), Ogg with Opus, MP3 /
// WAV (the server's speech module, Piper). AVFoundation opens MP4, MP3, WAV, CAF,
// AAC and FLAC; WebM and Ogg it does not, so they are taken apart
// (OpusContainers) and their Opus packets decoded by AudioToolbox's Opus decoder
// (kAudioFormatOpus, on the device — nothing leaves the phone). `playable`
// returns bytes AVAudioPlayer opens: the original when it can, else a WAV of the
// decoded audio (24 kHz mono: speech).

import AVFoundation
import Foundation

enum VoiceClipError: Error, Equatable, CustomStringConvertible {
    case empty, encoder(String), decoder(String), unsupported(String)

    var description: String {
        switch self {
        case .empty: "no audio"
        case .encoder(let m): "encoder: \(m)"
        case .decoder(let m): "decoder: \(m)"
        case .unsupported(let m): "unsupported audio: \(m)"
        }
    }
}

/// An audio clip: encoded bytes, their MIME type, duration, and the PCM it came from (nil when unknown).
struct VoiceClip: Sendable, Equatable {
    var bytes: Data
    var mime: String
    var durationMs: Int64
    var pcm: Pcm16?

    /// The file name a voice message travels under (Android Composer: "hlas-<ms>.m4a").
    static func fileName(at ms: Int64) -> String { "hlas-\(ms).m4a" }
    static let mime = "audio/mp4"
}

enum VoiceClipCodec {
    /// AAC-LC bit rate (Android's KEY_BIT_RATE).
    static let bitRate = 48_000

    /// What a voice message is made of: the container and the codec, for the settings' "About" and the tests.
    static let sendFormat = "AAC-LC, 48 kbit/s, mono, MPEG-4 (audio/mp4, .m4a)"

    private static func tempURL(_ ext: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("m5-\(UUID().uuidString).\(ext)")
    }

    private static func writeProtected(_ data: Data, ext: String) throws -> URL {
        let url = tempURL(ext)
        try data.write(to: url, options: [.completeFileProtection, .atomic])
        return url
    }

    // MARK: encode

    /// Recorded PCM → an AAC clip (a voice message), as Android's Voice.clip.
    static func clip(_ pcm: Pcm16) throws -> VoiceClip {
        VoiceClip(bytes: try encodeAAC(pcm), mime: VoiceClip.mime, durationMs: pcm.durationMs, pcm: pcm)
    }

    /// PCM (16-bit mono) → AAC-LC in an MPEG-4 file. The file is written to the temporary directory with
    /// complete file protection and removed before this returns.
    static func encodeAAC(_ pcm: Pcm16) throws -> Data {
        guard !pcm.samples.isEmpty, pcm.rate > 0 else { throw VoiceClipError.empty }
        let url = tempURL("m4a")
        defer { try? FileManager.default.removeItem(at: url) }
        var settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Double(pcm.rate),
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: bitRate,
            AVEncoderBitRateStrategyKey: AVAudioBitRateStrategy_Constant,
        ]
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true)
        } catch {
            // A rate the encoder refuses 48 kbit/s at: let it choose the bit rate.
            settings[AVEncoderBitRateKey] = nil
            settings[AVEncoderBitRateStrategyKey] = nil
            do { file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true) }
            catch { throw VoiceClipError.encoder(error.localizedDescription) }
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(pcm.samples.count)) else {
            throw VoiceClipError.encoder("no buffer")
        }
        buffer.frameLength = AVAudioFrameCount(pcm.samples.count)
        pcm.samples.withUnsafeBufferPointer { src in
            buffer.int16ChannelData![0].update(from: src.baseAddress!, count: src.count)
        }
        do { try file.write(from: buffer) } catch { throw VoiceClipError.encoder(error.localizedDescription) }
        file.close()
        do {
            let data = try Data(contentsOf: url)
            guard data.count > 8 else { throw VoiceClipError.encoder("empty file") }
            // ExtAudioFile leaves ~23 kB of `free` padding between moov and mdat — more than a short voice
            // message itself; Android's MediaMuxer writes none. Dropped (the chunk offsets moved with it).
            return Mp4Compact.withoutFree(data)
        } catch let e as VoiceClipError { throw e } catch { throw VoiceClipError.encoder(error.localizedDescription) }
    }

    // MARK: decode

    /// The container of some audio bytes, by its magic (the MIME type only as a hint).
    enum Container: String, Sendable { case mp4, webm, ogg, wav, mp3, caf, flac, aac, unknown }

    static func container(_ b: [UInt8], mime: String?) -> Container {
        if WebM.isWebM(b) { return .webm }
        if Ogg.isOgg(b) { return .ogg }
        if SpeakSendErrors.isWav(b) { return .wav }
        if b.count >= 12, b[4] == 0x66, b[5] == 0x74, b[6] == 0x79, b[7] == 0x70 { return .mp4 } // ....ftyp
        if b.count >= 4, b[0] == 0x63, b[1] == 0x61, b[2] == 0x66, b[3] == 0x66 { return .caf }  // caff
        if b.count >= 4, b[0] == 0x66, b[1] == 0x4C, b[2] == 0x61, b[3] == 0x43 { return .flac } // fLaC
        if b.count >= 3, b[0] == 0x49, b[1] == 0x44, b[2] == 0x33 { return .mp3 }               // ID3
        if b.count >= 2, b[0] == 0xFF, b[1] & 0xF6 == 0xF0 { return .aac }                        // ADTS
        if b.count >= 2, b[0] == 0xFF, b[1] & 0xE0 == 0xE0 { return .mp3 }                       // an MPEG frame
        let m = (mime ?? "").lowercased()
        if m.contains("mp4") || m.contains("m4a") { return .mp4 }
        if m.contains("mpeg") || m.contains("mp3") { return .mp3 }
        return .unknown
    }

    /// Any voice message or audio clip → 16-bit mono PCM (its own rate; Opus at 48 kHz).
    static func decode(_ data: Data, mime: String?) throws -> Pcm16 {
        let b = [UInt8](data)
        switch container(b, mime: mime) {
        case .webm:
            do { return try decodeOpus(try WebM.opus(b)) } catch let e as OpusContainerError { throw VoiceClipError.unsupported(e.description) }
        case .ogg:
            do { return try decodeOpus(try Ogg.opus(b)) } catch let e as OpusContainerError { throw VoiceClipError.unsupported(e.description) }
        case .wav:
            if let p = try? AudioPCM.readWav(b) { return p }
            return try decodeFile(data, ext: "wav")
        case .mp4: return try decodeFile(data, ext: "m4a")
        case .mp3: return try decodeFile(data, ext: "mp3")
        case .caf: return try decodeFile(data, ext: "caf")
        case .flac: return try decodeFile(data, ext: "flac")
        case .aac: return try decodeFile(data, ext: "aac")
        case .unknown: return try decodeFile(data, ext: "m4a")
        }
    }

    /// AVAudioFile (ExtAudioFile) for what AVFoundation opens; mixed to mono, 16-bit.
    private static func decodeFile(_ data: Data, ext: String) throws -> Pcm16 {
        let url = try writeProtected(data, ext: ext)
        defer { try? FileManager.default.removeItem(at: url) }
        let file: AVAudioFile
        do { file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false) }
        catch { throw VoiceClipError.decoder(error.localizedDescription) }
        let format = file.processingFormat
        let frames = AVAudioFrameCount(max(0, file.length))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { throw VoiceClipError.empty }
        do { try file.read(into: buffer) } catch { throw VoiceClipError.decoder(error.localizedDescription) }
        return Pcm16(samples: monoInt16(buffer), rate: Int(format.sampleRate.rounded()))
    }

    /// A float buffer (any channels) mixed down to 16-bit mono.
    static func monoInt16(_ buffer: AVAudioPCMBuffer, gain: Float = 1) -> [Int16] {
        let n = Int(buffer.frameLength), ch = Int(buffer.format.channelCount)
        guard n > 0, let data = buffer.floatChannelData else { return [] }
        var out = [Int16](repeating: 0, count: n)
        for i in 0..<n {
            var s: Float = 0
            for c in 0..<ch { s += data[c][i] }
            out[i] = AudioPCM.int16(s / Float(max(1, ch)) * gain)
        }
        return out
    }

    /// Opus packets → PCM with AudioToolbox's decoder: the pre-skip dropped, the true end kept (Ogg's
    /// last granule), the head's output gain applied.
    static func decodeOpus(_ stream: OpusStream) throws -> Pcm16 {
        let channels = max(1, min(2, stream.head.channels))
        guard !stream.packets.isEmpty else { throw VoiceClipError.empty }
        var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
                                               mFramesPerPacket: 960, mBytesPerFrame: 0, mChannelsPerFrame: UInt32(channels),
                                               mBitsPerChannel: 0, mReserved: 0)
        guard let input = AVAudioFormat(streamDescription: &asbd),
              let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: AVAudioChannelCount(channels), interleaved: false),
              let converter = AVAudioConverter(from: input, to: output) else {
            throw VoiceClipError.unsupported("this device has no Opus decoder")
        }
        let packets = stream.packets.filter { OpusPacket.samples($0) != nil }
        var index = 0
        var samples = [Int16]()
        samples.reserveCapacity(packets.reduce(0) { $0 + (OpusPacket.samples($1) ?? 0) })
        let gain = stream.head.gainFactor
        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 5760 * 4) else { throw VoiceClipError.decoder("no buffer") }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, inputStatus in
                guard index < packets.count else { inputStatus.pointee = .endOfStream; return nil }
                let p = packets[index]
                index += 1
                let cb = AVAudioCompressedBuffer(format: input, packetCapacity: 1, maximumPacketSize: p.count)
                p.withUnsafeBytes { cb.data.copyMemory(from: $0.baseAddress!, byteCount: p.count) }
                cb.byteLength = UInt32(p.count)
                cb.packetCount = 1
                cb.packetDescriptions?[0] = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: UInt32(OpusPacket.samples(p) ?? 960),
                                                                         mDataByteSize: UInt32(p.count))
                inputStatus.pointee = .haveData
                return cb
            }
            samples += monoInt16(out, gain: gain)
            if status == .error { throw VoiceClipError.decoder(error?.localizedDescription ?? "Opus") }
            if status == .endOfStream || (status == .inputRanDry && index >= packets.count) { break }
        }
        let skip = min(samples.count, stream.head.preSkip)
        var pcm = Array(samples[skip...])
        if let end = stream.endGranule, end > Int64(stream.head.preSkip) {
            let total = Int(end) - stream.head.preSkip
            if total >= 0 && total < pcm.count { pcm = Array(pcm[..<total]) }
        }
        guard !pcm.isEmpty else { throw VoiceClipError.empty }
        return Pcm16(samples: pcm, rate: 48_000)
    }

    // MARK: play

    /// Bytes AVAudioPlayer opens, and its file type hint: the original for what AVFoundation plays
    /// natively, a 24 kHz WAV of the decoded audio for WebM / Ogg (Opus).
    static func playable(_ data: Data, mime: String?) throws -> (data: Data, hint: String?) {
        let b = [UInt8](data.prefix(16))
        switch container(b, mime: mime) {
        case .webm, .ogg:
            let pcm = try decode(data, mime: mime)
            let speech = pcm.rate > 24_000 ? AudioPCM.resample(pcm, to: 24_000) : pcm
            return (AudioPCM.wavBytes(speech.samples, rate: speech.rate), AVFileType.wav.rawValue)
        case .mp4: return (data, AVFileType.m4a.rawValue)
        case .mp3: return (data, AVFileType.mp3.rawValue)
        case .wav: return (data, AVFileType.wav.rawValue)
        case .caf: return (data, AVFileType.caf.rawValue)
        case .aac: return (data, "public.aac-audio")
        case .flac: return (data, "org.xiph.flac")
        case .unknown: return (data, nil)
        }
    }
}
