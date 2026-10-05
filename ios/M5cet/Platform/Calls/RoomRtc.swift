// A room's WebRTC side: one peer connection per member (a mesh, like the web
// and Android), the "m5cet" data channel the chat runs over, and the room's
// call. Port of android/app/src/main/java/cz/m5cet/app/chat/Calls.java and the
// WebRTC parts of chat/RoomSession.java (createPeer, dropPeer, signals,
// onChannelOpen, broadcastAudio, refreshStats).
//
// Calls in a room, as the web client does them: no ringing on the wire —
// tracks are added to the existing peer connections (perfect negotiation
// renegotiates) and "audio-status" tells the others. Media is DTLS-SRTP end
// to end between the devices; the extra frame encryption of browsers ("media"
// in the hello) is not announced (MediaFrameProtection), so browsers talk to
// this app without it, as to Android.
//
// What a call was for me (incoming, outgoing, missed, declined — CallTrack)
// goes into the call history; a call someone else starts rings (CallCenter →
// CallKit). The room session drives everything here and answers RoomRtcLink.

import Foundation
import Observation
@preconcurrency import WebRTC

/// What a room's call tells the call center (CallKit) — CallCenter implements it.
@MainActor
protocol RoomCallEvents: AnyObject {
    /// Someone else started a call here and I am not in it.
    func roomCallRings(_ room: RoomRtc, who: String, video: Bool)
    /// The ring is over (I joined, declined, or the call ended).
    func roomCallRingOver(_ room: RoomRtc)
    /// Calls finished (CallTrack's records — already in the history).
    func roomCall(_ room: RoomRtc, recorded: [CallTrack.Record])
    /// Anything changed: my audio, the others' audio, the peers.
    func roomCallChanged(_ room: RoomRtc)
}

@MainActor
@Observable
final class RoomRtc {
    let roomKey: String
    /// The room's name (as saved on this device).
    var roomLabel: String

    /// The peers in the order they came.
    private(set) var peerOrder: [String] = []
    /// Bumped on every change of a peer or of the call (the views read it).
    private(set) var revision = 0
    /// My call here: off, live, muted.
    private(set) var audioState: CallAudioState = .off
    /// My camera is in the call.
    private(set) var videoOn = false
    /// The camera sends (off = black frames, no renegotiation — like the web).
    private(set) var cameraOn = true
    /// The front camera (the local preview is mirrored).
    private(set) var frontCamera = true
    /// CallKit put the call on hold (another call took the audio).
    private(set) var held = false
    private(set) var localVideo: RTCVideoTrack?
    /// When I joined the call.
    private(set) var startedAt: Date?

    @ObservationIgnored weak var link: (any RoomRtcLink)?
    @ObservationIgnored weak var events: (any RoomCallEvents)?
    @ObservationIgnored var history: AppCallHistory?
    @ObservationIgnored let engine: RtcEngine
    @ObservationIgnored var now: () -> Int64 = { CallTrack.millis() }

    @ObservationIgnored private var peerMap: [String: RtcPeer] = [:]
    @ObservationIgnored private var audioSource: RTCAudioSource?
    @ObservationIgnored private var audioTrack: RTCAudioTrack?
    @ObservationIgnored private var videoSource: RTCVideoSource?
    @ObservationIgnored private var camera: CameraCapture?
    @ObservationIgnored private var startingVideo = false
    @ObservationIgnored private var mutedBeforeHold = false
    @ObservationIgnored private var track = CallTrack()
    @ObservationIgnored private var recheck: Task<Void, Never>?
    @ObservationIgnored private var closed = false

    init(roomKey: String, label: String, engine: RtcEngine = .shared) {
        self.roomKey = roomKey
        self.roomLabel = label
        self.engine = engine
    }

    // MARK: - the room session's side

    /// The hub joined the room ("joined"): TURN credentials can be had now (6.12).
    func roomJoined() {
        closed = false
        engine.hubConnected()
    }

    /// A member to connect to: those listed in "joined" (I am the initiator — I came later),
    /// or one whose first signal arrives (receiveSignal makes it, not the initiator).
    func addPeer(id: String, name: String?, initiator: Bool) {
        guard !id.isEmpty, peerMap[id] == nil, !closed else { return }
        let shown = (name?.isEmpty ?? true) ? "peer-" + String(id.suffix(4)) : name!
        let p = RtcPeer(room: self, engine: engine, id: id, name: shown, initiator: initiator)
        peerMap[id] = p
        peerOrder.append(id)
        p.start()
        changed()
    }

    func renamePeer(id: String, name: String) {
        guard let p = peerMap[id], !name.isEmpty, p.name != name else { return }
        p.name = name
        changed()
    }

    /// A member left (or its connection went for good).
    func removePeer(id: String) {
        guard let p = peerMap.removeValue(forKey: id) else { return }
        peerOrder.removeAll { $0 == id }
        p.close()
        changed()
    }

    /// A signal the room session opened (Envelopes.openSignal): to its peer, in order; an unknown
    /// peer is made first (it joined after me and offers).
    func receiveSignal(_ signal: RtcSignal, from peerId: String, name: String? = nil) {
        if peerMap[peerId] == nil { addPeer(id: peerId, name: name, initiator: false) }
        peerMap[peerId]?.receive(signal)
    }

    /// One frame to one peer; false when its channel is not open.
    @discardableResult
    func send(_ frame: RtcDataFrame, to peerId: String) -> Bool {
        peerMap[peerId]?.send(frame) ?? false
    }

    /// The peers whose channel is open now (where a frame can go).
    var openPeerIds: [String] { peerOrder.filter { peerMap[$0]?.isOpen ?? false } }

    func isOpen(_ peerId: String) -> Bool { peerMap[peerId]?.isOpen ?? false }

    func peer(_ id: String) -> RtcPeer? { peerMap[id] }

    var peers: [RtcPeer] { peerOrder.compactMap { peerMap[$0] } }

    /// Bytes waiting in a peer's channel.
    func bufferedAmount(of peerId: String) -> UInt64 { peerMap[peerId]?.bufferedAmount ?? 0 }

    /// Waits while a peer's channel holds more than `limit` (file chunks: Android waits ≤ 10 s, 20 ms steps).
    /// False when the channel closed or the time ran out.
    func waitForBuffer(of peerId: String, below limit: UInt64 = RtcChannelSpec.highWater,
                       timeout: Duration = .seconds(10)) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while let p = peerMap[peerId], p.isOpen, p.bufferedAmount > limit {
            if clock.now >= deadline { return false }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return peerMap[peerId]?.isOpen ?? false
    }

    /// A peer's audio-status message (opened by the room session): "off" ends its video tile.
    func peerAudioStatus(_ status: String, from peerId: String) {
        guard let p = peerMap[peerId] else { return }
        p.audio = CallAudioState(rawValue: status) ?? .off
        if p.audio == .off && p.remoteVideo != nil { p.dropRemoteVideo() }
        changed()
    }

    /// Reads every open connection's statistics (the call screen, People).
    func refreshStats() async {
        for p in peers where p.status == .open { _ = await p.readStats() }
        changed(track: false)
    }

    /// The room's socket went (leave, offline): the call stops, the connections close.
    func disconnect() {
        stop()
        for p in peerMap.values { p.close() }
        peerMap.removeAll()
        peerOrder.removeAll()
        changed()
    }

    /// The room is going away: what was open is recorded now.
    func destroy() {
        disconnect()
        closed = true
        recheck?.cancel()
        apply(track.flush(now: now()))
    }

    // MARK: - from the peers

    func sendSignal(_ signal: RtcSignal, to peerId: String) {
        link?.rtc(self, sendSignal: signal, to: peerId)
    }

    func channelOpened(_ p: RtcPeer) {
        link?.rtc(self, channelOpenedWith: p.id)
        // Tells the peer how we are in the call ("off" too, like the web).
        link?.rtc(self, broadcastAudioStatus: audioState)
        changed()
    }

    func channelClosed(_ p: RtcPeer) {
        link?.rtc(self, channelClosedWith: p.id)
        changed()
    }

    func received(_ frame: RtcDataFrame, from p: RtcPeer) {
        link?.rtc(self, received: frame, from: p.id)
    }

    func peerChanged(_ p: RtcPeer) { changed() }

    func remoteVideoChanged(_ p: RtcPeer) { changed() }

    func remoteAudioArrived(_ p: RtcPeer) {
        if held { p.remoteAudio?.isEnabled = false }
        changed(track: false)
    }

    /// A new peer gets the live tracks.
    func attachLocal(to p: RtcPeer) {
        guard let pc = p.pc else { return }
        for t in [audioTrack as RTCMediaStreamTrack?, localVideo as RTCMediaStreamTrack?].compactMap({ $0 }) {
            if let sender = pc.add(t, streamIds: [RtcChannelSpec.label]) {
                p.senders.append(sender)
                engine.frameProtection?.protect(sender: sender, peerId: p.id)
            }
        }
    }

    // MARK: - the call

    var inCall: Bool { audioState != .off }

    /// The peers whose video shows (the call screen's tiles).
    var remoteVideoPeers: [RtcPeer] { peers.filter { $0.remoteVideo != nil } }

    /// The others whose audio is on (live or muted), by their names in the room.
    var liveNames: [String] { peers.filter { $0.audio != .off && $0.status != .closed }.map(\.name) }

    /// Someone else is in a call here now.
    var othersInCall: Bool { !liveNames.isEmpty }

    /// Turns my audio on: the track goes to every peer (renegotiation follows) and the others hear "live".
    func startAudio() {
        guard audioTrack == nil else { return }
        let factory = engine.factory
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let audio = factory.audioTrack(with: source, trackId: "m5-audio")
        audioSource = source
        audioTrack = audio
        add(audio)
        audioState = .live
        held = false
        startedAt = Date()
        link?.rtc(self, broadcastAudioStatus: .live)
        CallLog.info("audio on")
        changed()
    }

    /// Audio and the camera (the front one). False when there is no camera (the call stays audio).
    @discardableResult
    func startVideo() async -> Bool {
        startAudio()
        if localVideo != nil { return true }
        guard !startingVideo, CameraCapture.available else { return false }
        startingVideo = true
        defer { startingVideo = false }
        let source = engine.factory.videoSource()
        let camera = CameraCapture(source: source)
        guard await camera.start(front: true), audioTrack != nil else {
            await camera.stop()
            return false
        }
        let video = engine.factory.videoTrack(with: source, trackId: "m5-video")
        videoSource = source
        self.camera = camera
        localVideo = video
        frontCamera = camera.front
        cameraOn = true
        add(video)
        videoOn = true
        changed()
        return true
    }

    private func add(_ track: RTCMediaStreamTrack) {
        for p in peers {
            guard let pc = p.pc, let sender = pc.add(track, streamIds: [RtcChannelSpec.label]) else { continue }
            p.senders.append(sender)
            engine.frameProtection?.protect(sender: sender, peerId: p.id)
        }
    }

    func mute(_ muted: Bool) {
        guard let audioTrack, !held else { return }
        audioTrack.isEnabled = !muted
        audioState = muted ? .muted : .live
        link?.rtc(self, broadcastAudioStatus: audioState)
        changed()
    }

    /// CallKit's hold: my microphone off ("muted" to the others) and the others silent; and back.
    func setHold(_ on: Bool) {
        guard let audioTrack, on != held else { return }
        if on {
            mutedBeforeHold = audioState == .muted
            audioTrack.isEnabled = false
            for p in peers { p.remoteAudio?.isEnabled = false }
            held = true
            audioState = .muted
        } else {
            held = false
            audioTrack.isEnabled = !mutedBeforeHold
            for p in peers { p.remoteAudio?.isEnabled = true }
            audioState = mutedBeforeHold ? .muted : .live
        }
        link?.rtc(self, broadcastAudioStatus: audioState)
        changed()
    }

    /// Camera on / off in a video call (the track is disabled: black frames, no renegotiation — like the web).
    func toggleCamera() {
        guard let localVideo else { return }
        cameraOn.toggle()
        localVideo.isEnabled = cameraOn
        changed(track: false)
    }

    /// Front / back camera.
    func switchCamera() async {
        guard let camera else { return }
        await camera.switchCamera()
        frontCamera = camera.front
        changed(track: false)
    }

    /// Hangs up: the tracks go (renegotiation follows), the others hear "off".
    func stop() {
        let was = audioTrack != nil
        for p in peers {
            for s in p.senders { _ = p.pc?.removeTrack(s) }
            p.senders.removeAll()
            p.remoteAudio?.isEnabled = true
        }
        if let camera { Task { await camera.stop() } }
        camera = nil
        localVideo?.isEnabled = false
        localVideo = nil
        videoSource = nil
        audioTrack?.isEnabled = false
        audioTrack = nil
        audioSource = nil
        if was {
            let seconds = startedAt.map { Int(Date().timeIntervalSince($0)) } ?? 0
            link?.rtc(self, broadcastAudioStatus: .off)
            CallLog.info("call ended after \(seconds) s")
        }
        videoOn = false
        cameraOn = true
        held = false
        startedAt = nil
        audioState = .off
        changed()
    }

    /// I declined the ring (CallKit's decline): the call counts as declined unless I join it after all.
    func decline() {
        apply(track.decline())
    }

    // MARK: - CallTrack

    private func changed(track: Bool = true) {
        revision &+= 1
        if track { self.trackCall() }
        events?.roomCallChanged(self)
    }

    /// What the call is now for me (Calls.track).
    private func trackCall() {
        let peerVideo = peers.contains { $0.remoteVideo != nil && $0.audio != .off }
        apply(track.update(now: now(), meOn: audioState != .off, myVideo: videoOn, live: liveNames, peerVideo: peerVideo))
    }

    private func apply(_ s: CallTrack.Step) {
        for r in s.records { history?.record(r, roomKey: roomKey, room: roomLabel) }
        // In this order: a ring that is over gives its place to the missed call.
        if s.ringOver { events?.roomCallRingOver(self) }
        if s.ring { events?.roomCallRings(self, who: s.who, video: s.video) }
        if !s.records.isEmpty { events?.roomCall(self, recorded: s.records) }
        if s.recheckAt > 0 {
            recheck?.cancel()
            let wait = max(100, s.recheckAt - now() + 50)
            recheck = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(wait))
                guard !Task.isCancelled, let self else { return }
                self.trackCall()
            }
        }
    }
}
