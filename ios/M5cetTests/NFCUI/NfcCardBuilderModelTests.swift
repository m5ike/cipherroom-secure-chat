// The M5Cet card builder (Android NfcCardBuilder): records, the size against real
// tags (Android's estimate), the checks before writing, and the card written —
// the container opens again with its PIN (M5NFC M5Card, the web's bytes).

import M5Core
import M5Design
import M5NFC
import XCTest
@testable import M5cet

@MainActor
final class NfcCardBuilderModelTests: XCTestCase {
    private func builder(_ fake: FakeNfcUi, _ rec: NfcUiRecorder = NfcUiRecorder()) -> NfcCardBuilderModel {
        let m = NfcCardBuilderModel(service: { fake }, words: NfcUiTest.words)
        m.flashed = { t, l in rec.flashes.append((t, l)) }
        m.accountRoot = { nil }
        return m
    }

    func testRecordsAreAddedEditedMovedAndRemoved() throws {
        let m = builder(FakeNfcUi())
        XCTAssertEqual(m.types.map(\.type), M5Records.buildable)
        m.add("one-time-message")
        XCTAssertEqual(m.editing?.oneTime, true, "the type's default")
        XCTAssertEqual(m.editing?.isInternal, false)
        m.save(values: ["text": "hi", "url": ""], oneTime: true, isInternal: false)
        XCTAssertEqual(m.drafts.count, 1)
        XCTAssertEqual(m.drafts[0].data, ["text": "hi"], "empty fields are left out")
        m.add("passkey-backup")
        XCTAssertEqual(m.editing?.isInternal, true, "an account-only type")
        m.save(values: ["user": "mike"], oneTime: false, isInternal: true)
        XCTAssertEqual(m.title(m.drafts[1]), NfcUiTest.w("nfc.rec.passkey") + "  🔑")
        XCTAssertEqual(m.title(m.drafts[0]), NfcUiTest.w("nfc.rec.onetime") + "  🔥")
        XCTAssertEqual(m.summary(m.drafts[1]), "mike")

        let first = m.drafts[0].id
        m.move(first, by: 1)
        XCTAssertEqual(m.drafts[1].id, first)
        m.move(first, by: 1)
        XCTAssertEqual(m.drafts[1].id, first, "the last stays last")
        m.edit(first)
        m.save(values: ["text": "changed"], oneTime: false, isInternal: false)
        XCTAssertEqual(m.drafts[1].data, ["text": "changed"])
        XCTAssertEqual(m.drafts.count, 2)
        m.remove(first)
        XCTAssertEqual(m.drafts.count, 1)
    }

    /// Android updateSize: 7 + Σ(37 + json + 16), the external record 16 B (19 B from 256).
    func testTheSizeEstimateIsAndroids() {
        let m = builder(FakeNfcUi())
        XCTAssertEqual(m.ndefSize, 7 + 16)
        m.add("message")
        m.save(values: ["text": "hello"], oneTime: false, isInternal: false)
        let json = #"{"text":"hello"}"#.utf8.count
        XCTAssertEqual(m.ndefSize, 7 + 37 + json + 16 + 16)
        XCTAssertEqual(m.fit, "NTAG213")
        XCTAssertEqual(m.sizeText, NfcUiTest.w("nfc.builder.size") + ": \(m.ndefSize) B · NTAG213")
        m.add("message")
        m.save(values: ["text": String(repeating: "x", count: 540)], oneTime: false, isInternal: false)
        // 716 B would be a MIFARE Classic 1K on Android — an iPhone writes no Classic: NTAG216.
        XCTAssertGreaterThan(m.ndefSize, 504)
        XCTAssertLessThanOrEqual(m.ndefSize, 716)
        XCTAssertEqual(m.fit, "NTAG216")
        m.add("message")
        m.save(values: ["text": String(repeating: "y", count: 3000)], oneTime: false, isInternal: false)
        XCTAssertEqual(m.fit, NfcUiTest.w("nfc.builder.big"))
    }

    func testTheChecksBeforeWriting() {
        let rec = NfcUiRecorder()
        let fake = FakeNfcUi()
        let m = builder(fake, rec)
        XCTAssertEqual(m.check(), .empty)
        m.write()
        XCTAssertEqual(rec.lastFlash, NfcUiTest.w("nfc.builder.empty"))
        m.add("message"); m.save(values: ["text": "a"], oneTime: false, isInternal: false)
        m.pin = "1234"
        XCTAssertEqual(m.check(), .badPin, "a card PIN is 6–18 digits")
        m.write()
        XCTAssertEqual(rec.lastFlash, NfcUiTest.w("nfc.builder.pin"))
        m.pin = "123456"
        XCTAssertEqual(m.check(), .ok)
        m.add("identity-backup"); m.save(values: ["user": "u"], oneTime: false, isInternal: true)
        XCTAssertEqual(m.check(), .needAccount, "an internal record needs the account's key")
        m.accountRoot = { [UInt8](repeating: 1, count: 32) }
        XCTAssertEqual(m.check(), .ok)
        XCTAssertTrue(fake.calls.isEmpty)

        // iPad: everything checks out but there is no reader — said, not a dead button.
        let pad = builder(FakeNfcUi(iPhone: false), rec)
        pad.add("message"); pad.save(values: ["text": "a"], oneTime: false, isInternal: false)
        pad.pin = "123456"
        XCTAssertEqual(pad.check(), .noReader)
        XCTAssertEqual(pad.writeReason, NfcService.noReader)
        pad.write()
        XCTAssertEqual(rec.lastFlash, NfcService.noReader)
    }

    func testTheCardIsWrittenAndOpensWithItsPin() async throws {
        let rec = NfcUiRecorder()
        let fake = FakeNfcUi()
        let m = builder(fake, rec)
        m.add("wifi")
        m.save(values: ["ssid": "Guest", "password": "pw"], oneTime: false, isInternal: false)
        m.pin = " 48151623 "
        m.write()
        XCTAssertTrue(m.writing)
        await NfcUiTest.until(.seconds(30)) { !m.writing }
        XCTAssertEqual(fake.written.count, 1)
        let sealed = try M5Card.decodeContainer(fake.written[0])
        XCTAssertEqual(sealed.map(\.type), ["wifi"])
        let opened = try M5Card.open(sealed[0], M5Card.keys(pin: "48151623", root: nil))
        XCTAssertEqual(opened.data, ["ssid": "Guest", "password": "pw"])
        XCTAssertEqual(rec.flashes.last?.1, .success)
        XCTAssertEqual(rec.lastFlash, NfcUiTest.w("nfc.done.writtenBytes").replacingOccurrences(of: "{0}", with: String(fake.written[0].count + 16)))

        // A read-only tag: the design's words.
        fake.readError = NfcWriteFailure(.readOnly, needed: 10, available: 0)
        m.write()
        await NfcUiTest.until(.seconds(30)) { !m.writing }
        XCTAssertEqual(rec.lastFlash, NfcUiTest.w("nfc.err.readOnly"))
    }
}
