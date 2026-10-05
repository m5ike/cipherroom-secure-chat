// One connected room (android chat/RoomSession.java) as a Swift actor: it owns
// a RoomCore (the protocol logic, synchronous) and adds what is asynchronous —
// the timers (join fallback, receipt batches, parked relays, expiry, saving
// the replay window), sealing a message's code (PBKDF2, off the actor) and
// key transparency (the KtState actor's lookups, gossip). M5Net feeds it the
// hub frames, the app the data-channel texts; both reach it in order.

import Foundation
import M5Core
import M5Crypto

public actor RoomSession {
    let core: RoomCore
    private let device: P4Device
    private let ktFetch: Kt.ConsistencyFetcher?
    private var timers = [String: Task<Void, Never>]()

    public init(key: String, room: String, label: String, userName: String, keys: RoomKeys, identity: ChatIdentity, transport: any RoomTransport,
                events: any RoomEvents, device: P4Device, pins: NamePins, verifiedDevice: @escaping @Sendable (String) -> Bool,
                settings: RoomSettings = RoomSettings(), ktFetch: Kt.ConsistencyFetcher? = nil, clock: any Clock = SystemClock()) {
        self.device = device
        self.ktFetch = ktFetch
        core = RoomCore(key: key, room: room, label: label, userName: userName, keys: keys, identity: identity, transport: transport, events: events,
                        device: device, pins: pins, verifiedDevice: verifiedDevice, settings: settings, clock: clock)
    }

    /// Runs `body` with the room's core (reads for the UI, operations not wrapped here).
    public func withCore<T: Sendable>(_ body: (RoomCore) throws -> T) rethrows -> T { try body(core) }

    /// Key transparency's state for this server into the core (call at start and after a refresh).
    public func refreshKt() async {
        core.ktOn = await device.ktOn()
        core.sth = await device.sth()
        core.ktCheckPeers()
    }

    public func setSettings(_ s: RoomSettings) { core.settings = s }

    public func resume(peerId: String, secret: String) { core.resume(peerId: peerId, secret: secret) }

    /* ------------------------------------------------------------ socket */

    public func socketOpened() {
        core.onSocketOpen()
        schedule("join", after: 4_000) { $0.core.joinFallback() }
    }

    public func socketClosed(code: Int) { core.onSocketClosed(code: code) }

    public func hubText(_ text: String) async {
        core.onHubText(text)
        await afterInput()
    }

    public func hubFrame(_ frame: JSONObject) async {
        core.onHubFrame(frame)
        await afterInput()
    }

    public func sendAuth(token: String) { core.sendAuth(token: token) }

    /// The room left or closed: the replay window is saved, everything of the connection forgotten.
    public func disconnected() {
        for t in timers.values { t.cancel() }
        timers.removeAll()
        saveReplay()
        core.disconnected()
    }

    /* ---------------------------------------------------- data channels */

    public func channelOpened(_ peerId: String) async {
        core.onChannelOpen(peerId)
        await afterInput()
    }

    public func channelGone(_ peerId: String) { core.onChannelGone(peerId) }

    public func peerText(_ peerId: String, _ text: String) async {
        core.onPeerText(peerId, text)
        await afterInput()
    }

    public func sendSignal(_ target: String, _ payload: JSONObject) { core.sendSignal(target, payload) }

    /* -------------------------------------------------------------- send */

    /// Sends a message (the bubble at once as "sending"; a code seals it off the actor first).
    @discardableResult
    public func send(_ o: Outgoing) async -> ChatMessage {
        let m = core.compose(o)
        var sealed: (ciphertext: String, meta: JSONObject)?
        if let code = m.sealCode, let plain = m.sealPlain {
            do { sealed = try await Task.detached { try Sealed.seal(plain, code: code) }.value }
            catch { core.systemNotice("⚠ \(error)"); return m }
        }
        core.finishSend(m.id, recipients: o.recipients, sealed: sealed)
        await afterInput()
        return core.message(m.id) ?? m
    }

    public func broadcastAudio(_ state: String) { core.broadcastAudio(state) }

    public func flushOutbox() async { core.flushOutbox("asked"); await afterInput() }

    public func markRead(_ ids: [String]) { core.markRead(ids); scheduleTimers() }

    public func identityVerified(_ peerId: String, _ on: Bool) async { core.identityVerified(peerId, on); await afterInput() }

    public func hide(_ id: String, until: Int64, unlock: String?, why: String?) { core.hide(id, until: until, unlock: unlock, why: why) }

    public func deleteLocal(_ id: String) { core.deleteLocal(id) }

    public func vanished(_ id: String) { core.vanished(id) }

    public func restore(_ history: [ChatMessage]) { core.restore(history); scheduleTimers() }

    public func messages() -> [ChatMessage] { core.messages }

    /* ----------------------------------------------- async work, timers */

    private func afterInput() async {
        let work = core.takeKtWork()
        for (ref, lookup) in work.lookups {
            var checked: Kt.Checked?
            if let lookup, let fetch = ktFetch { checked = await device.kt.lookup(device.origin, lookup, u: nil, fetch: fetch) }
            core.applyKtLookup(ref: ref, checked: checked, lookupPresent: lookup != nil)
        }
        for sth in work.gossip { await device.gossip(.object(sth), fetch: ktFetch) }
        scheduleTimers()
    }

    private func schedule(_ name: String, after ms: Int64, _ body: @escaping @Sendable (isolated RoomSession) -> Void) {
        timers[name]?.cancel()
        timers[name] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.fire(name, body)
        }
    }

    private func fire(_ name: String, _ body: @Sendable (isolated RoomSession) -> Void) {
        timers[name] = nil
        body(self)
        scheduleTimers()
    }

    private func scheduleTimers() {
        let now = core.clock.now()
        if core.receiptsWaiting && timers["receipts"] == nil { schedule("receipts", after: 400) { $0.core.sendReceipts() } }
        if let at = core.nextRelayDeadline, timers["relay"] == nil { schedule("relay", after: at - now) { $0.core.sendParkedRelays() } }
        if let at = core.nextExpiry, timers["expiry"] == nil { schedule("expiry", after: max(250, at - now)) { $0.core.expire() } }
        if core.replayDirty && timers["replay"] == nil { schedule("replay", after: 5_000) { $0.saveReplay() } }
    }

    /// The room's replay window into the vault (5 s after a change, and when the room goes).
    public func saveReplay() {
        core.replayDirty = false
        device.store.saveReplay(core.keys.roomId, core.replayWindow)
    }
}
