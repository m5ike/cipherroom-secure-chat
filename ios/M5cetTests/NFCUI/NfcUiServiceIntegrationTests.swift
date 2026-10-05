// The NFC UI on the real NfcService (Platform/NFC) over the simulated Core NFC of
// M5cetTests/NFC — the seam the screens use, end to end: a scan, a write of the
// card the builder made, the lock only after the yes, the panel's read of a
// connection tag, and an iPad (no reader: nothing opens a sheet).

import M5Core
import M5NFC
import XCTest
@testable import M5cet

@MainActor
final class NfcUiServiceIntegrationTests: XCTestCase {
    private func tag(_ records: [NdefRecord]) -> FakeTag {
        let t = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        t.ndef = NdefStatus(state: .readWrite, capacity: 500)
        t.records = records
        t.mifare = { f in f == [0x60] ? Hex.decodeLenient("0004040201001103") : [0x0a] }
        return t
    }

    func testTheWorkbenchScansAndLocksThroughNfcService() async {
        let rig = NfcRig()
        let card = tag([try! Ndef.textRecord("hi")])
        rig.present(card)
        let s = makeNfcService(rig)
        let m = NfcWorkbenchModel(service: { s }, words: NfcUiTest.words)
        m.scan()
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(m.content, .card)
        XCTAssertEqual(m.tech, NfcCatalog.ntag21x)
        XCTAssertTrue(m.opButtons().first { $0.id == "ndef-lock" }!.enabled)

        m.tap("ndef-lock")
        XCTAssertEqual(rig.drivers.count, 1, "the lock's question opens no sheet")
        m.confirmLock()
        await NfcUiTest.until { !m.working }
        XCTAssertTrue(card.locked)
        XCTAssertEqual(m.content, .op(["done": .string(NfcUiTest.w("nfc.done.locked"))]))
    }

    func testTheBuildersCardIsWrittenThroughNfcService() async throws {
        let rig = NfcRig()
        let blank = tag([])
        rig.present(blank)
        let s = makeNfcService(rig)
        let b = NfcCardBuilderModel(service: { s }, words: NfcUiTest.words)
        b.accountRoot = { [UInt8](repeating: 9, count: 32) }
        b.add("message")
        b.save(values: ["text": "hello"], oneTime: false, isInternal: true)
        b.write()
        await NfcUiTest.until(.seconds(30)) { !b.writing }
        let written = try XCTUnwrap(blank.written.last)
        let container = try XCTUnwrap(NfcTagRead.m5Container(written))
        let rec = try M5Card.open(try M5Card.decodeContainer(container)[0], M5Card.keys(pin: nil, root: [UInt8](repeating: 9, count: 32)))
        XCTAssertEqual(rec.data, ["text": "hello"])
    }

    func testThePanelReadsAConnectionTagThroughNfcService() async throws {
        let rig = NfcRig()
        let body = try ConnectionCard.sealV1(["v": 1, "room": "team", "passphrase": "pp", "name": "Mike"], pin: "4321")
        rig.present(tag([ConnectionCard.record(body)]))
        let s = makeNfcService(rig)
        let p = NfcPanelModel(service: { s }, words: NfcUiTest.words)
        p.pin = "4321"
        p.action("read")
        await NfcUiTest.until(.seconds(20)) { p.mode == "idle" }
        let conn = try XCTUnwrap(p.lastConn)
        XCTAssertEqual(conn.format, "v1")
        XCTAssertTrue(conn.weak, "format 1 is weak — the card offers the rewrite")
        XCTAssertEqual(conn.room?.room, "team")
        XCTAssertEqual(conn.room?.name, "Mike")
    }

    func testAnIPadOpensNoSheet() async {
        let rig = NfcRig()
        let s = makeNfcService(rig, readingAvailable: false)
        XCTAssertEqual(s.unavailableReason, NfcService.noReader)
        let m = NfcWorkbenchModel(service: { s }, words: NfcUiTest.words)
        m.scan()
        m.run("ndef-read", .none)
        m.startTemplate(NfcUiTest.template(["label": "T", "card": "iso7816", "steps": [["apdu": "00B0000000"]]]), nil)
        let b = NfcCardBuilderModel(service: { s }, words: NfcUiTest.words)
        XCTAssertEqual(b.writeReason, NfcService.noReader)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(rig.drivers.isEmpty)
    }
}
