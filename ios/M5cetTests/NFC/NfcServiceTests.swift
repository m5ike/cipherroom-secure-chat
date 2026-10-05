// NfcService with a fake radio: the readings the screens will call — a tag's
// identity and records (connection tag, M5Cet card), NDEF writes (an NDEF tag,
// a blank NTAG through its pages; read-only / too small in the design's words),
// the lock only with the explicit yes, an e-ID read on the BAC chip (the master
// file selected for EF.CardAccess, as a Core NFC session needs), templates on
// the simulated cards, the workbench ops; what the iPhone cannot do (EMV,
// MIFARE Classic, raw frames) refused with M5NFC's reason before any sheet; iPad.

import XCTest
import M5NFC
@testable import M5cet

@MainActor
final class NfcServiceTests: XCTestCase {
    let english = NfcSheetTexts(FixedNfcTexts())

    func isoTag(_ chip: SimChip, aid: String) -> FakeTag {
        let t = FakeTag(.iso7816(initialSelectedAid: aid, historicalBytes: nil, applicationData: nil, supportsPace: false))
        t.chip = chip
        return t
    }

    func ndefTag(_ records: [NdefRecord], capacity: Int = 500, state: NdefStatus.State = .readWrite) -> FakeTag {
        let t = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        t.ndef = NdefStatus(state: state, capacity: capacity)
        t.records = records
        t.mifare = { f in f == [0x60] ? hx("0004040201001103") : [0x0a] }
        return t
    }

    static let offlineBody: String = {
        let v = try! NfcRepo.json("test/vectors/nfc-tag-v2.json")
        return v["offline"]![0]!["body"]!.stringValue!
    }()

    /* ------------------------------------------------------------ availability */

    func testAnIpadHasNoReaderAndNoSheetOpens() async {
        let rig = NfcRig()
        let s = makeNfcService(rig, readingAvailable: false)
        XCTAssertEqual(s.capabilities, .none)
        XCTAssertEqual(s.limit(op: "ndef-read"), "This device has no NFC reader (iPad and Apple Watch have none).")
        XCTAssertTrue(s.technologies.isEmpty)
        do { _ = try await s.readTag(); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .unsupported) } catch { XCTFail() }
        XCTAssertTrue(rig.drivers.isEmpty)
    }

    func testTheSimulatorIsHonestAboutHavingNoNfc() {
        // Core NFC in the simulator: no reader — the app's own service says so, nothing pretends.
        XCTAssertFalse(CoreNFCSessionDriver.readingAvailable)
        XCTAssertEqual(NfcService.shared.capabilities, .none)
        XCTAssertFalse(NfcService.shared.readingAvailable)
    }

    func testTheIphonesCapabilitiesAndLimits() {
        let s = makeNfcService(NfcRig())
        XCTAssertEqual(s.capabilities, .coreNFCiPhone)
        XCTAssertNil(s.limit(op: "ndef-write", tech: NfcCatalog.ndef))
        XCTAssertNil(s.limit(op: "eid-read", tech: NfcCatalog.eid))
        XCTAssertEqual(s.limit(op: "emv-read", tech: NfcCatalog.emv), "Core NFC does not allow payment applications (EMV AIDs) — use an external reader.")
        XCTAssertEqual(s.limit(op: "classic-read", tech: NfcCatalog.mifareClassic1k), "MIFARE Classic is not available on iPhone (Core NFC has no MIFARE Classic).")
        XCTAssertNotNil(s.limit(op: "write-uid"))
        XCTAssertEqual(s.limit(op: "conn-emulate", tech: NfcCatalog.connectionTag),
                       "Card emulation needs the HCE entitlement (Core NFC CardSession) — not available on this device.")
        XCTAssertFalse(s.technologies.contains(NfcCatalog.emv))
        XCTAssertFalse(s.technologies.contains(NfcCatalog.mifareClassic1k))
        XCTAssertTrue(s.technologies.contains(NfcCatalog.eid))
    }

    /* ------------------------------------------------------------ tags */

    func testReadingATagFindsTheConnectionTagAndTheM5Card() async throws {
        let rig = NfcRig()
        rig.present(ndefTag([try Ndef.textRecord("hi"), ConnectionCard.record(Self.offlineBody)]))
        let s = makeNfcService(rig)
        let r = try await s.readTag(texts: english)
        XCTAssertEqual(r.identity.tech, NfcCatalog.connectionTag)
        XCTAssertEqual(r.connectionBody, Self.offlineBody)
        XCTAssertEqual(r.records?.count, 2)
        XCTAssertEqual(r.ndef, NdefStatus(state: .readWrite, capacity: 500))
        XCTAssertEqual(r.json.optBool("writable"), true)
        let d = try XCTUnwrap(rig.last)
        XCTAssertEqual(d.request.polling, .all)
        await rig.wait { d.invalidations.count == 1 }
        XCTAssertEqual(d.invalidations, [nil])
        XCTAssertEqual(d.alertMessage, "Done")

        let container = try M5Card.encodeContainer([M5Card.Sealed(id: 1, type: "message", mode: M5Card.modeExternal, oneTime: false,
                                                                   salt: filled(16, 1), iv: filled(12, 2), ct: filled(40, 3))])
        rig.present(ndefTag([M5Card.ndefRecord(container)]))
        let m5 = try await s.readTag(texts: english)
        XCTAssertEqual(m5.identity.tech, NfcCatalog.m5cetCard)
        XCTAssertEqual(m5.m5Container, container)
        // A tag without NDEF: its identity, no records.
        let blank = FakeTag(.iso15693(icManufacturer: 4), uid: hx("E004010203040506"))
        rig.present(blank)
        let v = try await s.readTag(texts: english)
        XCTAssertNil(v.records)
        XCTAssertEqual(v.identity.tech, NfcCatalog.iso15693)
        XCTAssertEqual(v.identity.uid, "E004010203040506")
    }

    func testWritingNdefAndWhyItFails() async throws {
        let rig = NfcRig()
        let s = makeNfcService(rig)
        let records = [try Ndef.textRecord("Ahoj", lang: "cs"), Ndef.uriRecord("https://m5cet.cz")]
        let size = try Ndef.encodeMessage(records).count
        let tag = ndefTag([])
        rig.present(tag)
        let written = try await s.writeTag(records, texts: english)
        XCTAssertEqual(written, size)
        XCTAssertEqual(tag.written.last, records)
        XCTAssertEqual(rig.last?.alertMessage, "Written \(size) B")
        XCTAssertEqual(rig.last?.request.aids, ["D2760000850101", "D2760000850100"])

        rig.present(ndefTag([], state: .readOnly))
        do { _ = try await s.writeTag(records, texts: english); XCTFail() } catch let e as NfcWriteFailure { XCTAssertEqual(e.kind, .readOnly) }
        await rig.wait { rig.last?.invalidations.count == 1 }
        XCTAssertEqual(rig.last?.invalidations, ["The tag is read-only."])

        rig.present(ndefTag([], capacity: 10))
        do { _ = try await s.writeTag(records, texts: english); XCTFail() } catch let e as NfcWriteFailure {
            XCTAssertEqual(e, NfcWriteFailure(.tooSmall, needed: size, available: 10))
        }
        await rig.wait { rig.last?.invalidations.count == 1 }
        XCTAssertEqual(rig.last?.invalidations, ["Too small: needs \(size) B, the card holds 10 B."])

        // ISO 15693 tag without NDEF: Core NFC cannot write it.
        rig.present(FakeTag(.iso15693(icManufacturer: 4)))
        do { _ = try await s.writeTag(records, texts: english); XCTFail() } catch let e as NfcWriteFailure { XCTAssertEqual(e.kind, .notWritable) }
    }

    func testABlankNtagIsWrittenPageByPage() async throws {
        let rig = NfcRig()
        let s = makeNfcService(rig)
        let tag = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        let pages = LockedBox([Int: [UInt8]]())
        tag.mifare = { f in
            switch f[0] {
            case 0x60: return hx("0004040201001103")                            // NTAG215: 504 B
            case 0x30: return [UInt8](repeating: 0, count: 16)                  // no CC on page 3
            case 0xa2: pages.update { $0[Int(f[1])] = Array(f[2...]) }; return [0x0a]
            default: throw NSError(domain: "NFCError", code: 102)
            }
        }
        rig.present(tag)
        let records = [ConnectionCard.record(Self.offlineBody)]
        let n = try await s.writeTag(records, texts: english)
        let p = pages.value
        XCTAssertEqual(p[3], [0xe1, 0x10, 0x3f, 0x00])                          // the CC: 504 / 8
        let area = (4..<(4 + p.count - 1)).flatMap { p[$0]! }
        XCTAssertEqual(Ndef.extractT2Ndef(area), try Ndef.encodeMessage(records))
        XCTAssertEqual(n, try Ndef.encodeMessage(records).count)
    }

    func testLockingNeedsTheExplicitYes() async throws {
        let rig = NfcRig()
        let s = makeNfcService(rig)
        let tag = ndefTag([])
        rig.present(tag)
        do { try await s.lockTag(confirmPermanentLock: false, texts: english); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .invalidArgument) }
        XCTAssertTrue(rig.drivers.isEmpty, "no sheet without the yes")
        do { _ = try await s.perform("ndef-lock", input: .confirmLock(false), texts: english); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .invalidArgument) }
        XCTAssertFalse(tag.locked)
        try await s.lockTag(confirmPermanentLock: true, texts: english)
        XCTAssertTrue(tag.locked)
        XCTAssertEqual(rig.last?.alertMessage, "Locked read-only")
    }

    /* ------------------------------------------------------------ cards */

    func testAnEPassportReadOverBac() async throws {
        let rig = NfcRig(), chip = BacChip(NfcDoc.key, NfcDoc.files())
        rig.present(isoTag(chip, aid: "A0000002471001"))
        let s = makeNfcService(rig)
        let r = try await s.readMrtd(mrz: NfcDoc.mrz, texts: english)
        XCTAssertEqual(r.optString("status"), "ok")
        let mrtd = try XCTUnwrap(r.optObject("mrtd"))
        XCTAssertEqual(mrtd.optObject("mrzInfo")?.optString("documentNumber"), "L898902C")
        XCTAssertEqual(mrtd.optString("access"), "bac")
        XCTAssertEqual(r.optObject("card")?.optString("tech"), NfcCatalog.eid)
        // Core NFC had already selected the eMRTD application: EF.CardAccess is looked for under the MF too.
        XCTAssertEqual(Array(chip.selected.prefix(3)), [0x011c, 0x3f00, 0x011c])
        let d = try XCTUnwrap(rig.last)
        XCTAssertEqual(d.request.polling, [.iso14443])
        XCTAssertEqual(d.request.aids, ["A0000002471001"])
        XCTAssertEqual(d.alertMessage, "Done")
        // The wrong key: the document stays closed and the sheet says so.
        rig.present(isoTag(BacChip(NfcDoc.key, NfcDoc.files()), aid: "A0000002471001"))
        let wrong = try await s.readMrtd(MrtdReader.Options(key: MrzKey("L898902C", "690807", "940623")), texts: english)
        XCTAssertEqual(wrong.optString("status"), "auth-failed")
        await rig.wait { rig.last?.invalidations.count == 1 }
        XCTAssertEqual(rig.last?.invalidations, [english.authFailed])
    }

    func testEmvIsRefusedOnTheIphoneButTheTransportCarriesIt() async throws {
        let rig = NfcRig()
        let s = makeNfcService(rig)
        do { _ = try await s.readEmv(texts: english); XCTFail() } catch let e as NfcError {
            XCTAssertEqual(e, NfcError.unsupported("Core NFC does not allow payment applications (EMV AIDs) — use an external reader."))
        }
        for (op, tech) in [("emv-read", NfcCatalog.emv), ("emv-public", NfcCatalog.emv), ("classic-read", NfcCatalog.mifareClassic1k), ("write-uid", NfcCatalog.mifareClassic1k)] {
            do { _ = try await s.perform(op, tech: tech, texts: english); XCTFail(op) } catch let e as NfcError { XCTAssertEqual(e.code, .unsupported, op) }
        }
        let emvTemplate = ApduTemplates.parse(try NfcRepo.json("android/app/src/test/resources/nfc/standard-apdu-templates.json").arrayValue).first { $0.cardType == ApduTemplates.emv }!
        do { _ = try await s.runTemplate(emvTemplate, texts: english); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .unsupported) }
        XCTAssertTrue(rig.drivers.isEmpty, "nothing reaches a card")

        // The EMV reader itself runs over this transport (an external reader with payment AIDs would use it).
        let chip = EmvSim()
        rig.present(isoTag(chip, aid: "D2760000850101"))
        let session = makeNfcSession(rig)
        let t = try await session.waitForCard(timeout: .seconds(5))
        let emv = await EmvReader.read(t, EmvReader.Options(maxApps: 1, history: false, deep: false))
        XCTAssertEqual(emv.objects("apps").first?.optString("pan"), "5413330089020011")
        XCTAssertTrue(chip.forbidden.isEmpty)
        await session.succeed()
    }

    func testTemplatesRunOnTheSimulatedCards() async throws {
        let all = ApduTemplates.parse(try NfcRepo.json("android/app/src/test/resources/nfc/standard-apdu-templates.json").arrayValue)
        let rig = NfcRig()
        let s = makeNfcService(rig)
        let iso = all.first { $0.label.hasPrefix("Smart card (ISO 7816-4)") }!
        let chip = IsoSim()
        rig.present(isoTag(chip, aid: "D2760000850101"))
        let steps = LockedBox([String]())
        let r = try await s.runTemplate(iso, texts: NfcSheetTexts(KeyTexts()), onStep: { n, total, label in steps.update { $0.append("\(n)/\(total) \(label)") } })
        XCTAssertEqual(r.status, "warn")
        XCTAssertEqual(r.exchanges.map(\.command), chip.seen)
        XCTAssertTrue(chip.seen.contains(String(format: "00C00000%02X", NfcSim.dir1.count)))
        XCTAssertEqual(steps.value.first, "1/12 SELECT MF (3F00)")
        await rig.wait { rig.last?.invalidations.count == 1 }
        XCTAssertEqual(rig.last?.invalidations, [nil])
        XCTAssertTrue(rig.last!.alertMessage == "⟨nfc.model.done⟩")

        let desfire = all.first { $0.cardType == ApduTemplates.desfire }!
        let df = FakeTag(.miFare(family: "desfire", historicalBytes: nil))
        df.chip = DesfireSim()
        rig.present(df)
        let dfRun = try await s.readCard(template: desfire, texts: english)
        XCTAssertEqual(dfRun.status, "ok")

        let eid = all.first { $0.label.hasPrefix("e-ID / e-passport — MRZ data only") }!
        rig.present(isoTag(BacChip(NfcDoc.key, NfcDoc.files()), aid: "A0000002471001"))
        let e = try await s.runTemplate(eid, mrtd: MrtdReader.Options(mrz: NfcDoc.mrz), texts: english)
        XCTAssertEqual(e.mrtd?.optObject("mrzInfo")?.optString("documentNumber"), "L898902C")
    }

    func testWorkbenchOps() async throws {
        let rig = NfcRig()
        let s = makeNfcService(rig)
        // ISO 15693 blocks.
        let v = FakeTag(.iso15693(icManufacturer: 4), uid: hx("E004010203040506"))
        v.blocks = [hx("01020304"), hx("05060708")]
        rig.present(v)
        var r = try await s.perform("v-read", texts: english)
        XCTAssertEqual(r.output.strings("blocks"), ["01020304", "05060708"])
        XCTAssertEqual(rig.last?.request.polling, [.iso15693])
        rig.present(v)
        _ = try await s.perform("v-write", input: .block(1, hx("AABBCCDD")), texts: english)
        XCTAssertEqual(v.blocks[1], hx("AABBCCDD"))
        // FeliCa.
        let f = FakeTag(.feliCa(idm: hx("0123456789ABCDEF"), systemCode: hx("12FC")))
        f.felicaCodes = [hx("12FC"), hx("FE00")]
        rig.present(f)
        r = try await s.perform("felica-systems", texts: english)
        XCTAssertEqual(r.output.optString("idm"), "0123456789ABCDEF")
        XCTAssertEqual(r.output.strings("systems"), ["12FC", "FE00"])
        // DESFire, a raw APDU, the e-ID's public presence.
        let df = FakeTag(.miFare(family: "desfire", historicalBytes: nil))
        df.chip = DesfireSim()
        rig.present(df)
        r = try await s.perform("desfire-apps", texts: english)
        XCTAssertEqual(r.output.strings("applications").count, 2)
        rig.present(isoTag(IsoSim(), aid: "D2760000850101"))
        r = try await s.perform("raw-apdu", input: .apdu(hx("00A4000C023F00")), texts: english)
        XCTAssertEqual(r.output.optString("apdu"), "9000")
        rig.present(isoTag(BacChip(NfcDoc.key, NfcDoc.files()), aid: "A0000002471001"))
        r = try await s.perform("eid-public", texts: english)
        XCTAssertEqual(r.output.optBool("selected"), true)
        // Ultralight pages; an op on the wrong card waits for the right one.
        let ul = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        ul.mifare = { f in
            if f == [0x60] { return [] }
            if f[0] == 0x30 && f[1] < 8 { return [UInt8](repeating: f[1], count: 16) }
            throw NSError(domain: "NFCError", code: 102)
        }
        rig.onBegin = { $0.detect([v]) }
        rig.onRestart = { $0.detect([ul]) }
        r = try await s.perform("ul-read", texts: english)
        XCTAssertEqual(r.output.optInt("pageCount"), 8)
        XCTAssertEqual(rig.last?.restarts, 1)
        rig.onRestart = nil
        // Writing a text record through the op.
        let tag = ndefTag([])
        rig.present(tag)
        r = try await s.perform("ndef-write", input: .text("ahoj"), texts: english)
        XCTAssertEqual(tag.written.count, 1)
        XCTAssertEqual(r.card.uid, "04A23B11223380")
        XCTAssertNotNil(r.output.string("done"))
    }

    func testOneReadingAtATimeTheNewestWins() async throws {
        let rig = NfcRig()
        let s = makeNfcService(rig)
        let first = Task { try await s.readTag(texts: english) }
        await rig.wait { rig.drivers.count == 1 }
        XCTAssertTrue(s.busy)
        rig.present(ndefTag([]))
        let second = try await s.readTag(texts: english)
        XCTAssertEqual(second.identity.uid, "04A23B11223380")
        do { _ = try await first.value; XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cancelled) }
        XCTAssertFalse(s.busy)
        // cancel() ends the one in progress.
        rig.onBegin = nil
        let third = Task { try await s.readTag(texts: english) }
        await rig.wait { rig.drivers.count == 3 }
        s.cancel()
        do { _ = try await third.value; XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .cancelled) }
        XCTAssertFalse(s.busy)
    }
}
