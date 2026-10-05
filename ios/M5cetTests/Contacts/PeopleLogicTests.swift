// Ports of the Android JVM tests of contacts/* (android/app/src/test/java/cz/m5cet/app/contacts):
// MatchTest, SafetyTest, LastSeenTest, PresenceTest, AvatarsTest — the same vectors (the web's,
// computed by Node's WebCrypto), the same expectations. RtcStatsTest is ported by Platform/Calls
// (M5cetTests/Calls/RtcStatsTests.swift), where RtcStats lives on iOS.

import XCTest
import M5Core
import M5Crypto
@testable import M5cet

final class MatchTests: XCTestCase {
    private func c(_ room: String, _ peer: String, _ user: String, _ signedIn: Bool, _ open: Bool, _ active: Bool, _ activity: Int64) -> Match.Candidate {
        Match.Candidate(roomKey: room, peerId: peer, username: user, signedIn: signedIn, open: open, activeRoom: active, roomActivity: activity)
    }

    func testUsernamesAsTheWebCleansThem() {
        XCTAssertEqual("bystry-sokol-7k3q", Match.cleanUsername(" bystry-sokol-7k3q "))
        XCTAssertEqual("", Match.cleanUsername("ab"))
        XCTAssertEqual("", Match.cleanUsername("with space"))
        XCTAssertEqual("", Match.cleanUsername("tomáš"))
        XCTAssertEqual("", Match.cleanUsername(json: 42))
        XCTAssertEqual("", Match.cleanUsername(nil))
        XCTAssertEqual("", Match.cleanUsername(json: .null))
        XCTAssertEqual("Old_Account_Id-1234567", Match.cleanUsername("Old_Account_Id-1234567"))
    }

    func testOnlySignedInPeopleCanBeLinked() {
        XCTAssertTrue(Match.canLink("bystry-sokol-7k3q", signedIn: true))
        XCTAssertFalse(Match.canLink("bystry-sokol-7k3q", signedIn: false)) // a guest's session username is not an account
        XCTAssertFalse(Match.canLink("", signedIn: true))
        XCTAssertEqual("bystry-sokol-7k3q", Match.key("Bystry-Sokol-7K3Q"))
    }

    func testTheSignedInOpenPersonWithThatUsername() {
        let cs = [
            c("a", "p1", "bystry-sokol-7k3q", false, true, true, 5),   // claims the name without an account
            c("a", "p2", "bystry-sokol-7k3q", true, false, true, 5),   // not connected
            c("b", "p3", "Bystry-Sokol-7K3Q", true, true, false, 1),
            c("b", "p4", "jiny-rys-2222", true, true, false, 1),
        ]
        XCTAssertEqual("p3", Match.pick(cs, username: "bystry-sokol-7k3q")?.peerId)
        XCTAssertNil(Match.pick(cs, username: "nikdo-tu-9999"))
        XCTAssertNil(Match.pick(cs, username: ""))
        XCTAssertNil(Match.pick([], username: "bystry-sokol-7k3q"))
    }

    func testTheActiveRoomFirstThenTheMostRecentlyActive() {
        let cs = [
            c("old", "p1", "rys-lis-aaaa", true, true, false, 100),
            c("recent", "p2", "rys-lis-aaaa", true, true, false, 900),
            c("active", "p3", "rys-lis-aaaa", true, true, true, 10),
        ]
        XCTAssertEqual("active", Match.pick(cs, username: "rys-lis-aaaa")?.roomKey)
        XCTAssertEqual("recent", Match.pick(Array(cs[0..<2]), username: "rys-lis-aaaa")?.roomKey)
    }

    func testWaitsWhileRoomsSettleThenSaysNotOnline() {
        XCTAssertEqual(.found, Match.decide(found: true, settling: true, startedAt: 0, now: 1))
        XCTAssertEqual(.wait, Match.decide(found: false, settling: true, startedAt: 1000, now: 1000 + Match.waitMs - 1))
        XCTAssertEqual(.missing, Match.decide(found: false, settling: true, startedAt: 1000, now: 1000 + Match.waitMs))
        XCTAssertEqual(.missing, Match.decide(found: false, settling: false, startedAt: 1000, now: 1001))
    }
}

final class SafetyTests: XCTestCase {
    private let a = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4/wYNFBsiKTA3PkVMU1phaG92fYSLkpmgp661vMPK0djf5u30+wIJEBceJSwzOkFIT1ZdZGtyeQ=="
    private let b = "yNXi7/wJFiMwPUpXZHF+i5ilsr/M2ebzAA0aJzRBTltodYKPnKm2w9Dd6vcEER4rOEVSX2x5hpOgrbrH1OHu+wgVIi88SVZjcH2Kl6SxvsvY5fL/DBkmM0BNWg=="
    private let number = "13286 60170 84613 24995 23962 36648 18264 48418 04707 59157 69365 29038"

    func testTheSameNumberOnBothSides() {
        XCTAssertEqual(number, Safety.number(a, b))
        XCTAssertEqual(number, Safety.number(b, a))
        // M5Crypto's identity computes the same for valid keys (one algorithm, two homes).
        XCTAssertEqual(number, ChatIdentity.safetyNumber(a, b))
    }

    func testNoNumberWithoutBothKeys() {
        XCTAssertEqual("", Safety.number(a, ""))
        XCTAssertEqual("", Safety.number(nil, b))
        XCTAssertEqual("", Safety.number(a, "not base64 !"))
    }

    func testReadAloudInThreeLines() {
        XCTAssertEqual("13286 60170 84613 24995\n23962 36648 18264 48418\n04707 59157 69365 29038", Safety.lines(number))
        XCTAssertEqual("", Safety.lines(""))
    }

    func testFingerprintAndKeyId() {
        XCTAssertEqual("8537 3E64 524D FF04 7F54 2310 0FA3 B932", Safety.fingerprint(a))
        XCTAssertEqual("hTc-ZFJN_wR_VCMQ", Safety.keyId(a))
        XCTAssertEqual("", Safety.fingerprint(""))
        XCTAssertEqual("", Safety.keyId(nil))
        XCTAssertEqual(Ec.kid(a), Safety.keyId(a))
        XCTAssertEqual(Ec.fingerprint(a), Safety.fingerprint(a))
    }
}

final class LastSeenTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000, min: Int64 = 60_000

    private func away(_ lastSeen: Int64) -> String { LastSeen.state(connected: false, foreground: false, lastSeen: lastSeen, now: now) }

    func testOnlineWhileConnectedInTheForeground() {
        XCTAssertEqual("online", LastSeen.state(connected: true, foreground: true, lastSeen: 0, now: now))
        XCTAssertEqual("online", LastSeen.state(connected: true, foreground: true, lastSeen: now - 10 * 60 * min, now: now))
    }

    func testTheThresholdsMatchTheWeb() {
        XCTAssertEqual(5 * min, LastSeen.onlineMs)
        XCTAssertEqual(60 * min, LastSeen.awayMs)
        XCTAssertEqual("online", away(now))
        XCTAssertEqual("online", away(now - 5 * min))
        XCTAssertEqual("online", LastSeen.state(connected: true, foreground: false, lastSeen: now - 4 * min, now: now))
        XCTAssertEqual("away", away(now - 5 * min - 1))
        XCTAssertEqual("away", away(now - 60 * min))
        XCTAssertEqual("far", away(now - 60 * min - 1))
        XCTAssertEqual("far", away(0))
    }

    func testSaysWhenTheColourChangesByItself() {
        XCTAssertEqual(-1, LastSeen.changeIn(connected: true, foreground: true, lastSeen: now, now: now))
        let inMs = LastSeen.changeIn(connected: false, foreground: false, lastSeen: now - 2 * min, now: now)
        XCTAssertEqual("away", LastSeen.state(connected: false, foreground: false, lastSeen: now - 2 * min, now: now + inMs))
        XCTAssertEqual("online", LastSeen.state(connected: false, foreground: false, lastSeen: now - 2 * min, now: now + inMs - 1))
        XCTAssertEqual(-1, LastSeen.changeIn(connected: false, foreground: false, lastSeen: now - 2 * 60 * min, now: now))
        XCTAssertEqual(now, LastSeen.seenAt(connected: true, foreground: true, lastSeen: 5, now: now))
        XCTAssertEqual(5, LastSeen.seenAt(connected: true, foreground: false, lastSeen: 5, now: now))
    }

    func testColoursAreThemeTokensAndOrange() {
        XCTAssertEqual("@success", LastSeen.color("online"))
        XCTAssertEqual("@warning", LastSeen.color("away"))
        XCTAssertEqual("#f97316", LastSeen.color("far"))
    }

    func testWordsHowLongAgo() {
        let en: LastSeen.Words = { key in
            switch key {
            case "presence.now": "In the app right now"
            case "presence.seen": "Last seen {ago}"
            case "presence.seen.unknown": "Not known when last seen"
            case "presence.ago.now": "just now"
            case "presence.ago.min": "{n} min ago"
            case "presence.ago.h": "{n} h ago"
            case "presence.ago.d": "{n} d ago"
            default: key
            }
        }
        XCTAssertEqual("In the app right now", LastSeen.seenText(connected: true, foreground: true, lastSeen: 0, now: now, words: en))
        XCTAssertEqual("Last seen just now", LastSeen.seenText(connected: false, foreground: false, lastSeen: now - 20_000, now: now, words: en))
        XCTAssertEqual("Last seen 12 min ago", LastSeen.seenText(connected: false, foreground: false, lastSeen: now - 12 * min, now: now, words: en))
        XCTAssertEqual("Last seen 3 h ago", LastSeen.seenText(connected: true, foreground: false, lastSeen: now - 3 * 60 * min - 5, now: now, words: en))
        XCTAssertEqual("Last seen 2 d ago", LastSeen.seenText(connected: false, foreground: false, lastSeen: now - 2 * 24 * 60 * min, now: now, words: en))
        XCTAssertEqual("Not known when last seen", LastSeen.seenText(connected: false, foreground: false, lastSeen: 0, now: now, words: en))
        XCTAssertEqual("min", LastSeen.ago(lastSeen: now - 12 * min, now: now).unit)
        XCTAssertEqual(12, LastSeen.ago(lastSeen: now - 12 * min, now: now).n)
    }

    func testDecoratesAPersonOfThePeopleWidget() {
        let w: LastSeen.Words = { $0 }
        let live = LastSeen.decorate(JSONObject([("channel", "open"), ("connected", true), ("foreground", false),
                                                 ("lastSeen", .double(Double(now - 20 * min))), ("statusIcon", "circle-check")]), words: w, now: now)
        XCTAssertEqual("away", live.optString("presence"))
        XCTAssertEqual("@warning", live.optString("presenceColor"))
        XCTAssertEqual("presence.away", live.optString("presenceLabel"))
        XCTAssertEqual("circle-check", live.optString("statusIcon")) // a live peer keeps its connection status

        let held = LastSeen.decorate(JSONObject([("channel", "held"), ("connected", false), ("foreground", false),
                                                 ("lastSeen", .double(Double(now - 3 * 60 * min)))]), words: w, now: now)
        XCTAssertEqual("far", held.optString("presence"))
        XCTAssertEqual("moon", held.optString("statusIcon"))
        XCTAssertEqual("#f97316", held.optString("statusColor"))

        let none = LastSeen.decorate(JSONObject([("channel", "open")]), words: w, now: now)
        XCTAssertFalse(none.has("presence"))
        XCTAssertTrue(LastSeen.decorate(JSONObject([("me", true), ("connected", true), ("foreground", true), ("lastSeen", .double(Double(now)))]),
                                        words: w, now: now).has("seenText"))
    }
}

final class PresenceTests: XCTestCase {
    func testStatusFromWhatTheRoomKnows() {
        XCTAssertEqual(Presence.online, Presence.status(channel: "open", signedIn: true, audio: "off"))
        XCTAssertEqual(Presence.light, Presence.status(channel: "open", signedIn: false, audio: "off"))
        XCTAssertEqual(Presence.dnd, Presence.status(channel: "open", signedIn: true, audio: "live"))
        XCTAssertEqual(Presence.dnd, Presence.status(channel: "open", signedIn: false, audio: "muted"))
        XCTAssertEqual(Presence.away, Presence.status(channel: "away", signedIn: true, audio: "off"))
        XCTAssertEqual(Presence.connecting, Presence.status(channel: "connecting", signedIn: true, audio: "live"))
        XCTAssertEqual(Presence.offline, Presence.status(channel: "closed", signedIn: true, audio: "off"))
        XCTAssertEqual(Presence.offline, Presence.status(channel: nil, signedIn: false, audio: nil))
    }

    func testConnectedFirstAwayNextTheRestLast() {
        XCTAssertEqual(0, Presence.rank(Presence.online))
        XCTAssertEqual(0, Presence.rank(Presence.light))
        XCTAssertEqual(0, Presence.rank(Presence.dnd))
        XCTAssertEqual(1, Presence.rank(Presence.away))
        XCTAssertEqual(2, Presence.rank(Presence.connecting))
        XCTAssertEqual(3, Presence.rank(Presence.offline))
    }

    func testIconsAndColours() {
        XCTAssertEqual("circle-check", Presence.icon(Presence.online))
        XCTAssertEqual("moon", Presence.icon(Presence.away))
        XCTAssertEqual("circle-minus", Presence.icon(Presence.dnd))
        XCTAssertEqual("circle-off", Presence.icon(Presence.offline))
        XCTAssertEqual("@success", Presence.color(Presence.online))
        XCTAssertEqual("@warning", Presence.color(Presence.away))
        XCTAssertEqual("@danger", Presence.color(Presence.dnd))
        XCTAssertEqual("@muted", Presence.color(Presence.connecting))
    }

    func testTheWebsLatencyMeter() {
        XCTAssertEqual(0, Presence.bars(open: false, rttMs: 20))
        XCTAssertEqual(2, Presence.bars(open: true, rttMs: -1))
        XCTAssertEqual(4, Presence.bars(open: true, rttMs: 0))
        XCTAssertEqual(4, Presence.bars(open: true, rttMs: 59))
        XCTAssertEqual(3, Presence.bars(open: true, rttMs: 60))
        XCTAssertEqual(3, Presence.bars(open: true, rttMs: 119))
        XCTAssertEqual(2, Presence.bars(open: true, rttMs: 120))
        XCTAssertEqual(2, Presence.bars(open: true, rttMs: 249))
        XCTAssertEqual(1, Presence.bars(open: true, rttMs: 250))
        XCTAssertEqual(1, Presence.bars(open: true, rttMs: 5000))
    }

    func testSignalIconsAndTones() {
        XCTAssertEqual("signal-zero", Presence.signalIcon(0))
        XCTAssertEqual("signal-low", Presence.signalIcon(1))
        XCTAssertEqual("signal-medium", Presence.signalIcon(2))
        XCTAssertEqual("signal-high", Presence.signalIcon(3))
        XCTAssertEqual("signal", Presence.signalIcon(4))
        XCTAssertEqual("off", Presence.tone(0))
        XCTAssertEqual("bad", Presence.tone(1))
        XCTAssertEqual("ok", Presence.tone(2))
        XCTAssertEqual("ok", Presence.tone(3))
        XCTAssertEqual("good", Presence.tone(4))
        XCTAssertEqual("@muted", Presence.signalColor(0))
        XCTAssertEqual("@danger", Presence.signalColor(1))
        XCTAssertEqual("@warning", Presence.signalColor(3))
        XCTAssertEqual("@success", Presence.signalColor(4))
    }

    func testTransport() {
        XCTAssertEqual("", Presence.transport(local: "", remote: ""))
        XCTAssertEqual("direct", Presence.transport(local: "host", remote: "srflx"))
        XCTAssertEqual("direct", Presence.transport(local: "prflx", remote: "host"))
        XCTAssertEqual("relay", Presence.transport(local: "relay", remote: "srflx"))
        XCTAssertEqual("relay", Presence.transport(local: "host", remote: "relay"))
    }

    func testDurationsAndBytesAsTheWebWritesThem() {
        XCTAssertEqual("—", Presence.duration(-1, h: "h", m: "min", s: "s"))
        XCTAssertEqual("0 s", Presence.duration(999, h: "h", m: "min", s: "s"))
        XCTAssertEqual("40 s", Presence.duration(40_000, h: "h", m: "min", s: "s"))
        XCTAssertEqual("3 min 12 s", Presence.duration(192_000, h: "h", m: "min", s: "s"))
        XCTAssertEqual("2 h 5 min", Presence.duration(7_500_000, h: "h", m: "min", s: "s"))
        XCTAssertEqual("512 B", Presence.bytes(512))
        XCTAssertEqual("1.5 kB", Presence.bytes(1536))
        XCTAssertEqual("2.25 MB", Presence.bytes(2_359_296))
    }
}

final class AvatarsTests: XCTestCase {
    func testGlyphs() {
        XCTAssertEqual("A", Avatars.glyph(name: "alice", avatar: nil))
        XCTAssertEqual("Ž", Avatars.glyph(name: " žofie", avatar: nil))
        XCTAssertEqual("?", Avatars.glyph(name: "", avatar: nil))
        XCTAssertEqual("?", Avatars.glyph(name: nil, avatar: nil))
        XCTAssertEqual("😀", Avatars.glyph(name: "😀x", avatar: nil))
        XCTAssertEqual("SS", Avatars.glyph(name: "ßtraße", avatar: nil))
        // A short emoji avatar wins; anything that looks like a URL or path does not.
        XCTAssertEqual("🦊", Avatars.glyph(name: "alice", avatar: "🦊"))
        XCTAssertEqual("A", Avatars.glyph(name: "alice", avatar: "https://x"))
        XCTAssertEqual("A", Avatars.glyph(name: "alice", avatar: "abc"))
    }

    func testHuesAsTheWebComputesThem() {
        XCTAssertEqual(0, Avatars.hue("alice"))
        XCTAssertEqual(314, Avatars.hue("tomáš"))
        XCTAssertEqual(201, Avatars.hue("Žofie"))
        XCTAssertEqual(63, Avatars.hue("?"))
        XCTAssertEqual(63, Avatars.hue(""))
        XCTAssertEqual(273, Avatars.hue("bystry-sokol-7k3q"))
        XCTAssertEqual(229, Avatars.hue("😀x"))
        XCTAssertEqual(Avatars.hue("Alice"), Avatars.hue("alice"))
    }

    func testHslAsCssComputesIt() {
        XCTAssertEqual(0xffff0000, Avatars.hsl(0, 1, 0.5, 1))
        XCTAssertEqual(0xff00ff00, Avatars.hsl(120, 1, 0.5, 1))
        XCTAssertEqual(0xff0000ff, Avatars.hsl(240, 1, 0.5, 1))
        XCTAssertEqual(0xff808080, Avatars.hsl(77, 0, 0.5, 1))
        // hsl(0 70% 42%) = rgb(182, 32, 32); hsl(0 62% 42% / 0.22) = rgba(174, 41, 41, 0.22)
        XCTAssertEqual("#ffb62020", Avatars.foreground("alice"))
        XCTAssertEqual("#38ae2929", Avatars.background("alice"))
    }
}

/// Java's %.Nf and Math.round, which the links and texts of every port use.
final class JavaFormatTests: XCTestCase {
    func testFixedRoundsTheShortestFormHalfUp() {
        XCTAssertEqual("50.087500", JavaFormat.fixed(50.0875, 6))
        XCTAssertEqual("-33.856800", JavaFormat.fixed(-33.8568, 6))
        XCTAssertEqual("0.2", JavaFormat.fixed(0.15, 1))      // C's printf: 0.1
        XCTAssertEqual("1.3", JavaFormat.fixed(1.25, 1))      // C's printf: 1.2
        XCTAssertEqual("-0.0", JavaFormat.fixed(-0.04, 1))
        XCTAssertEqual("3", JavaFormat.fixed(2.5, 0))
        XCTAssertEqual("0.000001", JavaFormat.fixed(1e-6, 6))
        XCTAssertEqual("12.00", JavaFormat.fixed(12, 2))
    }

    func testRoundIsFloorOfXPlusAHalf() {
        XCTAssertEqual(3, JavaFormat.round(2.5))
        XCTAssertEqual(-2, JavaFormat.round(-2.5))
        XCTAssertEqual(-3, JavaFormat.round(-2.6))
        XCTAssertEqual(Int32(13), JavaFormat.round(Float(12.5)))
    }
}
