// The renderer's sample mode never touches a network: the tools' engine talks to
// ToolsPreviewTransport (DEBUG), whose answers end like the server's — a done after the pieces.

#if DEBUG
import Foundation
import M5Core
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class ToolsPreviewTransportTests: XCTestCase {
    func testTheAssistantsSampleAnswerEnds() {
        let a = AiAssistant(api: FnApi(base: "https://chat.example.com", transport: ToolsPreviewTransport()))
        Task { _ = await a.loadStatus(bearer: "") }
        waitUntil { a.status != nil }
        XCTAssertTrue(a.send(bearer: "", question: "x"))
        waitUntil(10) { !a.busy }
        XCTAssertEqual(a.lastAnswer?.text.hasPrefix("/report zkontroluje"), true)
    }

    func testTheSampleReportRuns() {
        let room = RecordingRoom()
        let core = toolsCore(room)
        let engine = ToolsFnEngine(transport: ToolsPreviewTransport())
        engine.core = { core }
        engine.timerEnabled = false
        engine.load()
        waitUntil { engine.commands().state(bearer: "Bearer tok").enabled == true }
        XCTAssertTrue(engine.run(room: room, text: "/report example.org"))
        waitUntil(10) { room.answers.count == 1 }
        XCTAssertEqual(room.answers.first?.local?.array("outputs")?.first?.objectValue?.optString("type"), "html")
    }
}
#endif
