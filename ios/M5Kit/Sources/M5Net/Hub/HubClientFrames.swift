// The frames a client sends to the signaling hub, protocol v2
// (server/signaling/frames.ts). Each is built here exactly as the server
// parses it — required fields present, optional ones left out, the limits
// checked (`validate`) — so the hub never answers one with `invalid-frame`
// (a socket that keeps earning refusals is closed, 1008). What the encoder
// writes is the server's normalized form: recipients deduplicated, `per` and
// `mention` limited to `to` (Tests/M5NetTests: golden frames run through the
// server's own parseFrame).

import Foundation

public let hubProtocolVersion = 2
/// Largest frame the hub accepts, in bytes (frames.ts MAX_FRAME_BYTES).
public let hubMaxFrameBytes = 256 * 1024

/// 6.12 (§ 13): the proof that the joiner holds the room key — raw Ed25519 key and signature, standard base64.
public struct HubJoinProof: Sendable, Equatable {
    public let pub: String
    public let sig: String
    public init(pub: String, sig: String) {
        self.pub = pub
        self.sig = sig
    }
    public var json: NetJSON { ["pub": .string(pub), "sig": .string(sig)] }
}

public struct HubJoin: Sendable, Equatable {
    public var room: String
    public var name: String
    public var peerId: String?
    public var resume: String?
    public var auth: String?
    public var away: Bool
    public var features: [String]
    public var foreground: Bool?
    public var proof: HubJoinProof?
    public var protocolVersion: Int

    public init(room: String, name: String, peerId: String? = nil, resume: String? = nil, auth: String? = nil, away: Bool = false,
                features: [String] = ["bin"], foreground: Bool? = nil, proof: HubJoinProof? = nil, protocolVersion: Int = hubProtocolVersion) {
        self.room = room
        self.name = name
        self.peerId = peerId
        self.resume = resume
        self.auth = auth
        self.away = away
        self.features = features
        self.foreground = foreground
        self.proof = proof
        self.protocolVersion = protocolVersion
    }
}

/// A message relayed for members who are away (relay.ts): `envelope` for every recipient, or `per[ref]` its own.
public struct HubRelay: Sendable, Equatable {
    public var messageId: String
    public var to: [String]
    public var envelope: NetJSON?
    public var per: [String: NetJSON]?
    public var expiresAt: Millis?
    public var mention: [String]?
    public var call: Bool
    /// 6.14 (call wake, frames.ts): the end of a ring (the call ended before anyone answered) — never with `call`.
    public var callEnd: Bool
    /// 6.14: the call a ring (`call`) or its end (`callEnd`) belongs to; an end needs it. Only with `call` / `callEnd`.
    public var callId: String?
    /// 6.14: a video call. Only with `call` / `callEnd`.
    public var video: Bool

    public init(messageId: String, to: [String], envelope: NetJSON? = nil, per: [String: NetJSON]? = nil, expiresAt: Millis? = nil,
                mention: [String]? = nil, call: Bool = false, callEnd: Bool = false, callId: String? = nil, video: Bool = false) {
        self.messageId = messageId
        self.to = to
        self.envelope = envelope
        self.per = per
        self.expiresAt = expiresAt
        self.mention = mention
        self.call = call
        self.callEnd = callEnd
        self.callId = callId
        self.video = video
    }
}

public enum HubReceiptState: String, Sendable { case read, delivered }

public enum HubClientFrame: Sendable, Equatable {
    case join(HubJoin)
    /// Sign in or out without leaving the room (nil token: out).
    case auth(token: String?, away: Bool)
    case leave(away: Bool)
    /// SDP / ICE (or a sealed signal) to one peer — the payload as the crypto layer made it.
    case signal(target: String, payload: NetJSON)
    case ping(t: Millis)
    /// `away`: the relay covers for this member; 6.7 `foreground`: the app is open in front.
    case presence(away: Bool, foreground: Bool?)
    case relay(HubRelay)
    case relayAck(ids: [String])
    case receipt(messageIds: [String], state: HubReceiptState)
    case commandPoll(deviceId: String)
    case commandAck(commandId: String, result: String?)
    case storage(id: String, op: String, payload: NetJSON, auth: String?, session: String?)
    case proxyMeta(transferId: String, iv: String, ciphertext: String, v: Int?)
    case proxyChunk(transferId: String, seq: Int, iv: String, ciphertext: String, v: Int?)
    case proxyEnd(transferId: String, v: Int?, iv: String?, ciphertext: String?)
    case proxyCancel(transferId: String)
    case proxyNeed(transferId: String, seqs: [Int])
    /// 6.12: a member's devices in the key directory, by its room-scoped reference.
    case keyBundles(ref: String)
    /// 6.12: a member's key-transparency entries, by its room-scoped reference.
    case ktLookup(ref: String)

    public var type: String {
        switch self {
        case .join: return "join"
        case .auth: return "auth"
        case .leave: return "leave"
        case .signal: return "signal"
        case .ping: return "ping"
        case .presence: return "presence"
        case .relay: return "relay"
        case .relayAck: return "relay-ack"
        case .receipt: return "receipt"
        case .commandPoll: return "command-poll"
        case .commandAck: return "command-ack"
        case .storage: return "storage"
        case .proxyMeta: return "proxy-meta"
        case .proxyChunk: return "proxy-chunk"
        case .proxyEnd: return "proxy-end"
        case .proxyCancel: return "proxy-cancel"
        case .proxyNeed: return "proxy-need"
        case .keyBundles: return "key-bundles"
        case .ktLookup: return "kt-lookup"
        }
    }

    /// The token bucket the hub counts this frame in (limits.ts limitClassOf).
    public var limitClass: HubLimitClass { HubLimitClass.of(type) }

    /// The frame as the hub reads it.
    public var json: NetJSON {
        switch self {
        case .join(let j):
            var o: [String: NetJSON] = ["type": "join", "protocol": .int(Int64(j.protocolVersion)), "room": .string(j.room), "name": .string(j.name), "away": .bool(j.away)]
            if let p = j.peerId { o["peerId"] = .string(p) }
            if let r = j.resume, !r.isEmpty { o["resume"] = .string(r) }
            if let a = j.auth, !a.isEmpty { o["auth"] = .string(a) }
            let features = HubClientFrame.unique(j.features.filter { $0 == "bin" })
            if !features.isEmpty { o["features"] = .strings(features) }
            if let f = j.foreground { o["foreground"] = .bool(f) }
            if let p = j.proof { o["proof"] = p.json }
            return .object(o)
        case .auth(let token, let away):
            return ["type": "auth", "token": .string(token), "away": .bool(away)]
        case .leave(let away):
            return ["type": "leave", "away": .bool(away)]
        case .signal(let target, let payload):
            return ["type": "signal", "target": .string(target), "payload": payload]
        case .ping(let t):
            return ["type": "ping", "t": .int(t)]
        case .presence(let away, let foreground):
            var o: [String: NetJSON] = ["type": "presence", "away": .bool(away)]
            if let f = foreground { o["foreground"] = .bool(f) }
            return .object(o)
        case .relay(let r):
            let to = HubClientFrame.unique(r.to)
            var o: [String: NetJSON] = ["type": "relay", "messageId": .string(r.messageId), "to": .strings(to)]
            if let e = r.envelope { o["envelope"] = e }
            if let per = r.per {
                var kept: [String: NetJSON] = [:]
                for (ref, env) in per where to.contains(ref) { kept[ref] = env }
                if !kept.isEmpty { o["per"] = .object(kept) }
            }
            if let x = r.expiresAt { o["expiresAt"] = .int(x) }
            if let m = r.mention, !m.isEmpty { o["mention"] = .strings(m.filter { to.contains($0) }) }
            if r.call { o["call"] = true }
            // 6.14 (call wake): the ring's end, the call's id, video — only with a ring or its end (frames.ts).
            if r.callEnd && !r.call { o["callEnd"] = true }
            if r.call || r.callEnd {
                if let c = r.callId { o["callId"] = .string(c) }
                if r.video { o["video"] = true }
            }
            return .object(o)
        case .relayAck(let ids):
            return ["type": "relay-ack", "ids": .strings(ids)]
        case .receipt(let ids, let state):
            return ["type": "receipt", "messageIds": .strings(ids), "state": .string(state.rawValue)]
        case .commandPoll(let deviceId):
            return ["type": "command-poll", "deviceId": .string(deviceId)]
        case .commandAck(let id, let result):
            var o: [String: NetJSON] = ["type": "command-ack", "commandId": .string(id)]
            if let r = result, !r.isEmpty { o["result"] = .string(r) }
            return .object(o)
        case .storage(let id, let op, let payload, let auth, let session):
            var o: [String: NetJSON] = ["type": "storage", "id": .string(id), "op": .string(op), "payload": payload.objectValue != nil ? payload : .object([:])]
            if let a = auth, !a.isEmpty { o["auth"] = .string(a) }
            if let s = session, !s.isEmpty { o["session"] = .string(s) }
            return .object(o)
        case .proxyMeta(let id, let iv, let ct, let v):
            return HubClientFrame.versioned(["type": "proxy-meta", "transferId": .string(id), "iv": .string(iv), "ciphertext": .string(ct)], v)
        case .proxyChunk(let id, let seq, let iv, let ct, let v):
            return HubClientFrame.versioned(["type": "proxy-chunk", "transferId": .string(id), "seq": .int(Int64(seq)), "iv": .string(iv), "ciphertext": .string(ct)], v)
        case .proxyEnd(let id, let v, let iv, let ct):
            var o: [String: NetJSON] = ["type": "proxy-end", "transferId": .string(id)]
            if let iv, let ct, !iv.isEmpty, !ct.isEmpty { o["iv"] = .string(iv); o["ciphertext"] = .string(ct) }
            return HubClientFrame.versioned(o, v)
        case .proxyCancel(let id):
            return ["type": "proxy-cancel", "transferId": .string(id)]
        case .proxyNeed(let id, let seqs):
            return ["type": "proxy-need", "transferId": .string(id), "seqs": .array(seqs.map { .int(Int64($0)) })]
        case .keyBundles(let ref):
            return ["type": "key-bundles", "ref": .string(ref)]
        case .ktLookup(let ref):
            return ["type": "kt-lookup", "ref": .string(ref)]
        }
    }

    /// The JSON text that goes on the socket.
    public var text: String { json.text }

    private static func versioned(_ o: [String: NetJSON], _ v: Int?) -> NetJSON {
        var o = o
        if let v, v == 2 || v == 4 { o["v"] = .int(Int64(v)) }
        return .object(o)
    }

    static func unique(_ list: [String]) -> [String] {
        var seen = Set<String>()
        return list.filter { seen.insert($0).inserted }
    }
}

/* ------------------------------------------------------------ validation */

/// Why a frame would be refused by the hub (checked before it is sent).
public struct HubFrameInvalid: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

extension HubClientFrame {
    /// Checks what frames.ts parseFrame checks, so the hub accepts the frame.
    public func validate() throws {
        func fail(_ m: String) -> HubFrameInvalid { HubFrameInvalid(message: m) }
        switch self {
        case .join(let j):
            guard HubWire.cleanRoom(j.room) != nil else { throw fail("join needs a room") }
            if let p = j.peerId, !HubWire.isId(p) { throw fail("bad peer id") }
            if let r = j.resume, !r.isEmpty, !HubWire.isB64(r, max: 64) { throw fail("bad resume secret") }
            if let a = j.auth, a.count > 200 { throw fail("auth too long") }
            if let p = j.proof, !(HubWire.isStdB64(p.pub, max: 64) && HubWire.isStdB64(p.sig, max: 128)) { throw fail("join.proof is { pub, sig } in base64") }
        case .auth(let token, _):
            if let t = token, t.count > 200 { throw fail("bad token") }
        case .signal(let target, let payload):
            guard HubWire.isId(target), HubWire.isSignalPayload(payload) else { throw fail("signal needs a target and an SDP or ICE payload") }
        case .relay(let r):
            let to = HubClientFrame.unique(r.to)
            guard HubWire.isId(r.messageId), !to.isEmpty, r.to.count <= 50, to.allSatisfy(HubWire.isId) else { throw fail("relay needs messageId, to[] and an envelope") }
            if let e = r.envelope, !HubWire.isRelayEnvelope(e) { throw fail("relay has a bad envelope") }
            if let per = r.per {
                guard per.count <= 50 else { throw fail("relay.per maps recipient references to envelopes") }
                for (ref, env) in per {
                    guard HubWire.isId(ref) else { throw fail("relay.per maps recipient references to envelopes") }
                    guard HubWire.isRelayEnvelope(env) else { throw fail("relay.per has a bad envelope") }
                }
            }
            if r.envelope == nil, !to.allSatisfy({ r.per?[$0] != nil }) { throw fail("relay needs an envelope for every recipient (envelope, or per[ref])") }
            if let m = r.mention, m.count > 50 || !m.allSatisfy(HubWire.isId) { throw fail("bad mention list") }
            if r.call && r.callEnd { throw fail("relay.call and relay.callEnd exclude each other") }
            if r.call || r.callEnd, let c = r.callId, !HubWire.isId(c) { throw fail("relay.callId is an id ([A-Za-z0-9_:.-], at most 96)") }
            if r.callEnd && r.callId == nil { throw fail("relay.callEnd needs the callId of its ring") }
        case .relayAck(let ids):
            guard ids.count <= 500, ids.allSatisfy(HubWire.isId) else { throw fail("relay-ack needs ids[]") }
        case .receipt(let ids, _):
            guard !ids.isEmpty, ids.count <= 200, ids.allSatisfy(HubWire.isId) else { throw fail("receipt needs messageIds[] and a state") }
        case .commandPoll(let d):
            guard HubWire.isId(d) else { throw fail("command-poll needs a deviceId") }
        case .commandAck(let c, let result):
            guard HubWire.isId(c) else { throw fail("command-ack needs a commandId") }
            if let r = result, r.count > 256 { throw fail("result too long") }
        case .storage(let id, let op, _, let auth, let session):
            guard id.count <= 64, !op.isEmpty, op.count <= 40 else { throw fail("storage needs an op") }
            if let a = auth, a.count > 200 { throw fail("auth too long") }
            if let s = session, s.count > 96 { throw fail("session too long") }
        case .proxyMeta(let id, let iv, let ct, _):
            guard HubWire.isId(id), HubWire.isB64(iv, max: 64), !iv.isEmpty, HubWire.isB64(ct, max: 16_384) else { throw fail("proxy-meta needs transferId, iv, ciphertext") }
        case .proxyChunk(let id, let seq, let iv, let ct, _):
            guard HubWire.isId(id), HubWire.isB64(iv, max: 64), !iv.isEmpty, HubWire.isB64(ct, max: 200_000), seq >= 0, seq <= 10_000_000 else {
                throw fail("proxy-chunk needs transferId, seq, iv, ciphertext")
            }
        case .proxyEnd(let id, _, let iv, let ct):
            guard HubWire.isId(id) else { throw fail("proxy-end needs a transferId") }
            if let iv, !HubWire.isB64(iv, max: 64) { throw fail("bad proxy-end iv") }
            if let ct, !HubWire.isB64(ct, max: 4_096) { throw fail("bad proxy-end digest") }
        case .proxyCancel(let id):
            guard HubWire.isId(id) else { throw fail("proxy-cancel needs a transferId") }
        case .proxyNeed(let id, let seqs):
            guard HubWire.isId(id), !seqs.isEmpty, seqs.count <= 5_000, seqs.allSatisfy({ $0 >= 0 && $0 <= 10_000_000 }) else { throw fail("proxy-need needs a transferId and seqs[]") }
        case .keyBundles(let ref), .ktLookup(let ref):
            guard HubWire.isId(ref) else { throw fail("\(type) needs a member reference (ref)") }
        case .leave, .ping, .presence:
            break
        }
        if text.utf8.count > hubMaxFrameBytes { throw fail("frame too large") }
    }
}

/// The hub's field rules (frames.ts), for building and checking frames.
public enum HubWire {
    /// An id: peer ids, message ids, transfer ids, member references (frames.ts ID).
    public static func isId(_ s: String) -> Bool {
        guard !s.isEmpty, s.utf8.count <= 96 else { return false }
        return s.utf8.allSatisfy { c in
            (0x30...0x39).contains(c) || (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || c == UInt8(ascii: "_") || c == UInt8(ascii: ":")
                || c == UInt8(ascii: ".") || c == UInt8(ascii: "-")
        }
    }

    /// frames.ts B64: either alphabet, padding anywhere — and at most `max` characters.
    public static func isB64(_ s: String, max: Int) -> Bool {
        s.count <= max && s.utf8.allSatisfy { c in
            (0x30...0x39).contains(c) || (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || c == UInt8(ascii: "+") || c == UInt8(ascii: "/")
                || c == UInt8(ascii: "=") || c == UInt8(ascii: "_") || c == UInt8(ascii: "-")
        }
    }

    /// frames.ts std(): standard base64, non-empty, at most `max`.
    public static func isStdB64(_ s: String, max: Int) -> Bool {
        !s.isEmpty && s.count <= max && s.range(of: "^[A-Za-z0-9+/]*={0,2}$", options: .regularExpression) != nil
    }

    /// The room as the hub keeps it (cleanRoom): control characters out, trimmed, at most 64; nil when empty.
    public static func cleanRoom(_ room: String) -> String? {
        let s = String(String.UnicodeScalarView(room.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let cut = prefixUTF16(s, 64).trimmingCharacters(in: .whitespacesAndNewlines)
        return cut.isEmpty ? nil : cut
    }

    /// A display name as the hub keeps it (cleanName): printable, trimmed, at most 48 characters.
    public static func cleanName(_ name: String, fallback: String = "Anonymous") -> String {
        let bad: (Unicode.Scalar) -> Bool = { u in
            u.value < 0x20 || u.value == 0x7F || (0x200B...0x200F).contains(u.value) || (0x202A...0x202E).contains(u.value) || (0x2066...0x2069).contains(u.value)
        }
        let s = String(String.UnicodeScalarView(name.unicodeScalars.filter { !bad($0) })).trimmingCharacters(in: .whitespacesAndNewlines)
        let cut = prefixUTF16(s, 48)
        return cut.isEmpty ? fallback : cut
    }

    /// The longest prefix of whole scalars within `n` UTF-16 units (String.slice(0, n), never splitting a pair).
    static func prefixUTF16(_ s: String, _ n: Int) -> String {
        var units = 0
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            let w = u.value > 0xFFFF ? 2 : 1
            if units + w > n { break }
            units += w
            out.append(u)
        }
        return String(out)
    }

    /// An SDP, an ICE candidate or a sealed signal (frames.ts parseSignal).
    public static func isSignalPayload(_ p: NetJSON) -> Bool {
        guard case .object = p else { return false }
        if let sealed = p.obj("sealed") {
            return sealed["v"]?.int64Value == 2 && isB64(sealed.str("iv"), max: 64) && !sealed.str("iv").isEmpty
                && isB64(sealed.str("ciphertext"), max: 96 * 1024) && !sealed.str("ciphertext").isEmpty
        }
        if let type = p["type"]?.stringValue {
            guard ["offer", "answer", "pranswer", "rollback"].contains(type) else { return false }
            return type == "rollback" || (p["sdp"]?.stringValue.map { $0.count <= 64 * 1024 } ?? false)
        }
        guard let c = p["candidate"]?.stringValue else { return false }
        return c.count <= 2_048
    }

    /// A protocol-3 envelope (flat, iv + ciphertext) or a protocol-4 one (`mb` / `mb-set`).
    public static func isRelayEnvelope(_ e: NetJSON) -> Bool {
        guard let o = e.objectValue else { return false }
        if e["v"]?.int64Value == 4 { return isP4Envelope(e) }
        guard o.count <= 12, e["iv"]?.stringValue != nil, e["ciphertext"]?.stringValue != nil else { return false }
        var size = 0
        for (k, v) in o {
            guard k.range(of: "^[a-z][a-zA-Z0-9]{0,15}$", options: .regularExpression) != nil else { return false }
            switch v {
            case .string(let s):
                guard s.count <= 180_000 else { return false }
                size += s.count
            case .int: break
            case .double(let d): guard d.isFinite else { return false }
            default: return false
            }
        }
        return size <= 190_000
    }

    /// The shape of a protocol-4 envelope (frames.ts parseP4Envelope — the field checks the hub makes).
    public static func isP4Envelope(_ e: NetJSON) -> Bool {
        guard e["v"]?.int64Value == 4, e.text.count <= 128_000 else { return false }
        switch e.str("kind") {
        case "mb": return isMailboxItem(e)
        case "mb-set":
            guard isId(e.str("id")), let items = e.arr("items"), !items.isEmpty, items.count <= 16 else { return false }
            return items.allSatisfy(isMailboxItem)
        default: return false
        }
    }

    static func isMailboxItem(_ m: NetJSON) -> Bool {
        let std = { (v: NetJSON?, max: Int) -> Bool in (v?.stringValue).map { isStdB64($0, max: max) } ?? false }
        let url = { (v: NetJSON?, max: Int) -> Bool in
            (v?.stringValue).map { !$0.isEmpty && $0.count <= max && $0.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil } ?? false
        }
        guard m["v"]?.int64Value == 4, m.str("kind") == "mb", isId(m.str("id")), url(m["to"], 16), let sb = m.obj("sb"),
              url(sb["id"], 16), std(sb["dh"], 200), std(sb["kem"], 1_600), (sb["exp"]?.int64Value ?? -1) >= 0, std(sb["sig"], 100),
              std(m["spk"], 200), std(m["e"], 200), std(m["kct"], 1_600), std(m["c"], 128_000) else { return false }
        if let sacc = m["sacc"] {
            guard case .object = sacc, std(sacc["apk"], 64), std(sacc["ac"], 128) else { return false }
            if let cv = sacc["cv"], cv.int64Value != 2 { return false }
            if let exp = sacc["exp"], (exp.int64Value ?? -1) < 0 { return false }
        }
        return true
    }
}
