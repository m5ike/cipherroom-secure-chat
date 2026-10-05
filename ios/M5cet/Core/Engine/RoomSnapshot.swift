// What the main actor keeps of a room's core (it lives on the room's actor):
// a value copied after every change, and the people list built from it and the
// WebRTC peers — the port of RoomSession.peopleScope, trustFields, addPresence,
// usersScope, peersScope and userCount (android chat/RoomSession.java).

import Foundation
import M5Core
import M5Crypto
import M5Proto

/// One member as the core knows it (RoomPeer, copied).
struct PeerSnap: Sendable, Equatable {
    let id: String
    let name: String
    let publicKey: String
    /// "" | "v4" | "legacy"
    let proto: String
    let downgrade: Bool
    let verified: Bool
    let changed: Bool
    let trust: String
    let kt: String
    let verifiedAs: String
    let audio: String
    /// The member's attested account key (both attested: the safety number uses the account keys).
    let accountKey: String
    let held: Int
}

/// A room's core, copied for the main actor.
struct RoomSnap: Sendable {
    var status = "offline"
    var notice = ""
    var myId = ""
    var proven = false
    var peers: [PeerSnap] = []
    var facts = PeerFacts()
    var presence = RoomPresence()
    var messages: [ChatMessage] = []
    var heldIds: Set<String> = []
    var myAccountKey = ""
    var outbox = 0

    static func of(_ core: RoomCore) -> RoomSnap {
        var s = RoomSnap()
        s.status = core.status
        s.notice = core.notice
        s.myId = core.myId
        s.proven = core.proven
        s.peers = core.peerList.map { p in
            let acc = p.proto == "v4" ? core.p4.account(p.id) : nil
            return PeerSnap(id: p.id, name: p.name, publicKey: p.publicKey, proto: p.proto, downgrade: p.downgrade, verified: p.verified, changed: p.changed,
                            trust: p.trust, kt: p.kt, verifiedAs: p.verifiedAs, audio: p.audio, accountKey: acc?.valid == true ? acc!.publicKey : "",
                            held: core.heldCount(p.id))
        }
        s.facts = core.people
        s.presence = core.presence
        s.messages = core.messages
        s.heldIds = core.heldIds
        s.outbox = core.outboxCount
        return s
    }
}

enum RoomPeople {
    static func tr(_ key: String) -> String { P4Texts.t(key) }

    /// Everyone of the room for People (RoomSession.peopleScope): me, the peers, the signed-in members who are away
    /// ("away:" + account ref), the held ones — with trust, protocol and presence.
    static func people(_ s: RoomSnap, wire: [WirePeer], me: (name: String, account: String, publicKey: String, audio: String, foreground: Bool),
                       connected: Bool, now: Int64) -> [JSONObject] {
        var out = [JSONObject]()
        let wireById = Dictionary(wire.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if connected {
            var u = JSONObject([("id", .string(s.myId)), ("name", .string(me.name)), ("me", true), ("channel", "open"), ("username", .string(me.account)),
                                ("signedIn", .bool(!me.account.isEmpty)), ("since", .double(Double(s.facts.joinedAt))), ("audio", .string(me.audio)),
                                ("signed", true), ("changed", false), ("publicKey", .string(me.publicKey)), ("app", ""), ("rtt", .double(-1))])
            trustMe(&u, s)
            out.append(u)
        }
        var here = Set<String>()
        for p in s.peers {
            let f = s.facts.get(p.id)
            let account = s.facts.account(p.id)
            if !account.isEmpty { here.insert(account) }
            let w = wireById[p.id]
            let st = w?.status ?? "connecting"
            let channel = st == "open" ? "open" : st == "closed" ? "closed" : "connecting"
            var u = JSONObject([("id", .string(p.id)), ("name", .string(p.name)), ("me", false), ("channel", .string(channel)),
                                ("username", .string(f?.username ?? "")), ("signedIn", .bool(!account.isEmpty)), ("since", .double(Double(f?.since ?? 0))),
                                ("audio", .string(w?.audio ?? p.audio)), ("signed", .bool(p.verified)), ("changed", .bool(p.changed)),
                                ("publicKey", .string(p.publicKey)), ("app", .string(f?.app ?? "")), ("rtt", .double(Double(w?.rttMs ?? -1)))])
            trustPeer(&u, p, s)
            out.append(u)
        }
        for w in s.facts.away where !here.contains(w.account) {
            out.append(JSONObject([("id", .string("away:" + w.account)), ("name", .string(w.name)), ("me", false), ("channel", "away"),
                                   ("username", .string(s.facts.user(ofAccount: w.account))), ("signedIn", true), ("since", .double(Double(w.since))),
                                   ("audio", "off"), ("signed", false), ("changed", false), ("publicKey", ""), ("app", ""), ("rtt", .double(-1))]))
        }
        addPresence(&out, s, foreground: me.foreground, now: now)
        return out
    }

    /// trustFields for me.
    private static func trustMe(_ u: inout JSONObject, _ s: RoomSnap) {
        u["trust"] = .string(Trust.verified)
        u["protocol"] = "p4"
        u["legacy"] = false
        u["proven"] = .bool(s.proven)
        u["unproven"] = false
        u["held"] = 0
        u["kt"] = ""
        u["ktLabel"] = ""
        u["trustLabel"] = ""
        u["protocolLabel"] = .string(tr("p4.protocol4"))
    }

    /// trustFields for a peer (§ 12.1 trust, protocol, § 13 proven, held, KT).
    private static func trustPeer(_ u: inout JSONObject, _ p: PeerSnap, _ s: RoomSnap) {
        let legacy = p.proto == "legacy"
        let pr = s.facts.proven(p.id)
        let trustLabel = p.verifiedAs.isEmpty ? tr("p4.trust." + p.trust) : tr("p4.trust.otherName").replacingOccurrences(of: "{name}", with: p.verifiedAs)
        u["trust"] = .string(p.trust)
        u["trustLabel"] = .string(trustLabel)
        u["verifiedAs"] = .string(p.verifiedAs)
        u["protocol"] = .string(p.proto == "v4" ? "p4" : p.proto)
        u["legacy"] = .bool(legacy)
        u["protocolLabel"] = .string(legacy ? tr("p4.legacy") : p.proto == "v4" ? tr("p4.protocol4") : "")
        u["downgrade"] = .bool(p.downgrade)
        u["proven"] = pr.map { .bool($0) } ?? .null
        u["unproven"] = .bool(pr == false)
        u["held"] = .int(p.held)
        u["kt"] = .string(p.kt)
        u["ktLabel"] = .string(p.kt.isEmpty || p.kt == "accepted" ? "" : tr("p4.kt." + p.kt))
    }

    /// Each person's presence (.connected, .foreground, .lastSeen) and the held members, listed as away.
    private static func addPresence(_ out: inout [JSONObject], _ s: RoomSnap, foreground: Bool, now: Int64) {
        var ids = Set<String>(), awayRefs = Set<String>()
        for i in out.indices {
            let id = out[i].optString("id")
            ids.insert(id)
            if out[i].bool("me") == true {
                out[i]["connected"] = true; out[i]["foreground"] = .bool(foreground); out[i]["lastSeen"] = .double(Double(now))
                continue
            }
            if id.hasPrefix("away:") {
                let ref = String(id.dropFirst(5))
                awayRefs.insert(ref)
                let seen = s.presence.awayLastSeen(ref)
                out[i]["connected"] = false; out[i]["foreground"] = false
                out[i]["lastSeen"] = .double(seen > 0 ? Double(seen) : out[i].double("since") ?? 0)
                continue
            }
            let lv = s.presence.live(id)
            out[i]["connected"] = true
            out[i]["foreground"] = .bool(lv?.foreground ?? true)
            out[i]["lastSeen"] = .double(Double(lv?.lastSeen ?? 0))
        }
        for h in s.presence.held(excluding: ids, awayAccounts: awayRefs) {
            out.append(JSONObject([("id", .string(h.peerId)), ("name", .string(h.name)), ("me", false), ("channel", "held"),
                                   ("username", .string(h.account.isEmpty ? "" : s.facts.user(ofAccount: h.account))), ("signedIn", .bool(!h.account.isEmpty)),
                                   ("since", .double(Double(h.since))), ("audio", "off"), ("signed", false), ("changed", false), ("publicKey", ""),
                                   ("app", ""), ("rtt", .double(-1)), ("connected", false), ("foreground", false), ("lastSeen", .double(Double(h.lastSeen)))]))
        }
    }

    /// RoomSession.usersScope: me (when joined) and every peer not closed — the user panel's $users.
    static func users(_ s: RoomSnap, wire: [WirePeer], myName: String, myAudio: String, connected: Bool) -> [DesignValue] {
        var out = [DesignValue]()
        let byId = Dictionary(wire.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if connected { out.append(["name": .string(myName), "me": true, "verified": true, "away": false, "audio": .string(myAudio)]) }
        for p in s.peers {
            let st = byId[p.id]?.status ?? "connecting"
            if st == "closed" { continue }
            out.append(["name": .string(p.name), "me": false, "verified": .bool(p.verified && !p.changed), "changed": .bool(p.changed), "away": false,
                        "audio": .string(byId[p.id]?.audio ?? p.audio), "status": .string(st), "trust": .string(p.trust)])
        }
        return out
    }
}
