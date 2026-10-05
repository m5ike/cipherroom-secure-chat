// The open rooms' connections (Android: the connection part of chat/Rooms).
// The hub keeps a socket in one room at a time, so each open room has its own
// HubConnection (one socket per room, to that room's server); this keeps them
// together: the policy's room limit, the app going to the foreground or the
// background, the account signing in or out, a clean shutdown.

import Foundation

public actor HubRooms {
    private let transport: any HubTransport
    private let resumeStore: (any HubResumeStore)?
    private let timing: HubTiming
    private let clock: NetClock
    private let userAgent: String
    private var connections: [String: HubConnection] = [:]
    private var foreground = true
    private var account: (token: String, away: Bool)?
    /// At most this many rooms at once (the policy's rooms.max; DeviceState.maxRooms).
    public var maxRooms: Int

    public init(transport: any HubTransport = URLSessionHubTransport(), resumeStore: (any HubResumeStore)? = nil, timing: HubTiming = .standard,
                clock: NetClock = .system, userAgent: String = M5NetInfo.userAgent, maxRooms: Int = 8) {
        self.transport = transport
        self.resumeStore = resumeStore
        self.timing = timing
        self.clock = clock
        self.userAgent = userAgent
        self.maxRooms = maxRooms
    }

    public func setMaxRooms(_ n: Int) { maxRooms = max(1, min(16, n)) }

    /// The connection of a room, made and connected when it is not open yet; nil when the limit is reached.
    /// `proofSigner`: the room's hub key (blind rooms); the connection keeps it.
    public func open(_ room: HubRoom, proofSigner: (any HubProofSigner)? = nil) async -> HubConnection? {
        if let c = connections[room.key] {
            await c.connect()
            return c
        }
        guard connections.count < maxRooms else { return nil }
        let c = HubConnection(room: room, transport: transport, proofSigner: proofSigner, resumeStore: resumeStore, timing: timing,
                              clock: clock, userAgent: userAgent)
        connections[room.key] = c
        await c.setForeground(foreground)
        if let account { await c.setAccount(token: account.token, away: account.away) }
        await c.connect()
        return c
    }

    public func connection(_ key: String) -> HubConnection? { connections[key] }
    public var keys: [String] { Array(connections.keys) }

    /// Leaves a room and forgets its connection.
    public func close(_ key: String) async {
        guard let c = connections.removeValue(forKey: key) else { return }
        await c.shutdown()
    }

    /// How many rooms are joined now.
    public func joinedCount() async -> Int {
        var n = 0
        for c in connections.values where await c.status == .joined { n += 1 }
        return n
    }

    /// The app came to the foreground or went to the background (every room's presence).
    public func setForeground(_ on: Bool) async {
        foreground = on
        for c in connections.values { await c.setForeground(on) }
    }

    /// Signed in (token) or out (nil): every room's socket binds the session (`auth`).
    public func setAccount(token: String?, away: Bool) async {
        if let token, !token.isEmpty { account = (token, away) } else { account = nil }
        for c in connections.values { await c.setAccount(token: token, away: away) }
    }

    /// Every room closes without leaving (held as away by the hub) — the app goes to the background on iOS.
    public func pauseAll() async {
        for c in connections.values { await c.pause() }
    }

    /// Every room connects again (resuming as the same member).
    public func resumeAll() async {
        for c in connections.values { await c.connect() }
    }

    /// Leaves every room and ends their event streams.
    public func shutdown() async {
        let all = connections
        connections = [:]
        for c in all.values { await c.shutdown() }
    }
}
