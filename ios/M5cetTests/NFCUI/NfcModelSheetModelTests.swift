// A Functions model asks for a card (Android NfcModelSheet): what is answered at
// once, the document key asked of the holder, and the holder's consent (6.10
// G-17) — "Send (masked)" leaves no MRZ, photo or details, "Don't send" and
// closing the sheet answer "denied", a cancelled sheet answers "Cancelled" once.

import M5Core
import M5Design
import M5NFC
import XCTest
@testable import M5cet

@MainActor
final class NfcModelSheetModelTests: XCTestCase {
    private final class Answers {
        var all: [NfcJSONObject] = []
        var last: NfcJSONObject? { all.last }
    }

    private func start(_ fake: FakeNfcUi, _ spec: NfcJSONObject, _ answers: Answers) -> NfcModelSheetModel? {
        NfcModelSheetPresenter.start(runId: "run-1", spec: spec, modelName: "Doklady", host: nil, service: fake, present: false) { answers.all.append($0) }
    }

    private func eid(_ args: NfcJSONObject = ["can": "123456"]) -> NfcJSONObject { ["command": ["op": "eid-read", "args": .object(args)]] }

    func testRefusalsEnumAndThisDevicesLimitsAreAnsweredAtOnce() {
        let a = Answers()
        XCTAssertNil(start(FakeNfcUi(), ["command": ["op": "ndef-write"]], a))
        XCTAssertEqual(a.last?.optString("status"), "denied", "writes never run for a model")
        XCTAssertNil(start(FakeNfcUi(), ["command": ["op": "m5-emulate"]], a))
        XCTAssertEqual(a.last?.optString("status"), "denied")
        XCTAssertNil(start(FakeNfcUi(), ["command": ["op": "enum"]], a))
        XCTAssertEqual(a.last?.optString("status"), "ok")
        XCTAssertNil(start(FakeNfcUi(), ["command": ["op": "emv-read"]], a))
        XCTAssertEqual(a.last?.optString("status"), "unsupported", "Core NFC: no payment AIDs")
        XCTAssertTrue(a.last!.optString("message").contains("payment"))
        XCTAssertNil(start(FakeNfcUi(iPhone: false), ["command": ["op": "scan"]], a))
        XCTAssertNotEqual(a.last?.optString("status"), "ok", "an iPad has no reader")
        XCTAssertEqual(a.all.count, 5)
    }

    func testAnEidReadWithoutTheKeyAsksTheHolder() async throws {
        let fake = FakeNfcUi()
        fake.modelResult = ["status": "ok", "card": ["uid": "08", "tech": "eid"], "mrtd": .object(NfcUiTestData.mrtd)]
        let a = Answers()
        let m = try XCTUnwrap(start(fake, eid([:]), a))
        XCTAssertEqual(m.state, .key)
        XCTAssertEqual(m.title, NfcUiTest.w("nfc.model.what.eid"))
        XCTAssertEqual(m.byLine, NfcUiTest.w("nfc.model.by").replacingOccurrences(of: "{0}", with: "Doklady"))
        m.submitKey(ModelNfc.DocumentKey(can: "12"))
        XCTAssertEqual(m.keyError, NfcUiTest.w("nfc.model.key.badCan"))
        XCTAssertTrue(fake.calls.isEmpty)
        m.submitKey(ModelNfc.DocumentKey(can: "123456"))
        XCTAssertNil(m.keyError)
        XCTAssertEqual(m.state, .wait)
        XCTAssertEqual(m.command.args.optString("can"), "123456", "the key lives in this read's command only")
        await NfcUiTest.until { m.state == .consent }
        XCTAssertEqual(fake.calls, ["modelRead:eid-read"])
        XCTAssertTrue(a.all.isEmpty, "nothing goes before the holder's choice")
    }

    func testSendMaskedIsTheDefaultAndKeepsTheDocumentsSecrets() async throws {
        let fake = FakeNfcUi()
        fake.modelResult = ["status": "ok", "card": ["uid": "08", "tech": "eid"], "mrtd": .object(NfcUiTestData.mrtd)]
        let a = Answers()
        let m = try XCTUnwrap(start(fake, eid(), a))
        m.autoCloseAfter = .seconds(60)
        await NfcUiTest.until { m.state == .consent }
        XCTAssertTrue(m.offersFull)
        XCTAssertTrue(m.consentText.hasPrefix(NfcUiTest.w("nfc.consent.text").replacingOccurrences(of: "{model}", with: "Doklady")))
        XCTAssertTrue(m.consentText.contains("SPECIMEN"))
        m.sendMasked()
        let sent = try XCTUnwrap(a.last)
        XCTAssertEqual(a.all.count, 1)
        XCTAssertEqual(sent.optString("status"), "ok")
        let mrtd = try XCTUnwrap(sent.optObject("mrtd"))
        XCTAssertFalse(mrtd.has("photo"))
        XCTAssertFalse(mrtd.has("images"))
        XCTAssertFalse(mrtd.has("personal"))
        XCTAssertNotEqual(mrtd.optObject("mrzInfo")?.optString("documentNumber"), "SPEC01234")
        XCTAssertEqual(m.state, .done)
        XCTAssertEqual(m.resultHead, "✓ " + NfcUiTest.w("nfc.model.done"))
        m.close()
        XCTAssertEqual(a.all.count, 1, "answered once")
    }

    func testSendEverythingAndDontSend() async throws {
        let fake = FakeNfcUi()
        fake.modelResult = ["status": "ok", "card": ["uid": "08", "tech": "eid"], "mrtd": .object(NfcUiTestData.mrtd)]
        let full = Answers()
        let m1 = try XCTUnwrap(start(fake, eid(), full))
        await NfcUiTest.until { m1.state == .consent }
        m1.sendFull()
        XCTAssertEqual(full.last?.optObject("mrtd"), NfcUiTestData.mrtd)

        let no = Answers()
        let m2 = try XCTUnwrap(start(fake, eid(), no))
        await NfcUiTest.until { m2.state == .consent }
        m2.dontSend()
        XCTAssertEqual(no.last?.optString("status"), "denied")
        XCTAssertNil(no.last?.optObject("mrtd"))
        XCTAssertEqual(m2.resultHead, NfcUiTest.w("nfc.consent.notSent"))

        // Closing the sheet while asked is the holder's no.
        let closed = Answers()
        let m3 = try XCTUnwrap(start(fake, eid(), closed))
        await NfcUiTest.until { m3.state == .consent }
        m3.dismissed()
        XCTAssertEqual(closed.all.map { $0.optString("status") }, ["denied"])
    }

    func testWhatHoldsNoCardDataGoesWithoutAQuestion() async throws {
        let fake = FakeNfcUi()
        fake.modelResult = ModelNfc.result("ok", ["uid": "04A1", "tech": "ntag21x"], nil)
        let a = Answers()
        let m = try XCTUnwrap(start(fake, ["command": ["op": "read-uid"]], a))
        await NfcUiTest.until { !a.all.isEmpty }
        XCTAssertEqual(a.all, [fake.modelResult])
        XCTAssertEqual(m.state, .done)
        XCTAssertEqual(m.resultDetail, "· 04A1", "Android: label · uid, trimmed")
    }

    func testClosingWhileWaitingAnswersCancelledOnceAndStopsTheRead() async throws {
        let fake = FakeNfcUi()
        fake.busy = true
        fake.modelReadDelay = .seconds(5)
        let a = Answers()
        let m = try XCTUnwrap(start(fake, ["command": ["op": "scan", "timeout": 30]], a))
        XCTAssertEqual(m.state, .wait)
        XCTAssertEqual(m.secondsLeft, 30)
        m.close()
        XCTAssertEqual(a.all, [ModelNfc.cancelled()])
        XCTAssertEqual(fake.cancels, 1, "the system sheet closes")
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(a.all.count, 1)
    }

    func testTheSystemSheetClosedIsCancelled() async throws {
        let fake = FakeNfcUi()
        fake.modelResult = ModelNfc.cancelled()
        let a = Answers()
        var dismissed = false
        let m = try XCTUnwrap(start(fake, ["command": ["op": "scan"]], a))
        m.dismiss = { dismissed = true }
        await NfcUiTest.until { !a.all.isEmpty }
        XCTAssertEqual(a.all, [ModelNfc.cancelled()])
        XCTAssertTrue(dismissed)
    }

    func testTheRunEndingWhileWaitingAnswersNothing() async throws {
        let fake = FakeNfcUi()
        fake.modelReadDelay = .seconds(5)
        let a = Answers()
        let m = try XCTUnwrap(start(fake, ["command": ["op": "scan"]], a))
        m.runEnded()
        XCTAssertTrue(m.over)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(a.all.isEmpty)
    }

    func testTheBackgroundEndsTheSessionAndTheReturnAsksAgain() async throws {
        let fake = FakeNfcUi()
        fake.modelResult = ModelNfc.cancelled()
        fake.modelReadDelay = .milliseconds(200)
        let a = Answers()
        let m = try XCTUnwrap(start(fake, ["command": ["op": "scan", "timeout": 30]], a))
        m.wentToBackground()
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertTrue(a.all.isEmpty, "Core NFC ended the session because of the background — not the holder's cancel")
        fake.modelResult = ModelNfc.result("ok", ["uid": "04", "tech": "ntag21x"], nil)
        m.resumed()
        await NfcUiTest.until { !a.all.isEmpty }
        XCTAssertEqual(fake.calls, ["modelRead:scan", "modelRead:scan"])
        XCTAssertEqual(a.last?.optString("status"), "ok")
    }

    func testResultLines() async throws {
        let w = NfcUiTest.words
        for (status, head) in [("timeout", "⚠ " + w("nfc.model.timeout").replacingOccurrences(of: "{0}", with: "20")), ("no-card", "⚠ " + w("nfc.model.lost")),
                               ("auth-failed", "⚠ " + w("nfc.model.authFailed")), ("unsupported", "⚠ " + w("nfc.model.notThisCard")),
                               ("error", "⚠ " + w("nfc.model.error"))] {
            let fake = FakeNfcUi()
            fake.modelResult = ModelNfc.result(status, nil, "why")
            let a = Answers()
            let m = try XCTUnwrap(start(fake, ["command": ["op": "scan"]], a))
            await NfcUiTest.until { m.state == .done }
            XCTAssertEqual(m.resultHead, head, status)
            XCTAssertEqual(m.resultDetail, status == "timeout" ? "" : "why")
        }
    }

    /// The Functions engine's JSON (M5Core) in and out.
    func testTheEngineOverloadSpeaksM5CoreJson() throws {
        var answer: JSONObject?
        let spec = try XCTUnwrap(JSON.parseObject(#"{"command":{"op":"ndef-write"}}"#))
        XCTAssertNil(NfcModelSheetPresenter.start(runId: "r", spec: spec, modelName: nil, host: nil) { answer = $0 })
        XCTAssertEqual(answer?.optString("status"), "denied")
    }
}
