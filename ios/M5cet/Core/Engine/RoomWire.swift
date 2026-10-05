// A room's data channels and call as the room controller drives them — the
// seam between Core and Platform/Calls (RoomRtc, CallSystem). In the app every
// room attaches to CallSystem.shared (one RoomRtc per room: WebRTC peers, the
// "m5cet" data channel, the room's call, CallKit); tests attach to an
// in-memory loopback. Android: the Peer / Calls parts of chat/RoomSession.

import Foundation
import M5Core
import M5Proto

/// One peer's channel as the people list and the call screen read it.
struct WirePeer: Sendable, Equatable {
    let id: String
    let name: String
    /// "connecting" | "open" | "closed" (Android Peer.status).
    let status: String
    /// The peer's call audio: "off" | "live" | "muted".
    let audio: String
    /// The pair's round trip, ms; -1 unknown.
    let rttMs: Int64
}

/// A room's WebRTC side (RoomRtc in the app).
@MainActor
protocol RoomWire: AnyObject {
    /// The hub joined the room (TURN credentials can be had now).
    func roomJoined()
    func addPeer(id: String, name: String?, initiator: Bool)
    func renamePeer(id: String, name: String)
    func removePeer(id: String)
    /// An opened WebRTC signal ({type, sdp} / {candidate, sdpMid, sdpMLineIndex}).
    func receiveSignal(_ description: JSONObject, from peerId: String, name: String?)
    /// False when the peer's channel is not open.
    func sendText(_ text: String, to peerId: String) -> Bool
    func sendBinary(_ data: Data, to peerId: String) -> Bool
    func isOpen(_ peerId: String) -> Bool
    var openPeerIds: [String] { get }
    /// Waits while the peer's channel buffer is above its high-water mark (file chunks).
    func waitForBuffer(of peerId: String) async
    /// A peer's audio-status message.
    func peerAudioStatus(_ status: String, from peerId: String)
    var peerStates: [WirePeer] { get }
    /// My call here: "off" | "live" | "muted"; video on.
    var callState: String { get }
    var callVideo: Bool { get }
    /// 6.14 (call wake): the call I am starting is a video call (the camera comes after the audio).
    var callWantsVideo: Bool { get }
    func refreshStats() async
    /// The room left: every peer closed (the call recorded first).
    func disconnect()
}

extension RoomWire {
    var callWantsVideo: Bool { callVideo }
}

/// Where rooms attach their WebRTC side (CallSystem in the app; a fake in tests).
@MainActor
protocol RoomWireFactory: AnyObject {
    /// The room connects: its wire, with the controller as its link (RoomRtcLink).
    func attach(roomKey: String, label: String, controller: RoomController) -> any RoomWire
    /// The room went (left, forgotten, locked strictly, wiped).
    func detach(roomKey: String)
}

// MARK: - the app: Platform/Calls

/// CallSystem.shared as the rooms' wire factory.
@MainActor
final class CallSystemWires: RoomWireFactory {
    private var links: [String: RtcLinkAdapter] = [:]

    func attach(roomKey: String, label: String, controller: RoomController) -> any RoomWire {
        let link = links[roomKey] ?? RtcLinkAdapter()
        link.controller = controller
        links[roomKey] = link
        let rtc = CallSystem.shared.attach(roomKey: roomKey, label: label, link: link)
        return RtcWire(rtc: rtc)
    }

    func detach(roomKey: String) {
        CallSystem.shared.detach(roomKey: roomKey)
        links[roomKey] = nil
    }
}

/// RoomRtcLink → the room controller (signals, channel open / close, frames, audio status).
@MainActor
final class RtcLinkAdapter: RoomRtcLink {
    weak var controller: RoomController?

    func rtc(_ room: RoomRtc, sendSignal signal: RtcSignal, to peerId: String) {
        guard let o = JSON.parseObject(String(decoding: signal.jsonData, as: UTF8.self)) else { return }
        controller?.wireSignal(o, to: peerId)
    }

    func rtc(_ room: RoomRtc, channelOpenedWith peerId: String) { controller?.wireOpened(peerId) }
    func rtc(_ room: RoomRtc, channelClosedWith peerId: String) { controller?.wireClosed(peerId) }

    func rtc(_ room: RoomRtc, received frame: RtcDataFrame, from peerId: String) {
        switch frame {
        case .text(let t): controller?.wireText(t, from: peerId)
        case .binary(let d): controller?.wireBinary(d, from: peerId)
        }
    }

    func rtc(_ room: RoomRtc, broadcastAudioStatus status: CallAudioState) { controller?.broadcastAudio(status.rawValue) }
}

/// RoomRtc as a RoomWire.
@MainActor
final class RtcWire: RoomWire {
    let rtc: RoomRtc
    init(rtc: RoomRtc) { self.rtc = rtc }

    func roomJoined() { rtc.roomJoined() }
    func addPeer(id: String, name: String?, initiator: Bool) { rtc.addPeer(id: id, name: name, initiator: initiator) }
    func renamePeer(id: String, name: String) { rtc.renamePeer(id: id, name: name) }
    func removePeer(id: String) { rtc.removePeer(id: id) }

    func receiveSignal(_ description: JSONObject, from peerId: String, name: String?) {
        guard let s = RtcSignal(jsonData: Data(description.stringify().utf8)) else { return }
        rtc.receiveSignal(s, from: peerId, name: name)
    }

    func sendText(_ text: String, to peerId: String) -> Bool { rtc.send(.text(text), to: peerId) }
    func sendBinary(_ data: Data, to peerId: String) -> Bool { rtc.send(.binary(data), to: peerId) }
    func isOpen(_ peerId: String) -> Bool { rtc.isOpen(peerId) }
    var openPeerIds: [String] { rtc.openPeerIds }
    func waitForBuffer(of peerId: String) async { _ = await rtc.waitForBuffer(of: peerId) }
    func peerAudioStatus(_ status: String, from peerId: String) { rtc.peerAudioStatus(status, from: peerId) }

    var peerStates: [WirePeer] {
        rtc.peers.map { WirePeer(id: $0.id, name: $0.name, status: $0.status.rawValue, audio: $0.audio.rawValue, rttMs: $0.stats?.rttMs ?? -1) }
    }

    var callState: String { rtc.audioState.rawValue }
    var callVideo: Bool { rtc.videoOn }
    var callWantsVideo: Bool { CallSystem.shared.center.call(forRoom: rtc.roomKey)?.video ?? rtc.videoOn }
    func refreshStats() async { await rtc.refreshStats() }
    func disconnect() { rtc.disconnect() }
}
