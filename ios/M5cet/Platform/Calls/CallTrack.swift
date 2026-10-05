// 6.8: what a room's call was for me — one record per call, not per peer —
// worked out from what the room sees: my own audio (on / off, video) and the
// others' audio-status ("live" / "muted" / "off"). Calls have no ringing on
// the wire: someone else's audio going live is the announcement, and it rings
// here (CallKit, CallCenter).
//
//   out        I turned my audio on while nobody else was in the call
//   in         I turned it on while someone was (I joined their call)
//   missed     someone was in a call here, and it ended without me
//   declined   …and I declined its ring (and did not join after all)
//
// Incoming / outgoing are recorded when I leave the call (its length is my time
// in it); missed / declined when the call is over — nobody in it for `graceMs`,
// so a connection that drops and comes back is still the same call (one record,
// one ring). Pure: RoomRtc feeds it on every change, CallTrackTests checks it.
//
// Port of android/app/src/main/java/cz/m5cet/app/chat/CallTrack.java (times in
// milliseconds since 1970, as Android and the call history's JSON keep them).

import Foundation

struct CallTrack: Sendable {
    /// How long nobody may be in a call before it is over.
    static let graceMs: Int64 = 20_000
    /// At most this many names in a record.
    static let peopleMax = 8

    /// What a call was for me (the call history's "kind").
    enum Kind: String, Sendable, CaseIterable {
        case outgoing = "out", incoming = "in", missed, declined
    }

    /// One call as I had it.
    struct Record: Equatable, Sendable {
        let kind: Kind
        /// When I joined / started it (in, out), or when it started (missed, declined), ms.
        let at: Int64
        /// My time in it (0 for missed / declined).
        let seconds: Int64
        let video: Bool
        /// The others in it (their names in the room), in the order they came.
        let people: [String]

        init(kind: Kind, at: Int64, seconds: Int64, video: Bool, people: [String]) {
            self.kind = kind
            self.at = at
            self.seconds = max(0, seconds)
            self.video = video
            self.people = people
        }
    }

    /// What the room does after an update.
    struct Step: Sendable {
        var records: [Record] = []
        /// Someone else started a call and I am not in it: ring.
        var ring = false
        /// The ring is over (I joined, declined, or the call ended).
        var ringOver = false
        /// Update again at this time (when a quiet call would be over); 0 = no need.
        var recheckAt: Int64 = 0
        /// Who rings (the first of the others), whether with video.
        var who = ""
        var video = false
    }

    // The call in the room (anyone's).
    private var call = false, joined = false, declined = false, ringingNow = false, callVideo = false
    private var callAt: Int64 = 0, quietSince: Int64 = 0
    private var callPeople: [String] = []
    // My part of it.
    private var me = false, meOutgoing = false, meVideo = false
    private var meSince: Int64 = 0
    private var mePeople: [String] = []

    /// Whether a call is ringing here now.
    var ringing: Bool { ringingNow }

    /// The room now: whether my audio is on (and my camera), the names of the
    /// others whose audio is on, whether any of them sends video.
    mutating func update(now: Int64, meOn: Bool, myVideo: Bool, live: [String], peerVideo: Bool) -> Step {
        var s = Step()
        let others = !live.isEmpty
        let any = meOn || others
        if !call && any {
            call = true
            callAt = now
            joined = false; declined = false; ringingNow = false; callVideo = false
            callPeople.removeAll()
        }
        if call {
            Self.add(&callPeople, live)
            callVideo = callVideo || peerVideo || myVideo
        }
        if meOn && !me {
            me = true
            meSince = now
            meOutgoing = !others
            meVideo = false
            mePeople.removeAll()
            joined = true
        }
        if meOn {
            meVideo = meVideo || myVideo || peerVideo
            Self.add(&mePeople, live)
        } else if me {
            me = false
            s.records.append(Record(kind: meOutgoing ? .outgoing : .incoming, at: meSince, seconds: (now - meSince) / 1000,
                                    video: meVideo, people: mePeople))
        }
        if call && others && !joined && !declined && !ringingNow {
            ringingNow = true
            s.ring = true
            s.who = live[0]
            s.video = callVideo
        }
        if ringingNow && (joined || declined) { ringingNow = false; s.ringOver = true }
        if call && !any {
            if quietSince == 0 { quietSince = now }
            if now - quietSince >= Self.graceMs { end(&s) } else { s.recheckAt = quietSince + Self.graceMs }
        } else {
            quietSince = 0
        }
        return s
    }

    /// I declined the ring: the call counts as declined unless I join it after all.
    mutating func decline() -> Step {
        var s = Step()
        if !call || joined { return s }
        declined = true
        if ringingNow { ringingNow = false; s.ringOver = true }
        return s
    }

    /// The room is gone (left, closed): whatever was open is recorded now.
    mutating func flush(now: Int64) -> Step {
        var s = Step()
        if me {
            me = false
            s.records.append(Record(kind: meOutgoing ? .outgoing : .incoming, at: meSince, seconds: (now - meSince) / 1000,
                                    video: meVideo, people: mePeople))
        }
        if call { end(&s) }
        return s
    }

    private mutating func end(_ s: inout Step) {
        call = false
        quietSince = 0
        if ringingNow { ringingNow = false; s.ringOver = true }
        // A call I was never in, of someone else (one I started alone and left is my outgoing record).
        if !joined && !callPeople.isEmpty {
            s.records.append(Record(kind: declined ? .declined : .missed, at: callAt, seconds: 0, video: callVideo, people: callPeople))
        }
        callPeople.removeAll()
    }

    private static func add(_ to: inout [String], _ names: [String]) {
        for n in names {
            if to.count >= peopleMax { return }
            if !n.isEmpty && !to.contains(n) { to.append(n) }
        }
    }
}

extension CallTrack {
    /// Milliseconds since 1970 (the unit of every time here).
    static func millis(_ date: Date = Date()) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }
}
