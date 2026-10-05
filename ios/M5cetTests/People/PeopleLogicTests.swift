// Ports of the Android JVM tests of contacts/* (AvatarsTest, LastSeenTest, MatchTest,
// PresenceTest, SafetyTest) — the same vectors, made by the web's code (Node's
// WebCrypto, UserBadge.tsx, presence.ts) — and the QR code of a safety number
// (the web's UserInfoModal: "M5CET-SN:1:" + the digits), drawn and read back.

import M5Core
import M5Crypto
import XCTest
@testable import M5cet

final class PeopleAvatarsTests: XCTestCase {
    func testGlyphs() {
        XCTAssertEqual(PeopleAvatars.glyph("alice", nil), "A")
        XCTAssertEqual(PeopleAvatars.glyph(" žofie", nil), "Ž")
        XCTAssertEqual(PeopleAvatars.glyph("", nil), "?")
        XCTAssertEqual(PeopleAvatars.glyph(nil, nil), "?")
        XCTAssertEqual(PeopleAvatars.glyph("😀x", nil), "😀")
        XCTAssertEqual(PeopleAvatars.glyph("ßtraße", nil), "SS")
        // A short emoji avatar wins; anything that looks like a URL or path does not.
        XCTAssertEqual(PeopleAvatars.glyph("alice", "🦊"), "🦊")
        XCTAssertEqual(PeopleAvatars.glyph("alice", "https://x"), "A")
        XCTAssertEqual(PeopleAvatars.glyph("alice", "abc"), "A")
    }

    func testHuesAsTheWebComputesThem() {
        XCTAssertEqual(PeopleAvatars.hue("alice"), 0)
        XCTAssertEqual(PeopleAvatars.hue("tomáš"), 314)
        XCTAssertEqual(PeopleAvatars.hue("Žofie"), 201)
        XCTAssertEqual(PeopleAvatars.hue("?"), 63)
        XCTAssertEqual(PeopleAvatars.hue(""), 63)
        XCTAssertEqual(PeopleAvatars.hue("bystry-sokol-7k3q"), 273)
        XCTAssertEqual(PeopleAvatars.hue("😀x"), 229)
        XCTAssertEqual(PeopleAvatars.hue("Alice"), PeopleAvatars.hue("alice"))
    }

    func testHslAsCssComputesIt() {
        XCTAssertEqual(PeopleAvatars.hsl(0, 1, 0.5, 1), 0xFFFF_0000)
        XCTAssertEqual(PeopleAvatars.hsl(120, 1, 0.5, 1), 0xFF00_FF00)
        XCTAssertEqual(PeopleAvatars.hsl(240, 1, 0.5, 1), 0xFF00_00FF)
        XCTAssertEqual(PeopleAvatars.hsl(77, 0, 0.5, 1), 0xFF80_8080)
        // hsl(0 70% 42%) = rgb(182, 32, 32); hsl(0 62% 42% / 0.22) = rgba(174, 41, 41, 0.22)
        XCTAssertEqual(PeopleAvatars.foreground("alice"), "#ffb62020")
        XCTAssertEqual(PeopleAvatars.background("alice"), "#38ae2929")
    }
}

final class PeopleLastSeenTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000, min: Int64 = 60_000

    private func away(_ lastSeen: Int64) -> String { PeopleLastSeen.state(connected: false, foreground: false, lastSeen: lastSeen, now: now) }

    func testOnlineWhileConnectedInTheForeground() {
        XCTAssertEqual(PeopleLastSeen.state(connected: true, foreground: true, lastSeen: 0, now: now), "online")
        XCTAssertEqual(PeopleLastSeen.state(connected: true, foreground: true, lastSeen: now - 10 * 60 * min, now: now), "online")
    }

    func testTheThresholdsMatchTheWeb() {
        XCTAssertEqual(PeopleLastSeen.onlineMs, 5 * min)
        XCTAssertEqual(PeopleLastSeen.awayMs, 60 * min)
        XCTAssertEqual(away(now), "online")
        XCTAssertEqual(away(now - 5 * min), "online")
        XCTAssertEqual(PeopleLastSeen.state(connected: true, foreground: false, lastSeen: now - 4 * min, now: now), "online")
        XCTAssertEqual(away(now - 5 * min - 1), "away")
        XCTAssertEqual(away(now - 60 * min), "away")
        XCTAssertEqual(away(now - 60 * min - 1), "far")
        XCTAssertEqual(away(0), "far")
    }

    func testSaysWhenTheColourChangesByItself() {
        XCTAssertEqual(PeopleLastSeen.changeIn(connected: true, foreground: true, lastSeen: now, now: now), -1)
        let i = PeopleLastSeen.changeIn(connected: false, foreground: false, lastSeen: now - 2 * min, now: now)
        XCTAssertEqual(PeopleLastSeen.state(connected: false, foreground: false, lastSeen: now - 2 * min, now: now + i), "away")
        XCTAssertEqual(PeopleLastSeen.state(connected: false, foreground: false, lastSeen: now - 2 * min, now: now + i - 1), "online")
        XCTAssertEqual(PeopleLastSeen.changeIn(connected: false, foreground: false, lastSeen: now - 2 * 60 * min, now: now), -1)
        XCTAssertEqual(PeopleLastSeen.seenAt(connected: true, foreground: true, lastSeen: 5, now: now), now)
        XCTAssertEqual(PeopleLastSeen.seenAt(connected: true, foreground: false, lastSeen: 5, now: now), 5)
    }

    func testColoursAreThemeTokensAndOrange() {
        XCTAssertEqual(PeopleLastSeen.color("online"), "@success")
        XCTAssertEqual(PeopleLastSeen.color("away"), "@warning")
        XCTAssertEqual(PeopleLastSeen.color("far"), "#f97316")
    }

    func testWordsHowLongAgo() {
        let en: (String) -> String = { key in
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
        XCTAssertEqual(PeopleLastSeen.seenText(connected: true, foreground: true, lastSeen: 0, now: now, t: en), "In the app right now")
        XCTAssertEqual(PeopleLastSeen.seenText(connected: false, foreground: false, lastSeen: now - 20_000, now: now, t: en), "Last seen just now")
        XCTAssertEqual(PeopleLastSeen.seenText(connected: false, foreground: false, lastSeen: now - 12 * min, now: now, t: en), "Last seen 12 min ago")
        XCTAssertEqual(PeopleLastSeen.seenText(connected: true, foreground: false, lastSeen: now - 3 * 60 * min - 5, now: now, t: en), "Last seen 3 h ago")
        XCTAssertEqual(PeopleLastSeen.seenText(connected: false, foreground: false, lastSeen: now - 2 * 24 * 60 * min, now: now, t: en), "Last seen 2 d ago")
        XCTAssertEqual(PeopleLastSeen.seenText(connected: false, foreground: false, lastSeen: 0, now: now, t: en), "Not known when last seen")
        XCTAssertEqual(PeopleLastSeen.ago(now - 12 * min, now: now), .init(unit: "min", n: 12))
    }

    func testDecoratesAPersonOfThePeopleWidget() {
        let w: (String) -> String = { $0 }
        var live = JSONObject([("channel", "open"), ("connected", true), ("foreground", false), ("lastSeen", .double(Double(now - 20 * min))), ("statusIcon", "circle-check")])
        PeopleLastSeen.decorate(&live, t: w, now: now)
        XCTAssertEqual(live.optString("presence"), "away")
        XCTAssertEqual(live.optString("presenceColor"), "@warning")
        XCTAssertEqual(live.optString("presenceLabel"), "presence.away")
        XCTAssertEqual(live.optString("statusIcon"), "circle-check") // a live peer keeps its connection status

        var held = JSONObject([("channel", "held"), ("connected", false), ("foreground", false), ("lastSeen", .double(Double(now - 3 * 60 * min)))])
        PeopleLastSeen.decorate(&held, t: w, now: now)
        XCTAssertEqual(held.optString("presence"), "far")
        XCTAssertEqual(held.optString("statusIcon"), "moon")
        XCTAssertEqual(held.optString("statusColor"), "#f97316")

        var none = JSONObject([("channel", "open")])
        PeopleLastSeen.decorate(&none, t: w, now: now)
        XCTAssertFalse(none.has("presence"))
        var me = JSONObject([("me", true), ("connected", true), ("foreground", true), ("lastSeen", .double(Double(now)))])
        PeopleLastSeen.decorate(&me, t: w, now: now)
        XCTAssertTrue(me.has("seenText"))
    }
}

final class PeopleMatchTests: XCTestCase {
    private func c(_ room: String, _ peer: String, _ user: String, _ signedIn: Bool, _ open: Bool, _ active: Bool, _ activity: Int64) -> PeopleMatch.Candidate {
        PeopleMatch.Candidate(roomKey: room, peerId: peer, username: user, signedIn: signedIn, open: open, activeRoom: active, roomActivity: activity)
    }

    func testUsernamesAsTheWebCleansThem() {
        XCTAssertEqual(PeopleMatch.cleanUsername(" bystry-sokol-7k3q "), "bystry-sokol-7k3q")
        XCTAssertEqual(PeopleMatch.cleanUsername("ab"), "")
        XCTAssertEqual(PeopleMatch.cleanUsername("with space"), "")
        XCTAssertEqual(PeopleMatch.cleanUsername("tomáš"), "")
        XCTAssertEqual(PeopleMatch.cleanUsername(42), "")
        XCTAssertEqual(PeopleMatch.cleanUsername(nil), "")
        XCTAssertEqual(PeopleMatch.cleanUsername("Old_Account_Id-1234567"), "Old_Account_Id-1234567")
    }

    func testOnlySignedInPeopleCanBeLinked() {
        XCTAssertTrue(PeopleMatch.canLink("bystry-sokol-7k3q", signedIn: true))
        XCTAssertFalse(PeopleMatch.canLink("bystry-sokol-7k3q", signedIn: false)) // a guest's session username is not an account
        XCTAssertFalse(PeopleMatch.canLink("", signedIn: true))
        XCTAssertEqual(PeopleMatch.key("Bystry-Sokol-7K3Q"), "bystry-sokol-7k3q")
    }

    func testTheSignedInOpenPersonWithThatUsername() {
        let cs = [c("a", "p1", "bystry-sokol-7k3q", false, true, true, 5),   // claims the name without an account
                  c("a", "p2", "bystry-sokol-7k3q", true, false, true, 5),   // not connected
                  c("b", "p3", "Bystry-Sokol-7K3Q", true, true, false, 1),
                  c("b", "p4", "jiny-rys-2222", true, true, false, 1)]
        XCTAssertEqual(PeopleMatch.pick(cs, "bystry-sokol-7k3q")?.peerId, "p3")
        XCTAssertNil(PeopleMatch.pick(cs, "nikdo-tu-9999"))
        XCTAssertNil(PeopleMatch.pick(cs, ""))
        XCTAssertNil(PeopleMatch.pick([], "bystry-sokol-7k3q"))
    }

    func testTheActiveRoomFirstThenTheMostRecentlyActive() {
        let cs = [c("old", "p1", "rys-lis-aaaa", true, true, false, 100),
                  c("recent", "p2", "rys-lis-aaaa", true, true, false, 900),
                  c("active", "p3", "rys-lis-aaaa", true, true, true, 10)]
        XCTAssertEqual(PeopleMatch.pick(cs, "rys-lis-aaaa")?.roomKey, "active")
        XCTAssertEqual(PeopleMatch.pick(Array(cs.prefix(2)), "rys-lis-aaaa")?.roomKey, "recent")
    }

    func testWaitsWhileRoomsSettleThenSaysNotOnline() {
        XCTAssertEqual(PeopleMatch.decide(found: true, settling: true, startedAt: 0, now: 1), PeopleMatch.found)
        XCTAssertEqual(PeopleMatch.decide(found: false, settling: true, startedAt: 1000, now: 1000 + PeopleMatch.waitMs - 1), PeopleMatch.wait)
        XCTAssertEqual(PeopleMatch.decide(found: false, settling: true, startedAt: 1000, now: 1000 + PeopleMatch.waitMs), PeopleMatch.missing)
        XCTAssertEqual(PeopleMatch.decide(found: false, settling: false, startedAt: 1000, now: 1001), PeopleMatch.missing)
    }
}

final class PeoplePresenceTests: XCTestCase {
    func testStatusFromWhatTheRoomKnows() {
        XCTAssertEqual(PeoplePresence.status("open", signedIn: true, audio: "off"), PeoplePresence.online)
        XCTAssertEqual(PeoplePresence.status("open", signedIn: false, audio: "off"), PeoplePresence.light)
        XCTAssertEqual(PeoplePresence.status("open", signedIn: true, audio: "live"), PeoplePresence.dnd)
        XCTAssertEqual(PeoplePresence.status("open", signedIn: false, audio: "muted"), PeoplePresence.dnd)
        XCTAssertEqual(PeoplePresence.status("away", signedIn: true, audio: "off"), PeoplePresence.away)
        XCTAssertEqual(PeoplePresence.status("connecting", signedIn: true, audio: "live"), PeoplePresence.connecting)
        XCTAssertEqual(PeoplePresence.status("closed", signedIn: true, audio: "off"), PeoplePresence.offline)
        XCTAssertEqual(PeoplePresence.status(nil, signedIn: false, audio: nil), PeoplePresence.offline)
    }

    func testConnectedFirstAwayNextTheRestLast() {
        XCTAssertEqual(PeoplePresence.rank(PeoplePresence.online), 0)
        XCTAssertEqual(PeoplePresence.rank(PeoplePresence.light), 0)
        XCTAssertEqual(PeoplePresence.rank(PeoplePresence.dnd), 0)
        XCTAssertEqual(PeoplePresence.rank(PeoplePresence.away), 1)
        XCTAssertEqual(PeoplePresence.rank(PeoplePresence.connecting), 2)
        XCTAssertEqual(PeoplePresence.rank(PeoplePresence.offline), 3)
    }

    func testIconsAndColours() {
        XCTAssertEqual(PeoplePresence.icon(PeoplePresence.online), "circle-check")
        XCTAssertEqual(PeoplePresence.icon(PeoplePresence.away), "moon")
        XCTAssertEqual(PeoplePresence.icon(PeoplePresence.dnd), "circle-minus")
        XCTAssertEqual(PeoplePresence.icon(PeoplePresence.offline), "circle-off")
        XCTAssertEqual(PeoplePresence.color(PeoplePresence.online), "@success")
        XCTAssertEqual(PeoplePresence.color(PeoplePresence.away), "@warning")
        XCTAssertEqual(PeoplePresence.color(PeoplePresence.dnd), "@danger")
        XCTAssertEqual(PeoplePresence.color(PeoplePresence.connecting), "@muted")
    }

    func testTheWebsLatencyMeter() {
        XCTAssertEqual(PeoplePresence.bars(open: false, rttMs: 20), 0)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: -1), 2)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 0), 4)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 59), 4)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 60), 3)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 119), 3)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 120), 2)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 249), 2)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 250), 1)
        XCTAssertEqual(PeoplePresence.bars(open: true, rttMs: 5000), 1)
    }

    func testSignalIconsAndTones() {
        XCTAssertEqual(PeoplePresence.signalIcon(0), "signal-zero")
        XCTAssertEqual(PeoplePresence.signalIcon(1), "signal-low")
        XCTAssertEqual(PeoplePresence.signalIcon(2), "signal-medium")
        XCTAssertEqual(PeoplePresence.signalIcon(3), "signal-high")
        XCTAssertEqual(PeoplePresence.signalIcon(4), "signal")
        XCTAssertEqual(PeoplePresence.tone(0), "off")
        XCTAssertEqual(PeoplePresence.tone(1), "bad")
        XCTAssertEqual(PeoplePresence.tone(2), "ok")
        XCTAssertEqual(PeoplePresence.tone(3), "ok")
        XCTAssertEqual(PeoplePresence.tone(4), "good")
        XCTAssertEqual(PeoplePresence.signalColor(0), "@muted")
        XCTAssertEqual(PeoplePresence.signalColor(1), "@danger")
        XCTAssertEqual(PeoplePresence.signalColor(3), "@warning")
        XCTAssertEqual(PeoplePresence.signalColor(4), "@success")
    }

    func testTransport() {
        XCTAssertEqual(PeoplePresence.transport("", ""), "")
        XCTAssertEqual(PeoplePresence.transport("host", "srflx"), "direct")
        XCTAssertEqual(PeoplePresence.transport("prflx", "host"), "direct")
        XCTAssertEqual(PeoplePresence.transport("relay", "srflx"), "relay")
        XCTAssertEqual(PeoplePresence.transport("host", "relay"), "relay")
    }

    func testDurationsAndBytesAsTheWebWritesThem() {
        XCTAssertEqual(PeoplePresence.duration(-1, h: "h", m: "min", s: "s"), "—")
        XCTAssertEqual(PeoplePresence.duration(999, h: "h", m: "min", s: "s"), "0 s")
        XCTAssertEqual(PeoplePresence.duration(40_000, h: "h", m: "min", s: "s"), "40 s")
        XCTAssertEqual(PeoplePresence.duration(192_000, h: "h", m: "min", s: "s"), "3 min 12 s")
        XCTAssertEqual(PeoplePresence.duration(7_500_000, h: "h", m: "min", s: "s"), "2 h 5 min")
        XCTAssertEqual(PeoplePresence.bytes(512), "512 B")
        XCTAssertEqual(PeoplePresence.bytes(1536), "1.5 kB")
        XCTAssertEqual(PeoplePresence.bytes(2_359_296), "2.25 MB")
    }
}

final class PeopleSafetyTests: XCTestCase {
    static let a = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4/wYNFBsiKTA3PkVMU1phaG92fYSLkpmgp661vMPK0djf5u30+wIJEBceJSwzOkFIT1ZdZGtyeQ=="
    static let b = "yNXi7/wJFiMwPUpXZHF+i5ilsr/M2ebzAA0aJzRBTltodYKPnKm2w9Dd6vcEER4rOEVSX2x5hpOgrbrH1OHu+wgVIi88SVZjcH2Kl6SxvsvY5fL/DBkmM0BNWg=="
    static let number = "13286 60170 84613 24995 23962 36648 18264 48418 04707 59157 69365 29038"

    func testTheSameNumberOnBothSides() {
        XCTAssertEqual(PeopleSafety.number(Self.a, Self.b), Self.number)
        XCTAssertEqual(PeopleSafety.number(Self.b, Self.a), Self.number)
    }

    func testNoNumberWithoutBothKeys() {
        XCTAssertEqual(PeopleSafety.number(Self.a, ""), "")
        XCTAssertEqual(PeopleSafety.number(nil, Self.b), "")
        XCTAssertEqual(PeopleSafety.number(Self.a, "not base64 !"), "")
    }

    func testReadAloudInThreeLines() {
        XCTAssertEqual(PeopleSafety.lines(Self.number), "13286 60170 84613 24995\n23962 36648 18264 48418\n04707 59157 69365 29038")
        XCTAssertEqual(PeopleSafety.lines(""), "")
    }

    func testFingerprintAndKeyId() {
        XCTAssertEqual(PeopleSafety.fingerprint(Self.a), "8537 3E64 524D FF04 7F54 2310 0FA3 B932")
        XCTAssertEqual(PeopleSafety.keyId(Self.a), "hTc-ZFJN_wR_VCMQ")
        XCTAssertEqual(PeopleSafety.fingerprint(""), "")
        XCTAssertEqual(PeopleSafety.keyId(nil), "")
    }

    /// The same digits as M5Crypto's identity code (two implementations, one number).
    func testTheSameAsTheProtocolsSafetyNumber() {
        XCTAssertEqual(PeopleSafety.number(Self.a, Self.b), M5CryptoSafety.number(Self.a, Self.b))
    }

    func testTheQRPayloadAsTheWebMakesIt() {
        let payload = PeopleSafety.qrPayload(PeopleSafety.lines(Self.number))
        XCTAssertEqual(payload, "M5CET-SN:1:132866017084613249952396236648182644841804707591576936529038")
        XCTAssertEqual(PeopleSafety.qrDigits(payload), String(payload.dropFirst(11)))
        XCTAssertTrue(PeopleSafety.qrMatches(payload, number: Self.number))
        XCTAssertTrue(PeopleSafety.qrMatches(" " + payload + "\n", number: Self.number))
        XCTAssertFalse(PeopleSafety.qrMatches(payload.replacingOccurrences(of: "29038", with: "29039"), number: Self.number))
        XCTAssertFalse(PeopleSafety.qrMatches(payload, number: ""))
        XCTAssertNil(PeopleSafety.qrDigits("M5CET-SN:2:" + String(payload.dropFirst(11))))
        XCTAssertNil(PeopleSafety.qrDigits("https://example.com"))
        XCTAssertEqual(PeopleSafety.qrPayload("123"), "")
    }

    /// The QR code drawn with CoreImage reads back as the same text (what the other phone's camera reads).
    @MainActor
    func testTheQRCodeRoundTrip() throws {
        let payload = PeopleSafety.qrPayload(Self.number)
        let image = try XCTUnwrap(SafetyQR.image(payload))
        XCTAssertGreaterThan(image.size.width, 100)
        let read = try XCTUnwrap(SafetyQR.read(image))
        XCTAssertEqual(read, payload)
        XCTAssertTrue(PeopleSafety.qrMatches(read, number: Self.number))
        XCTAssertNil(SafetyQR.image(""))
    }
}

/// M5Crypto's identity.ts safetyNumber, for the cross-check.
enum M5CryptoSafety {
    static func number(_ a: String, _ b: String) -> String { ChatIdentity.safetyNumber(a, b) }
}
