// A Functions model's `nfc` call on the iPhone (Android NfcModelSheet.start):
// refused before any card (writes, emulation, unknown ops; EMV with the payment
// AID limit; iPad without NFC), `enum`, the e-ID key asked on the device, then
// the read in the system sheet — timeout, the sheet closed, a card that left,
// an e-ID over BAC whose answer only leaves masked with the holder's yes.

import XCTest
import M5NFC
@testable import M5cet

@MainActor
final class NfcModelTests: XCTestCase {
    let english = NfcSheetTexts(FixedNfcTexts())

    func spec(_ command: NfcJSONObject) -> NfcJSONObject { ["command": .object(command)] }

    func answer(_ p: ModelNfcPlan) -> NfcJSONObject? { if case .answer(let r) = p { return r }; return nil }

    func testThePlanBeforeAnyCard() throws {
        let s = makeNfcService(NfcRig())
        XCTAssertEqual(answer(s.modelPlan(spec(["op": "ndef-write"])))?.optString("status"), "denied")
        XCTAssertEqual(answer(s.modelPlan(spec(["op": "conn-emulate"])))?.optString("status"), "denied")
        XCTAssertEqual(answer(s.modelPlan(spec(["op": "launch-rockets"])))?.optString("status"), "unsupported")
        let emv = try XCTUnwrap(answer(s.modelPlan(spec(["op": "emv-read"]))))
        XCTAssertEqual(emv.optString("status"), "unsupported")
        XCTAssertEqual(emv.optString("message"), "Core NFC does not allow payment applications (EMV AIDs) — use an external reader.")
        XCTAssertEqual(answer(s.modelPlan(spec(["op": "scan", "reader": "bluetooth"])))?.optString("status"), "unsupported")
        XCTAssertEqual(answer(s.modelPlan(spec(["op": "scan", "reader": "usb"])))?.optString("message"), "No USB reader is connected.")
        guard case .askDocumentKey(let c) = s.modelPlan(spec(["op": "eid-read"])) else { return XCTFail() }
        XCTAssertEqual(c.op, "eid-read")
        guard case .read(let withCan) = s.modelPlan(spec(["op": "eid-read", "args": ["can": "123456"]])) else { return XCTFail() }
        XCTAssertEqual(withCan.args.optString("can"), "123456")
        guard case .read = s.modelPlan(nil) else { return XCTFail("no command = a scan") }
        // enum: this iPhone's reader, its technologies — no EMV, no MIFARE Classic.
        let e = try XCTUnwrap(answer(s.modelPlan(spec(["op": "enum"]))))
        XCTAssertEqual(e.optString("status"), "ok")
        let data = try NfcJSON.parse(String(decoding: Data(base64Encoded: e.optString("data"))!, as: UTF8.self)).objectValue!
        XCTAssertEqual(data.optString("default"), "internal")
        XCTAssertFalse(data.strings("technologies").contains(NfcCatalog.emv))
        XCTAssertFalse(data.strings("technologies").contains(NfcCatalog.mifareClassic1k))
        XCTAssertTrue(data.strings("technologies").contains(NfcCatalog.eid))
    }

    func testAnIpadAnswersAtOnce() {
        let s = makeNfcService(NfcRig(), readingAvailable: false)
        XCTAssertEqual(answer(s.modelPlan(spec(["op": "scan"])))?.optString("message"), "This device has no NFC reader.")
        let d = s.modelDevice()
        XCTAssertFalse(d.hasNfc)
        XCTAssertEqual(d.internalCapabilities, .none)
    }

    func testAScanOfATag() async throws {
        let rig = NfcRig()
        let tag = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        tag.ndef = NdefStatus(state: .readWrite, capacity: 137)
        tag.records = [Ndef.uriRecord("https://m5cet.cz")]
        tag.mifare = { _ in [] }
        rig.present(tag)
        let s = makeNfcService(rig)
        guard case .read(let c) = s.modelPlan(spec(["op": "ndef-read", "timeout": 5])) else { return XCTFail() }
        let r = await s.modelRead(c, texts: english)
        XCTAssertEqual(r.optString("status"), "ok")
        XCTAssertEqual(r.optObject("card")?.optString("uid"), "04A23B11223380")
        XCTAssertEqual(r.optArray("ndef")?.first?["data"]?.stringValue, "https://m5cet.cz")
        XCTAssertEqual(rig.last?.alertMessage, "Done")
        XCTAssertFalse(ModelNfc.consent(r).sensitive)
    }

    func testNoCardTheSheetClosedAndACardThatLeft() async throws {
        let rig = NfcRig()
        let s = makeNfcService(rig)
        guard case .read(let c) = s.modelPlan(spec(["op": "scan", "timeout": 1])) else { return XCTFail() }
        let timedOut = await s.modelRead(c, texts: english)
        XCTAssertEqual(timedOut, ModelNfc.timedOut(1))
        XCTAssertEqual(rig.last?.invalidations, ["No card within 1 s."])

        rig.onBegin = { d in DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { d.systemInvalidate(200) } }
        let closed = await s.modelRead(c, texts: english)
        XCTAssertEqual(closed, ModelNfc.cancelled())

        let gone = FakeTag(.iso7816(initialSelectedAid: "A0000002471001", historicalBytes: nil, applicationData: nil, supportsPace: false))
        gone.failure = NSError(domain: "NFCError", code: 100)
        rig.present(gone)
        guard case .read(let pub) = s.modelPlan(spec(["op": "eid-public", "timeout": 5])) else { return XCTFail() }
        let lost = await s.modelRead(pub, texts: english)
        XCTAssertEqual(lost.optString("status"), "no-card")
        await rig.wait { rig.last?.invalidations.count == 1 }
        XCTAssertEqual(rig.last?.invalidations, [english.lost])
        XCTAssertEqual(NfcService.sessionLimit, 60)
    }

    func testAnEidReadForAModelOnlyLeavesMasked() async throws {
        let rig = NfcRig()
        let tag = FakeTag(.iso7816(initialSelectedAid: "A0000002471001", historicalBytes: nil, applicationData: nil, supportsPace: false))
        tag.chip = BacChip(NfcDoc.key, NfcDoc.files())
        rig.present(tag)
        let s = makeNfcService(rig)
        guard case .askDocumentKey(let c) = s.modelPlan(spec(["op": "eid-read", "args": ["readPhoto": false]])) else { return XCTFail() }
        let key = ModelNfc.DocumentKey(mrz: NfcDoc.mrz)
        XCTAssertNil(ModelNfc.checkDocumentKey(key))
        let r = await s.modelRead(ModelNfc.withDocumentKey(c, key), texts: english)
        XCTAssertEqual(r.optString("status"), "ok")
        XCTAssertEqual(r.optObject("card")?.optString("tech"), NfcCatalog.eid)
        XCTAssertEqual(rig.last?.request.aids, ["A0000002471001"])
        let consent = ModelNfc.consent(r)
        XCTAssertTrue(consent.sensitive)
        let masked = try XCTUnwrap(ModelNfc.masked(r))
        XCTAssertEqual(masked.optObject("mrtd")?.optObject("mrzInfo")?.optString("documentNumber"), "•••••02C")
        XCTAssertNil(masked.optObject("mrtd")?.optObject("mrzInfo")?["mrz"])
        XCTAssertEqual(ModelNfc.declined(r).optString("status"), "denied")
    }
}
