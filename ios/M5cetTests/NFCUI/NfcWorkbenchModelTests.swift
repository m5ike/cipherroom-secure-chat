// The NFC workbench's logic (Android NfcWorkbench) on a fake NfcService: what an
// iPhone and an iPad offer and why not, the inputs asked before the card (the
// lock's yes on iOS), scans, connection tags, templates (G-18 refusals, the e-ID
// key), the output's views and masking (G-19), Share / Forward / Keep, the report.

import M5Core
import M5Design
import M5NFC
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class NfcWorkbenchModelTests: XCTestCase {
    private func w(_ k: String) -> String { NfcUiTest.w(k) }

    // MARK: what the device offers

    func testAnIPhoneOffersCoreNfcAndSaysWhyNotForTheRest() {
        let m = NfcUiTest.workbench(FakeNfcUi())
        m.tech = NfcCatalog.ntag21x
        let ops = Dictionary(uniqueKeysWithValues: m.opButtons().map { ($0.id, $0) })
        XCTAssertNil(ops["scan"], "scan is the top button")
        for id in ["read-public", "ndef-read", "ndef-write", "ndef-lock", "ntag-read", "ntag-write"] { XCTAssertTrue(ops[id]!.enabled, id) }
        // No reader of the app runs these (Android: "nfc.op.unsupported" after the tap) — disabled, with the design's words.
        XCTAssertEqual(ops["ntag-password"]?.reason, w("nfc.op.unsupported"))
        XCTAssertEqual(ops["ntag-counter"]?.reason, w("nfc.op.unsupported"))

        m.tech = NfcCatalog.mifareClassic1k
        let classic = Dictionary(uniqueKeysWithValues: m.opButtons().map { ($0.id, $0.reason) })
        XCTAssertTrue(classic["classic-read"]!!.contains("MIFARE Classic"), "\(String(describing: classic["classic-read"]))")
        XCTAssertTrue(classic["classic-dump"]!!.contains("MIFARE Classic"))
        XCTAssertTrue(classic["write-uid"]!!.contains("MIFARE Classic") || classic["write-uid"]!!.contains("Raw"))
        XCTAssertNil(classic["ndef-read"]!, "NDEF on a Classic tag is the tag's NDEF")

        m.tech = NfcCatalog.emv
        let emv = Dictionary(uniqueKeysWithValues: m.opButtons().map { ($0.id, $0.reason) })
        XCTAssertTrue(emv["emv-read"]!!.contains("payment"), "Core NFC: no payment AIDs")
        XCTAssertTrue(emv["emv-public"]!!.contains("payment"))

        m.tech = NfcCatalog.m5cetCard
        let m5 = Dictionary(uniqueKeysWithValues: m.opButtons().map { ($0.id, $0.reason) })
        XCTAssertTrue(m5["m5-emulate"]!!.contains("HCE"), "emulation only with the HCE entitlement")
        XCTAssertNil(m5["m5-read"]!)
        XCTAssertNil(m5["m5-write"]!)

        m.tech = NfcCatalog.eid
        XCTAssertTrue(m.opButtons().first { $0.id == "eid-read" }!.enabled)
    }

    func testAnIPhoneWithHceMayBeTheCard() {
        let m = NfcUiTest.workbench(FakeNfcUi(hce: true))
        m.tech = NfcCatalog.connectionTag
        XCTAssertTrue(m.opButtons().first { $0.id == "conn-emulate" }!.enabled)
    }

    func testAnIPadHasNoReaderAndNothingIsADeadButton() {
        let fake = FakeNfcUi(iPhone: false)
        let rec = NfcUiRecorder()
        let m = NfcUiTest.workbench(fake, recorder: rec)
        XCTAssertFalse(m.available)
        XCTAssertEqual(m.unavailableReason, NfcService.noReader)
        XCTAssertEqual(m.status, w("nfc.unavailable"))
        for tech in TagTech.selectable {
            m.tech = tech
            for b in m.opButtons() { XCTAssertEqual(b.reason, NfcService.noReader, "\(tech) \(b.id)") }
        }
        // Even if something taps: the reason, no sheet.
        m.tap("ndef-read")
        m.scan()
        XCTAssertEqual(rec.flashes.map(\.0), [NfcService.noReader, w("nfc.unavailable")])
        XCTAssertTrue(fake.calls.isEmpty)
        XCTAssertNotNil(m.reason("m5-read", tech: NfcCatalog.m5cetCard))
    }

    // MARK: inputs before the card

    func testMakingATagReadOnlyNeedsAnExplicitYes() async {
        let fake = FakeNfcUi()
        let m = NfcUiTest.workbench(fake)
        m.tech = NfcCatalog.ndef
        m.tap("ndef-lock")
        XCTAssertEqual(m.prompt, .lock)
        XCTAssertTrue(fake.calls.isEmpty, "nothing before the yes")
        m.cancelPrompt()
        XCTAssertNil(m.prompt)
        XCTAssertTrue(fake.calls.isEmpty, "no means nothing")

        m.tap("ndef-lock")
        m.confirmLock()
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(fake.calls.filter { $0 == "ndef-lock" }.count, 1)
        guard case .confirmLock(true) = fake.inputs["ndef-lock"]! else { return XCTFail("the yes goes with the op") }
        XCTAssertEqual(m.content, .op(["done": .string(w("nfc.done.locked"))]))
    }

    func testTheRealServiceLocksNothingWithoutTheYes() async {
        let s = makeNfcService(NfcRig())
        do {
            _ = try await s.perform("ndef-lock", tech: NfcCatalog.ndef, input: .none)
            XCTFail("must refuse")
        } catch let e as NfcError {
            XCTAssertEqual(e.code, .invalidArgument)
        } catch { XCTFail("\(error)") }
        do {
            try await s.lockTag(confirmPermanentLock: false)
            XCTFail("must refuse")
        } catch let e as NfcError {
            XCTAssertEqual(e.message, NfcService.lockNeedsYes)
        } catch { XCTFail("\(error)") }
    }

    func testOpsAskWhatTheyNeedFirst() {
        let m = NfcUiTest.workbench(FakeNfcUi())
        m.tap("ndef-write"); XCTAssertEqual(m.prompt, .text(op: "ndef-write"))
        m.tap("raw-apdu"); XCTAssertEqual(m.prompt, .hex(op: "raw-apdu"))
        m.tap("ntag-write"); XCTAssertEqual(m.prompt, .block(op: "ntag-write", hexLength: 8))
        m.tap("v-write"); XCTAssertEqual(m.prompt, .block(op: "v-write", hexLength: 8))
        m.tap("eid-read"); XCTAssertEqual(m.prompt, .mrtd(photo: true, all: true, template: false))
    }

    func testHexAndBlockInputsAreCheckedBeforeTheSheet() async {
        let fake = FakeNfcUi()
        let rec = NfcUiRecorder()
        let m = NfcUiTest.workbench(fake, recorder: rec)
        m.submitHex("raw-apdu", "00A4 0")
        XCTAssertEqual(rec.lastFlash, w("nfc.hex.bad"))
        m.submitBlock("ntag-write", block: "x", data: "01020304", hexLength: 8)
        XCTAssertEqual(rec.lastFlash, w("nfc.block.no"))
        m.submitBlock("ntag-write", block: "4", data: "010203", hexLength: 8)
        XCTAssertEqual(rec.lastFlash, w("nfc.hex.bad"))
        XCTAssertTrue(fake.calls.isEmpty)

        m.submitHex("raw-apdu", "00 a4 04 00 00")
        await NfcUiTest.until { !m.working }
        guard case .apdu(let a) = fake.inputs["raw-apdu"]! else { return XCTFail() }
        XCTAssertEqual(a, [0x00, 0xA4, 0x04, 0x00, 0x00])
        m.submitBlock("ntag-write", block: " 4 ", data: "DE AD BE EF", hexLength: 8)
        await NfcUiTest.until { !m.working }
        guard case .block(4, let d) = fake.inputs["ntag-write"]! else { return XCTFail() }
        XCTAssertEqual(d, [0xDE, 0xAD, 0xBE, 0xEF])
    }

    /// Android askMrtd: the CAN alone (PACE), a pasted MRZ, or the three BAC fields; partial keys are refused.
    func testTheDocumentKeyRules() {
        XCTAssertEqual(NfcWorkbenchModel.mrtdOptions(NfcMrtdForm(can: "123456"))?.can, "123456")
        let mrz = NfcWorkbenchModel.mrtdOptions(NfcMrtdForm(mrz: " P<UTOERIKSSON<<ANNA\nL898902C36UTO7408122F1204159 ", photo: false, all: false))
        XCTAssertEqual(mrz?.mrz, "P<UTOERIKSSON<<ANNA\nL898902C36UTO7408122F1204159")
        XCTAssertEqual(mrz?.readPhoto, false)
        XCTAssertEqual(mrz?.all, false)
        let bac = NfcWorkbenchModel.mrtdOptions(NfcMrtdForm(documentNumber: "L898902C3", dateOfBirth: "740812", dateOfExpiry: "120415"))
        XCTAssertEqual(bac?.key, MrzKey("L898902C3", "740812", "120415"))
        XCTAssertNil(NfcWorkbenchModel.mrtdOptions(NfcMrtdForm()), "nothing")
        XCTAssertNil(NfcWorkbenchModel.mrtdOptions(NfcMrtdForm(documentNumber: "L898902C3")), "a partial key")
        XCTAssertNil(NfcWorkbenchModel.mrtdOptions(NfcMrtdForm(documentNumber: "L898902C3", can: "123456")), "a partial key beside the CAN")
        let both = NfcWorkbenchModel.mrtdOptions(NfcMrtdForm(documentNumber: "L898902C3", dateOfBirth: "740812", dateOfExpiry: "120415", can: "123456"))
        XCTAssertEqual(both?.can, "123456")
        XCTAssertNotNil(both?.key)
    }

    func testAnEidReadShowsTheDocumentAndItsReport() async throws {
        let fake = FakeNfcUi()
        fake.opResult = { _, _ in
            NfcOpResult(card: CardIdentity(uid: "08A1", tech: NfcCatalog.eid), output: ["status": "ok", "mrtd": .object(NfcUiTestData.mrtd)])
        }
        let rec = NfcUiRecorder()
        let m = NfcUiTest.workbench(fake, recorder: rec)
        m.submitMrtd(NfcMrtdForm(documentNumber: "L8", dateOfBirth: "", dateOfExpiry: ""))
        XCTAssertEqual(rec.lastFlash, w("nfc.eid.needKey"))
        XCTAssertTrue(fake.calls.isEmpty)
        m.submitMrtd(NfcMrtdForm(can: "123456"))
        await NfcUiTest.until { !m.working }
        guard case .mrtd(let mrtd) = m.content else { return XCTFail("\(m.content)") }
        XCTAssertEqual(mrtd.optObject("mrzInfo")?.optString("surname"), "SPECIMEN")
        XCTAssertEqual(m.tech, NfcCatalog.eid)
        XCTAssertTrue(m.status.contains("SPECIMEN"), m.status)

        // The report (CardReport): html, json, csv, text and the document's own files.
        let files = m.reportFiles()
        XCTAssertEqual(Array(files.prefix(4)).map(\.name), ["e-id-report.html", "e-id.json", "e-id.csv", "e-id.txt"])
        XCTAssertEqual(files[0].mime, "text/html")
        XCTAssertTrue(String(decoding: files[0].data, as: UTF8.self).contains("SPECIMEN"))
        XCTAssertTrue(String(decoding: files[0].data, as: UTF8.self).hasPrefix("<!doctype html>"))
        XCTAssertNoThrow(try NfcJSON.parse(files[1].data))
        XCTAssertTrue(String(decoding: files[2].data, as: UTF8.self).hasPrefix("section,field,value"))
        XCTAssertTrue(files.dropFirst(4).contains { $0.name.hasSuffix(".jp2") }, "the document's pictures as files: \(files.map(\.name))")
        XCTAssertTrue(files.allSatisfy { !$0.data.isEmpty })
    }

    // MARK: scanning

    func testAScanShowsTheCardAndItsTechnologysOps() async {
        let fake = FakeNfcUi()
        fake.tag = NfcTagRead(identity: CardIdentity(uid: "04A23B", tech: NfcCatalog.ntag21x), ndef: NdefStatus(state: .readWrite, capacity: 496),
                              records: [try! Ndef.textRecord("hi")])
        let m = NfcUiTest.workbench(fake)
        m.scan()
        XCTAssertEqual(m.status, w("nfc.hold"))
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(m.content, .card)
        XCTAssertEqual(m.tech, NfcCatalog.ntag21x)
        XCTAssertEqual(m.card?.uid, "04A23B")
        XCTAssertEqual(m.status, NfcCatalog.techInfo(NfcCatalog.ntag21x).label)
        XCTAssertEqual(fake.calls, ["stopEmulation", "readTag"], "a scan stops the emulation first (Android CardService.stopServing)")
    }

    func testAConnectionTagWithItsCodeOpensToItsRoomAtOnce() async {
        let fake = FakeNfcUi()
        fake.tag = NfcTagRead(identity: CardIdentity(uid: "04", tech: NfcCatalog.ntag21x), ndef: NdefStatus(state: .readWrite, capacity: 496),
                              records: [ConnectionCard.record(NfcTagV2.prefix + "{}")])
        fake.conn = { _, secret, redeem in
            var r = NfcConnReading()
            r.format = "v2-off"
            if secret == "CODE", !redeem { r.room = .init(room: "team", passphrase: "p", name: "") } else { r.need = "code" }
            return r
        }
        let m = NfcUiTest.workbench(fake)
        m.scan()
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(m.content, .card, "no code typed: the card and its ops")
        XCTAssertEqual(m.tech, NfcCatalog.connectionTag)

        m.pin = " CODE "
        m.scan()
        await NfcUiTest.until { !m.working }
        guard case .connection(let r, _) = m.content else { return XCTFail("\(m.content)") }
        XCTAssertEqual(r.room?.room, "team")
        XCTAssertTrue(fake.calls.contains("openConn:peek"), "an invitation is redeemed only on Open")
    }

    func testConnReadRedeemsAndWordsSayWhatIsMissing() async {
        let fake = FakeNfcUi()
        fake.opResult = { _, _ in NfcOpResult(card: CardIdentity(uid: "04", tech: NfcCatalog.connectionTag), output: ["connBody": .string(NfcTagV2.prefix + "{}")]) }
        fake.conn = { _, _, _ in var r = NfcConnReading(); r.format = "v2-inv"; r.error = "other-server"; r.origin = "https://other.example"; return r }
        let m = NfcUiTest.workbench(fake)
        m.tap("conn-read")
        await NfcUiTest.until { !m.working && m.content != .none }
        guard case .connection(let r, _) = m.content else { return XCTFail("\(m.content)") }
        XCTAssertTrue(fake.calls.contains("openConn:redeem"))
        XCTAssertEqual(NfcConnTagFlow.error(r, words: NfcUiTest.words), w("nfc.v2.err.other-server").replacingOccurrences(of: "{origin}", with: "https://other.example"))
        XCTAssertEqual(NfcConnTagFlow.kind(r, words: NfcUiTest.words), w("nfc.v2.invite"))
        var weak = NfcConnReading(); weak.format = "v1"; weak.weak = true; weak.need = "pin"
        XCTAssertEqual(NfcConnTagFlow.need(weak, words: NfcUiTest.words), w("nfc.v2.needPin"))
        XCTAssertEqual(NfcConnTagFlow.kind(weak, words: NfcUiTest.words), w("nfc.v2.old"))
        var wrong = NfcConnReading(); wrong.error = "wrong-pin"
        XCTAssertEqual(NfcConnTagFlow.error(wrong, words: NfcUiTest.words), w("nfc.wrongPin"))
    }

    func testWritingAConnectionTagPreparesItFirstAndShowsTheOfflineCodeOnce() async {
        let fake = FakeNfcUi()
        let m = NfcUiTest.workbench(fake)
        var shownCode: String?
        m.conn.presenter = { flow in if let c = flow.code { shownCode = c } }
        m.tech = NfcCatalog.connectionTag
        m.tap("conn-write")
        XCTAssertTrue(m.conn.choosing)
        await m.conn.choose("off", words: NfcUiTest.words)
        XCTAssertEqual(shownCode, "ABCD-EFGH-JKMN-PQRS-TVWX")
        XCTAssertFalse(fake.calls.contains("conn-write"), "not before the code was seen")
        m.conn.codeDone()
        await NfcUiTest.until { !m.working && fake.calls.contains("conn-write") }
        guard case .records(let rs) = fake.inputs["conn-write"]! else { return XCTFail() }
        XCTAssertEqual(ConnectionCard.body(of: rs), NfcTagV2.prefix + "{\"k\":\"off\"}")
        XCTAssertNil(m.conn.code)

        // An invitation has no code: written at once.
        m.tap("conn-write")
        await m.conn.choose("inv", words: NfcUiTest.words)
        await NfcUiTest.until { !m.working && fake.calls.filter { $0 == "conn-write" }.count == 2 }
        XCTAssertEqual(fake.calls.filter { $0 == "prepare:inv" }.count, 1)
    }

    func testWritingNeedsARoom() {
        let rec = NfcUiRecorder()
        let m = NfcUiTest.workbench(FakeNfcUi(), recorder: rec)
        m.activeCard = { nil }
        m.tap("conn-write")
        XCTAssertEqual(rec.lastFlash, w("rooms.empty"))
        XCTAssertFalse(m.conn.choosing)
    }

    // MARK: the M5Cet card

    func testM5CardRecordsOpenWithTheirKeyAndDoWhatTheySay() async throws {
        let fake = FakeNfcUi()
        let root = [UInt8](repeating: 3, count: 32)
        let container = try M5Card.buildCard([
            M5Card.Record(type: "server-room", mode: M5Card.modeInternal, data: ["room": "team", "passphrase": "pp", "name": "Mike"]),
            M5Card.Record(type: "message", mode: M5Card.modeInternal, oneTime: true, data: ["text": "hello"]),
        ], M5Card.keys(pin: nil, root: root))
        fake.opResult = { _, _ in NfcOpResult(card: CardIdentity(uid: "04", tech: NfcCatalog.m5cetCard), output: ["m5": .string(Hex.upper(container))]) }
        let rec = NfcUiRecorder()
        let m = NfcUiTest.workbench(fake, recorder: rec)
        m.tap("m5-read")
        await NfcUiTest.until { !m.working }
        guard case .records(let rs) = m.content else { return XCTFail("\(m.content)") }
        XCTAssertEqual(rs.map(\.type), ["server-room", "message"])

        // Without the account an internal record says so.
        NfcUiHooks.accountRoot = nil
        m.openRecord(rs[0])
        await NfcUiTest.until { !rec.flashes.isEmpty }
        XCTAssertEqual(rec.lastFlash, w("nfc.m5.needsAccount"))

        NfcUiHooks.accountRoot = { root }
        defer { NfcUiHooks.accountRoot = nil }
        m.openRecord(rs[0])
        await NfcUiTest.until { !rec.outcomes.isEmpty }
        XCTAssertEqual(rec.outcomes, [.join(room: "team", passphrase: "pp", name: "Mike")])

        // A one-time record is shown, then erased from the card on the next tag.
        m.openRecord(rs[1])
        await NfcUiTest.until { fake.written.count == 1 && !m.working }
        XCTAssertEqual(rec.outcomes.last, .text(title: w("nfc.rec.message"), body: "hello"))
        XCTAssertEqual(try M5Card.decodeContainer(fake.written[0]).map(\.type), ["server-room"])
        XCTAssertEqual(m.status, w("nfc.onetime.erased") + " ✓")
        XCTAssertTrue(rec.flashes.contains { $0.0 == w("nfc.onetime.rewrite") })
    }

    func testRecordOutcomes() {
        let words = NfcUiTest.words
        func rec(_ type: String, _ data: NfcJSONObject) -> M5Card.Record { M5Card.Record(type: type, data: data) }
        XCTAssertEqual(NfcWorkbenchModel.outcome(rec("wifi", ["ssid": "S", "password": "P"]), words: words), .wifi(ssid: "S", password: "P"))
        // A website login is a RUN record (M5Records): it opens its address, as on Android.
        XCTAssertEqual(NfcWorkbenchModel.outcome(rec("url-login", ["url": "https://x", "user": "u", "password": "p"]), words: words), .url("https://x"))
        XCTAssertEqual(NfcWorkbenchModel.outcome(rec("contact", ["name": "Ann", "tel": "1"]), words: words), .contact(name: "Ann", tel: "1", email: "", org: ""))
        XCTAssertEqual(NfcWorkbenchModel.outcome(rec("passkey-backup", ["user": "u"]), words: words), .handoff(title: words("nfc.rec.passkey")))
        XCTAssertEqual(NfcWorkbenchModel.outcome(rec("external-key", ["key": "k"]), words: words), .handoff(title: words("nfc.rec.externalKey")))
        XCTAssertEqual(NfcWorkbenchModel.outcome(rec("one-time-message", ["url": "https://y"]), words: words), .text(title: words("nfc.rec.onetime"), body: "https://y"))
    }

    func testBeTheCardNeedsACardFirstAndHce() async {
        let rec = NfcUiRecorder()
        let fake = FakeNfcUi(hce: true)
        let m = NfcUiTest.workbench(fake, recorder: rec)
        m.tap("m5-emulate")
        XCTAssertEqual(rec.lastFlash, w("nfc.m5.buildFirst"))
        XCTAssertEqual(rec.screens, ["nfc.builder"])
        m.tap("m5-write")
        XCTAssertEqual(rec.screens, ["nfc.builder", "nfc.builder"])
    }

    // MARK: templates (6.10)

    func testThePickerSaysWhyATemplateCannotRunHere() {
        let fake = FakeNfcUi()
        let m = NfcUiTest.workbench(fake)
        m.define = { NfcDemo.templates }
        m.showTemplates()
        XCTAssertEqual(m.prompt, .templates)
        XCTAssertEqual(m.templateGroups.map(\.title), [w("nfc.tpl.group.emv"), w("nfc.tpl.group.emrtd"), w("nfc.tpl.group.desfire"), w("nfc.tpl.group.iso7816")])
        let byLabel = Dictionary(uniqueKeysWithValues: m.templates.map { ($0.label, $0) })
        let emv = m.templateProblem(byLabel["Payment card — every application"]!)
        XCTAssertTrue(emv!.contains("payment"), "Core NFC: \(emv!)")
        let write = m.templateProblem(byLabel["Write test"]!)
        XCTAssertTrue(write!.hasPrefix(w("nfc.tpl.cantRun").replacingOccurrences(of: "{0}", with: "")), "G-18: \(write!)")
        XCTAssertNil(m.templateProblem(byLabel["Smart card — basic info"]!))
        XCTAssertEqual(m.templateMeta(byLabel["Smart card — basic info"]!), w("nfc.tpl.steps").replacingOccurrences(of: "{0}", with: "3"))

        // On an iPad nothing runs: the reason is the missing reader.
        let pad = NfcUiTest.workbench(FakeNfcUi(iPhone: false))
        pad.define = { NfcDemo.templates }
        pad.showTemplates()
        XCTAssertTrue(pad.templateProblem(byLabel["Smart card — basic info"]!)!.contains(NfcService.noReader))

        // Picking one that cannot run does nothing.
        m.pickTemplate(byLabel["Write test"]!)
        XCTAssertFalse(fake.calls.contains { $0.hasPrefix("template:") })
    }

    func testNoTemplatesSaysWhereToDefineThem() {
        let rec = NfcUiRecorder()
        let m = NfcUiTest.workbench(FakeNfcUi(), recorder: rec)
        m.showTemplates()
        XCTAssertNil(m.prompt)
        XCTAssertEqual(rec.lastFlash, w("nfc.tpl.none"))
    }

    func testAnEidTemplateAsksTheKeyWithItsPresets() async {
        let fake = FakeNfcUi()
        let m = NfcUiTest.workbench(fake)
        let t = NfcUiTest.template(["label": "ID", "card": "emrtd", "steps": [["op": "eid-read", "args": ["readPhoto": false, "all": true]]]])
        m.pickTemplate(t)
        XCTAssertEqual(m.prompt, .mrtd(photo: false, all: true, template: true))
        fake.chip = FakeUiChip()
        m.submitMrtd(NfcMrtdForm(can: "123456"))
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(fake.calls, ["stopEmulation", "template:ID"])
    }

    func testARunsOutputIsMaskedUnlessAskedAndSharedInMemory() async throws {
        let fake = FakeNfcUi()
        fake.chip = FakeUiChip()
        let m = NfcUiTest.workbench(fake)
        let t = NfcUiTest.template(["label": "Records", "card": "iso7816",
                                    "steps": [["apdu": "00A4040007A0000002471001", "label": "SELECT"], ["apdu": "00B2010C00", "label": "READ RECORD"],
                                              ["apdu": "00CA9F7F00", "label": "GET DATA", "optional": true]]])
        m.startTemplate(t, nil)
        guard case .progress("Records") = m.content else { return XCTFail("\(m.content)") }
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(m.content, .run)
        let r = try XCTUnwrap(m.lastRun)
        XCTAssertEqual(r.exchanges.count, 3)
        XCTAssertTrue(m.runSummary(r).hasPrefix("⚠ "), "an optional step not found: \(m.runSummary(r))")
        XCTAssertTrue(m.runSummary(r).contains("3"))
        XCTAssertEqual(m.outView, TemplateViews.readable)
        XCTAssertFalse(m.fullPan)
        XCTAssertTrue(TemplateViews.masks(r))

        for v in TemplateViews.views {
            m.outView = v
            XCTAssertFalse(m.outputText().contains(FakeUiChip.pan), "G-19: masked in \(v)")
        }
        m.outView = TemplateViews.io
        m.fullPan = true
        XCTAssertTrue(m.outputText().contains(FakeUiChip.pan), "the full data when asked")
        m.fullPan = false

        // Share: text, or JSON as a file in memory.
        m.outView = TemplateViews.raw
        guard case .text(let text, let subject) = m.shareItem() else { return XCTFail() }
        XCTAssertEqual(subject, "Records")
        XCTAssertFalse(text.contains(FakeUiChip.pan))
        m.outView = TemplateViews.json
        m.clock = { Date(timeIntervalSince1970: 1_760_000_000) }
        guard case .file(let f, _) = m.shareItem() else { return XCTFail() }
        XCTAssertEqual(f.mime, "application/json")
        XCTAssertTrue(f.name.hasPrefix("nfc-records-2025"), f.name)
        XCTAssertTrue(f.name.hasSuffix(".json"))
        XCTAssertNoThrow(try NfcJSON.parse(f.data))
        XCTAssertFalse(String(decoding: f.data, as: UTF8.self).contains(FakeUiChip.pan))

        // A new run starts readable and masked again.
        m.fullPan = true
        m.outView = TemplateViews.io
        m.startTemplate(t, nil)
        await NfcUiTest.until { !m.working }
        XCTAssertFalse(m.fullPan)
        XCTAssertEqual(m.outView, TemplateViews.readable)
    }

    func testForwardAndKeepForMyself() async throws {
        let fake = FakeNfcUi()
        fake.chip = FakeUiChip()
        let rec = NfcUiRecorder()
        let m = NfcUiTest.workbench(fake, recorder: rec)
        let rooms = PreviewRooms()
        m.rooms = { rooms }
        m.files = { PreviewFiles() }
        m.startTemplate(NfcUiTest.template(["label": "Basic", "card": "iso7816", "steps": [["apdu": "00B2010C00"]]]), nil)
        await NfcUiTest.until { !m.working }

        // Forward: the text as the message, from "NFC".
        let msg = try XCTUnwrap(try m.forwardMessage())
        XCTAssertEqual(msg.senderName, "NFC")
        XCTAssertEqual(msg.forwardedFrom, "NFC · Basic")
        XCTAssertFalse(msg.text.contains(FakeUiChip.pan))
        XCTAssertNil(msg.fileName)
        // JSON goes as a file (inline when small).
        m.outView = TemplateViews.json
        let file = try XCTUnwrap(try m.forwardMessage())
        XCTAssertEqual(file.fileName?.hasSuffix(".json"), true)
        // Android Payloads.safeMime: a JSON file travels as octet-stream.
        XCTAssertEqual(file.fileMime, Payloads.safeMime("application/json"))
        XCTAssertTrue(file.fileDataUrl?.hasPrefix("data:" + Payloads.safeMime("application/json") + ";base64,") ?? false)

        // Keep for myself: a note in the room on screen, never sent.
        m.outView = TemplateViews.readable
        let room = try XCTUnwrap(rooms.active)
        let before = room.messages.count
        m.keepForMyself()
        XCTAssertEqual(room.messages.count, before + 1)
        let note = try XCTUnwrap(room.messages.last)
        XCTAssertEqual(note.kind, "note")
        XCTAssertTrue(note.text.hasPrefix("🔒 " + w("nfc.out.noteHead") + " · Basic\n\n"))
        XCTAssertFalse(note.text.contains(FakeUiChip.pan))
        XCTAssertEqual(rec.flashes.last?.1, .success)

        let none = NfcUiTest.workbench(fake, recorder: rec)
        none.rooms = { NoRooms() }
        none.showRun(m.lastRun!)
        none.keepForMyself()
        XCTAssertEqual(rec.lastFlash, w("nfc.out.noRoom"))
    }

    func testAClosedSheetIsNoFailure() async {
        let fake = FakeNfcUi()
        fake.readError = NfcError(.cancelled, "closed")
        let m = NfcUiTest.workbench(fake)
        m.scan()
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(m.status, w("nfc.work.tapScan"))
        fake.readError = NfcWriteFailure(.tooSmall, needed: 300, available: 137)
        m.submitText("ndef-write", "x")
        await NfcUiTest.until { !m.working }
        XCTAssertEqual(m.status, w("nfc.err.tooSmall").replacingOccurrences(of: "{0}", with: "300").replacingOccurrences(of: "{1}", with: "137"))
    }
}

enum NfcUiTestData {
    /// A specimen e-ID read (no real person).
    static var mrtd: NfcJSONObject { MainActor.assumeIsolated { NfcDemo.mrtd() } }
}
