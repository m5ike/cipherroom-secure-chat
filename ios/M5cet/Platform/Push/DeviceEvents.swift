// Events for the server (Android core/Events): security, updates, pushes —
// queued in the SYS tier (record "events", at most 500, readable while locked),
// sent in batches of 100 over the signed API (POST /api/ios/events) and kept
// until the server has them. Each has its own id, so a retry never counts twice.
//
// It is also a SecurityEvents (Platform/Security): handed to SecurityCenter, the
// lock's events (unlock-failed, lockout, key-invalidated, screenshot…) reach the
// console as Android's do.

import Foundation
import M5Net
import os

final class DeviceEvents: SecurityEvents, @unchecked Sendable {
    static let record = "events"
    static let keep = 500

    private let store: (any SyncStateStore)?
    private let memoryStore = NSLock()
    private var memory: [NetJSON] = []
    private let lock = NSLock()
    private var sending = false
    private let clock: NetClock
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "events")
    /// Sends one batch (DeviceService: POST /events); throws when it could not.
    var send: (@Sendable ([DeviceEvent]) async throws -> Void)?
    /// Called after an event is queued (DeviceService flushes a moment later).
    var onAdd: (@Sendable () -> Void)?

    /// `store` nil: in memory only (tests, previews).
    init(store: (any SyncStateStore)?, clock: NetClock = .system) {
        self.store = store
        self.clock = clock
    }

    private func pending() -> [NetJSON] {
        if let store { return store.loadNow(Self.record)?.arr("list") ?? [] }
        return memoryStore.withLock { memory }
    }

    private func save(_ list: [NetJSON]) {
        if let store { store.saveNow(Self.record, ["list": .array(list)]) } else { memoryStore.withLock { memory = list } }
    }

    // MARK: SecurityEvents

    func add(_ type: String, _ detail: [String: any Sendable]) {
        var d: [String: NetJSON] = [:]
        for (k, v) in detail { d[k] = NetJSON.from([k: v])?[k] ?? .string("\(v)") }
        add(type, detail: .object(d))
    }

    /// Queues one event ({id, type, at, detail}).
    func add(_ type: String, detail: NetJSON = .object([:])) {
        let e = DeviceEvent(type: type, at: clock.now(), detail: detail)
        lock.withLock {
            var list = pending()
            list.append(e.json)
            if list.count > Self.keep { list.removeFirst(list.count - Self.keep) }
            save(list)
        }
        logger.info("event \(type, privacy: .public)")
        onAdd?()
    }

    var queued: [DeviceEvent] {
        lock.withLock { pending() }.compactMap { j in
            guard !j.str("id").isEmpty else { return nil }
            return DeviceEvent(id: j.str("id"), type: j.str("type"), at: j.int("at"), detail: j.obj("detail") ?? .object([:]))
        }
    }

    /// Sends what is queued, a batch at a time; waits quietly for the next chance when it cannot.
    @discardableResult
    func flush() async -> Bool {
        guard let send else { return false }
        while true {
            let batch: [DeviceEvent]? = lock.withLock {
                if sending { return nil }
                let all = queued0()
                if all.isEmpty { return nil }
                sending = true
                return Array(all.prefix(100))
            }
            guard let batch else { return true }
            do {
                try await send(batch)
            } catch {
                lock.withLock { sending = false }
                logger.debug("sending events later")
                return false
            }
            let sent = Set(batch.map(\.id))
            let more: Bool = lock.withLock {
                let rest = pending().filter { !sent.contains($0.str("id")) }
                save(rest)
                sending = false
                return !rest.isEmpty
            }
            if !more { return true }
        }
    }

    private func queued0() -> [DeviceEvent] {
        pending().compactMap { j in
            guard !j.str("id").isEmpty else { return nil }
            return DeviceEvent(id: j.str("id"), type: j.str("type"), at: j.int("at"), detail: j.obj("detail") ?? .object([:]))
        }
    }

    /// The wipe: nothing is left to send (the wipe's own report is the Wiper's).
    func forget() { lock.withLock { save([]) } }
}
