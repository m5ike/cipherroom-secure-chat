// Opt-in: the History screen ("log") drawn by the design with THIS part's $log
// (ToolsCallLog over a call history and a room's messages) — the sample mode
// (-M5Screen log) shows the console's sample $log instead. iPhone and iPad,
// light and dark, through the same DesignShell, drawn with drawHierarchy.
//   TEST_RUNNER_M5_SHOTS_DIR=/path xcodebuild … test -only-testing:M5cetTests/ToolsScreenshotTests
// Without the variable it is skipped.

import Foundation
import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

@MainActor
final class ToolsScreenshotTests: XCTestCase {
    private func sampleLog(now: Int64) -> ToolsCallLog {
        let history = AppCallHistory(vault: ToolsMemoryVault(), now: { now })
        func call(_ id: String, _ kind: CallTrack.Kind, _ ago: Int64, room: String, video: Bool = false, people: [String], seconds: Int64 = 0) {
            var e = CallHistory.Entry()
            e.id = id; e.roomKey = room; e.room = room.capitalized; e.kind = kind.rawValue; e.at = now - ago
            e.video = video; e.people = people; e.seconds = seconds
            history.add(e)
        }
        call("c1", .missed, 25 * 60_000, room: "team", people: ["Alice"])
        call("c2", .incoming, 3 * 3_600_000, room: "family", people: ["Eva"], seconds: 312)
        call("c3", .outgoing, 26 * 3_600_000, room: "family", video: true, people: ["Bob", "Eva"], seconds: 724)
        call("c4", .declined, 50 * 3_600_000, room: "team", people: ["Bob"])
        let team = ToolsRecordingRoom("team")
        func msg(_ id: String, _ text: String, _ from: String, _ ago: Int64, _ edit: (inout ChatMessage) -> Void = { _ in }) -> ChatMessage {
            var m = ChatMessage()
            m.id = id; m.text = text; m.senderName = from; m.createdAt = now - ago
            edit(&m)
            return m
        }
        team.messages = [msg("m1", "Zavoláme se po obědě?", "Alice", 10 * 60_000),
                         msg("m2", "tajné", "Eva", 2 * 3_600_000) { $0.sealed = JSONObject([("v", 1)]) },
                         msg("m3", "Posílám plán", "Bob", 27 * 3_600_000) { $0.fileName = "plan.pdf" },
                         msg("m4", "Jen pro tebe", "Mike", 28 * 3_600_000) { $0.mine = true; $0.to = ["Alice"] }]
        let rooms = ToolsFakeRooms(team)
        rooms.savedKeys = ["team", "family"]
        let core = CoreModels(rooms: rooms, account: ToolsFakeAccount())
        let log = ToolsCallLog()
        log.history = { history }
        log.core = { core }
        log.now = { now }
        return log
    }

    func testTheHistoryScreen() throws {
        guard let dir = ProcessInfo.processInfo.environment["M5_SHOTS_DIR"], !dir.isEmpty else { throw XCTSkip("M5_SHOTS_DIR not set") }
        let now = EpochMs.now
        for (device, size, regular) in [("iphone", CGSize(width: 402, height: 874), false), ("ipad", CGSize(width: 1032, height: 1376), true)] {
            for dark in [false, true] {
                let state = StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: true))
                let host = RendererTestSupport.host(state: state)
                host.services.setLang("en")
                host.toneOverride = dark
                let log = sampleLog(now: now)
                log.open(host)
                state.vars["log"] = ["log": log.scope(host: host)]
                host.showScreen("log", transition: false)
                let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: size, regular: regular, dark: dark)
                defer { window.isHidden = true }
                RunLoop.main.run(until: Date().addingTimeInterval(0.6))
                let image = RendererTestSupport.draw(vc.view)
                try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(device)-log-\(dark ? "dark" : "light").png"))
            }
        }
    }
}
