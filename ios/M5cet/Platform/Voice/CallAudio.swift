// Audio ↔ text calls (6.1) and the voice changer in calls (6.7) — port of
// android/app/src/main/java/cz/m5cet/app/voice/CallAudio.java. While a room's
// call runs in this mode:
//  - out: what I write is spoken (VoiceSpeech.synthesize) into the call — the
//    captured microphone buffer is replaced by the speech (silence between
//    utterances);
//  - in: the call's audio is cut into utterances (energy, 700 ms of quiet, at
//    most 15 s) and transcribed on the phone (Dictation.recognize — on the
//    device only); the text comes into the chat as that peer's message, the
//    utterance kept (AAC, encrypted in the vault) behind the bubble's "source".
// Out of this mode the microphone's buffer goes through the voice changer
// (MicFx) before WebRTC encodes it.
//
// How the audio gets here — the difference to Android: Android's WebRTC build
// gives each remote track a sink (AudioTrackSink) and the capture buffer a
// callback (JavaAudioDeviceModule). The iOS WebRTC (stasel M150, Google's ObjC
// SDK) has neither: RTCAudioTrack has no sink and the built-in audio device no
// capture hook. What the SDK does have is a custom audio device
// (RTCAudioDevice): CallVoiceAudioDevice (CallVoiceAudioDevice.swift) runs the
// VoiceProcessingIO unit itself and passes every capture buffer through
// `CallVoiceTaps.processCapture` and every playout buffer through
// `processPlayout`. Platform/Calls must create its factory with it
// (RtcEngine: `RTCPeerConnectionFactory(encoderFactory:decoderFactory:audioDevice:
// CallVoiceAudioDevice.shared)`) — until it does, calls run without the voice
// changer and without voice ↔ text (the bridge stays idle). The playout is the
// MIX of everyone: who spoke is told by the peers' inbound audio energy
// (CallVoicePeers, WebRTC statistics), which is exact with one other person and
// a best guess when several talk at once.

import Foundation
import M5Core
@preconcurrency import WebRTC

// MARK: - cutting utterances (pure)

/// Android CallAudio.Listener.onData: an utterance ends after 700 ms of quiet (or at 15 s); shorter than
/// 300 ms of voice is dropped. RMS > 600 (16-bit) is voice.
struct UtteranceCutter: Sendable {
    static let threshold = 600.0
    static let quietMs: Int64 = 700
    static let maxMs: Int64 = 15_000
    static let minMs: Int64 = 300

    private(set) var rate: Int
    private var pcm: [Int16] = []
    private var quietMs: Int64 = 0
    private var voicedMs: Int64 = 0

    init(rate: Int) { self.rate = rate }

    /// Mono frames in; a finished utterance (at `rate`) out, nil while it goes on.
    mutating func feed(_ mono: UnsafeBufferPointer<Int16>, rate r: Int) -> Pcm16? {
        guard !mono.isEmpty else { return nil }
        if r != rate { rate = r; pcm.removeAll(); quietMs = 0; voicedMs = 0 }
        var sum: Int64 = 0
        for s in mono { sum += Int64(s) * Int64(s) }
        let rms = (Double(sum) / Double(mono.count)).squareRoot()
        let ms = Int64(mono.count) * 1000 / Int64(max(1, r))
        if rms > Self.threshold { voicedMs += ms; quietMs = 0 } else { quietMs += ms }
        if voicedMs > 0 { pcm.append(contentsOf: mono) }
        guard voicedMs > 0, quietMs > Self.quietMs || voicedMs > Self.maxMs else { return nil }
        let utterance = pcm, spoke = voicedMs
        pcm.removeAll(keepingCapacity: true)
        voicedMs = 0
        quietMs = 0
        return spoke > Self.minMs ? Pcm16(samples: utterance, rate: r) : nil
    }

    mutating func feed(_ mono: [Int16], rate r: Int) -> Pcm16? { mono.withUnsafeBufferPointer { feed($0, rate: r) } }
}

// MARK: - the audio thread's side

/// What the call's audio device does to each buffer (thread-safe: the device's I/O thread calls it).
final class CallVoiceTaps: @unchecked Sendable {
    /// The app's (CallVoiceBridge.shared and CallVoiceAudioDevice.shared share it).
    static let shared = CallVoiceTaps()

    private let lock = NSLock()
    private var active = false
    private var speech: [Pcm16] = []
    private var current: Pcm16?
    private var currentAt = 0
    private var fx: MicFx.Stream?
    private var fxRate = 0
    private var cutter = UtteranceCutter(rate: 48_000)
    private var mono = [Int16]()
    /// A finished utterance of the call's playout (on the I/O thread; hop to the main actor).
    var onUtterance: (@Sendable (Pcm16) -> Void)?

    var isActive: Bool { lock.withLock { active } }

    func setActive(_ on: Bool) {
        lock.withLock {
            active = on
            speech.removeAll()
            current = nil
            currentAt = 0
            cutter = UtteranceCutter(rate: cutter.rate)
        }
    }

    /// Speech to say into the call (queued after what is being said).
    func enqueue(_ pcm: Pcm16) {
        guard !pcm.samples.isEmpty else { return }
        lock.withLock { speech.append(pcm) }
    }

    var queuedSpeech: Int { lock.withLock { speech.count + (current == nil ? 0 : 1) } }

    /// The microphone's buffer (16-bit interleaved), in place: the queued speech or silence in voice ↔ text
    /// mode, else the voice changer (MicFx). Android CallAudio.onCapture.
    func processCapture(_ p: UnsafeMutablePointer<Int16>, frames: Int, channels: Int, rate: Int) {
        let ch = max(1, channels)
        lock.lock()
        defer { lock.unlock() }
        if !active {
            if fx == nil && !MicFx.active { return } // nothing to do: not a sample touched
            if fx == nil || fxRate != rate { fx = MicFx.Stream(rate: rate); fxRate = rate }
            fx?.process(p, frames: frames, channels: ch)
            return
        }
        for i in 0..<frames {
            var v: Int16 = 0
            // The current speech is over when its next sample would be past its end. (Android compares the
            // device-frame counter with the speech's length, which cuts a 24 kHz voice at half on a 48 kHz
            // device; here the speech's own position decides.)
            if let c = current, currentAt * c.rate / max(1, rate) >= c.samples.count { current = nil }
            if current == nil, !speech.isEmpty { current = speech.removeFirst(); currentAt = 0 }
            if let c = current {
                // Nearest-sample resampling from the speech's rate to the device's.
                let idx = currentAt * c.rate / max(1, rate)
                if idx < c.samples.count { v = c.samples[idx] }
                currentAt += 1
            }
            for k in 0..<ch { p[i * ch + k] = v }
        }
    }

    /// The call's playout (16-bit interleaved, what the speaker plays): cut into utterances when active.
    func processPlayout(_ p: UnsafePointer<Int16>, frames: Int, channels: Int, rate: Int) {
        let ch = max(1, channels)
        var done: Pcm16?
        lock.lock()
        if active {
            if mono.count < frames { mono = [Int16](repeating: 0, count: frames) }
            for f in 0..<frames {
                var s = 0
                for k in 0..<ch { s += Int(p[f * ch + k]) }
                mono[f] = Int16(s / ch)
            }
            done = mono.withUnsafeBufferPointer { cutter.feed(UnsafeBufferPointer(rebasing: $0[0..<frames]), rate: rate) }
        }
        let tell = onUtterance
        lock.unlock()
        if let done { tell?(done) }
    }
}

// MARK: - who is in the call

/// The call's peers as voice ↔ text needs them (Platform/Calls' RoomRtc; RoomRtcVoicePeers below).
@MainActor
protocol CallVoicePeers: AnyObject {
    /// The peers connected in the call now.
    var peerIds: [String] { get }
    /// Each peer's inbound audio energy so far (WebRTC statistics: inbound-rtp totalAudioEnergy).
    func audioEnergy() async -> [String: Double]
}

/// Who spoke an utterance: the only peer, else the one whose inbound audio energy grew most since the last
/// look (pure: the tests check it).
enum CallVoiceSpeaker {
    static func pick(peers: [String], before: [String: Double], after: [String: Double]) -> String? {
        if peers.count == 1 { return peers[0] }
        var best: (String, Double)?
        for p in peers {
            let grew = (after[p] ?? 0) - (before[p] ?? 0)
            if grew > 0, grew > (best?.1 ?? 0) { best = (p, grew) }
        }
        return best?.0 ?? peers.first
    }
}

/// RoomRtc (Platform/Calls) as CallVoicePeers: its open peers and their connections' statistics.
@MainActor
final class RoomRtcVoicePeers: CallVoicePeers {
    private weak var room: RoomRtc?

    init(room: RoomRtc) { self.room = room }

    var peerIds: [String] { room?.peers.filter { $0.status == .open }.map(\.id) ?? [] }

    func audioEnergy() async -> [String: Double] {
        var out = [String: Double]()
        for p in room?.peers ?? [] {
            guard let pc = p.pc else { continue }
            let report = await RtcAsync.statistics(pc)
            var e = 0.0
            for (_, s) in report where s.type == "inbound-rtp" {
                if case .string(let kind)? = s.values["kind"], kind != "audio" { continue }
                if case .number(let v)? = s.values["totalAudioEnergy"] { e += v }
            }
            out[p.id] = e
        }
        return out
    }
}

// MARK: - the bridge

@MainActor
final class CallVoiceBridge {
    static let shared = CallVoiceBridge()

    /// The audio thread's side (CallVoiceAudioDevice calls it).
    nonisolated let taps: CallVoiceTaps
    /// The phone's voice (VoiceService.shared.speech.synthesize by default).
    var synthesize: @MainActor (String) async -> Pcm16? = { await VoiceService.shared.speech.synthesize($0) }
    /// The phone's recogniser, on the device (VoiceService.shared.dictation.recognize by default).
    var recognize: @MainActor (Pcm16) async -> String? = { await VoiceService.shared.dictation.recognize($0) }
    /// Where the utterances are kept (Platform/Security); nil: not kept (no source icon).
    var vault: (any VoiceSourceVault)?
    /// The audio device runs (Platform/Calls made its factory with CallVoiceAudioDevice).
    var deviceInstalled: @MainActor () -> Bool = { CallVoiceAudioDevice.shared.isInitialized }

    typealias Sink = @MainActor (_ peerId: String, _ text: String, _ sourceId: String?) -> Void

    private(set) var active = false
    private var sink: Sink?
    private var peers: (any CallVoicePeers)?
    private var energy: [String: Double] = [:]
    private var jobs: [Pcm16] = []
    private var recognizing = false
    private var sourceCounter = 0

    init(taps: CallVoiceTaps = .shared) {
        self.taps = taps
        taps.onUtterance = { [weak self] pcm in
            Task { @MainActor in self?.heard(pcm) }
        }
    }

    /// Voice ↔ text can run (the call's audio passes this app's device).
    var available: Bool { deviceInstalled() }

    /// Starts the mode for a call: transcripts go to `sink` (the room session's addTranscript: "🎙 " + text).
    func start(peers: any CallVoicePeers, sink: @escaping Sink) {
        self.peers = peers
        self.sink = sink
        active = true
        jobs.removeAll()
        taps.setActive(true)
        Task { energy = await peers.audioEnergy() }
    }

    func stop() {
        active = false
        sink = nil
        peers = nil
        jobs.removeAll()
        taps.setActive(false)
    }

    // MARK: out

    /// Speaks text into the call; the recording's vault id (for the bubble's source icon), nil when not kept.
    func say(_ text: String) async -> String? {
        guard active, let pcm = await synthesize(text), active else { return nil }
        taps.enqueue(pcm)
        return keep(pcm)
    }

    // MARK: in

    private func heard(_ utterance: Pcm16) {
        guard active else { return }
        jobs.append(AudioPCM.resample(utterance, to: AudioPCM.rate))
        if !recognizing { next() }
    }

    /// One at a time: the recogniser is one.
    private func next() {
        guard active, !jobs.isEmpty else { recognizing = false; return }
        recognizing = true
        let pcm = jobs.removeFirst()
        Task { @MainActor in
            let text = await recognize(pcm)
            if let text, !text.javaTrimmed.isEmpty, active, let peers {
                let now = await peers.audioEnergy()
                let who = CallVoiceSpeaker.pick(peers: peers.peerIds, before: energy, after: now)
                energy = now
                if let who { sink?(who, text.javaTrimmed, keep(pcm)) }
            }
            next()
        }
    }

    /// The utterance as an AAC file in the vault (the source icon plays it); its id, or nil.
    private func keep(_ pcm: Pcm16) -> String? {
        guard let vault else { return nil }
        do {
            let clip = try VoiceClipCodec.clip(pcm)
            sourceCounter += 1
            let id = "src-\(Int64(Date().timeIntervalSince1970 * 1_000_000))-\(sourceCounter)"
            try vault.store(id: id, bytes: clip.bytes)
            return id
        } catch {
            M5Log.shared.warn("call", "source not kept: \(error)")
            return nil
        }
    }
}
