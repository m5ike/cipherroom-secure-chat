// CallVoiceAudioDevice with the real WebRTC M150 in the simulator: two factories, each with the device
// in synthetic mode (a generator for the "microphone", a sink for the "speaker"), one peer connection
// each, an audio track, offer / answer, host candidates. What one side captures arrives at the other —
// through Opus, SRTP and the mixer — and the taps change it on the way: the voice changer (MicFx) on
// the capture, the spoken text instead of the microphone in voice ↔ text mode, the utterances of the
// playout for the transcription. This is the path Platform/Calls gets when its factory uses the device.

import XCTest
@preconcurrency import WebRTC
@testable import M5cet

/// A peer connection's delegate that hands candidates to the other side.
private final class LoopDelegate: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    var onCandidate: ((RTCIceCandidate) -> Void)?
    private let lock = NSLock()
    private var stateValue: RTCPeerConnectionState = .new
    var state: RTCPeerConnectionState { lock.withLock { stateValue } }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) { onCandidate?(candidate) }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) { lock.withLock { stateValue = newState } }
}

/// What a synthetic "speaker" heard (thread-safe).
private final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var samples = [Int16]()
    func add(_ p: UnsafePointer<Int16>, _ n: Int) { lock.withLock { samples.append(contentsOf: UnsafeBufferPointer(start: p, count: n)) } }
    var all: [Int16] { lock.withLock { samples } }
    func clear() { lock.withLock { samples.removeAll() } }
}

/// A sine for the synthetic "microphone".
private final class Tone: @unchecked Sendable {
    private let lock = NSLock()
    private var phase = 0.0
    var hz: Double
    var amplitude: Double
    init(hz: Double, amplitude: Double) { self.hz = hz; self.amplitude = amplitude }
    func fill(_ p: UnsafeMutablePointer<Int16>, _ n: Int) {
        lock.withLock {
            for i in 0..<n {
                p[i] = Int16(amplitude * sin(phase))
                phase += 2 * Double.pi * hz / 48_000
                if phase > 2 * Double.pi { phase -= 2 * Double.pi }
            }
        }
    }
}

/// The power of one frequency (Goertzel), normalised by the length.
func tonePower(_ x: ArraySlice<Int16>, hz: Double, rate: Double) -> Double {
    let w = 2 * Double.pi * hz / rate, c = 2 * cos(w)
    var s1 = 0.0, s2 = 0.0
    for v in x { let s0 = Double(v) + c * s1 - s2; s2 = s1; s1 = s0 }
    let p = s1 * s1 + s2 * s2 - c * s1 * s2
    return p / Double(max(1, x.count))
}

@MainActor
final class CallVoiceDeviceTests: XCTestCase {
    private struct Side {
        let factory: RTCPeerConnectionFactory
        let pc: RTCPeerConnection
        let delegate: LoopDelegate
        let device: CallVoiceAudioDevice
        let taps: CallVoiceTaps
    }

    private func side(_ capture: @escaping @Sendable (UnsafeMutablePointer<Int16>, Int) -> Void,
                      _ playout: @escaping @Sendable (UnsafePointer<Int16>, Int) -> Void) -> Side {
        RTCInitializeSSL()
        let taps = CallVoiceTaps()
        let device = CallVoiceAudioDevice(taps: taps, synthetic: .init(capture: capture, playout: playout))
        let factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil, audioDevice: device)
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.iceServers = []
        config.bundlePolicy = .maxBundle
        let delegate = LoopDelegate()
        let pc = factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: delegate)!
        let track = factory.audioTrack(with: factory.audioSource(with: nil), trackId: "m5-audio-\(UUID().uuidString.prefix(6))")
        pc.add(track, streamIds: ["m5"])
        return Side(factory: factory, pc: pc, delegate: delegate, device: device, taps: taps)
    }

    private func connect(_ a: Side, _ b: Side) async throws {
        a.delegate.onCandidate = { [weak bpc = b.pc] c in bpc?.add(c) { _ in } }
        b.delegate.onCandidate = { [weak apc = a.pc] c in apc?.add(c) { _ in } }
        // Implicit descriptions, as RtcPeer negotiates: the offer, then the answer.
        try await RtcAsync.setLocal(a.pc)
        let offer = try XCTUnwrap(a.pc.localDescription)
        try await RtcAsync.setRemote(b.pc, RTCSessionDescription(type: offer.type, sdp: offer.sdp))
        try await RtcAsync.setLocal(b.pc)
        let answer = try XCTUnwrap(b.pc.localDescription)
        try await RtcAsync.setRemote(a.pc, RTCSessionDescription(type: answer.type, sdp: answer.sdp))
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline, a.delegate.state != .connected || b.delegate.state != .connected {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(.connected, a.delegate.state)
        XCTAssertEqual(.connected, b.delegate.state)
    }

    private func close(_ s: Side...) {
        for x in s { x.pc.close() }
    }

    /// Waits until `heard` holds `seconds` of audio, then returns its last `seconds`.
    private func listen(_ heard: Heard, seconds: Double) async throws -> ArraySlice<Int16> {
        heard.clear()
        let need = Int(48_000 * seconds)
        let deadline = Date().addingTimeInterval(seconds + 10)
        while heard.all.count < need, Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        let all = heard.all
        return all.suffix(need)
    }

    func testWhatOneSideCapturesTheOtherPlays() async throws {
        MicFx.use(VoiceFx.neutralParams)
        let tone = Tone(hz: 440, amplitude: 8000)
        let heardB = Heard()
        let a = side({ tone.fill($0, $1) }, { _, _ in })
        let b = side({ $0.update(repeating: 0, count: $1) }, { heardB.add($0, $1) })
        defer { close(a, b) }
        try await connect(a, b)
        XCTAssertTrue(a.device.isInitialized)
        XCTAssertTrue(a.device.isRecording)
        XCTAssertTrue(b.device.isPlaying)
        // Let the jitter buffer fill, then listen for a second.
        try await Task.sleep(for: .seconds(2))
        let x = try await listen(heardB, seconds: 1)
        let at440 = tonePower(x, hz: 440, rate: 48_000), at1000 = tonePower(x, hz: 1000, rate: 48_000)
        XCTAssertGreaterThan(at440, 50 * max(at1000, 1), "440 Hz \(at440), 1 kHz \(at1000)")
    }

    func testTheVoiceChangerChangesWhatGoesOut() async throws {
        // robot (ring modulation at 70 Hz): 440 Hz goes out as 370 + 510 Hz.
        MicFx.use(VoiceFx.preset("robot")!)
        defer { MicFx.use(VoiceFx.neutralParams) }
        let tone = Tone(hz: 440, amplitude: 8000)
        let heardB = Heard()
        let a = side({ tone.fill($0, $1) }, { _, _ in })
        let b = side({ $0.update(repeating: 0, count: $1) }, { heardB.add($0, $1) })
        defer { close(a, b) }
        try await connect(a, b)
        try await Task.sleep(for: .seconds(2))
        let x = try await listen(heardB, seconds: 1)
        let side1 = tonePower(x, hz: 370, rate: 48_000), side2 = tonePower(x, hz: 510, rate: 48_000), tone440 = tonePower(x, hz: 440, rate: 48_000)
        XCTAssertGreaterThan(min(side1, side2), 10 * max(tone440, 1), "370 \(side1) 510 \(side2) 440 \(tone440)")
    }

    func testVoiceToTextSpeaksIntoTheCallAndCutsWhatComesBack() async throws {
        MicFx.use(VoiceFx.neutralParams)
        let micA = Tone(hz: 300, amplitude: 8000) // the microphone A would have — replaced while active
        let heardB = Heard()
        let a = side({ micA.fill($0, $1) }, { _, _ in })
        let b = side({ $0.update(repeating: 0, count: $1) }, { heardB.add($0, $1) })
        defer { close(a, b) }
        // B transcribes: its playout is cut into utterances.
        let utterances = Heard()
        b.taps.onUtterance = { pcm in pcm.samples.withUnsafeBufferPointer { utterances.add($0.baseAddress!, $0.count) } }
        b.taps.setActive(true)
        // A is in voice ↔ text mode: silence, then 1.2 s of "speech" (a 1 kHz tone at 24 kHz, as a voice gives).
        a.taps.setActive(true)
        try await connect(a, b)
        try await Task.sleep(for: .seconds(1))
        let speech = (0..<28_800).map { Int16(9000 * sin(2 * Double.pi * 1000 * Double($0) / 24_000)) }
        a.taps.enqueue(Pcm16(samples: speech, rate: 24_000))
        // The utterance ends 700 ms after the speech: within a few seconds B has it.
        let deadline = Date().addingTimeInterval(10)
        while utterances.all.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        let u = utterances.all
        // All 1.2 s of the speech (not cut at half by the 24 → 48 kHz step) and the 0.7 s of quiet after it.
        XCTAssertGreaterThan(u.count, Int(48_000 * 1.85), "an utterance of 1.2 s + the quiet")
        XCTAssertGreaterThan(tonePower(u[...], hz: 1000, rate: 48_000), 50 * max(tonePower(u[...], hz: 300, rate: 48_000), 1),
                             "the spoken text, not A's microphone")
        XCTAssertEqual(0, a.taps.queuedSpeech)
    }
}
