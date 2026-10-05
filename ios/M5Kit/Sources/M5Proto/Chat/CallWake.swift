// 6.14 — call wake (docs/api.md › Buzení při hovoru; android chat/CallWake.java,
// the web's client/src/lib/call-wake.ts).
//
// Calls have no ringing on the wire: someone's audio going live is the
// announcement, and only members on a live data channel see it. A member who is
// AWAY (no awake socket) never did. Now the caller's room relays ONE call item to
// the away members when its call starts — sealed like a message (P4Relay: their
// devices' mailboxes, else the room envelope) — and the server wakes them with
// kind "call" (FCM, web push, iOS PushKit). Hanging up before anyone answered
// relays a second item that ends the ring.
//
//   payload  {kind:"call", id, createdAt, senderId, senderName,
//             call:"<call id>", state:"ring"|"end", video, at}
//   frame    the relay frame + {call:true | callEnd:true, callId, video?} —
//            only to a server whose hello lists "call-wake"
//
// Older apps drop the payload (Payloads.validate refuses an unknown kind).
//
// The receiver (Inbox): a pushed ring rings like a call the room shows; a relayed
// one (the room is connected again) waits `settleMs` for the room to show the
// call. Once the room shows a call, its CallTrack has it — one record per call; a
// ring that never showed, or an end, is a missed call (declined when I declined
// the pushed ring). Pure; the room feeds it and carries out its steps.

import Foundation
import M5Core
import M5Crypto

public enum CallWake {
    /// The hello feature of a server that wakes for calls (server/signaling/frames.ts).
    public static let feature = "call-wake"
    /// A ring rings at most this long (the server's push expiry on every channel).
    public static let ringMs: Int64 = 60_000
    /// A relayed ring (or a late push) waits this long for the room to show its call.
    public static let settleMs: Int64 = 30_000
    public static let ring = "ring", end = "end"

    /// `[A-Za-z0-9_:.-]{1,max}`.
    static func validCallId(_ s: String, max: Int) -> Bool {
        let u = Array(s.utf16)
        guard !u.isEmpty, u.count <= max else { return false }
        for c in u {
            switch c {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x5F, 0x3A, 0x2E, 0x2D: continue
            default: return false
            }
        }
        return true
    }

    /// The relay message id of a call's ring / end (the queue deduplicates a repeated one).
    public static func messageId(_ callId: String, _ state: String) -> String { callId + (state == ring ? ":r" : ":e") }

    /// A new call id: "cw-" and 24 hex digits.
    public static func newCallId() -> String { "cw-" + Crypto.hex(Crypto.random(12)) }

    /// The sealed payload of a ring or an end.
    public static func payload(callId: String, state: String, video: Bool, at: Int64, senderId: String, senderName: String, now: Int64) -> JSONObject {
        JSONObject([("kind", "call"), ("id", .string(messageId(callId, state))), ("createdAt", .int(now)),
                    ("senderId", .string(senderId)), ("senderName", .string(senderName)), ("call", .string(callId)),
                    ("state", .string(state)), ("video", .bool(video)), ("at", .int(at))])
    }

    /// What the relay frame adds (server/signaling/frames.ts): call or callEnd, callId, video.
    public static func relayFields(callId: String, state: String, video: Bool) -> JSONObject {
        var o = JSONObject([(state == ring ? "call" : "callEnd", .bool(true)), ("callId", .string(callId))])
        if video { o["video"] = .bool(true) }
        return o
    }

    /// org.json's `instanceof Number && finite && > 0`, at most `now + futureSkew`; `now` otherwise.
    static func clamp(_ v: JSON?, _ now: Int64) -> Int64 {
        guard let n = v?.numberValue, n.double.isFinite else { return now }
        let l: Int64
        if let i = n.int64 { l = i } else if n.double >= 9.2e18 { l = .max } else if n.double <= -9.2e18 { l = .min } else { l = Int64(n.double.rounded(.towardZero)) }
        if l <= 0 { return now }
        return min(l, now + Payloads.futureSkew)
    }

    // MARK: - receiving

    /// A call item from the relay, checked like a message (Payloads.validate).
    public struct Item: Sendable, Equatable {
        public let id: String, call: String, state: String, senderId: String, senderName: String
        public let video: Bool
        public let at: Int64, createdAt: Int64
        public var isEnd: Bool { state == CallWake.end }
    }

    /// A decrypted relayed payload that is a call item: its sender the peer the server says relayed it, never us
    /// or a reserved id; bounded; a clock far ahead held to now. nil when it is not one (Payloads.validate decides).
    public static func parse(_ p: JSONObject?, transportSender: String?, myId: String, now: Int64) -> Item? {
        guard let p, Payloads.orgString(p["kind"]) == "call" else { return nil }
        guard let id = Payloads.str(p["id"], Payloads.idMax), !id.isEmpty,
              let senderId = Payloads.str(p["senderId"], Payloads.idMax), !senderId.isEmpty else { return nil }
        if ["system", "self", "server", "admin"].contains(senderId) { return nil }
        if ModelIdentity.reservedSender(senderId) { return nil }
        if senderId == myId { return nil }
        if let t = transportSender, senderId != t { return nil }
        guard let call = p["call"]?.stringValue, validCallId(call, max: 90) else { return nil }
        let state = Payloads.orgString(p["state"])
        guard state == ring || state == end else { return nil }
        let tail = String(decoding: senderId.utf16.suffix(4), as: UTF16.self)
        let name = Payloads.clean(p["senderName"], Payloads.nameMax, "peer-" + tail) ?? ""
        return Item(id: id, call: call, state: state, senderId: senderId, senderName: name, video: p["video"] == .bool(true),
                    at: clamp(p["at"], now), createdAt: clamp(p["createdAt"], now))
    }

    /// A call the server pushed (a "notify" message of kind "call" with `call`).
    public struct Pushed: Sendable, Equatable {
        public let call: String, room: String, who: String
        public let video: Bool, end: Bool
        public let at: Int64
        public init(call: String, room: String, who: String, video: Bool, end: Bool, at: Int64) {
            self.call = call; self.room = room; self.who = who; self.video = video; self.end = end; self.at = at
        }
    }

    /// The call of a server notification (server/notify: `call` {id, video, at, end?, room} — the room only on the
    /// app channel); nil when it is not one. `who`: the sender as far as the user's privacy level let it through.
    public static func pushed(_ p: JSONObject?, now: Int64) -> Pushed? {
        guard let p, Payloads.orgString(p["kind"]) == "call", let c = p.object("call") else { return nil }
        let id = c["id"] == nil ? "" : Payloads.orgString(c["id"]), room = c["room"] == nil ? "" : Payloads.orgString(c["room"])
        guard validCallId(id, max: 96), !room.isEmpty, room.utf16.count <= 64 else { return nil }
        let who = p.object("vars").map { Payloads.clean($0["sender"], Payloads.nameMax, "") ?? "" } ?? ""
        return Pushed(call: id, room: room, who: who, video: CallHistory.OrgJSON.bool(c["video"]), end: CallHistory.OrgJSON.bool(c["end"]),
                      at: clamp(c["at"], now))
    }

    // MARK: - sending

    /// A ring that is out: its call, video, when, and to whom (room-scoped references).
    public struct Ring: Sendable, Equatable {
        public let callId: String
        public let video: Bool
        public let at: Int64
        public let refs: [String]
    }

    /// The caller's side of one call.
    public struct Sender: Sendable {
        private var current: Ring?
        private var answered = false

        public init() {}

        /// I turned my audio on. A ring when the server wakes for calls, nobody else is in the call (I start it —
        /// CallTrack's outgoing) and someone is away; nil otherwise (joining someone's call rings nobody).
        public mutating func start(serverWakes: Bool, othersInCall: Int, away: [String]?, video: Bool, now: Int64,
                                   newId: () -> String = CallWake.newCallId) -> Ring? {
            current = nil
            answered = false
            guard serverWakes, othersInCall <= 0, let away else { return nil }
            var refs = [String]()
            for r in away where !refs.contains(r) { refs.append(r) }
            if refs.isEmpty { return nil }
            if refs.count > 50 { refs = Array(refs.prefix(50)) }
            current = Ring(callId: newId(), video: video, at: now, refs: refs)
            return current
        }

        /// Someone else's audio went on while my ring was out: answered — no end.
        public mutating func markAnswered() { if current != nil { answered = true } }

        /// The ring that is out, nil when none (or answered).
        public var ringing: Ring? { answered ? nil : current }

        /// I hung up: the end of my ring when nobody answered it — to those still away. nil otherwise.
        public mutating func stop(awayNow: [String]?) -> Ring? {
            let c = current, was = answered
            current = nil
            answered = false
            guard let c, !was else { return nil }
            let refs = c.refs.filter { awayNow?.contains($0) ?? false }
            return refs.isEmpty ? nil : Ring(callId: c.callId, video: c.video, at: c.at, refs: refs)
        }
    }

    // MARK: - the inbox

    /// What the room does now: ring, stop a ring (over), record calls, show a missed call.
    public struct Step: Sendable, Equatable {
        public var ring = false, over = false
        public var who = ""
        public var video = false
        public var records: [CallTrack.Record] = []
        /// A missed call to show — the record's details.
        public var missed: CallTrack.Record?
        public init() {}
    }

    private struct Pending: Sendable {
        var who: String
        let video: Bool
        let at: Int64
        var until: Int64
        var rang = false, declined = false
    }

    /// The receiver's side, one per room.
    public struct Inbox: Sendable {
        private var pending = OrderedMap<String, Pending>()
        private var done = OrderedMap<String, Bool>()

        public init() {}

        private mutating func finish(_ call: String) {
            pending.remove(call)
            done[call] = true
            while done.count > 500, let first = done.first { done.remove(first.key) }
        }

        /// A ring or an end the server pushed. `roomInCall`: someone else's audio is on in the room now.
        public mutating func push(_ p: Pushed?, now: Int64, roomInCall: Bool) -> Step {
            var s = Step()
            guard let p, done[p.call] == nil else { return s }
            if p.end { return end(p.call, who: p.who, video: p.video, at: p.at, &s) }
            if roomInCall { finish(p.call); return s } // the room shows it: its CallTrack rings
            let fresh = now - p.at <= CallWake.ringMs
            var w = pending[p.call] ?? Pending(who: p.who, video: p.video, at: p.at, until: fresh ? now + CallWake.ringMs : now + CallWake.settleMs)
            if pending[p.call] != nil, w.who.isEmpty { w.who = p.who }
            if fresh && !w.rang && !w.declined {
                w.rang = true
                w.until = max(w.until, now + CallWake.ringMs)
                s.ring = true
                s.who = w.who
                s.video = w.video
            }
            pending[p.call] = w
            return s
        }

        /// A call item the relay delivered (the room is connected again): never rings by itself — the room does.
        public mutating func relayed(_ item: Item?, now: Int64, roomInCall: Bool) -> Step {
            var s = Step()
            guard let item, done[item.call] == nil else { return s }
            if item.isEnd { return end(item.call, who: item.senderName, video: item.video, at: item.at, &s) }
            if roomInCall { finish(item.call); return s }
            if var w = pending[item.call] {
                if w.who.isEmpty { w.who = item.senderName } // the push did not name the caller; the item does
                pending[item.call] = w
            } else {
                pending[item.call] = Pending(who: item.senderName, video: item.video, at: item.at, until: now + CallWake.settleMs)
            }
            return s
        }

        private mutating func end(_ call: String, who: String, video: Bool, at: Int64, _ s: inout Step) -> Step {
            let w = pending[call]
            finish(call)
            let declined = w?.declined ?? false
            let name = (w.map { !$0.who.isEmpty } ?? false) ? w!.who : who
            s.over = w?.rang ?? false
            let r = Self.record(declined: declined, at: w?.at ?? at, video: w?.video ?? video, who: name)
            s.records.append(r)
            if !declined { s.missed = r }
            return s
        }

        private static func record(declined: Bool, at: Int64, video: Bool, who: String) -> CallTrack.Record {
            CallTrack.Record(kind: declined ? CallTrack.declined : CallTrack.missed, at: at, seconds: 0, video: video, people: who.isEmpty ? [] : [who])
        }

        /// The room shows a call now: the waiting rings are that call — its CallTrack records it. True when I had
        /// declined one of them (the room then declines its ring: no second ring, a declined call).
        public mutating func roomInCall() -> Bool {
            let declined = pending.orderedValues.contains { $0.declined }
            for call in pending.keys { finish(call) }
            return declined
        }

        /// I declined the pushed ring.
        public mutating func decline() {
            for (call, var w) in pending.entries where w.rang {
                w.declined = true
                pending[call] = w
            }
        }

        /// Whether a ring waits (for the room to show its call).
        public var waiting: Bool { !pending.isEmpty }

        /// The waiting rings whose time is up: missed calls (declined when I declined them).
        public mutating func due(now: Int64) -> Step {
            var s = Step()
            for (call, w) in pending.entries where w.until <= now {
                finish(call)
                if w.rang { s.over = true }
                let r = Self.record(declined: w.declined, at: w.at, video: w.video, who: w.who)
                s.records.append(r)
                if !w.declined && s.missed == nil { s.missed = r }
            }
            return s
        }

        /// When the next waiting ring is due (0: none).
        public var nextDue: Int64 {
            var next: Int64 = 0
            for w in pending.orderedValues where next == 0 || w.until < next { next = w.until }
            return next
        }
    }
}
