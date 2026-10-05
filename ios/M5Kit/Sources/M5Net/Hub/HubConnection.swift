// One room's connection to the signaling hub (Android: the socket part of
// chat/RoomSession; web: client/src/lib/room-hub.ts). A socket carries ONE
// room — the hub's `join` leaves the room the socket was in — so a client in
// several rooms keeps one socket per room (HubRooms).
//
//   open      the socket; the server's `hello` names the connection and gives
//             the join proof's nonce (6.12)
//   join      at the hello (or 4 s after opening, without a proof, from a server
//             that sends none): the room id, the name, the peer id and resume
//             secret of the previous connection, features ["bin"], foreground,
//             and the proof that this client holds the room key (HubProof)
//   joined    the peer id and resume secret are kept (HubResumeStore); the
//             account's session is bound (`auth`), the presence sent
//   keepalive a ping every 25 s; nothing heard for 75 s — the connection is dead
//   presence  foreground / background, at most one frame per 6 s (the latest)
//   close     4001 (replaced) / 4003 (closed by the operator): no reconnect;
//             room-blocked / room-full / a refused proof: stop; anything else:
//             reconnect after min(120 s, 1 s·2^attempts)·random + 250 ms
//   leave     `leave` and a clean close; `pause` closes without `leave` — the
//             hub keeps the member listed as away (held) until it resumes
//
// Every server frame goes out on `events`, decoded (HubServerFrame) with its
// raw JSON; the room logic (M5Proto) reads peers, signals, relay items there.

import Foundation

/// What room a connection is for.
public struct HubRoom: Sendable, Equatable {
    /// The app's key of the room (the resume store's key; Android: the saved room's key).
    public var key: String
    /// The server's address (https://host[:port][/prefix]).
    public var server: String
    /// The room id the hub knows: a blind v3 id ("r3.…", RoomKeys.roomId) or a plain name.
    public var roomId: String
    /// The display name in the room.
    public var name: String
    public var features: [String]

    public init(key: String, server: String, roomId: String, name: String, features: [String] = ["bin"]) {
        self.key = key
        self.server = server
        self.roomId = roomId
        self.name = name
        self.features = features
    }

    /// wss://host[/prefix]/ws (http → ws).
    public var socketURL: URL? {
        let base = normalizeServer(server)
        let ws = base.replacingOccurrences(of: "^https://", with: "wss://", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "^http://", with: "ws://", options: [.regularExpression, .caseInsensitive])
        return URL(string: ws + "/ws")
    }
}

/// The timings of a connection (Android's values by default; tests make them short).
public struct HubTiming: Sendable {
    /// The join waits this long for the hello's nonce.
    public var joinFallback: Duration = .seconds(4)
    public var heartbeat: Duration = .seconds(25)
    /// Nothing received this long (pongs included): the connection is dead, reconnect.
    public var deadAfter: Duration = .seconds(75)
    /// Presence frames at most this often (the hub's bucket: 10, then one per 5 s).
    public var presenceGap: Duration = .seconds(6)
    public var connectTimeout: Duration = .seconds(20)
    public var backoffBaseMs: Int64 = 1_000
    public var backoffCapMs: Int64 = 120_000
    public var backoffMinMs: Int64 = 250
    /// After a refused proof, joins go without one this long (review S14).
    public var proofRetryMs: Int64 = 3_600_000
    /// key-bundles / kt-lookup answers are awaited this long.
    public var answerTimeout: Duration = .seconds(3)

    public init() {}
    public static let standard = HubTiming()
}

public enum HubStopReason: Sendable, Equatable {
    /// We left (disconnect).
    case left
    /// Paused: closed without leaving (the hub holds us as away).
    case paused
    /// The same client connected again elsewhere (4001).
    case replaced
    /// The operator closed the connection (4003).
    case closedByServer(String)
    case roomBlocked(String)
    case roomFull(String)
    /// The hub refused our proof of the room key and does not admit us without it.
    case proofRefused(code: String)
}

public enum HubStatus: Sendable, Equatable {
    /// Not connected now (waiting to reconnect, or not started).
    case offline
    case connecting
    /// The socket is open; the join is under way.
    case joining
    case joined
    /// It will not reconnect by itself.
    case stopped(HubStopReason)
}

/// Things the connection noticed that the UI may tell (the frames themselves come as `.frame`).
public enum HubNotice: Sendable, Equatable {
    /// Our proof was refused (squatted room); we joined without it — the others see us unproven.
    case proofLegacy
    /// The hub refused a frame for its rate limit.
    case rateLimited(frame: String, retryAfterMs: Millis)
    /// An `error` frame (other than the ones that stop the connection).
    case serverError(code: String, message: String)
}

public enum HubEvent: Sendable {
    case status(HubStatus)
    case frame(HubServerFrame, raw: NetJSON)
    /// A binary message (a file chunk relayed by the hub, BinaryChunkFrame).
    case binary(Data)
    case notice(HubNotice)
}

public enum HubSendResult: Sendable, Equatable {
    case sent
    /// No open socket (or not in the room yet).
    case notConnected
    /// Over the class's rate limit: try again after this many ms.
    case throttled(Millis)
    case invalid(String)
}

public actor HubConnection {
    public let room: HubRoom
    public nonisolated let events: AsyncStream<HubEvent>
    private let continuation: AsyncStream<HubEvent>.Continuation
    private let transport: any HubTransport
    private let proofSigner: (any HubProofSigner)?
    private let resumeStore: (any HubResumeStore)?
    private let timing: HubTiming
    private let clock: NetClock
    private let random: @Sendable () -> Double
    private let userAgent: String

    public private(set) var status: HubStatus = .offline
    /// Our peer id in the room ("" before the first join).
    public private(set) var peerId = ""
    private var resumeSecret = ""
    /// 6.12: whether our join proved the room key (nil: the server did not say).
    public private(set) var proven: Bool?
    public private(set) var hello: HubHello?
    /// The last ping's round trip, ms.
    public private(set) var rttMs: Millis?
    /// The server's clock minus ours (from the last pong), ms.
    public private(set) var serverClockOffsetMs: Millis?

    private var wanted = false
    private var attempts = 0
    private var socket: (any HubSocket)?
    private var generation = 0
    private var runTask: Task<Void, Never>?
    private var hubNonce = ""
    private var joinSent = false
    private var legacyRetried = false
    private var proofSkipUntil: Millis = 0
    private var stopReason: HubStopReason?
    private var foreground = true
    private var sentForeground = true
    private var presenceAt: Millis = 0
    private var presenceTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var joinFallbackTask: Task<Void, Never>?
    private var lastReceived: Millis = 0
    private var account: (token: String, away: Bool)?
    private var limiter = HubRateLimiter()
    private var waiters: [String: [(id: Int, resume: CheckedContinuation<HubServerFrame?, Never>)]] = [:]
    private var waiterSeq = 0
    private var resumeLoaded = false

    public init(room: HubRoom, transport: any HubTransport = URLSessionHubTransport(), proofSigner: (any HubProofSigner)? = nil,
                resumeStore: (any HubResumeStore)? = nil, timing: HubTiming = .standard, clock: NetClock = .system,
                random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }, userAgent: String = M5NetInfo.userAgent) {
        self.room = room
        self.transport = transport
        self.proofSigner = proofSigner
        self.resumeStore = resumeStore
        self.timing = timing
        self.clock = clock
        self.random = random
        self.userAgent = userAgent
        (events, continuation) = AsyncStream<HubEvent>.makeStream(bufferingPolicy: .unbounded)
    }

    /* ------------------------------------------------------------ public */

    /// Connects (and keeps reconnecting) until disconnect / pause, or the server stops it.
    public func connect() {
        wanted = true
        stopReason = nil
        if runTask == nil { runTask = Task { await self.run() } }
    }

    /// Leaves the room: `leave`, a clean close, no reconnect.
    public func disconnect() async {
        await stop(.left, leave: true)
    }

    /// Closes without leaving: the hub keeps us listed as away (held) and our resume secret brings us back.
    /// (iOS: the app goes to the background and its socket would be suspended anyway.)
    public func pause() async {
        await stop(.paused, leave: false)
    }

    /// Disconnects and ends the event stream (the connection is not used again).
    public func shutdown() async {
        await stop(.left, leave: true)
        continuation.finish()
    }

    /// The app is in the foreground or not (6.7 presence, last seen).
    public func setForeground(_ on: Bool) {
        foreground = on
        sendPresence()
    }

    /// The account's session on this socket (`auth`): the relay keeps messages for us and reports states.
    /// `away`: with notifications on, the server covers for this device while the app is closed.
    /// As on Android, nothing is sent for a nil token (the server ends a signed-out session on its own).
    public func setAccount(token: String?, away: Bool) async {
        if let token, !token.isEmpty { account = (token, away) } else { account = nil }
        await sendAuth()
    }

    /// Sends a frame (it must be valid and within the hub's rate limit). Frames for the room need `joined`.
    public func send(_ frame: HubClientFrame) async -> HubSendResult {
        switch frame {
        case .ping, .commandPoll, .commandAck, .storage, .auth, .leave, .join: break
        default: if status != .joined { return .notConnected }
        }
        return await transmit(frame)
    }

    /// Sends a binary file chunk (BinaryChunkFrame, proxy type) — needs `joined`.
    public func sendBinary(_ data: Data) async -> HubSendResult {
        guard status == .joined, let s = socket else { return .notConnected }
        guard let chunk = BinaryChunkFrame.decode(data), chunk.type == BinaryChunkFrame.proxy else { return .invalid("not a proxy chunk") }
        if let wait = limiter.allow(.proxy, bytes: (chunk.data.count + 2) / 3 * 4, now: clock.now()) { return .throttled(wait) }
        do { try await s.send(.binary(data)); return .sent } catch { return .notConnected }
    }

    /// 6.12: a member's devices from the key directory (`key-bundles` by its room reference), nil when no answer came.
    public func keyBundles(ref: String) async -> [NetJSON]? {
        guard case .keyBundles(_, let devices)? = await ask(.keyBundles(ref: ref), key: "key-bundles|\(ref)") else { return nil }
        return devices
    }

    /// 6.12: a member's key-transparency lookup (`kt-lookup`); `.some(nil)`: KT is not running there; nil: no answer.
    public func ktLookup(ref: String) async -> NetJSON?? {
        guard case .ktLookup(_, let lookup)? = await ask(.ktLookup(ref: ref), key: "kt-lookup|\(ref)") else { return nil }
        return .some(lookup)
    }

    /* -------------------------------------------------------------- loop */

    private func run() async {
        if !resumeLoaded {
            resumeLoaded = true
            if peerId.isEmpty, resumeSecret.isEmpty, let r = await resumeStore?.load(roomKey: room.key) {
                peerId = r.peerId
                resumeSecret = r.secret
            }
        }
        while wanted, !Task.isCancelled {
            setStatus(.connecting)
            var code = 1006
            guard let url = room.socketURL else {
                await stop(.closedByServer("bad server address"), leave: false)
                break
            }
            do {
                let s = try await transport.connect(to: url, headers: ["User-Agent": userAgent], timeout: timing.connectTimeout)
                if !wanted || Task.isCancelled {
                    s.close(code: 1000, reason: "leave")
                    break
                }
                generation += 1
                let gen = generation
                socket = s
                opened(gen)
                code = await readLoop(s, gen)
            } catch {
                code = 1006
            }
            closed()
            if code == 4001 || code == 4003 || stopReason == .replaced || stopReason.isClosedByServer {
                wanted = false
                let reason = stopReason ?? (code == 4001 ? .replaced : .closedByServer(""))
                stopReason = reason
                setStatus(.stopped(reason))
                break
            }
            if !wanted || Task.isCancelled { break }
            setStatus(.offline)
            let cap = min(timing.backoffCapMs, timing.backoffBaseMs << Int64(min(attempts, 12)))
            let delay = Int64(random() * Double(cap)) + timing.backoffMinMs
            attempts += 1
            try? await Task.sleep(for: .milliseconds(delay))
        }
        runTask = nil
        if !wanted, let reason = stopReason, status != .stopped(reason) { setStatus(.stopped(reason)) }
        // connect() came while this loop was ending (after a stop): a fresh loop.
        if wanted { runTask = Task { await self.run() } }
    }

    private func readLoop(_ s: any HubSocket, _ gen: Int) async -> Int {
        while true {
            do {
                let m = try await s.receive()
                guard gen == generation else { return 1000 }
                lastReceived = clock.now()
                switch m {
                case .text(let t): await onText(t)
                case .binary(let d): continuation.yield(.binary(d))
                }
            } catch let c as HubSocketClosed {
                return c.code
            } catch {
                return 1006
            }
        }
    }

    private func opened(_ gen: Int) {
        attempts = 0
        hubNonce = ""
        joinSent = false
        legacyRetried = false
        hello = nil
        limiter.reset()
        lastReceived = clock.now()
        setStatus(.joining)
        joinFallbackTask?.cancel()
        joinFallbackTask = Task { [timing] in
            try? await Task.sleep(for: timing.joinFallback)
            if !Task.isCancelled { await self.joinFallback(gen) }
        }
        heartbeatTask?.cancel()
        heartbeatTask = Task { [timing] in
            while !Task.isCancelled {
                try? await Task.sleep(for: timing.heartbeat)
                if Task.isCancelled { return }
                guard await self.beat(gen) else { return }
            }
        }
    }

    private func closed() {
        socket = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        joinFallbackTask?.cancel()
        joinFallbackTask = nil
        presenceTask?.cancel()
        presenceTask = nil
        failWaiters()
        if case .stopped = status {} else { setStatus(.offline) }
    }

    private func stop(_ reason: HubStopReason, leave: Bool) async {
        wanted = false
        stopReason = reason
        let s = socket
        socket = nil
        generation += 1
        heartbeatTask?.cancel()
        joinFallbackTask?.cancel()
        presenceTask?.cancel()
        runTask?.cancel()
        if let s {
            if leave { try? await s.send(.text(HubClientFrame.leave(away: false).text)) }
            s.close(code: 1000, reason: leave ? "leave" : "pause")
        }
        failWaiters()
        setStatus(.stopped(reason))
    }

    private func setStatus(_ s: HubStatus) {
        guard s != status else { return }
        status = s
        continuation.yield(.status(s))
    }

    /* ------------------------------------------------------------ frames */

    private func onText(_ text: String) async {
        guard let (frame, raw) = HubServerFrame.decode(text) else { return }
        continuation.yield(.frame(frame, raw: raw))
        switch frame {
        case .hello(let h):
            hello = h
            hubNonce = h.nonce ?? ""
            if !joinSent { await sendJoin() }
        case .joined(let j):
            if !j.peerId.isEmpty { peerId = j.peerId }
            resumeSecret = j.resume
            await resumeStore?.save(roomKey: room.key, peerId: peerId, secret: resumeSecret)
            proven = j.proven
            setStatus(.joined)
            await sendAuth()
            sendPresence()
        case .pong(let t, let serverTs):
            let now = clock.now()
            if t > 0, t <= now {
                rttMs = now - t
                if serverTs > 0 { serverClockOffsetMs = serverTs - (t + (now - t) / 2) }
            }
        case .rateLimited(let type, let ms):
            limiter.block(HubLimitClass.of(type), until: clock.now() + ms)
            continuation.yield(.notice(.rateLimited(frame: type, retryAfterMs: ms)))
        case .replaced:
            stopReason = .replaced
        case .closedByServer(let reason):
            stopReason = .closedByServer(reason)
        case .keyBundles(let ref, _):
            resolve("key-bundles|\(ref)", frame)
        case .ktLookup(let ref, _):
            resolve("kt-lookup|\(ref)", frame)
        case .error(let e):
            await onError(e)
        default:
            break
        }
    }

    private func onError(_ e: HubErrorFrame) async {
        // 6.0: the operator closed the room, or it is full — not a network problem to retry.
        if e.code == "room-blocked" { await stop(.roomBlocked(e.message), leave: true); return }
        if e.code == "room-full" { await stop(.roomFull(e.message), leave: true); return }
        switch HubProof.refusal(code: e.code, legacyAllowed: e.legacyAllowed, retried: legacyRetried) {
        case .legacy:
            legacyRetried = true
            proofSkipUntil = clock.now() + timing.proofRetryMs
            continuation.yield(.notice(.proofLegacy))
            joinSent = false
            await sendJoin()
        case .refuse:
            await stop(.proofRefused(code: e.code), leave: true)
        case .none:
            continuation.yield(.notice(.serverError(code: e.code, message: e.message)))
        }
    }

    /// The join frame — with the proof when the server gave a nonce (§ 13, blind ids only).
    private func sendJoin() async {
        guard !joinSent, socket != nil else { return }
        joinSent = true
        joinFallbackTask?.cancel()
        joinFallbackTask = nil
        let gen = generation
        let proof = clock.now() < proofSkipUntil ? nil : await HubProof.build(signer: proofSigner, roomId: room.roomId, nonce: hubNonce)
        guard gen == generation, socket != nil else { return }
        if peerId.isEmpty { peerId = "peer-" + Bytes.hex(Bytes.random(12)) }
        let join = HubJoin(room: room.roomId, name: room.name, peerId: peerId, resume: resumeSecret.isEmpty ? nil : resumeSecret, away: false,
                           features: room.features, foreground: foreground, proof: proof)
        _ = await transmit(.join(join))
        sentForeground = foreground
    }

    private func joinFallback(_ gen: Int) async {
        guard gen == generation, !joinSent else { return }
        await sendJoin()
    }

    /// One keepalive tick; false when this socket is gone.
    private func beat(_ gen: Int) async -> Bool {
        guard gen == generation, let s = socket else { return false }
        let now = clock.now()
        if now - lastReceived > timing.deadAfter.millis {
            // Nothing heard (not even a pong): the connection is dead — drop it, the loop reconnects.
            s.abort()
            return false
        }
        _ = await transmit(.ping(t: now))
        return true
    }

    private func sendAuth() async {
        guard status == .joined, let account else { return }
        _ = await transmit(.auth(token: account.token, away: account.away))
    }

    private func sendPresence() {
        presenceTask?.cancel()
        presenceTask = nil
        guard status == .joined, socket != nil, foreground != sentForeground else { return }
        let wait = presenceAt + timing.presenceGap.millis - clock.now()
        if wait > 0 {
            presenceTask = Task {
                try? await Task.sleep(for: .milliseconds(wait))
                if !Task.isCancelled { self.sendPresence() }
            }
            return
        }
        // away stays false: the app keeps receiving while it is in the background; the relay covers a closed app.
        let fg = foreground
        sentForeground = fg
        presenceAt = clock.now()
        Task { _ = await self.transmit(.presence(away: false, foreground: fg)) }
    }

    /// Validates, rate-limits and sends a frame on the current socket.
    private func transmit(_ frame: HubClientFrame) async -> HubSendResult {
        guard let s = socket else { return .notConnected }
        do { try frame.validate() } catch { return .invalid("\(error)") }
        let bytes: Int
        switch frame {
        case .proxyChunk(_, _, _, let ct, _), .proxyMeta(_, _, let ct, _): bytes = ct.count
        default: bytes = 0
        }
        if let wait = limiter.allow(frame.limitClass, bytes: bytes, now: clock.now()) { return .throttled(wait) }
        do {
            try await s.send(.text(frame.text))
            return .sent
        } catch {
            return .notConnected
        }
    }

    /* ----------------------------------------------- request / answer */

    private func ask(_ frame: HubClientFrame, key: String) async -> HubServerFrame? {
        guard status == .joined else { return nil }
        waiterSeq += 1
        let id = waiterSeq
        let timeout = timing.answerTimeout
        return await withCheckedContinuation { (c: CheckedContinuation<HubServerFrame?, Never>) in
            waiters[key, default: []].append((id, c))
            Task {
                if await self.transmit(frame) != .sent { self.cancelWaiter(key, id); return }
                try? await Task.sleep(for: timeout)
                self.cancelWaiter(key, id)
            }
        }
    }

    private func cancelWaiter(_ key: String, _ id: Int) {
        guard var list = waiters[key], let i = list.firstIndex(where: { $0.id == id }) else { return }
        let w = list.remove(at: i)
        waiters[key] = list.isEmpty ? nil : list
        w.resume.resume(returning: nil)
    }

    private func resolve(_ key: String, _ frame: HubServerFrame) {
        guard let list = waiters.removeValue(forKey: key) else { return }
        for w in list { w.resume.resume(returning: frame) }
    }

    private func failWaiters() {
        let all = waiters
        waiters = [:]
        for (_, list) in all { for w in list { w.resume.resume(returning: nil) } }
    }
}

extension Duration {
    /// Whole milliseconds.
    var millis: Millis { Millis(components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000) }
}

private extension Optional where Wrapped == HubStopReason {
    var isClosedByServer: Bool { if case .closedByServer? = self { return true }; return false }
}
