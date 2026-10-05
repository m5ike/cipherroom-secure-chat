// M5cet on Apple Watch — the iPhone's side (6.14). The watch is a companion that never holds a secret: it
// gets no keys, no passphrases and no protocol state, derives nothing (Argon2id's 64 MiB is not for a watch)
// and talks to no server. The phone sends it a snapshot of what its own screens show — the rooms (an opaque
// id, the name, unread, state, a preview line) and the newest messages of the most recent open rooms — and
// the watch sends back what the person did: a reply (dictated, written, a quick reply), "mark read", "open on
// iPhone".
//
// When: only while M5cet is unlocked here (a PIN set up, the data key in memory) AND the person turned Apple
// Watch on (WatchSetting, off by default). Every lock (the menu, the auto-lock, the server's command, the
// suspension that forgets the key — LockParticipant), turning it off, a sign-out or another account, and the
// wipe (a Wiper teardown) replace the watch's snapshot with an empty one ("locked" / "off") at once and start a
// new generation: the old room ids and any reply still queued on the watch are refused from then on.
// How much: the notification privacy level (Settings › Notifications) exactly as Platform/Notifications draws
// a message the app decrypted itself (NotificationPrefs.localPrivacy("message"): the person's choice within the
// operator's maximum) — "neutral": rooms as "Conversation n", no senders, "New message"; "sender": + who;
// "room": + the room's name; "content" (the default): + the text. Sealed, hold-to-read, vanishing, hidden and
// held messages, media and positions never carry their content (WatchSnapshotBuilder).
//
// Wiring: one line in App/Bootstrap.swift (`WatchBridge.install(into:)`, after SecurityCenter). The bridge
// follows CoreModels.shared, the design's settings and the lock by observation (a burst of changes makes one
// snapshot after `debounce`), refreshes an unchanged snapshot every WatchWire.refreshMs (the watch hides content
// past its `exp`), and answers requests on the channel they came by (WatchTransport).
//
// Not here (other areas): the design's switch for `watch.on` and its texts (the iOS design's Settings ›
// Notifications, SettingsModel), Handoff to open the room on the iPhone (Info.plist NSUserActivityTypes + the
// app's onContinueUserActivity).

import Foundation
import M5Proto
import Observation
import os

@MainActor
final class WatchBridge: LockParticipant, WatchTransportHandler {
    /// The app's bridge (nil on iPad / before Bootstrap / in tests that make their own).
    static private(set) var shared: WatchBridge?
    static let log = Logger(subsystem: "cz.m5cet.app", category: "watch")
    /// How many answered request ids are remembered (a reply the watch re-sent through the queue goes once).
    static let rememberAnswers = 256

    let transport: any WatchTransport
    let env: any WatchEnvironment
    /// The core the snapshot is made from — read every time (Bootstrap may replace CoreModels.shared).
    var core: @MainActor () -> CoreModels = { CoreModels.shared }
    var clock: @MainActor () -> Int64 = { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
    /// Changes within this pause make one snapshot.
    var debounce: Duration = .milliseconds(400)
    /// Follows changes by itself (observation, the refresh timer); tests drive `publishNow` instead.
    var automatic = true

    /// The current generation's room ids.
    private(set) var ids = WatchRoomIds()
    private(set) var epoch = WatchWire.newId()
    private var seq: Int64 = 0
    /// The last snapshot the watch was given in this run (nil: none yet).
    private(set) var told: WatchSnapshot?
    private var account: String?
    private var scheduled: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var observing = 0
    private var observedCore: ObjectIdentifier?
    private var answered: [String: WatchResult] = [:]
    private var answeredOrder: [String] = []

    init(transport: any WatchTransport, env: any WatchEnvironment) {
        self.transport = transport
        self.env = env
        transport.handler = self
    }

    // MARK: installing

    /// App/Bootstrap.swift — after SecurityCenter.install (the lock and the wipe take part).
    static func install(into model: AppModel) {
        guard shared == nil, WCSessionTransport.supported else { return } // iPad: no watch
        let bridge = WatchBridge(transport: WCSessionTransport(), env: AppWatchEnvironment(model: model))
        shared = bridge
        if let security = SecurityCenter.shared {
            security.add(bridge)
            security.wiper.addTeardown("watch") { [weak bridge] in bridge?.wiped() }
        }
        model.design.actions.onSettingChanged { [weak bridge] key, _ in
            if key == WatchSetting.key || key.hasPrefix("notify.") || key == "lang" { bridge?.refresh() }
        }
        // Another design (a bundle) or language: the watch's strings anew (also while it shows "locked" / "off").
        model.design.onTextsChanged { [weak bridge] in bridge?.refresh() }
        model.onScenePhase { [weak bridge] _ in bridge?.refresh() }
        bridge.start()
    }

    func start() {
        transport.activate()
        observe()
        refresh()
    }

    // MARK: the switch

    var enabled: Bool { env.mirrorEnabled }

    /// The person's switch (the design's settings screen, once it has one).
    func setEnabled(_ on: Bool) {
        env.setMirrorEnabled(on)
        refresh()
    }

    /// What the watch may get now: off, locked, or content.
    func gate() -> WatchState {
        if !env.mirrorEnabled { return .off }
        if !env.unlocked { return .locked }
        return .ok
    }

    // MARK: publishing

    /// Something changed: leaving content (a lock, off) goes at once, new content after `debounce`.
    func refresh() {
        guard transport.canDeliver else { return }
        if observedCore != ObjectIdentifier(core()) { observe() }
        if gate() != .ok || told?.state != .ok || accountWillChange {
            scheduled?.cancel()
            scheduled = nil
            publishNow()
            return
        }
        guard scheduled == nil, automatic else { return }
        scheduled = Task { [weak self, debounce] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled, let self else { return }
            self.scheduled = nil
            self.publishNow()
        }
    }

    /// Makes the snapshot the watch should have and delivers it when it differs from the last one (or `force`).
    /// `as`: a state to tell regardless of the gate (the lock tells "locked" before its key is gone).
    @discardableResult
    func publishNow(force: Bool = false, as forced: WatchState? = nil) -> WatchSnapshot {
        let switched = accountChanged()
        let state = forced ?? gate()
        let now = clock()
        if state != .ok {
            if !force, !switched, let t = told, t.state == state { return t }
            let reason = switched ? "signout" : state == .off ? "off" : "lock"
            return clear(state, reason: reason, now: now)
        }
        let s = build(now: now)
        if !force, !switched, let t = told, t.state == .ok, Self.sameContent(t, s), now - t.at < WatchWire.refreshMs { return t }
        deliver(s)
        return s
    }

    /// A content snapshot of the current generation (shrunk until it fits the budget).
    func build(now: Int64) -> WatchSnapshot {
        let rooms = core().rooms
        let env = self.env
        let builder = WatchSnapshotBuilder(level: env.privacyLevel, now: now, t: { WatchTexts.t($0, env) }, ids: ids)
        let strings = WatchTexts.table(env)
        let quick = WatchTexts.quick(env)
        seq += 1
        let unread = min(max(0, rooms.unreadTotal), WatchWire.maxUnread)
        var made: WatchSnapshot?
        for limits in WatchSnapshotBuilder.Limits.steps {
            let s = WatchSnapshot(epoch: epoch, seq: seq, at: now, exp: now + WatchWire.lifetimeMs, state: .ok, reason: "", lang: lang,
                                  strings: strings, quick: quick, unread: unread, rooms: builder.rooms(rooms, limits: limits))
            made = s
            if let d = try? WatchEnvelope.snapshot(s).encoded(), d.count <= WatchWire.snapshotBudget { return s }
        }
        return made!
    }

    /// No content: a new generation, and the watch is told why.
    @discardableResult
    private func clear(_ state: WatchState, reason: String, now: Int64) -> WatchSnapshot {
        newGeneration()
        seq += 1
        let s = WatchSnapshot(epoch: epoch, seq: seq, at: now, exp: 0, state: state, reason: reason, lang: lang,
                              strings: WatchTexts.table(env), quick: [], unread: 0, rooms: [])
        deliver(s)
        return s
    }

    private var lang: String {
        let l = env.lang
        return WatchWire.isCode(l) && !l.isEmpty ? l : "en"
    }

    private func newGeneration() {
        ids = WatchRoomIds()
        epoch = WatchWire.newId()
        seq = 0
        answered = [:]
        answeredOrder = []
        scheduled?.cancel()
        scheduled = nil
    }

    private func deliver(_ s: WatchSnapshot) {
        guard transport.canDeliver else { return }
        let data: Data
        do {
            data = try WatchEnvelope.snapshot(s).encoded()
            try transport.updateContext(data)
        } catch {
            Self.log.error("watch snapshot not delivered: \(String(describing: type(of: error)), privacy: .public) \((error as NSError).code, privacy: .public)")
            return
        }
        // The watch app is open: now, not when the system gets to the context.
        if transport.reachable { transport.sendMessage(data) }
        told = s
        scheduleHeartbeat()
    }

    /// The same rooms and texts (only the order number and the times differ).
    static func sameContent(_ a: WatchSnapshot, _ b: WatchSnapshot) -> Bool {
        var x = a, y = b
        x.seq = 0; x.at = 0; x.exp = 0
        y.seq = 0; y.at = 0; y.exp = 0
        return x == y
    }

    private func scheduleHeartbeat() {
        heartbeat?.cancel()
        heartbeat = nil
        guard automatic, told?.state == .ok else { return }
        heartbeat = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(WatchWire.refreshMs))
            guard !Task.isCancelled, let self else { return }
            if self.observedCore != ObjectIdentifier(self.core()) { self.observe() }
            self.publishNow(force: true)
        }
    }

    // MARK: the account

    private var currentAccount: String {
        let a = core().account
        return a.signedIn ? a.username : ""
    }

    private var accountWillChange: Bool {
        guard let before = account, !before.isEmpty else { return false }
        return before != currentAccount
    }

    /// Signed out or another account: what the watch has belongs to the last one — a new generation.
    private func accountChanged() -> Bool {
        let now = currentAccount
        let before = account
        account = now
        guard let before, !before.isEmpty, before != now else { return false }
        newGeneration()
        return true
    }

    // MARK: following changes

    /// Registers for every value a snapshot reads (the gate always; the rooms only while the watch can take them).
    private func observe() {
        guard automatic else { return }
        observing += 1
        let token = observing
        observedCore = ObjectIdentifier(core())
        withObservationTracking {
            self.readInputs()
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.observing == token else { return }
                self.observe()
                self.refresh()
            }
        }
    }

    private func readInputs() {
        let core = core()
        _ = core.account.signedIn
        _ = core.account.username
        guard gate() == .ok, transport.canDeliver else { return }
        let env = self.env
        let builder = WatchSnapshotBuilder(level: env.privacyLevel, now: clock(), t: { WatchTexts.t($0, env) }, ids: ids)
        _ = env.lang
        _ = core.rooms.unreadTotal
        _ = builder.rooms(core.rooms, limits: .init())
    }

    // MARK: WatchTransportHandler

    func transportChanged() {
        observe()
        // Activated, paired, (re)installed, or the watch app opened: it gets the current state now.
        if transport.canDeliver { publishNow(force: true) }
    }

    func received(_ data: Data, channel: WatchChannel) -> Data? {
        let answer: WatchEnvelope
        do {
            let incoming = try WatchEnvelope.decode(data, maxBytes: WatchWire.maxRequestBytes)
            guard let req = incoming.request else { return nil } // only requests come this way
            if req.kind == .sync {
                answer = .snapshot(publishNow(force: true))
            } else {
                answer = .result(handle(req))
            }
        } catch {
            guard let id = Self.requestId(data) else { return nil }
            if case WatchWireError.version = error { answer = .result(.refused(id, WatchResult.Reason.version)) } else { answer = .result(.refused(id, WatchResult.Reason.invalid)) }
        }
        guard let out = try? answer.encoded() else { return nil }
        switch channel {
        case .message: return out
        case .messageNoReply: return nil
        case .queue:
            // A snapshot is already in the application context; a result goes back the same way.
            if answer.result != nil { transport.transferUserInfo(out) }
            return nil
        }
    }

    /// The id of a request that did not pass (to refuse it by name), when it has a usable one.
    static func requestId(_ data: Data) -> String? {
        guard data.count <= WatchWire.maxRequestBytes,
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let r = o["request"] as? [String: Any], let id = r["id"] as? String, WatchWire.isId(id) else { return nil }
        return id
    }

    // MARK: requests

    /// A request from the watch (each id once — a re-sent one gets the first answer).
    func handle(_ req: WatchRequest) -> WatchResult {
        if let done = answered[req.id] { return done }
        let r = route(req)
        answered[req.id] = r
        answeredOrder.append(req.id)
        if answeredOrder.count > Self.rememberAnswers { answered[answeredOrder.removeFirst()] = nil }
        return r
    }

    private func route(_ req: WatchRequest) -> WatchResult {
        switch gate() {
        case .off: return .refused(req.id, WatchResult.Reason.off)
        case .locked: return .refused(req.id, WatchResult.Reason.locked)
        case .ok: break
        }
        if req.kind == .sync { return .ok(req.id) }
        guard req.epoch == epoch else { return .refused(req.id, WatchResult.Reason.stale) }
        guard let key = ids.key(for: req.room) else { return .refused(req.id, WatchResult.Reason.unknownRoom) }
        let rooms = core().rooms
        switch req.kind {
        case .sync:
            return .ok(req.id)
        case .open:
            // Shown the next time the person looks at M5cet (iOS lets no app come forward by itself).
            rooms.switchTo(key)
            return .ok(req.id)
        case .reply:
            guard let room = rooms.room(key) else { return .refused(req.id, WatchResult.Reason.notOpen) }
            let text = WatchWire.clean(req.text, max: WatchWire.maxReply, lines: true)
            guard !text.isEmpty else { return .refused(req.id, WatchResult.Reason.empty) }
            let id = room.sendText(text)
            refresh()
            return .ok(req.id, sent: WatchWire.isId(id) ? id : "")
        case .read:
            guard let room = rooms.room(key) else { return .refused(req.id, WatchResult.Reason.notOpen) }
            let wanted = Set(req.ids)
            let read = room.messages.filter { !$0.mine && wanted.contains($0.id) }.map(\.id)
            if !read.isEmpty { room.markRead(read) }
            refresh()
            return .ok(req.id)
        }
    }

    // MARK: the lock and the wipe

    func lockWillForget(receiving inbox: LockInboxFiles?) {
        // The key is still here, the screens are not: the watch hears "locked" now.
        if told?.state != .locked { publishNow(as: env.mirrorEnabled ? .locked : .off) }
    }

    func lockDidForget() {
        if told?.state == .ok { publishNow(as: env.mirrorEnabled ? .locked : .off) }
    }

    func lockDidUnlock() { refresh() }

    /// The app is being erased: off, and the watch drops everything (its saved strings too).
    func wiped() {
        env.setMirrorEnabled(false)
        clear(.off, reason: "wipe", now: clock())
    }
}
