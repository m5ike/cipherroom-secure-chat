// The phone's side of WatchConnectivity behind a small protocol (the tests give a fake): the snapshot goes as
// the application context (the latest wins, delivered when the watch can take it — also after this app
// exits), and also as a message when the watch app is open; requests come as messages (answered by the reply)
// or through the user-info queue (answered by a user info back). Data only: every dictionary is [m5w: JSON].
//
// WCSession exists on iPhone only (`isSupported` is false on iPad): there the bridge is never installed.

import Foundation
import os
import WatchConnectivity

/// How a request came (and so how its answer goes back).
enum WatchChannel: Sendable, Equatable {
    /// sendMessage with a reply handler: the answer is the reply.
    case message
    /// sendMessage without a reply handler: no answer.
    case messageNoReply
    /// transferUserInfo: the answer goes back the same way.
    case queue
}

@MainActor
protocol WatchTransportHandler: AnyObject {
    /// Activation, pairing, the watch app installed or not, reachability changed.
    func transportChanged()
    /// A payload from the watch; the returned envelope (if any) answers it on its channel.
    func received(_ data: Data, channel: WatchChannel) -> Data?
}

@MainActor
protocol WatchTransport: AnyObject {
    var handler: (any WatchTransportHandler)? { get set }
    /// Activated, a watch paired and the watch app installed: something can be delivered.
    var canDeliver: Bool { get }
    /// The watch app is open (a message arrives now).
    var reachable: Bool { get }
    func activate()
    /// Replaces the application context (the watch keeps only the latest).
    func updateContext(_ data: Data) throws
    /// Best effort, now (the watch app is open).
    func sendMessage(_ data: Data)
    /// Queued, delivered in order, also later.
    func transferUserInfo(_ data: Data)
}

/// WCSession.default.
@MainActor
final class WCSessionTransport: WatchTransport {
    static var supported: Bool { WCSession.isSupported() }
    static let log = Logger(subsystem: "cz.m5cet.app", category: "watch")

    weak var handler: (any WatchTransportHandler)?
    private let session = WCSession.default
    private lazy var relay = WCSessionRelay(owner: self)

    func activate() {
        session.delegate = relay
        session.activate()
    }

    var canDeliver: Bool { session.activationState == .activated && session.isPaired && session.isWatchAppInstalled }
    var reachable: Bool { session.activationState == .activated && session.isReachable }

    func updateContext(_ data: Data) throws { try session.updateApplicationContext([WatchWire.key: data]) }

    func sendMessage(_ data: Data) {
        session.sendMessageData(data, replyHandler: nil) { error in
            // The application context still carries it; only the name of the failure is logged.
            Self.log.info("watch message not delivered: \((error as NSError).code, privacy: .public)")
        }
    }

    func transferUserInfo(_ data: Data) { session.transferUserInfo([WatchWire.key: data]) }

    fileprivate func changed() {
        // A watch switch (another watch paired): the session must be activated again for the new one.
        if session.activationState == .notActivated { session.activate() }
        handler?.transportChanged()
    }

    fileprivate func received(_ data: Data, channel: WatchChannel) -> Data? { handler?.received(data, channel: channel) }
}

/// A reply handler handed to the main actor (WatchConnectivity calls it from its own queue; calling it once
/// from any thread is fine).
private final class ReplyBox: @unchecked Sendable {
    let send: (Data) -> Void
    init(_ send: @escaping (Data) -> Void) { self.send = send }
}

/// WCSessionDelegate (called on WatchConnectivity's queue) → the transport on the main actor.
private final class WCSessionRelay: NSObject, WCSessionDelegate, @unchecked Sendable {
    let owner: WCSessionTransport

    init(owner: WCSessionTransport) { self.owner = owner }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        Task { @MainActor in owner.changed() }
    }

    func sessionDidBecomeInactive(_ session: WCSession) { Task { @MainActor in owner.changed() } }
    func sessionDidDeactivate(_ session: WCSession) { Task { @MainActor in owner.changed() } }
    func sessionWatchStateDidChange(_ session: WCSession) { Task { @MainActor in owner.changed() } }
    func sessionReachabilityDidChange(_ session: WCSession) { Task { @MainActor in owner.changed() } }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
        let reply = ReplyBox(replyHandler)
        Task { @MainActor in
            reply.send(owner.received(messageData, channel: .message) ?? Data())
        }
    }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        Task { @MainActor in _ = owner.received(messageData, channel: .messageNoReply) }
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        guard let data = userInfo[WatchWire.key] as? Data else { return }
        Task { @MainActor in _ = owner.received(data, channel: .queue) }
    }
}
