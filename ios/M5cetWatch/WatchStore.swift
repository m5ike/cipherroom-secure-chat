// What the watch shows: the last snapshot the iPhone sent (in memory only), the replies on their way, and the
// UI strings. The watch keeps no message on its own storage: the content lives in this object (the system's
// WatchConnectivity keeps the iPhone's last application context — which the iPhone replaces with an empty one at
// every lock, sign-out, "off" and wipe). Only the strings and the quick replies (the design's words, no content)
// are kept in UserDefaults so that "Locked on iPhone" reads in the person's language before the iPhone answers.
//
// The content goes when the iPhone says "locked" / "off", when a new generation starts (its old replies are
// dropped and their queued transfers cancelled), and when the snapshot's `exp` passes without a newer one (the
// iPhone out of reach while it may have locked — "iPhone not connected").

import Foundation
import Observation

/// Sends requests to the iPhone (WatchLink; the DEBUG sample has none).
@MainActor
protocol WatchSending: AnyObject {
    /// Sends now when the iPhone is reachable, else queues; the result comes to `WatchStore.result`.
    /// Returns whether it went now (false: queued).
    @discardableResult func send(_ request: WatchRequest) -> Bool
    /// Cancels the replies still queued for the iPhone (a new generation, a lock).
    func cancelQueued()
}

/// A reply on its way, shown under the room's messages (never stored).
struct PendingReply: Identifiable, Equatable, Sendable {
    enum State: Equatable, Sendable {
        case sending, queued
        /// The iPhone took it: the id it gave the message (it shows up in a later snapshot).
        case sent(String)
        /// Refused: a WatchResult reason.
        case failed(String)
    }

    let id: String
    let room: String
    let text: String
    var state: State
    let at: Int64
}

@MainActor
@Observable
final class WatchStore {
    enum Phase: Equatable, Sendable {
        /// Nothing from the iPhone yet; asking.
        case waiting
        case ok
        case locked
        case off
        /// No snapshot that may still be shown, and the iPhone out of reach.
        case away
    }

    /// The last accepted snapshot (its content only while `phase == .ok`).
    private(set) var current: WatchSnapshot?
    /// The content's lifetime passed without a newer snapshot.
    private(set) var expired = false
    /// The iPhone can be reached now (WatchConnectivity).
    var reachable = false
    private(set) var pending: [PendingReply] = []
    /// A short line to show once (after "Open on iPhone", a refused request).
    var notice: String?
    private(set) var strings: [String: String]
    private(set) var quick: [String]

    @ObservationIgnored weak var link: (any WatchSending)?
    @ObservationIgnored var clock: () -> Int64 = { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var expiry: Task<Void, Never>?
    @ObservationIgnored private var requests: [String: WatchRequest.Kind] = [:]

    static let stringsKey = "m5w.strings"
    static let quickKey = "m5w.quick"
    /// Replies that were sent or refused leave the list after this (ms).
    static let pendingLifetime: Int64 = 5 * 60_000

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        strings = Self.loadStrings(defaults)
        quick = (defaults.stringArray(forKey: Self.quickKey) ?? []).filter { !$0.isEmpty && WatchWire.isClean($0, max: WatchWire.maxQuickText) }
        if quick.isEmpty { quick = WatchWire.quickKeys.compactMap { WatchWire.english[$0] } }
    }

    // MARK: what the views read

    var phase: Phase {
        guard let c = current else { return reachable ? .waiting : .away }
        switch c.state {
        case .locked: return .locked
        case .off: return .off
        case .ok: return expired ? .away : .ok
        }
    }

    var rooms: [WatchRoom] { phase == .ok ? current?.rooms ?? [] : [] }
    var unread: Int { phase == .ok ? current?.unread ?? 0 : 0 }
    func room(_ id: String) -> WatchRoom? { rooms.first { $0.id == id } }
    func pending(in room: String) -> [PendingReply] { phase == .ok ? pending.filter { $0.room == room } : [] }

    /// A UI string: the iPhone's (the design's, in the person's language), else English.
    func t(_ key: String) -> String { strings[key] ?? WatchWire.english[key] ?? key }

    // MARK: from the iPhone

    /// A payload from the iPhone (application context, message, user info, a reply).
    func receive(_ envelope: WatchEnvelope) {
        if let s = envelope.snapshot { apply(s) }
        if let r = envelope.result { result(r) }
    }

    /// A snapshot, if it is newer than the one shown (in its generation by `seq`, a new generation by time).
    func apply(_ s: WatchSnapshot) {
        if let c = current {
            let older = s.epoch == c.epoch ? (s.seq <= c.seq) : (s.at < c.at)
            if older { return }
        }
        let newGeneration = s.epoch != current?.epoch
        current = s
        if newGeneration || s.state != .ok {
            // The old room ids mean nothing now; replies still queued for them would be refused anyway.
            pending.removeAll()
            requests.removeAll()
            link?.cancelQueued()
        }
        if s.reason == "wipe" {
            defaults.removeObject(forKey: Self.stringsKey)
            defaults.removeObject(forKey: Self.quickKey)
            strings = [:]
            quick = WatchWire.quickKeys.compactMap { WatchWire.english[$0] }
        } else {
            remember(strings: s.strings, quick: s.quick)
        }
        expired = s.state == .ok && s.exp <= clock()
        scheduleExpiry()
        prunePending()
    }

    /// The content's time ran out (also checked when the app comes back to the screen).
    func checkExpiry() {
        guard let c = current, c.state == .ok, !expired else { return }
        if c.exp <= clock() {
            expired = true
            notice = nil
        }
    }

    private func scheduleExpiry() {
        expiry?.cancel()
        guard let c = current, c.state == .ok, !expired else { return }
        let wait = max(0, c.exp - clock())
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(wait))
            guard !Task.isCancelled else { return }
            self?.checkExpiry()
        }
    }

    private func remember(strings new: [String: String], quick q: [String]) {
        if !new.isEmpty, new != strings {
            strings = new
            if let data = try? JSONEncoder().encode(new) { defaults.set(data, forKey: Self.stringsKey) }
        }
        if !q.isEmpty, q != quick {
            quick = q
            defaults.set(q, forKey: Self.quickKey)
        }
    }

    private static func loadStrings(_ defaults: UserDefaults) -> [String: String] {
        guard let data = defaults.data(forKey: stringsKey), data.count <= WatchWire.maxEnvelopeBytes,
              let o = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return o.filter { WatchWire.isStringKey($0.key) && WatchWire.isClean($0.value, max: WatchWire.maxStringValue) }
    }

    /// The iPhone's answer to a request.
    func result(_ r: WatchResult) {
        let kind = requests.removeValue(forKey: r.id)
        if let i = pending.firstIndex(where: { $0.id == r.id }) {
            pending[i].state = r.ok ? .sent(r.sent) : .failed(r.reason)
        }
        switch kind {
        case .open?: notice = r.ok ? t("watch.opened") : failure(r.reason)
        case .read?: if !r.ok { notice = failure(r.reason) }
        default: break
        }
        prunePending()
    }

    /// The words for a refused request.
    func failure(_ reason: String) -> String { reason == WatchResult.Reason.locked ? t("watch.reply.locked") : t("watch.reply.failed") }

    /// Sent replies that are in the room by now, and old ones, leave the list.
    private func prunePending() {
        let now = clock()
        let shown = Set(current?.rooms.flatMap { $0.messages ?? [] }.map(\.id) ?? [])
        pending.removeAll { p in
            if case .sent(let id) = p.state, !id.isEmpty, shown.contains(id) { return true }
            if case .sending = p.state { return false }
            if case .queued = p.state { return false }
            return now - p.at > Self.pendingLifetime
        }
    }

    // MARK: to the iPhone

    /// A reply (dictated, written, a quick one) to a room.
    func reply(_ room: String, _ text: String) {
        let body = WatchWire.clean(text, max: WatchWire.maxReply, lines: true)
        guard !body.isEmpty, let c = current, phase == .ok, self.room(room)?.reply == true else { return }
        let r = WatchRequest(kind: .reply, at: clock(), epoch: c.epoch, room: room, text: body)
        pending.append(PendingReply(id: r.id, room: room, text: body, state: .sending, at: r.at))
        requests[r.id] = .reply
        guard let link else { return }
        if !link.send(r) { queued(r.id) }
    }

    /// The request could not go now: it waits in the queue.
    func queued(_ id: String) {
        if let i = pending.firstIndex(where: { $0.id == id }), pending[i].state == .sending { pending[i].state = .queued }
    }

    /// The room's messages the watch showed were read.
    func markRead(_ room: String) {
        guard let c = current, phase == .ok, let r = self.room(room), let messages = r.messages else { return }
        let ids = messages.filter { !$0.mine }.suffix(WatchWire.maxReadIds).map(\.id)
        guard !ids.isEmpty else { return }
        let req = WatchRequest(kind: .read, at: clock(), epoch: c.epoch, room: room, ids: Array(ids))
        requests[req.id] = .read
        link?.send(req)
    }

    /// Makes the room the one M5cet on the iPhone shows.
    func openOnPhone(_ room: String) {
        guard let c = current, phase == .ok, self.room(room) != nil else { return }
        let req = WatchRequest(kind: .open, at: clock(), epoch: c.epoch, room: room)
        requests[req.id] = .open
        link?.send(req)
    }
}
