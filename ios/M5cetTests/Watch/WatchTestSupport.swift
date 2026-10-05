// Fakes for the watch bridge's tests: a WatchConnectivity that records what it was given, an environment with
// the switch, the lock and the privacy level in the test's hands, and a rooms model of any size built from
// PreviewRoom (Core/Preview) — fresh per test (CoreModels.shared is left alone).

import Foundation
import M5Core
import M5Design
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class FakeWatchTransport: WatchTransport {
    weak var handler: (any WatchTransportHandler)?
    var canDeliver = true
    var reachable = false
    var failContext = false
    private(set) var activated = 0
    private(set) var contexts: [Data] = []
    private(set) var messages: [Data] = []
    private(set) var userInfos: [Data] = []

    func activate() { activated += 1 }

    func updateContext(_ data: Data) throws {
        if failContext { throw NSError(domain: "WCErrorDomain", code: 7006) }
        XCTAssertLessThanOrEqual(data.count, WatchWire.snapshotBudget, "a snapshot over the budget")
        contexts.append(data)
    }

    func sendMessage(_ data: Data) { messages.append(data) }
    func transferUserInfo(_ data: Data) { userInfos.append(data) }

    /// The application context the watch would have now.
    var context: WatchSnapshot? { contexts.last.flatMap { try? WatchEnvelope.decode($0).snapshot } }
    var contextJSON: String { contexts.last.map { String(decoding: $0, as: UTF8.self) } ?? "" }
    var allJSON: String { (contexts + messages + userInfos).map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n") }

    func reset() { contexts = []; messages = []; userInfos = [] }
}

@MainActor
final class FakeWatchEnv: WatchEnvironment {
    var mirrorEnabled = true
    var unlocked = true
    var privacyLevel = WatchPrivacy.content
    var lang = "en"
    var appName = "M5cet"
    var texts: [String: String] = [:]

    func setMirrorEnabled(_ on: Bool) { mirrorEnabled = on }
    func text(_ key: String) -> String? { texts[key] }
}

/// Rooms of the test's making: saved rooms with a PreviewRoom session each (or none).
@MainActor
@Observable
final class FakeRooms: RoomsModel {
    var items: [RoomItem] = []
    var sessions: [String: PreviewRoom] = [:]
    var activeKey = ""
    private(set) var switched: [String] = []

    var loaded: Bool { true }
    var open: [any RoomModel] { sessions.values.sorted { $0.lastActivity > $1.lastActivity } }
    var selectedCount: Int { 0 }
    var connectedCount: Int { sessions.count }
    var unreadTotal: Int { items.reduce(0) { $0 + $1.unread } }
    var maxRooms: Int { 8 }
    var ktAlert: String { "" }

    /// Adds a room: `messages` texts (a session) or nil (saved only).
    @discardableResult
    func add(_ key: String, name: String, unread: Int = 0, messages: [String]?, at: Int64 = PreviewCore.t0) -> PreviewRoom? {
        var session: PreviewRoom?
        if let messages {
            let r = PreviewRoom(key: key, label: name, sample: false)
            r.messages = messages.enumerated().map { i, text in
                var m = ChatMessage()
                m.id = "\(key)-m\(i)"
                m.roomKey = key
                m.text = text
                m.senderName = "Alice"
                m.senderId = "peer-alice"
                m.createdAt = at + Int64(i) * 1000
                return m
            }
            r.unread = unread
            r.lastActivity = at + Int64(messages.count) * 1000
            sessions[key] = r
            session = r
        }
        items.append(RoomItem(key: key, name: name, room: key, users: 2, unread: unread, active: false, connected: session != nil,
                              status: session == nil ? "saved" : "joined", selected: session != nil))
        return session
    }

    func room(_ key: String) -> (any RoomModel)? { sessions[key] }
    func byServerId(_ id: String) -> (any RoomModel)? { nil }
    func saved(_ key: String) -> SavedRoom? { nil }
    func card(_ key: String) -> JSONObject? { nil }
    func switchTo(_ key: String) { switched.append(key); activeKey = key }
    func toggleSelected(_ key: String) {}
    func connectSelected() {}
    func leave(_ key: String) {}
    func forget(_ key: String) {}
    func join(room: String, passphrase: String, userName: String) -> String { "" }
    func clone(_ key: String) -> String? { nil }
    func update(_ oldKey: String, room: String, passphrase: String, userName: String) -> String? { nil }
    func setVisible(_ visible: Bool) {}
    func dismissKtAlert() {}
}

/// An account the test signs in and out.
@MainActor
@Observable
final class FakeWatchAccount: AccountModel {
    var signedIn = true
    var username = "bystry-sokol-7k3q"
    var scope: DesignValue { ["signedIn": .bool(signedIn)] }
    func bearer() async -> String { "" }
}

@MainActor
enum WatchTest {
    /// The sample core (team: every kind of message, family, project-x saved) — a fresh one.
    static func previewCore() -> CoreModels {
        CoreModels(rooms: PreviewRooms(), account: PreviewAccount())
    }

    static let now: Int64 = PreviewCore.t0 + 3_600_000

    /// A bridge on fakes, driven by hand (no observation, no timers).
    static func bridge(core: CoreModels, env: FakeWatchEnv = FakeWatchEnv(), transport: FakeWatchTransport = FakeWatchTransport()) -> WatchBridge {
        let b = WatchBridge(transport: transport, env: env)
        b.automatic = false
        b.core = { core }
        b.clock = { now }
        return b
    }

    /// Sends a request as the watch would and decodes the answer.
    static func ask(_ b: WatchBridge, _ r: WatchRequest, channel: WatchChannel = .message) -> WatchEnvelope? {
        let data = try! WatchEnvelope.request(r).encoded()
        return b.received(data, channel: channel).flatMap { try? WatchEnvelope.decode($0) }
    }
}

/// A clock the test moves.
@MainActor
final class WatchTestClock {
    var now = WatchTest.now
}
