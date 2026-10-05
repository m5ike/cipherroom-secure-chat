// A model's "nfc" question goes to the NFC part's sheet (Parts/NFC NfcModelSheetPresenter):
// a write is refused at once ("denied") and that answer goes to the run, as Android's
// Fn.ask → NfcModelSheet.start does.

import Foundation
import M5Core
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class FnNfcBridgeTests: XCTestCase {
    func testAModelsWriteIsRefusedByTheNfcPart() throws {
        let transport = ToolsFixtures.server()
        transport.route("/api/functions/run", .sse("event: interaction\ndata: {\"runId\":\"run_n\",\"id\":\"int_n\",\"kind\":\"nfc\",\"spec\":{\"command\":{\"op\":\"ndef-write\"}}}\n\n", stall: true))
        let room = ToolsRecordingRoom()
        let core = toolsCore(room)
        let engine = ToolsFnEngine(transport: transport)
        engine.core = { core }
        engine.timerEnabled = false
        engine.host = toolsHost()
        engine.nfcAsk = { i, name, host, reply in FnNfcBridge.ask(i, modelName: name, host: host, reply: reply) }
        engine.load()
        toolsWait { engine.commands().state(bearer: "Bearer tok").enabled == true }
        XCTAssertTrue(engine.run(room: room, text: "/ask"))
        toolsWait { !transport.seen("/api/functions/runs/").isEmpty }
        let v = try XCTUnwrap(transport.seen("/api/functions/runs/").first?.json?.object("value"))
        XCTAssertEqual(v.optString("status"), "denied")
        XCTAssertTrue(v.optString("message").contains("ndef-write"), v.optString("message"))
    }
}
