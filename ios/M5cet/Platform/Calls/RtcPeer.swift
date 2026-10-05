// One peer of a room: a WebRTC connection with the "m5cet" data channel
// (ordered, reliable), and perfect negotiation exactly as the web client and
// Android do it — whoever changes the session offers; on a collision the
// initiator (the one who joined later) ignores the other offer and the other
// side rolls its own back (implicit rollback). Signals of a peer are applied
// in the order they came (a candidate never overtakes its offer).
//
// Port of android/app/src/main/java/cz/m5cet/app/chat/Peer.java.
//
// Threads: WebRTC calls its delegates on its signaling thread. RtcPeerObserver
// turns every callback into a value (RtcPeerEvent) and hands it to the main
// queue in order (DispatchQueue.main is FIFO); everything else here runs on
// the main actor. The data channel's delegate is set on the signaling thread
// the moment the channel appears, so not even its first message is lost.

import Foundation
@preconcurrency import WebRTC

/// A peer connection's callbacks as values.
enum RtcPeerEvent: @unchecked Sendable {
    case candidate(RtcSignal)
    case negotiationNeeded
    case connectionState(RTCPeerConnectionState)
    case dataChannel(RTCDataChannel)
    case channelState(RTCDataChannelState)
    case message(RtcDataFrame)
    case track(RTCMediaStreamTrack, RTCRtpReceiver)
    case trackRemoved(RTCRtpReceiver)
}

/// The ObjC delegate of a peer connection and its data channel (any thread → main queue, in order).
final class RtcPeerObserver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
    private let deliver: @Sendable (RtcPeerEvent) -> Void

    init(deliver: @escaping @Sendable (RtcPeerEvent) -> Void) {
        self.deliver = deliver
    }

    // MARK: RTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) { deliver(.negotiationNeeded) }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        deliver(.candidate(.candidate(candidate: candidate.sdp, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex)))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        // Here, not on the main queue: a message the other side sends right away must find a delegate.
        dataChannel.delegate = self
        deliver(.dataChannel(dataChannel))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        deliver(.connectionState(newState))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
        if let track = transceiver.receiver.track { deliver(.track(track, transceiver.receiver)) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove rtpReceiver: RTCRtpReceiver) {
        deliver(.trackRemoved(rtpReceiver))
    }

    // MARK: RTCDataChannelDelegate

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        deliver(.channelState(dataChannel.readyState))
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        if let frame = RtcDataFrame(data: buffer.data, isBinary: buffer.isBinary) { deliver(.message(frame)) }
    }
}

/// Async work of one peer, one step after the other (on the main actor).
@MainActor
final class RtcSerialQueue {
    private var tail: Task<Void, Never>?
    private var generation = 0

    func enqueue(_ step: @escaping @MainActor () async -> Void) {
        let previous = tail
        let generation = self.generation
        tail = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, self.generation == generation else { return }
            await step()
        }
    }

    /// Drops what has not started yet.
    func cancel() {
        generation += 1
        tail = nil
    }
}

/// A weak reference the observer's closure can carry to the main queue.
private final class RtcPeerRef: @unchecked Sendable {
    weak var peer: RtcPeer?
}

@MainActor
final class RtcPeer {
    let id: String
    var name: String
    /// I joined after this peer: I create the data channel and win offer collisions.
    let initiator: Bool
    private(set) var status: RtcPeerStatus = .connecting
    /// The peer's audio-status (live / muted / off).
    var audio: CallAudioState = .off
    private(set) var remoteVideo: RTCVideoTrack?
    private(set) var remoteAudio: RTCAudioTrack?
    /// What we send it (the call's tracks).
    var senders: [RTCRtpSender] = []
    /// The link as getStats saw it last.
    var stats: RtcStatsSummary?

    private(set) var pc: RTCPeerConnection?
    private(set) var channel: RTCDataChannel?
    private var makingOffer = false
    private var ignoreOffer = false
    private var closed = false
    private let queue = RtcSerialQueue()
    private let ref = RtcPeerRef()
    private var observer: RtcPeerObserver!
    private weak var room: RoomRtc?
    private let engine: RtcEngine

    init(room: RoomRtc, engine: RtcEngine, id: String, name: String, initiator: Bool) {
        self.room = room
        self.engine = engine
        self.id = id
        self.name = name
        self.initiator = initiator
        let ref = self.ref
        observer = RtcPeerObserver { event in
            DispatchQueue.main.async { MainActor.assumeIsolated { ref.peer?.handle(event) } }
        }
        ref.peer = self
    }

    var isOpen: Bool { channel?.readyState == .open }
    /// Bytes waiting in the data channel (the file sender waits above RtcChannelSpec.highWater).
    var bufferedAmount: UInt64 { channel?.bufferedAmount ?? 0 }

    /// Makes the connection — after the ICE servers are known — and, as the initiator, the channel.
    func start() {
        queue.enqueue { [weak self] in await self?.open() }
    }

    private func open() async {
        let config = await engine.configuration()
        guard !closed, let room else { return }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = engine.factory.peerConnection(with: config, constraints: constraints, delegate: observer) else {
            CallLog.error("no peer connection")
            status = .closed
            room.peerChanged(self)
            return
        }
        self.pc = pc
        room.attachLocal(to: self)
        if initiator {
            let c = RTCDataChannelConfiguration()
            c.isOrdered = RtcChannelSpec.ordered
            if let dc = pc.dataChannel(forLabel: RtcChannelSpec.label, configuration: c) {
                dc.delegate = observer
                wire(dc)
            }
        }
    }

    // MARK: signals

    /// A signal from this peer, opened by the room session — applied in order.
    func receive(_ signal: RtcSignal) {
        queue.enqueue { [weak self] in await self?.apply(signal) }
    }

    private func apply(_ signal: RtcSignal) async {
        guard let pc, !closed else { return }
        switch signal {
        case let .description(type, sdp):
            let collision = type == .offer && (makingOffer || pc.signalingState != .stable)
            ignoreOffer = initiator && collision
            if ignoreOffer { return }
            do {
                try await RtcAsync.setRemote(pc, RTCSessionDescription(type: type == .offer ? .offer : .answer, sdp: sdp))
                if type == .offer {
                    try await RtcAsync.setLocal(pc)
                    sendLocal()
                }
            } catch {
                CallLog.error("set SDP: \(error.localizedDescription)")
            }
        case let .candidate(candidate, mid, index):
            do {
                try await RtcAsync.add(pc, RTCIceCandidate(sdp: candidate, sdpMLineIndex: index, sdpMid: mid))
            } catch {
                if !ignoreOffer { CallLog.info("candidate not added: \(error.localizedDescription)") }
            }
        }
    }

    /// The session changed here (a track, the channel): offer it (perfect negotiation).
    private func negotiate() {
        guard let pc, !closed else { return }
        makingOffer = true
        Task { @MainActor [weak self] in
            do {
                try await RtcAsync.setLocal(pc)
                self?.sendLocal()
            } catch {
                CallLog.error("negotiation failed: \(error.localizedDescription)")
            }
            self?.makingOffer = false
        }
    }

    private func sendLocal() {
        guard let d = pc?.localDescription, !closed else { return }
        let type: RtcSignal.SdpType
        switch d.type {
        case .offer: type = .offer
        case .answer: type = .answer
        default: return
        }
        room?.sendSignal(.description(type: type, sdp: d.sdp), to: id)
    }

    // MARK: the data channel

    private func wire(_ dc: RTCDataChannel) {
        channel = dc
        if dc.readyState == .open { channelOpened() }
    }

    private func channelOpened() {
        guard status != .open, !closed else { return }
        status = .open
        room?.channelOpened(self)
    }

    /// Sends one frame; false when the channel is not open (the room keeps it in its outbox).
    @discardableResult
    func send(_ frame: RtcDataFrame) -> Bool {
        guard let dc = channel, dc.readyState == .open else { return false }
        let w = frame.wire
        return dc.sendData(RTCDataBuffer(data: w.data, isBinary: w.isBinary))
    }

    // MARK: events

    private func handle(_ event: RtcPeerEvent) {
        guard !closed else { return }
        switch event {
        case let .candidate(signal):
            room?.sendSignal(signal, to: id)
        case .negotiationNeeded:
            negotiate()
        case let .connectionState(state):
            switch state {
            case .failed, .closed, .disconnected:
                if status != .closed { status = .closed; room?.peerChanged(self) }
            case .connected:
                if status == .closed && isOpen { status = .open; room?.peerChanged(self) }
            default: break
            }
        case let .dataChannel(dc):
            wire(dc)
        case let .channelState(state):
            if state == .open { channelOpened() }
            else if state == .closed, status != .closed { status = .closed; room?.channelClosed(self) }
        case let .message(frame):
            room?.received(frame, from: self)
        case let .track(track, receiver):
            engine.frameProtection?.protect(receiver: receiver, peerId: id)
            if let video = track as? RTCVideoTrack {
                if remoteVideo !== video { remoteVideo = video; room?.remoteVideoChanged(self) }
            } else if let audio = track as? RTCAudioTrack {
                remoteAudio = audio
                room?.remoteAudioArrived(self)
            }
        case let .trackRemoved(receiver):
            if let track = receiver.track, track === remoteVideo { remoteVideo = nil; room?.remoteVideoChanged(self) }
            if let track = receiver.track, track === remoteAudio { remoteAudio = nil }
        }
    }

    /// The peer's audio-status said "off": its video tile goes (Android Calls.onPeerAudio).
    func dropRemoteVideo() {
        remoteVideo = nil
    }

    // MARK: stats, close

    /// Reads the connection's statistics (RTT, candidates, bytes, codecs).
    func readStats() async -> RtcStatsSummary? {
        guard let pc, status == .open else { return nil }
        let report = await RtcAsync.statistics(pc)
        var all: [String: RtcStatsEntry] = [:]
        for (key, s) in report {
            all[key] = RtcStatsEntry(s.type, s.values)
        }
        let summary = RtcStatsSummary.parse(all, now: CallTrack.millis())
        stats = summary
        return summary
    }

    func close() {
        guard !closed else { return }
        closed = true
        queue.cancel()
        if let channel { channel.delegate = nil; channel.close() }
        channel = nil
        pc?.close()
        pc = nil
        status = .closed
        remoteVideo = nil
        remoteAudio = nil
        senders.removeAll()
        engine.frameProtection?.forget(peerId: id)
    }
}

/// WebRTC's completion handlers as async calls (resumed from WebRTC's thread).
enum RtcAsync {
    struct Stat: Sendable {
        var type: String
        var values: [String: RtcStatValue]
    }

    static func setLocal(_ pc: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
            pc.setLocalDescriptionWithCompletionHandler({ error in
                if let error { done.resume(throwing: error) } else { done.resume() }
            })
        }
    }

    static func setRemote(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
            pc.setRemoteDescription(sdp) { error in
                if let error { done.resume(throwing: error) } else { done.resume() }
            }
        }
    }

    static func add(_ pc: RTCPeerConnection, _ candidate: RTCIceCandidate) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
            pc.add(candidate) { error in
                if let error { done.resume(throwing: error) } else { done.resume() }
            }
        }
    }

    /// The report as values (read on WebRTC's thread, so nothing of it crosses threads).
    static func statistics(_ pc: RTCPeerConnection) async -> [String: Stat] {
        await withCheckedContinuation { (done: CheckedContinuation<[String: Stat], Never>) in
            pc.statistics(completionHandler: { report in
                var out: [String: Stat] = [:]
                for (key, s) in report.statistics {
                    var values: [String: RtcStatValue] = [:]
                    for (k, v) in s.values { if let x = RtcStatValue(v) { values[k] = x } }
                    out[key] = Stat(type: s.type, values: values)
                }
                done.resume(returning: out)
            })
        }
    }
}
