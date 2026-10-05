// What CallKit shows and Recents keeps: neutral by default, never more while
// locked (Android's CallLogBridgeTest for the entry name), the ring's name by
// the privacy level, an opaque handle that maps back only for saved rooms.

import XCTest
@testable import M5cet

final class CallNamingTests: XCTestCase {
    func testOnlyTheAppByDefaultAndWhileLocked() {
        XCTAssertEqual(CallNaming.entryName(level: "app", locked: false, appName: "M5cet", room: "Team", people: ["Alice"]), "M5cet")
        XCTAssertEqual(CallNaming.entryName(level: "everything", locked: false, appName: "M5cet", room: "Team", people: ["Alice"]), "M5cet",
                       "an unknown level is the neutral one")
        XCTAssertEqual(CallNaming.entryName(level: "room", locked: true, appName: "M5cet", room: "Team", people: ["Alice"]), "M5cet")
        XCTAssertEqual(CallNaming.entryName(level: "people", locked: true, appName: "M5cet", room: "Team", people: ["Alice"]), "M5cet")
        XCTAssertEqual(CallNaming.entryName(level: "app", locked: false, appName: "  ", room: "Team", people: nil), "M5cet",
                       "no app name: still not the room")
    }

    func testTheRoomAndThePeopleWhenChosen() {
        XCTAssertEqual(CallNaming.entryName(level: "room", locked: false, appName: "Chat", room: "Team", people: ["Alice"]), "Chat · Team")
        XCTAssertEqual(CallNaming.entryName(level: "people", locked: false, appName: "M5cet", room: "Team", people: ["Alice", "Bob"]), "Alice, Bob · Team")
        XCTAssertEqual(CallNaming.entryName(level: "people", locked: false, appName: "M5cet", room: "Team", people: ["A", "B", "", "C", "D", "E"]),
                       "A, B, C +2 · Team")
        XCTAssertEqual(CallNaming.entryName(level: "people", locked: false, appName: "M5cet", room: "Team", people: []), "M5cet · Team", "nobody: the room")
        XCTAssertEqual(CallNaming.entryName(level: "room", locked: false, appName: "M5cet", room: "", people: ["Alice"]), "M5cet", "no room: the app")
    }

    func testNamesAreOneCleanBoundedLine() {
        let name = CallNaming.entryName(level: "people", locked: false, appName: "M5cet", room: "Te\nam\u{202E}", people: ["Al\tice\u{0}"])
        XCTAssertEqual(name, "Al ice · Te am")
        let huge = String(repeating: "x", count: 300)
        let cut = CallNaming.entryName(level: "people", locked: false, appName: "M5cet", room: huge, people: [huge, huge, huge])
        XCTAssertLessThanOrEqual(cut.count, 120)
        XCTAssertFalse(cut.contains("\n"))
    }

    func testTheRingNameFollowsThePrivacyLevel() {
        XCTAssertEqual(CallNaming.ringName(level: 0, locked: false, appName: "M5cet", room: "Team", who: "Alice"), "M5cet")
        XCTAssertEqual(CallNaming.ringName(level: 1, locked: false, appName: "M5cet", room: "Team", who: "Alice"), "Alice")
        XCTAssertEqual(CallNaming.ringName(level: 2, locked: false, appName: "M5cet", room: "Team", who: "Alice"), "Alice · Team")
        XCTAssertEqual(CallNaming.ringName(level: 2, locked: true, appName: "M5cet", room: "Team", who: "Alice"), "M5cet", "locked: the app only")
        XCTAssertEqual(CallNaming.ringName(level: 2, locked: false, appName: "M5cet", room: "Team", who: ""), "Team")
        XCTAssertEqual(CallNaming.ringName(level: 1, locked: false, appName: "M5cet", room: "Team", who: " "), "M5cet")
        // Recents on: the call log's naming wins (it stays in the Phone app).
        XCTAssertEqual(CallNaming.displayName(recents: true, logName: "app", privacyLevel: 2, locked: false, appName: "M5cet", room: "Team",
                                              who: "Alice", people: []), "M5cet")
        XCTAssertEqual(CallNaming.displayName(recents: true, logName: "people", privacyLevel: 2, locked: false, appName: "M5cet", room: "Team",
                                              who: "Alice", people: []), "Alice · Team")
        XCTAssertEqual(CallNaming.displayName(recents: false, logName: "people", privacyLevel: 1, locked: false, appName: "M5cet", room: "Team",
                                              who: "Alice", people: []), "Alice")
    }

    func testTheHandleIsOpaqueStableAndMapsBackOnlyToASavedRoom() {
        let salt = Data((0..<32).map { UInt8($0) })
        let h = CallNaming.handle(roomKey: "team-secret", salt: salt)
        XCTAssertTrue(h.hasPrefix("m5cet-"))
        XCTAssertEqual(h.count, "m5cet-".count + 16)
        XCTAssertFalse(h.contains("team"))
        XCTAssertEqual(h, CallNaming.handle(roomKey: "team-secret", salt: salt), "stable for the room")
        XCTAssertNotEqual(h, CallNaming.handle(roomKey: "team-secret", salt: Data(repeating: 9, count: 32)), "another install, another handle")
        XCTAssertEqual(CallNaming.room(forHandle: h, among: ["other", "team-secret"], salt: salt), "team-secret")
        XCTAssertNil(CallNaming.room(forHandle: h, among: ["other"], salt: salt), "a room no longer saved")
        XCTAssertNil(CallNaming.room(forHandle: "+420123456789", among: ["team-secret"], salt: salt), "not ours")
    }
}
