// The room's actor (M5Proto RoomSession) talks to the app through two Sendable
// protocols, called on the actor: RoomTransport (the hub socket, the data
// channels) and RoomEvents (bubbles, peers, signals, files, profiles). This
// bridge keeps their order — every call becomes a FIFO hop to the main actor
// (DispatchQueue.main) or a FIFO stream to the hub connection — and answers
// "is this channel open" from a set the main actor keeps current.

import Foundation
import M5Core
import M5Crypto
import M5Proto

/// What reaches the room's actor, in the order it came (one pump per room).
enum RoomInput: Sendable {
    case socketOpened
    case socketClosed(Int)
    case hub(JSONObject)
    case channelOpened(String)
    case channelGone(String)
    case text(peer: String, String)
}

final class RoomBridge: RoomTransport, RoomEvents, @unchecked Sendable {
    private let lock = NSLock()
    private var openPeers = Set<String>()
    private let hubOut: AsyncStream<JSONObject>.Continuation
    /// The frames for the hub, in order (the controller's pump sends them on the connection).
    let hubFrames: AsyncStream<JSONObject>
    /// Read on the main actor only (inside the hops).
    nonisolated(unsafe) weak var controller: RoomController?

    init() {
        (hubFrames, hubOut) = AsyncStream<JSONObject>.makeStream(bufferingPolicy: .unbounded)
    }

    func finish() { hubOut.finish() }

    /// The main actor's channel state (RoomRtcLink: opened / closed, removePeer).
    func setOpen(_ peerId: String, _ open: Bool) {
        lock.withLock { if open { openPeers.insert(peerId) } else { openPeers.remove(peerId) } }
    }

    func clearOpen() { lock.withLock { openPeers.removeAll() } }

    private func main(_ body: @escaping @MainActor (RoomController) -> Void) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let c = self?.controller else { return }
                body(c)
            }
        }
    }

    // MARK: RoomTransport

    func sendHub(_ frame: JSONObject) { hubOut.yield(frame) }

    func sendText(_ peerId: String, _ text: String) -> Bool {
        guard isOpen(peerId) else { return false }
        main { c in
            if c.wire?.sendText(text, to: peerId) != true { c.wireClosed(peerId) }
        }
        return true
    }

    func isOpen(_ peerId: String) -> Bool { lock.withLock { openPeers.contains(peerId) } }

    // MARK: RoomEvents

    func added(_ message: ChatMessage, fresh: Bool) { main { $0.coreAdded(message, fresh: fresh) } }
    func changed(_ message: ChatMessage) { main { $0.coreChanged(message) } }
    func roomChanged() { main { $0.coreRoomChanged() } }
    func createPeer(_ peerId: String, name: String, initiator: Bool) { main { $0.wire?.addPeer(id: peerId, name: name, initiator: initiator) } }

    func dropPeer(_ peerId: String) {
        setOpen(peerId, false)
        main { c in
            c.wire?.removePeer(id: peerId)
            c.rooms?.core?.profiles?.peerGone(room: c, peerId: peerId)
        }
    }

    func signal(from peerId: String, _ description: JSONObject) { main { $0.wireReceive(description, from: peerId) } }
    func peerAudio(_ peerId: String, _ state: String) {
        main { c in
            c.wire?.peerAudioStatus(state, from: peerId)
            c.peerAudioChanged(state)
        }
    }
    func callWake(_ item: CallWake.Item) { main { $0.onRelayedWake(item) } }
    func fileFrame(_ peerId: String?, _ frame: JSONObject, proxy: Bool) { main { $0.files.onFrame(peerId, frame, proxy: proxy) } }
    func proxyFileKey(from: String, transferId: String, fk: Bytes, spk: String) { main { $0.files.proxyKey(from: from, transferId: transferId, fk: fk, spk: spk) } }
    func profileFrame(_ peerId: String, _ frame: JSONObject) { main { $0.profileFrame(peerId, frame) } }
    func profileHello(_ peerId: String, caps: [JSON]?) { main { $0.profileHello(peerId, caps: caps) } }
    func lockedState(messageId: String, who: String, name: String, state: String) { main { $0.lockedState(messageId: messageId, who: who, name: name, state: state) } }
    func joined(peerId: String, resume: String) { main { $0.joined(peerId: peerId, resume: resume) } }
}
