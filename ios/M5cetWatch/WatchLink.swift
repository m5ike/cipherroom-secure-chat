// The watch's side of WatchConnectivity: snapshots come as the application context (also the one the system
// kept from before this launch), as messages while the app is open, and as replies to "sync"; requests go as
// messages with a reply when the iPhone is reachable (WatchConnectivity wakes M5cet there in the background),
// else into the user-info queue (the result comes back the same way). A message that fails is queued — the
// iPhone answers each request id once, so a copy that did arrive is not sent twice.

import Foundation
import os
import WatchConnectivity

@MainActor
final class WatchLink: WatchSending {
    static let log = Logger(subsystem: "cz.m5cet.app.watchkitapp", category: "link")

    let store: WatchStore
    private let session = WCSession.default
    private lazy var relay = WatchSessionRelay(owner: self)

    init(store: WatchStore) {
        self.store = store
        store.link = self
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        session.delegate = relay
        session.activate()
    }

    private var active: Bool { session.activationState == .activated }

    /// Asks the iPhone for the current snapshot (the app opened, the iPhone came in reach).
    func sync() {
        store.reachable = active && session.isReachable
        store.checkExpiry()
        guard store.reachable, let data = try? WatchEnvelope.request(WatchRequest(kind: .sync, at: store.clock())).encoded() else { return }
        session.sendMessageData(data, replyHandler: { [weak self] reply in
            Task { @MainActor in self?.received(reply) }
        }, errorHandler: { error in
            Self.log.info("sync failed: \((error as NSError).code, privacy: .public)")
        })
    }

    @discardableResult
    func send(_ request: WatchRequest) -> Bool {
        guard active, let data = try? WatchEnvelope.request(request).encoded(), data.count <= WatchWire.maxRequestBytes else {
            store.result(.refused(request.id, WatchResult.Reason.invalid))
            return true
        }
        guard session.isReachable else {
            queue(data)
            return false
        }
        let id = request.id
        session.sendMessageData(data, replyHandler: { [weak self] reply in
            Task { @MainActor in self?.received(reply) }
        }, errorHandler: { [weak self] _ in
            Task { @MainActor in
                self?.queue(data)
                self?.store.queued(id)
            }
        })
        return true
    }

    func cancelQueued() {
        for transfer in session.outstandingUserInfoTransfers { transfer.cancel() }
    }

    private func queue(_ data: Data) {
        session.transferUserInfo([WatchWire.key: data])
    }

    // MARK: from the relay

    fileprivate func activated() {
        store.reachable = active && session.isReachable
        // What the iPhone said last (kept by the system across launches): a snapshot, or an empty one.
        if let env = try? WatchEnvelope.decode(dictionary: session.receivedApplicationContext) { store.receive(env) }
        sync()
    }

    fileprivate func reachabilityChanged() {
        let was = store.reachable
        store.reachable = active && session.isReachable
        if store.reachable && !was { sync() }
    }

    fileprivate func received(_ data: Data) {
        guard !data.isEmpty else { return }
        do {
            store.receive(try WatchEnvelope.decode(data))
        } catch {
            Self.log.error("refused a payload from the iPhone: \(String(describing: error), privacy: .public)")
        }
    }
}

/// WCSessionDelegate (WatchConnectivity's queue) → the link on the main actor.
private final class WatchSessionRelay: NSObject, WCSessionDelegate, @unchecked Sendable {
    let owner: WatchLink

    init(owner: WatchLink) { self.owner = owner }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        Task { @MainActor in owner.activated() }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in owner.reachabilityChanged() }
    }

    func sessionCompanionAppInstalledDidChange(_ session: WCSession) {
        Task { @MainActor in owner.reachabilityChanged() }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let data = applicationContext[WatchWire.key] as? Data else { return }
        Task { @MainActor in owner.received(data) }
    }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        Task { @MainActor in owner.received(messageData) }
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        guard let data = userInfo[WatchWire.key] as? Data else { return }
        Task { @MainActor in owner.received(data) }
    }
}
