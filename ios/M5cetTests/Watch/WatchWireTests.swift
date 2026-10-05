// The WatchConnectivity payloads: the two copies of WatchWire.swift are the same file, envelopes round-trip,
// a receiver refuses what is too big, of another version or outside the limits, and what the watch encodes
// (fixtures made by compiling ios/M5cetWatch/WatchWire.swift for macOS) decodes here as the watch meant it.

import XCTest
@testable import M5cet

final class WatchWireTests: XCTestCase {
    private static let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func testBothCopiesAreIdentical() throws {
        let phone = try Data(contentsOf: Self.ios.appendingPathComponent("M5cet/Platform/Watch/WatchWire.swift"))
        let watch = try Data(contentsOf: Self.ios.appendingPathComponent("M5cetWatch/WatchWire.swift"))
        XCTAssertGreaterThan(phone.count, 1000)
        XCTAssertEqual(phone, watch, "ios/M5cet/Platform/Watch/WatchWire.swift and ios/M5cetWatch/WatchWire.swift must be byte for byte the same")
    }

    // MARK: fixtures from the watch's copy

    /// Printed by the watch's WatchWire.swift compiled with swiftc on macOS (WatchEnvelope.request(…).encoded()).
    static let watchEncoded = [
        #"{"request":{"at":1760000123456,"epoch":"fixepoch00000001","id":"fixreply0000001","ids":[],"kind":"reply","room":"rfixroom00000001","text":"Jsem na cestě 🚲\nza 5 minut"},"t":"request","v":1}"#,
        #"{"request":{"at":1760000123457,"epoch":"fixepoch00000001","id":"fixread00000001","ids":["m1","msg-9f3a"],"kind":"read","room":"rfixroom00000001","text":""},"t":"request","v":1}"#,
        #"{"request":{"at":1760000123458,"epoch":"fixepoch00000001","id":"fixopen00000001","ids":[],"kind":"open","room":"rfixroom00000001","text":""},"t":"request","v":1}"#,
        #"{"request":{"at":1760000123459,"epoch":"","id":"fixsync00000001","ids":[],"kind":"sync","room":"","text":""},"t":"request","v":1}"#,
    ]

    func testTheWatchsRequestsDecodeHere() throws {
        let r = try Self.watchEncoded.map { try XCTUnwrap(WatchEnvelope.decode(Data($0.utf8)).request) }
        XCTAssertEqual(r.map(\.kind), [.reply, .read, .open, .sync])
        XCTAssertEqual(r[0].text, "Jsem na cestě 🚲\nza 5 minut")
        XCTAssertEqual(r[0].epoch, "fixepoch00000001")
        XCTAssertEqual(r[0].room, "rfixroom00000001")
        XCTAssertEqual(r[0].at, 1_760_000_123_456)
        XCTAssertEqual(r[1].ids, ["m1", "msg-9f3a"])
        XCTAssertEqual(r[3].room, "")
        // And this side writes the very same bytes for the same request (one wire, both ways).
        let again = WatchRequest(id: "fixreply0000001", kind: .reply, at: 1_760_000_123_456, epoch: "fixepoch00000001", room: "rfixroom00000001",
                                 text: "Jsem na cestě 🚲\nza 5 minut")
        XCTAssertEqual(String(decoding: try WatchEnvelope.request(again).encoded(), as: UTF8.self), Self.watchEncoded[0])
    }

    // MARK: round trips

    private func sampleSnapshot() -> WatchSnapshot {
        WatchSnapshot(epoch: "abcdefgh12345678", seq: 3, at: 1_760_000_000_000, exp: 1_760_000_600_000, state: .ok, reason: "", lang: "cs",
                      strings: ["notify.reply": "Odpovědět", "app": "M5cet"], quick: ["OK", "Ano"], unread: 2,
                      rooms: [WatchRoom(id: "rroom1", name: "Tým", unread: 2, status: "joined", at: 1_760_000_000_000, preview: "Alice: Ahoj",
                                        reply: true, messages: [
                                            WatchMessage(id: "m1", kind: WatchKind.text, sender: "Alice", mine: false, at: 1_760_000_000_000, text: "Ahoj\njak to jde?", status: ""),
                                            WatchMessage(id: "m5", kind: WatchKind.sealed, sender: "", mine: true, at: 1_760_000_060_000, text: "", status: "delivered"),
                                        ]),
                              WatchRoom(id: "rroom2", name: "Rodina", unread: 0, status: "saved", at: 0, preview: "", reply: false, messages: nil)])
    }

    func testEnvelopesRoundTrip() throws {
        let s = sampleSnapshot()
        XCTAssertEqual(try WatchEnvelope.decode(WatchEnvelope.snapshot(s).encoded()).snapshot, s)
        let r = WatchRequest(kind: .reply, at: 5, epoch: "abcdefgh12345678", room: "rroom1", text: "Na cestě")
        XCTAssertEqual(try WatchEnvelope.decode(WatchEnvelope.request(r).encoded()).request, r)
        let res = WatchResult.ok(r.id, sent: "msg-1f")
        XCTAssertEqual(try WatchEnvelope.decode(WatchEnvelope.result(res).encoded()).result, res)
        let refused = WatchResult.refused(r.id, WatchResult.Reason.locked)
        XCTAssertEqual(try WatchEnvelope.decode(WatchEnvelope.result(refused).encoded()).result, refused)
        // The WatchConnectivity dictionary form.
        let dict = try WatchEnvelope.snapshot(s).dictionary()
        XCTAssertEqual(Array(dict.keys), ["m5w"])
        XCTAssertTrue(dict["m5w"] is Data, "a property-list type")
        XCTAssertEqual(try WatchEnvelope.decode(dictionary: dict).snapshot, s)
        XCTAssertThrowsError(try WatchEnvelope.decode(dictionary: ["other": Data()]))
    }

    func testTheSameEnvelopeIsTheSameBytes() throws {
        let s = sampleSnapshot()
        XCTAssertEqual(try WatchEnvelope.snapshot(s).encoded(), try WatchEnvelope.snapshot(s).encoded())
    }

    // MARK: refusals

    func testSizeVersionAndShapeAreChecked() throws {
        XCTAssertThrowsError(try WatchEnvelope.decode(Data(count: WatchWire.maxEnvelopeBytes + 1))) { XCTAssertEqual($0 as? WatchWireError, .tooLarge) }
        let small = try WatchEnvelope.request(WatchRequest(kind: .sync, at: 1)).encoded()
        XCTAssertThrowsError(try WatchEnvelope.decode(small, maxBytes: small.count - 1)) { XCTAssertEqual($0 as? WatchWireError, .tooLarge) }
        XCTAssertThrowsError(try WatchEnvelope.decode(Data("not json".utf8))) { XCTAssertEqual($0 as? WatchWireError, .malformed) }
        // Another version: refused by name, also when its body does not parse as this one's.
        var other = WatchEnvelope.request(WatchRequest(kind: .sync, at: 1))
        other.v = 2
        XCTAssertThrowsError(try WatchEnvelope.decode(other.encoded())) { XCTAssertEqual($0 as? WatchWireError, .version(2)) }
        XCTAssertThrowsError(try WatchEnvelope.decode(Data(#"{"v":3,"t":"future","x":{}}"#.utf8))) { XCTAssertEqual($0 as? WatchWireError, .version(3)) }
        // A type with another type's body, two bodies, an unknown type.
        var mixed = WatchEnvelope.request(WatchRequest(kind: .sync, at: 1))
        mixed.t = "snapshot"
        XCTAssertThrowsError(try WatchEnvelope.decode(mixed.encoded()))
        var two = WatchEnvelope.snapshot(sampleSnapshot())
        two.result = .ok("abc")
        XCTAssertThrowsError(try WatchEnvelope.decode(two.encoded()))
        var unknown = WatchEnvelope.result(.ok("abc"))
        unknown.t = "command"
        XCTAssertThrowsError(try WatchEnvelope.decode(unknown.encoded()))
    }

    func testSnapshotLimits() throws {
        func refused(_ change: (inout WatchSnapshot) -> Void, _ what: String, line: UInt = #line) {
            var s = sampleSnapshot()
            change(&s)
            XCTAssertThrowsError(try WatchEnvelope.decode(WatchEnvelope.snapshot(s).encoded()), what, line: line)
        }
        refused({ $0.state = .locked }, "content with a locked state")
        refused({ $0.state = .off; $0.rooms = []; $0.unread = 1 }, "a count with an off state")
        refused({ $0.exp = $0.at }, "content without a lifetime")
        refused({ $0.epoch = "" }, "no generation")
        refused({ $0.epoch = "has space" }, "an id with a space")
        refused({ $0.rooms[0].name = "Tým\u{202E}evil" }, "a bidi override in a name")
        refused({ $0.rooms[0].name = "Line\nbreak" }, "a newline in a name")
        refused({ $0.rooms[0].name = String(repeating: "x", count: WatchWire.maxName + 1) }, "a long name")
        refused({ $0.rooms[1].id = $0.rooms[0].id }, "two rooms with one id")
        refused({ $0.rooms[0].unread = -1 }, "a negative count")
        refused({ $0.rooms[0].messages![0].text = String(repeating: "x", count: WatchWire.maxText + 1) }, "a long text")
        refused({ $0.rooms[0].messages![1].text = "the seal's text" }, "text on a sealed message")
        refused({ $0.rooms[0].messages = Array(repeating: $0.rooms[0].messages![0], count: WatchWire.maxMessages + 1) }, "too many messages")
        refused({ s in s.rooms = (0...WatchWire.maxRooms).map { i in WatchRoom(id: "r\(i)", name: "R", unread: 0, status: "saved", at: 0, preview: "", reply: false, messages: nil) } },
                "too many rooms")
        refused({ s in s.rooms = (0...WatchWire.maxRoomsWithMessages).map { i in WatchRoom(id: "r\(i)", name: "R", unread: 0, status: "joined", at: 0, preview: "", reply: true, messages: []) } },
                "too many rooms with messages")
        refused({ $0.strings["Bad Key"] = "x" }, "a string key outside [A-Za-z0-9.]")
        refused({ $0.quick = Array(repeating: "OK", count: WatchWire.maxQuick + 1) }, "too many quick replies")
        refused({ $0.quick = [""] }, "an empty quick reply")
        refused({ $0.rooms[0].status = "Joined!" }, "a state that is not a code")
        // An unknown kind (a newer phone) passes: the watch draws it as neutral.
        var newer = sampleSnapshot()
        newer.rooms[0].messages![0].kind = "poll"
        XCTAssertNoThrow(try WatchEnvelope.decode(WatchEnvelope.snapshot(newer).encoded()))
        // A state without content is fine.
        let locked = WatchSnapshot(epoch: "abcdefgh12345678", seq: 1, at: 5, exp: 0, state: .locked, reason: "lock", lang: "en", strings: [:], quick: [],
                                   unread: 0, rooms: [])
        XCTAssertNoThrow(try WatchEnvelope.decode(WatchEnvelope.snapshot(locked).encoded()))
    }

    func testRequestLimits() throws {
        func refused(_ r: WatchRequest, _ what: String, line: UInt = #line) {
            XCTAssertThrowsError(try WatchEnvelope.decode(WatchEnvelope.request(r).encoded()), what, line: line)
        }
        refused(WatchRequest(kind: .reply, at: 1, epoch: "e1", room: "r1", text: ""), "an empty reply")
        refused(WatchRequest(kind: .reply, at: 1, epoch: "e1", room: "r1", text: String(repeating: "x", count: WatchWire.maxReply + 1)), "a long reply")
        refused(WatchRequest(kind: .reply, at: 1, epoch: "", room: "r1", text: "hi"), "a reply without a generation")
        refused(WatchRequest(kind: .reply, at: 1, epoch: "e1", room: "", text: "hi"), "a reply without a room")
        refused(WatchRequest(kind: .read, at: 1, epoch: "e1", room: "r1"), "read without ids")
        refused(WatchRequest(kind: .read, at: 1, epoch: "e1", room: "r1", ids: ["a b"]), "an id with a space")
        refused(WatchRequest(kind: .read, at: 1, epoch: "e1", room: "r1", ids: Array(repeating: "m1", count: WatchWire.maxReadIds + 1)), "too many ids")
        refused(WatchRequest(kind: .sync, at: 1, room: "r1"), "sync with a room")
        refused(WatchRequest(kind: .open, at: 1, epoch: "e1", room: "r1", text: "x"), "open with text")
        refused(WatchRequest(id: "", kind: .sync, at: 1), "no id")
        refused(WatchRequest(kind: .sync, at: -1), "a negative time")
        XCTAssertNoThrow(try WatchEnvelope.decode(WatchEnvelope.request(WatchRequest(kind: .reply, at: 1, epoch: "e1", room: "r1", text: "Ahoj")).encoded()))
        // Results: a refusal names a known reason, a success none.
        XCTAssertThrowsError(try WatchEnvelope.decode(WatchEnvelope.result(WatchResult(id: "x1", ok: false, reason: "because", sent: "")).encoded()))
        XCTAssertThrowsError(try WatchEnvelope.decode(WatchEnvelope.result(WatchResult(id: "x1", ok: true, reason: "locked", sent: "")).encoded()))
    }

    // MARK: texts

    func testCleanIsTheNotificationsRule() {
        XCTAssertEqual(WatchWire.clean("  Ahoj\t\tsvěte \n ", max: 50), "Ahoj světe")
        XCTAssertEqual(WatchWire.clean("a\u{202E}b\u{200F}c\u{2066}d\u{FEFF}e\u{200B}f", max: 50), "abcdef", "bidi and invisible characters go")
        XCTAssertEqual(WatchWire.clean("👨‍👩‍👧", max: 50), "👨‍👩‍👧", "the emoji joiner stays")
        XCTAssertEqual(WatchWire.clean("x\u{0}y\u{7}z\u{85}w", max: 50), "x y z w", "control characters are spaces")
        XCTAssertEqual(WatchWire.clean("abcdefghij", max: 5), "abcd…")
        XCTAssertEqual(WatchWire.clean("abc def", max: 5), "abc…", "no space before the ellipsis")
        XCTAssertEqual(WatchWire.clean("one\n\n\n\ntwo  \n three\n", max: 50, lines: true), "one\n\ntwo\nthree")
        XCTAssertEqual(WatchWire.clean("one\ntwo", max: 50), "one two", "one line")
        for s in ["Ahoj, jak to jde?", "abc def ghi jkl", "one\n\ntwo", "x\u{202E}y"] {
            let once = WatchWire.clean(s, max: 8, lines: true)
            XCTAssertEqual(WatchWire.clean(once, max: 8, lines: true), once, "clean is idempotent")
            XCTAssertTrue(WatchWire.isClean(once, max: 8, lines: true))
        }
    }

    func testIdsAndEnglishTexts() {
        XCTAssertTrue(WatchWire.isId("msg-9f3a_x.y:z=+/"))
        XCTAssertFalse(WatchWire.isId(""))
        XCTAssertFalse(WatchWire.isId("ä"))
        XCTAssertFalse(WatchWire.isId(String(repeating: "a", count: WatchWire.maxId + 1)))
        let a = WatchWire.newId(), b = WatchWire.newId()
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a.count, 16)
        XCTAssertTrue(WatchWire.isId(a))
        // Every English text fits the wire, every quick reply has one.
        XCTAssertLessThanOrEqual(WatchWire.english.count, WatchWire.maxStrings)
        for (k, v) in WatchWire.english {
            XCTAssertTrue(WatchWire.isStringKey(k), k)
            XCTAssertTrue(WatchWire.isClean(v, max: WatchWire.maxStringValue), k)
        }
        for k in WatchWire.quickKeys { XCTAssertNotNil(WatchWire.english[k], k) }
    }
}
