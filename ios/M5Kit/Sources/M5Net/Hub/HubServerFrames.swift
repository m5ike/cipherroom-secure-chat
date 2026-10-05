// The frames the signaling hub sends (server/signaling/hub.ts, relay.ts,
// presence.ts, file proxy, storage, telephony). Decoded into typed values;
// the raw object travels with each one (HubEvent.frame) so a field the server
// adds later is never lost on the way to M5Proto.
//
// Members are named by room-scoped references (`account`, and its deprecated
// alias `accountId`, refs.ts) — never by account id.

import Foundation

/// The server's greeting: the connection's names, limits, features and (6.12) the join proof's nonce.
public struct HubHello: Sendable, Equatable {
    public let protocolVersion: Int64
    public let peerId: String
    public let connId: String
    public let serverTime: Millis
    public let maxFrameBytes: Int64
    public let features: [String]
    /// 6.12: what a join proof signs (24 random bytes, base64url); nil from a server before 6.12.
    public let nonce: String?

    init(_ j: NetJSON) {
        protocolVersion = j.int("protocol")
        peerId = j.str("peerId")
        connId = j.str("connId")
        serverTime = j.int("serverTime")
        maxFrameBytes = j.obj("limits")?.int("maxFrameBytes", Int64(hubMaxFrameBytes)) ?? Int64(hubMaxFrameBytes)
        features = j.arr("features")?.compactMap(\.stringValue) ?? []
        nonce = j["nonce"]?.stringValue
    }
}

/// A member in the room (joined.peers, peer-joined).
public struct HubMember: Sendable, Equatable {
    public let peerId: String
    public let name: String
    public let joinedAt: Millis
    /// The member's room-scoped account reference, nil when not signed in.
    public let account: String?
    public let foreground: Bool
    public let lastSeen: Millis
    /// 6.12: the member's join proved the room key.
    public let proven: Bool

    init(_ j: NetJSON) {
        peerId = j.str("peerId")
        name = j.str("name")
        joinedAt = j.int("joinedAt")
        account = HubMember.ref(j)
        foreground = j.bool("foreground", true)
        lastSeen = j.int("lastSeen")
        proven = j.bool("proven")
    }

    static func ref(_ j: NetJSON) -> String? {
        let a = j["account"]?.stringValue ?? j["accountId"]?.stringValue
        return a?.isEmpty == false ? a : nil
    }
}

/// 6.7: a member whose connection went without a goodbye — listed as away until they come back.
public struct HubHeldMember: Sendable, Equatable {
    public let peerId: String
    public let name: String
    public let joinedAt: Millis
    public let lastSeen: Millis
    public let since: Millis
    public let account: String?
    public let proven: Bool

    init(_ j: NetJSON) {
        peerId = j.str("peerId")
        name = j.str("name")
        joinedAt = j.int("joinedAt")
        lastSeen = j.int("lastSeen")
        since = j.int("since")
        account = HubMember.ref(j)
        proven = j.bool("proven")
    }
}

/// A signed-in member who is away: messages to them go through the relay.
public struct HubAwayMember: Sendable, Equatable {
    public let account: String
    public let name: String
    public let since: Millis
    public let lastSeen: Millis

    init(_ j: NetJSON) {
        account = HubMember.ref(j) ?? ""
        name = j.str("name")
        since = j.int("since")
        lastSeen = j.int("lastSeen", j.int("since"))
    }
}

public struct HubJoined: Sendable, Equatable {
    public let protocolVersion: Int64
    public let peerId: String
    public let room: String
    /// The resume secret: proves on the next join that this client is the same member.
    public let resume: String
    /// 6.12: whether this join proved the room key; nil from a server that does not say.
    public let proven: Bool?
    public let peers: [HubMember]
    public let away: [HubAwayMember]
    public let held: [HubHeldMember]
    /// Our own account reference in this room (signed in with `auth`), nil when none.
    public let account: String?
    /// The relay covers for us while away.
    public let accountAway: Bool
    /// The join's auth token was not valid.
    public let accountInvalid: Bool

    init(_ j: NetJSON) {
        protocolVersion = j.int("protocol")
        peerId = j.str("peerId")
        room = j.str("room")
        resume = j.str("resume")
        proven = j["proven"]?.boolValue
        peers = (j.arr("peers") ?? []).map(HubMember.init)
        away = (j.arr("away") ?? []).map(HubAwayMember.init)
        held = (j.arr("held") ?? []).map(HubHeldMember.init)
        let acc = j.obj("account")
        account = acc.flatMap(HubMember.ref)
        accountAway = acc?.bool("away") ?? false
        accountInvalid = acc?.bool("invalid") ?? false
    }
}

/// One item the relay kept for us (relay-deliver): a message (`envelope`) or a state of a message of ours (`status`).
public struct HubRelayItem: Sendable, Equatable {
    public let id: String
    public let seq: Int64
    /// "message" or "status".
    public let kind: String
    public let messageId: String
    public let fromPeerId: String
    public let fromName: String
    public let fromAccount: String?
    /// A protocol-3 room envelope or a protocol-4 `mb` / `mb-set` (M5Proto opens it).
    public let envelope: NetJSON?
    /// {state, at, recipientName} for a `status` item.
    public let status: NetJSON?
    public let storedAt: Millis
    public let attempts: Int64

    init(_ j: NetJSON) {
        id = j.str("id")
        seq = j.int("seq")
        kind = j.str("kind")
        messageId = j.str("messageId")
        let from = j.obj("from") ?? .object([:])
        fromPeerId = from.str("peerId")
        fromName = from.str("name")
        fromAccount = HubMember.ref(from)
        envelope = j.obj("envelope")
        status = j.obj("status")
        storedAt = j.int("storedAt")
        attempts = j.int("attempts")
    }

    /// Is the envelope protocol 4 (an item or a set)? (P4Relay.isP4)
    public var isP4: Bool {
        guard let e = envelope, e["v"]?.doubleValue == 4 else { return false }
        return e.str("kind") == "mb" || (e.str("kind") == "mb-set" && e.arr("items") != nil)
    }
}

/// What became of a relayed message of ours: stored, forwarded, duplicate, delivered, read — or rejected.
public struct HubRelayStatus: Sendable, Equatable {
    public let messageId: String
    public let recipientAccount: String
    public let recipientName: String
    public let state: String
    public let at: Millis
    public let reason: String?

    init(_ j: NetJSON) {
        messageId = j.str("messageId")
        let r = j.obj("recipient") ?? .object([:])
        recipientAccount = HubMember.ref(r) ?? ""
        recipientName = r.str("name")
        state = j.str("state")
        at = j.int("at")
        reason = j["reason"]?.stringValue
    }
}

/// A refusal ({type:"error", code, message, …}).
public struct HubErrorFrame: Sendable, Equatable {
    public let code: String
    public let message: String
    /// 6.12 review S14: on a proof refusal, whether the same join without a proof would be admitted.
    public let legacyAllowed: Bool?

    init(_ j: NetJSON) {
        code = j.str("code")
        message = j.str("message")
        legacyAllowed = j["legacyAllowed"]?.boolValue
    }
}

/// The operator speaking (server-notice): plain, never in the room's encryption.
public struct HubServerNotice: Sendable, Equatable {
    public let id: String
    /// "wall", "message", "flash" or "wake".
    public let kind: String
    public let text: String
    public let level: String
    public let from: String
    public let at: Millis
    public let pinned: Bool

    init(_ j: NetJSON) {
        id = j.str("id")
        kind = j.str("kind")
        text = j.str("text")
        level = j.str("level", "info")
        from = j.str("from")
        at = j.int("at")
        pinned = j.bool("pinned")
    }
}

public enum HubServerFrame: Sendable, Equatable {
    case hello(HubHello)
    case joined(HubJoined)
    case peerJoined(HubMember)
    case peerUpdated(peerId: String, name: String, account: String?)
    /// A member left (`held` nil), or its connection went and it stays listed as away (`held`).
    case peerLeft(peerId: String, held: HubHeldMember?)
    case peerPresence(peerId: String, foreground: Bool, lastSeen: Millis)
    case peerAway(HubAwayMember)
    case peerBack(account: String, peerId: String?, name: String?)
    case peerGone(account: String)
    case signal(source: String, payload: NetJSON)
    case signalUndeliverable(target: String)
    case pong(t: Millis, serverTs: Millis)
    case presenceAck(away: Bool)
    case authResult(ok: Bool, account: String?, away: Bool, invalid: Bool)
    case accountRevoked(reason: String)
    case relayDeliver([HubRelayItem])
    case relayStatus(HubRelayStatus)
    case rateLimited(frame: String, retryAfterMs: Millis)
    case error(HubErrorFrame)
    /// The same client connected again (the socket closes with 4001).
    case replaced(reason: String)
    /// The operator closed this connection (the socket closes with 4003).
    case closedByServer(reason: String)
    case serverNotice(HubServerNotice)
    case adminCommand(NetJSON)
    case keyBundles(ref: String, devices: [NetJSON])
    /// `lookup` nil: key transparency is not running on the server.
    case ktLookup(ref: String, lookup: NetJSON?)
    /// File proxy frames forwarded from another member (proxy-meta / -chunk / -end / -cancel / -need).
    case proxy(type: String, frame: NetJSON)
    case proxyAck(transferId: String, accepted: Bool, reason: String?)
    case storageResult(NetJSON)
    case phoneBridge(NetJSON)
    case other(type: String, frame: NetJSON)

    public var type: String {
        switch self {
        case .hello: return "hello"
        case .joined: return "joined"
        case .peerJoined: return "peer-joined"
        case .peerUpdated: return "peer-updated"
        case .peerLeft: return "peer-left"
        case .peerPresence: return "peer-presence"
        case .peerAway: return "peer-away"
        case .peerBack: return "peer-back"
        case .peerGone: return "peer-gone"
        case .signal: return "signal"
        case .signalUndeliverable: return "signal-undeliverable"
        case .pong: return "pong"
        case .presenceAck: return "presence-ack"
        case .authResult: return "auth-result"
        case .accountRevoked: return "account-revoked"
        case .relayDeliver: return "relay-deliver"
        case .relayStatus: return "relay-status"
        case .rateLimited: return "rate-limited"
        case .error: return "error"
        case .replaced: return "replaced"
        case .closedByServer: return "closed-by-server"
        case .serverNotice: return "server-notice"
        case .adminCommand: return "admin-command"
        case .keyBundles: return "key-bundles"
        case .ktLookup: return "kt-lookup"
        case .proxy(let t, _): return t
        case .proxyAck: return "proxy-ack"
        case .storageResult: return "storage-result"
        case .phoneBridge: return "phone-bridge"
        case .other(let t, _): return t
        }
    }

    /// A frame of the server's text, or nil when it is not a JSON object with a type.
    public static func decode(_ text: String) -> (frame: HubServerFrame, raw: NetJSON)? {
        guard let raw = try? NetJSON.parse(text) else { return nil }
        guard let f = decode(raw) else { return nil }
        return (f, raw)
    }

    public static func decode(_ j: NetJSON) -> HubServerFrame? {
        guard case .object = j, let type = j["type"]?.stringValue else { return nil }
        switch type {
        case "hello": return .hello(HubHello(j))
        case "joined": return .joined(HubJoined(j))
        case "peer-joined": return .peerJoined(HubMember(j))
        case "peer-updated": return .peerUpdated(peerId: j.str("peerId"), name: j.str("name"), account: HubMember.ref(j))
        case "peer-left": return .peerLeft(peerId: j.str("peerId"), held: j.bool("held") ? HubHeldMember(j) : nil)
        case "peer-presence": return .peerPresence(peerId: j.str("peerId"), foreground: j.bool("foreground", true), lastSeen: j.int("lastSeen"))
        case "peer-away": return .peerAway(HubAwayMember(j))
        case "peer-back": return .peerBack(account: HubMember.ref(j) ?? "", peerId: j["peerId"]?.stringValue, name: j["name"]?.stringValue)
        case "peer-gone": return .peerGone(account: HubMember.ref(j) ?? "")
        case "signal": return .signal(source: j.str("source"), payload: j["payload"] ?? .null)
        case "signal-undeliverable": return .signalUndeliverable(target: j.str("target"))
        case "pong": return .pong(t: j.int("t"), serverTs: j.int("serverTs"))
        case "presence-ack": return .presenceAck(away: j.bool("away"))
        case "auth-result":
            let acc = j.obj("account")
            return .authResult(ok: j.bool("ok"), account: acc.flatMap(HubMember.ref), away: acc?.bool("away") ?? false, invalid: j.bool("invalid"))
        case "account-revoked": return .accountRevoked(reason: j.str("reason"))
        case "relay-deliver": return .relayDeliver((j.arr("items") ?? []).prefix(500).map(HubRelayItem.init))
        case "relay-status": return .relayStatus(HubRelayStatus(j))
        case "rate-limited": return .rateLimited(frame: j.str("frame"), retryAfterMs: j.int("retryAfterMs"))
        case "error": return .error(HubErrorFrame(j))
        case "replaced": return .replaced(reason: j.str("reason"))
        case "closed-by-server": return .closedByServer(reason: j.str("reason"))
        case "server-notice": return .serverNotice(HubServerNotice(j))
        case "admin-command": return .adminCommand(j["command"] ?? .null)
        case "key-bundles": return .keyBundles(ref: j.str("ref"), devices: j.arr("devices") ?? [])
        case "kt-lookup": return .ktLookup(ref: j.str("ref"), lookup: j.obj("lookup"))
        case "proxy-meta", "proxy-chunk", "proxy-end", "proxy-cancel", "proxy-need": return .proxy(type: type, frame: j)
        case "proxy-ack": return .proxyAck(transferId: j.str("transferId"), accepted: j.bool("accepted", true), reason: j["reason"]?.stringValue)
        case "storage-result": return .storageResult(j)
        case "phone-bridge": return .phoneBridge(j)
        default: return .other(type: type, frame: j)
        }
    }
}
