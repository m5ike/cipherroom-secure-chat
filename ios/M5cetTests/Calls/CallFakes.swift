// Fakes of what the calls talk to: CallKit (provider, controller), the room
// list, the vault, the room session's link. They behave like the real ones
// where it matters: CallKit's completion handlers come later (the main
// queue), an accepted transaction performs its action on the provider's
// delegate (CallCenter) before the request completes.

import Foundation
import XCTest
@testable import M5cet

@MainActor
final class FakeProvider: CallProviding {
    enum Event: Equatable {
        case incoming(UUID, CallDisplay)
        case update(UUID, CallDisplay)
        case connecting(UUID)
        case connected(UUID)
        case ended(UUID, CallEndReason)
        case configured(CallProviderSettings)
    }

    var events: [Event] = []
    /// What CallKit answers an incoming report (false: Do Not Disturb, a blocked caller…).
    var acceptIncoming = true

    func reportIncoming(_ uuid: UUID, _ display: CallDisplay, done: @escaping @MainActor (Bool) -> Void) {
        events.append(.incoming(uuid, display))
        let ok = acceptIncoming
        DispatchQueue.main.async { MainActor.assumeIsolated { done(ok) } }
    }

    func reportUpdate(_ uuid: UUID, _ display: CallDisplay) { events.append(.update(uuid, display)) }
    func reportOutgoing(_ uuid: UUID, startedConnectingAt date: Date) { events.append(.connecting(uuid)) }
    func reportOutgoing(_ uuid: UUID, connectedAt date: Date) { events.append(.connected(uuid)) }
    func reportEnded(_ uuid: UUID, at date: Date, reason: CallEndReason) { events.append(.ended(uuid, reason)) }
    func configure(_ settings: CallProviderSettings) { events.append(.configured(settings)) }

    var incoming: [(UUID, CallDisplay)] {
        events.compactMap { if case let .incoming(u, d) = $0 { return (u, d) } else { return nil } }
    }

    var ended: [(UUID, CallEndReason)] {
        events.compactMap { if case let .ended(u, r) = $0 { return (u, r) } else { return nil } }
    }

    var connected: [UUID] { events.compactMap { if case let .connected(u) = $0 { return u } else { return nil } } }
    var connecting: [UUID] { events.compactMap { if case let .connecting(u) = $0 { return u } else { return nil } } }
}

@MainActor
final class FakeController: CallControlling {
    var requests: [CallRequest] = []
    /// false: CallKit refuses (as the simulator may).
    var accept = true
    weak var center: CallCenter?

    func request(_ request: CallRequest, done: @escaping @MainActor (Bool) -> Void) {
        requests.append(request)
        if accept, let center {
            switch request {
            case let .start(uuid, _): _ = center.performStart(uuid)
            case let .answer(uuid): _ = center.performAnswer(uuid)
            case let .end(uuid): _ = center.performEnd(uuid)
            case let .mute(uuid, m): _ = center.performMute(uuid, m)
            case let .hold(uuid, h): _ = center.performHold(uuid, h)
            }
        }
        let ok = accept
        DispatchQueue.main.async { MainActor.assumeIsolated { done(ok) } }
    }
}

@MainActor
final class FakeDirectory: CallRoomDirectory {
    var labels: [String: String] = [:]
    var onScreen: Set<String> = []
    var connected: [String] = []
    var opened: [String] = []
    var onConnect: ((String) -> Void)?

    func connect(roomKey: String) { connected.append(roomKey); onConnect?(roomKey) }
    func isOnScreen(roomKey: String) -> Bool { onScreen.contains(roomKey) }
    func open(roomKey: String) { opened.append(roomKey) }
    func label(ofRoom roomKey: String) -> String { labels[roomKey] ?? "" }
    func savedRoomKeys() -> [String] { Array(labels.keys).sorted() }
}

@MainActor
final class FakeVault: CallHistoryVault {
    var isUnlocked = true
    var data: Data?
    func readCalls() -> Data? { data }
    func writeCalls(_ data: Data) throws { self.data = data }
    func deleteCalls() { data = nil }
}

@MainActor
final class FakeEnvironment: CallEnvironment {
    var callSettings = CallSettings()
    var callPrivacy = CallPrivacy()
    var texts: [String: String] = [:]
    func text(_ key: String) -> String? { texts[key] }
}

/// The room session's side of a room: records what RoomRtc asks for.
@MainActor
final class RecordingLink: RoomRtcLink {
    var signals: [(String, RtcSignal)] = []
    var opened: [String] = []
    var closed: [String] = []
    var received: [(String, RtcDataFrame)] = []
    var statuses: [CallAudioState] = []

    func rtc(_ room: RoomRtc, sendSignal signal: RtcSignal, to peerId: String) { signals.append((peerId, signal)) }
    func rtc(_ room: RoomRtc, channelOpenedWith peerId: String) { opened.append(peerId) }
    func rtc(_ room: RoomRtc, channelClosedWith peerId: String) { closed.append(peerId) }
    func rtc(_ room: RoomRtc, received frame: RtcDataFrame, from peerId: String) { received.append((peerId, frame)) }
    func rtc(_ room: RoomRtc, broadcastAudioStatus status: CallAudioState) { statuses.append(status) }
}

/// Waits (on the main actor, letting the main queue run) until `condition` holds; false on time-out.
@MainActor
func eventually(_ timeout: TimeInterval = 5, _ condition: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
}

/// An engine for tests: no server to ask, no public STUN (host candidates are enough on one machine).
@MainActor
func testEngine() -> RtcEngine { RtcEngine(ice: IceConfigCache(source: nil, fallback: [])) }
