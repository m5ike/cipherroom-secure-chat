// A model's NFC command (ModelNfcTest.java / ModelNfcConsentTest.java; web-executor.ts, consent.ts):
// op routing, args in camelCase or snake_case, writes denied, the reader chosen, enum, the timeout / cancel
// shapes, a fake card; the e-ID document key the device asks for itself, which never reaches the answer;
// and G-17 — what goes masked (the default), what "send everything" adds, and that the masked answer holds
// no card number, no track data, no MRZ lines, no photo.

import Testing
import Foundation
@testable import M5NFC

func cmd(_ json: String) -> ModelNfc.Command { ModelNfc.parse(["command": try! NfcJSON.parse(json)]) }

final class FakeCard: ModelNfcCard {
    let ident: NfcJSONObject
    let iso: (any ApduChannel)?
    let records: [NdefRecord]?
    var ndefFails: Error?
    var isoOpened = 0

    init(_ tech: String, _ iso: (any ApduChannel)?, _ ndef: [NdefRecord]?) {
        ident = ["uid": "04A1B2C3D4E5F6", "tech": .string(tech), "label": .string(NfcCatalog.techInfo(tech).label), "sak": "20", "atqa": "0044",
                 "techList": ["IsoDep", "NfcA"], "sectors": 16]
        self.iso = iso; self.records = ndef
    }
    func identity() -> NfcJSONObject { ident }
    func isoDep() async throws -> (any ApduChannel)? { if iso != nil { isoOpened += 1 }; return iso }
    func ndef() async throws -> [NdefRecord]? { if let e = ndefFails { throw e }; return records }
}

func textRecord(_ lang: String, _ s: String) -> NdefRecord { NdefRecord(tnf: 1, type: Array("T".utf8), payload: [UInt8(lang.utf8.count)] + Array(lang.utf8) + Array(s.utf8)) }
func uriRecord(_ code: Int, _ rest: String) -> NdefRecord { NdefRecord(tnf: 1, type: Array("U".utf8), payload: [UInt8(code)] + Array(rest.utf8)) }

/// A Visa card; it fails the test if anything but a read is sent. `extra` adds tracks to the record.
func visaCard(pan: String = "4111111111111111", tracks: Bool = false) -> FnCard {
    let aid = "A0000000031010"
    let ppse = T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, T(0x61, T(0x4f, b(aid)), T(0x50, ascii("VISA")), T(0x87, u8(1))))))
    let fci = T(0x6f, T(0x84, b(aid)), T(0xa5, T(0x50, ascii("VISA")), T(0x9f38, b("9F66049F02069F3704"))))
    let gpo = T(0x77, T(0x82, b("5C00")), T(0x94, b("08010100")))
    let rec = tracks
        ? T(0x70, T(0x5a, b(pan)), T(0x57, b(pan + "D2912201987654321F")), T(0x56, ascii("B" + pan + "^NOVAK/JAN^2912201")), T(0x5f24, b("291231")), T(0x5f20, ascii("NOVAK/JAN")))
        : T(0x70, T(0x5a, b(pan)), T(0x5f24, b("291231")), T(0x5f20, ascii("VISA CARDHOLDER")))
    let ppseHex = H(ascii("2PAY.SYS.DDF01"))
    return FnCard { c in
        let cla = Int(c[0]), ins = Int(c[1]), p1 = Int(c[2]), p2 = Int(c[3])
        if ins == 0x20 || (cla == 0x80 && ins == 0xae) || ins == 0xd6 || ins == 0xdc || ins == 0xe2 { throw CardFailure(message: "a model's read must never VERIFY, GENERATE AC or write") }
        if ins == 0xa4 && p1 == 0x04 {
            let s = H(Bytes.slice(c, 5, 5 + Int(c[4])))
            if s == ppseHex { return ok(ppse) }
            if s == aid { return ok(fci) }
            return sw(0x6a82)
        }
        if cla == 0x80 && ins == 0xa8 { return ok(gpo) }
        if ins == 0xb2 { return p1 == 1 && p2 >> 3 == 1 ? ok(rec) : sw(0x6a83) }
        return sw(0x6d00)
    }
}

@Suite struct ModelNfcTests {
    @Test func parsesTheCommandWithDefaultsAndBounds() {
        let c = cmd("{\"op\":\"emv-read\",\"reader\":\"usb\",\"tech\":\"emv\",\"timeout\":500,\"args\":{\"maxApps\":2}}")
        #expect(c.op == "emv-read" && c.reader == "usb" && c.tech == "emv" && c.timeout == 120)
        #expect(c.args.optInt("maxApps") == 2)
        #expect(cmd("{\"op\":\"scan\"}").timeout == 20)
        #expect(cmd("{\"op\":\"scan\",\"timeout\":0.2}").timeout == 1)
        #expect(cmd("{\"op\":\"scan\",\"timeout\":\"30\"}").timeout == 20)
        #expect(cmd("{\"op\":\"scan\",\"reader\":\"pn532-wifi\"}").reader == nil)
        // The web answers an interaction without a command as a scan.
        #expect(ModelNfc.parse([:]).op == "scan")
        #expect(ModelNfc.parse(nil).op == "scan")
        // A malformed op is no op at all.
        #expect(cmd("{\"op\":\"EMV READ\"}").op == "")
        #expect(ModelNfc.refusal(cmd("{\"op\":\"EMV READ\"}"))?.optString("status") == "unsupported")
    }

    @Test func argsAreCamelCaseFromSnakeCaseAndNeverAKey() {
        let e = cmd("{\"op\":\"emv-read\",\"args\":{\"max_apps\":3,\"history\":false,\"deep\":true}}")
        #expect(e.args.optInt("maxApps") == 3)
        #expect(!e.args.has("max_apps"))
        #expect(e.args.optBool("history", true) == false)
        #expect(EmvReader.Options.from(args: e.args).maxApps == 3)
        let m = cmd("{\"op\":\"mrtd-read\",\"args\":{\"document_number\":\"L898902C\",\"date_of_birth\":\"690806\",\"date_of_expiry\":\"940623\",\"photo\":false,\"all\":false}}")
        #expect(m.args.optString("documentNumber") == "L898902C")
        #expect(m.args.optString("dateOfBirth") == "690806")
        #expect(m.args.optString("dateOfExpiry") == "940623")
        #expect(m.args["readPhoto"] == .bool(false))
        let o = MrtdReader.Options.from(args: m.args)
        #expect(o.key != nil && !o.readPhoto && !o.all)
        // An explicit camelCase key wins over its snake_case twin.
        #expect(cmd("{\"op\":\"emv-read\",\"args\":{\"maxApps\":5,\"max_apps\":1}}").args.optInt("maxApps") == 5)
        #expect(cmd("{\"op\":\"eid-read\",\"args\":{\"readPhoto\":true,\"read_photo\":false,\"photo\":false}}").args["readPhoto"] == .bool(true))
        // No raw card key / PIN argument gets through, whatever its spelling.
        let a = cmd("{\"op\":\"classic-read\",\"args\":{\"key\":\"FFFFFFFFFFFF\",\"key_a\":\"A0A1A2A3A4A5\",\"keyB\":\"B0\",\"pin\":\"1234\",\"PASSWORD\":\"x\",\"from\":4}}").args
        #expect(keysOf(.object(a)) == ["from"])
    }

    @Test func writesAndEmulationAreDeniedUnknownOpsUnsupported() {
        for op in ["ndef-write", "ndef-lock", "classic-write", "classic-restore", "ntag-write", "ul-write", "write-uid", "m5-write", "m5-erase", "conn-write", "desfire-write", "v-write", "ntag-password"] {
            let r = ModelNfc.refusal(cmd("{\"op\":\"\(op)\"}"))
            #expect(r?.optString("status") == "denied", "\(op)")
            #expect(r?.optString("message").contains("workbench") == true)
        }
        for op in ["m5-emulate", "conn-emulate"] { #expect(ModelNfc.refusal(cmd("{\"op\":\"\(op)\"}"))?.optString("status") == "denied") }
        for op in ["raw-apdu", "select-aid", "classic-read", "classic-dump", "desfire-read", "felica-read", "frobnicate", "write"] {
            #expect(ModelNfc.refusal(cmd("{\"op\":\"\(op)\"}"))?.optString("status") == "unsupported", "\(op)")
        }
        for op in ModelNfc.reads { #expect(ModelNfc.refusal(cmd("{\"op\":\"\(op)\"}")) == nil, "\(op)") }
        #expect(ModelNfc.refusal(cmd("{\"op\":\"enum\"}")) == nil)
        #expect(ModelNfc.kindOf("enum") == "enum")
        #expect(ModelNfc.kindOf("ndef-write") == "write")
        #expect(ModelNfc.kindOf("m5-emulate") == "emulate")
        #expect(ModelNfc.kindOf("raw-apdu") == "other")
        #expect(ModelNfc.kindOf("frobnicate") == "unknown")
        #expect(ModelNfc.refusal(cmd("{\"op\":\"raw-apdu\"}"))?.optString("message").contains("on iOS") == true)
    }

    @Test func aTechnologyThatDoesNotOfferTheOp() {
        let r = ModelNfc.refusal(cmd("{\"op\":\"emv-read\",\"tech\":\"ndef\"}"))
        #expect(r?.optString("status") == "unsupported")
        #expect(r?.optString("message").contains("NDEF tag") == true)
        #expect(ModelNfc.refusal(cmd("{\"op\":\"emv-read\",\"tech\":\"emv\"}")) == nil)
        #expect(ModelNfc.refusal(cmd("{\"op\":\"mrtd-read\",\"tech\":\"eid\"}")) == nil) // eid.read() sends mrtd-read
        #expect(ModelNfc.refusal(cmd("{\"op\":\"scan\",\"tech\":\"felica\"}")) == nil)
        #expect(ModelNfc.refusal(cmd("{\"op\":\"emv-read\",\"tech\":\"no-such-tech\"}")) == nil)
    }

    static func phone(_ nfc: Bool, _ on: Bool, _ caps: NfcCapabilities = .coreNFCiPhone) -> ModelNfc.Device {
        var d = ModelNfc.Device()
        d.hasNfc = nfc; d.nfcOn = on; d.internalCapabilities = caps
        return d
    }

    @Test func theReaderIsThePhonesOwnUnlessAUsbOneIsAllowed() {
        let scan = cmd("{\"op\":\"scan\"}")
        #expect(ModelNfc.route(scan, Self.phone(true, true)).reader == "internal")
        let off = ModelNfc.route(scan, Self.phone(true, false))
        #expect(off.reader == nil && off.nfcOff)
        #expect(off.result?.optString("status") == "unsupported")
        #expect(off.result?.optString("message").contains("switched off") == true)
        let none = ModelNfc.route(scan, Self.phone(false, false))
        #expect(!none.nfcOff)
        #expect(none.result?.optString("status") == "unsupported")
        var usb = Self.phone(true, true)
        usb.usb.append(.init("ACR122U", permitted: false))
        #expect(ModelNfc.route(scan, usb).reader == "internal")
        let notAllowed = ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"usb\"}"), usb)
        #expect(notAllowed.result?.optString("status") == "unsupported")
        #expect(notAllowed.result?.optString("message").contains("Allow") == true)
        usb.usb[0] = .init("ACR122U", permitted: true)
        #expect(ModelNfc.route(cmd("{\"op\":\"emv-read\",\"reader\":\"usb\"}"), usb).reader == "usb")
        #expect(ModelNfc.route(scan, usb).reader == "internal")
        usb.preferred = "usb" // the workbench uses the USB reader
        #expect(ModelNfc.route(scan, usb).reader == "usb")
        #expect(ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"internal\"}"), usb).reader == "internal")
        #expect(ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"usb\"}"), Self.phone(true, true)).result?.optString("message") == "No USB reader is connected.")
        #expect(ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"bluetooth\"}"), usb).result?.optString("status") == "unsupported")
        #expect(ModelNfc.route(cmd("{\"op\":\"scan\",\"reader\":\"serial\"}"), usb).result?.optString("status") == "unsupported")
    }

    /// iOS: Core NFC refuses payment AIDs, so a payment read on the iPhone's own reader is answered at once, honestly.
    @Test func anIphoneSaysItCannotReadAPaymentCard() {
        let r = ModelNfc.route(cmd("{\"op\":\"emv-read\"}"), Self.phone(true, true))
        #expect(r.reader == nil)
        #expect(r.result?.optString("message").contains("payment") == true)
        #expect(ModelNfc.route(cmd("{\"op\":\"emv-read\"}"), Self.phone(true, true, .android)).reader == "internal")
        #expect(ModelNfc.route(cmd("{\"op\":\"mrtd-read\"}"), Self.phone(true, true)).reader == "internal")
        #expect(NfcPlatform.limit(op: "eid-read", tech: "eid", capabilities: .none)?.contains("no NFC") == true)
    }

    @Test func enumTellsTheReadersAndTechnologiesWithoutACard() throws {
        var d = Self.phone(true, true, .android.subtracting(.mifareClassic))
        d.usb.append(.init("ACR1252U", permitted: true))
        d.bluetooth = true
        let r = ModelNfc.enumResult(cmd("{\"op\":\"enum\"}"), d)
        #expect(r.optString("status") == "ok")
        #expect(!r.has("card"))
        #expect(r.optString("message").contains("This device (NFC on)"))
        #expect(r.optString("message").contains("ACR1252U"))
        let data = try #require(try NfcJSON.parse(Data(base64Encoded: r.optString("data"))!).objectValue)
        let readers = data.objects("readers")
        #expect(readers.count == 3)
        #expect(readers[0].optString("kind") == "internal" && readers[0].optBool("enabled"))
        #expect(readers[1].optString("kind") == "usb")
        #expect(!readers[2].optBool("available"))
        #expect(data.optString("default") == "internal")
        let techs = data.strings("technologies")
        for t in ["emv", "eid", "ndef", "ntag21x", "iso-dep"] { #expect(techs.contains(t), "\(t)") }
        #expect(!techs.contains("mifare-classic-1k"), "no MIFARE Classic")
        #expect(!techs.contains("unknown"))
        #expect(data.strings("ops").contains("emv-read"))
        d.internalCapabilities.insert(.mifareClassic)
        #expect(ModelNfc.enumResult(cmd("{\"op\":\"enum\"}"), d).optString("message").contains("mifare-classic-1k"))
        // Scoped to one reader.
        let only = try #require(try NfcJSON.parse(Data(base64Encoded: ModelNfc.enumResult(cmd("{\"op\":\"enum\",\"reader\":\"usb\"}"), d).optString("data"))!).objectValue)
        #expect(only.arrayCount("readers") == 1)
        // Nothing at all.
        #expect(ModelNfc.enumResult(cmd("{\"op\":\"enum\"}"), Self.phone(false, false)).optString("message") == "No NFC reader on this device.")
        // An iPhone: no MIFARE Classic, and no payment card through Core NFC.
        let iphone = try #require(try NfcJSON.parse(Data(base64Encoded: ModelNfc.enumResult(cmd("{\"op\":\"enum\"}"), Self.phone(true, true)).optString("data"))!).objectValue)
        #expect(!iphone.strings("technologies").contains("emv"))
        #expect(!iphone.strings("technologies").contains("mifare-classic-1k"))
        #expect(iphone.strings("technologies").contains("eid"))
    }

    @Test func timeoutAndCancelShapes() {
        let c = ModelNfc.cancelled()
        #expect(c.optString("status") == "timeout" && c.optString("message") == "Cancelled" && c.count == 2)
        let t = ModelNfc.timedOut(20)
        #expect(t.optString("status") == "timeout" && t.optString("message").contains("20 s") && !t.has("card"))
    }

    @Test func readUidAnswersTheCardWithOnlyItsPublicFields() async throws {
        let r = await ModelNfc.run(cmd("{\"op\":\"read-uid\"}"), FakeCard(NfcCatalog.isoDep, nil, nil))
        #expect(r.optString("status") == "ok")
        let card = try #require(r.optObject("card"))
        #expect(card.optString("uid") == "04A1B2C3D4E5F6")
        #expect(card.optString("tech") == "iso-dep")
        #expect(card.optString("sak") == "20" && card.optString("atqa") == "0044")
        #expect(!card.has("techList") && !card.has("sectors"))
    }

    @Test func scanAndNdefReadDecodeTheRecords() async throws {
        let recs = [textRecord("cs", "Ahoj světe"), uriRecord(4, "m5cet.cz/x"), NdefRecord(tnf: 2, type: Array("text/plain".utf8), payload: [0x41]),
                    NdefRecord(tnf: 4, type: Array("example.com:t".utf8), payload: [0x01, 0x02]), NdefRecord(tnf: 0)]
        let r = await ModelNfc.run(cmd("{\"op\":\"scan\"}"), FakeCard(NfcCatalog.ntag21x, nil, recs))
        #expect(r.optString("status") == "ok")
        let n = r.objects("ndef")
        #expect(n.count == 5)
        #expect(n[0].optString("kind") == "text" && n[0].optString("text") == "Ahoj světe" && n[0].optString("lang") == "cs")
        #expect(n[1].optString("kind") == "uri" && n[1].optString("data") == "https://m5cet.cz/x")
        #expect(n[2].optString("kind") == "mime" && n[2].optString("type") == "text/plain" && n[2].optString("data") == "41")
        #expect(n[3].optString("kind") == "external")
        #expect(n[4].optString("kind") == "empty")
        #expect(!r.has("records"))
        #expect(await ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), FakeCard(NfcCatalog.ntag21x, nil, recs)).arrayCount("ndef") == 5)
        // Not an NDEF tag.
        let not = await ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), FakeCard(NfcCatalog.mifareClassic1k, nil, nil))
        #expect(not.optString("status") == "unsupported")
        #expect(not.optObject("card")?.optString("tech") == "mifare-classic-1k")
        // A scan of a card without NDEF is still its identity.
        let plain = await ModelNfc.run(cmd("{\"op\":\"scan\"}"), FakeCard(NfcCatalog.isoDep, nil, nil))
        #expect(plain.optString("status") == "ok" && !plain.has("ndef"))
    }

    @Test func aSmartPosterGivesItsUri() async {
        // Sp payload = an NDEF message: a short URI record (MB|ME|SR, TNF 1).
        let inner = u8(0xd1, 0x01, 0x05) + Array("U".utf8) + u8(0x03) + Array("a.cz".utf8)
        let r = await ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), FakeCard(NfcCatalog.ndef, nil, [NdefRecord(tnf: 1, type: Array("Sp".utf8), payload: inner)]))
        #expect(r.objects("ndef").first?.optString("kind") == "smart-poster")
        #expect(r.objects("ndef").first?.optString("data") == "http://a.cz")
    }

    @Test func anM5CetCardListsItsRecordsStillSealed() async throws {
        let s = M5Card.Sealed(id: 0x0a0b0c, type: "message", mode: M5Card.modeExternal, oneTime: true, salt: [UInt8](repeating: 0, count: 16), iv: [UInt8](repeating: 0, count: 12), ct: [UInt8](repeating: 0, count: 24))
        let rec = NdefRecord(tnf: 4, type: Array(M5Card.externalType.utf8), payload: try M5Card.encodeContainer([s]))
        let r = await ModelNfc.run(cmd("{\"op\":\"m5-read\"}"), FakeCard(NfcCatalog.ntag21x, nil, [rec]))
        #expect(r.optString("status") == "ok")
        #expect(r.optObject("card")?.optString("tech") == "m5cet-card")
        let one = try #require(r.objects("records").first)
        #expect(one.optInt("id") == 0x0a0b0c && one.optString("type") == "message" && one.optBool("oneTime"))
        #expect(await ModelNfc.run(cmd("{\"op\":\"scan\"}"), FakeCard(NfcCatalog.ntag21x, nil, [rec])).arrayCount("records") == 1)
        #expect(await ModelNfc.run(cmd("{\"op\":\"m5-read\"}"), FakeCard(NfcCatalog.ntag21x, nil, [textRecord("en", "x")])).optString("message") == "Not an M5Cet card.")
    }

    @Test func emvReadRunsTheCardLayerReadOnly() async throws {
        let card = FakeCard(NfcCatalog.isoDep, visaCard(), nil)
        let r = await ModelNfc.run(cmd("{\"op\":\"emv-read\",\"args\":{\"max_apps\":1,\"history\":false,\"deep\":false}}"), card)
        #expect(r.optString("status") == "ok")
        #expect(card.isoOpened == 1)
        let app = try #require(r.optObject("emv")?.objects("apps").first)
        #expect(app.optString("pan") == "4111111111111111")
        #expect(app.optString("expiry") == "2029-12")
        #expect(r.optObject("card")?.optString("tech") == "emv")
        #expect(r.optObject("card")?.optString("label") == "EMV payment card")
        #expect(!r.optString("message").isEmpty)
        // emv-public: the PPSE only.
        let pub = await ModelNfc.run(cmd("{\"op\":\"emv-public\"}"), FakeCard(NfcCatalog.isoDep, visaCard(), nil))
        #expect(pub.optString("status") == "ok")
        #expect(pub.optString("message").contains("A0000000031010"))
        #expect(!pub.has("emv"))
    }

    @Test func anIsoDepReadOnACardWithoutIsoDepIsUnsupported() async {
        for op in ["emv-read", "eid-read", "mrtd-read", "emv-public", "eid-public"] {
            let r = await ModelNfc.run(cmd("{\"op\":\"\(op)\",\"args\":{\"can\":\"123456\"}}"), FakeCard(NfcCatalog.mifareUltralight, nil, nil))
            #expect(r.optString("status") == "unsupported", "\(op)")
            #expect(r.optObject("card")?.optString("tech") == "mifare-ultralight")
        }
    }

    @Test func aCardTakenAwayIsNoCardAndOtherFailuresAnError() async {
        let gone = FakeCard(NfcCatalog.ndef, nil, nil)
        gone.ndefFails = NfcError.cardGone("tag lost")
        let r = await ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), gone)
        #expect(r.optString("status") == "no-card" && r.has("card"))
        #expect(await ModelNfc.run(cmd("{\"op\":\"scan\"}"), gone).optString("status") == "no-card")
        let broken = FakeCard(NfcCatalog.ndef, nil, nil)
        broken.ndefFails = CardFailure(message: "the NDEF message is malformed")
        let e = await ModelNfc.run(cmd("{\"op\":\"ndef-read\"}"), broken)
        #expect(e.optString("status") == "error")
        #expect(e.optString("message") == "the NDEF message is malformed")
        // A scan carries on without the NDEF it could not read.
        #expect(await ModelNfc.run(cmd("{\"op\":\"scan\"}"), broken).optString("status") == "ok")
    }

    /* ------------------------------------------------ the document key (e-ID) */

    @Test func anEidReadWithoutADocumentKeyAsksTheHolder() {
        #expect(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\"}")))
        #expect(ModelNfc.needsDocumentKey(cmd("{\"op\":\"mrtd-read\",\"args\":{\"readPhoto\":true}}")))
        #expect(ModelNfc.needsDocumentKey(cmd("{\"op\":\"mrtd-read\",\"args\":{\"can\":\"  \",\"mrz\":\"\"}}")))
        #expect(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"documentNumber\":\"L898902C\",\"dateOfBirth\":\"690806\"}}")), "two of the three fields are not a key")
        #expect(ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"can\":123456}}")))
        #expect(!ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"can\":\"123456\"}}")))
        #expect(!ModelNfc.needsDocumentKey(cmd("{\"op\":\"mrtd-read\",\"args\":{\"mrz\":\"P<UTO...\"}}")))
        #expect(!ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"documentNumber\":\"L898902C\",\"dateOfBirth\":\"690806\",\"dateOfExpiry\":\"940623\"}}")))
        #expect(!ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-read\",\"args\":{\"document_number\":\"L898902C\",\"date_of_birth\":\"690806\",\"date_of_expiry\":\"940623\"}}")))
        #expect(!ModelNfc.needsDocumentKey(cmd("{\"op\":\"emv-read\"}")), "not an e-ID read")
        #expect(!ModelNfc.needsDocumentKey(cmd("{\"op\":\"eid-public\"}")))
    }

    static func key(_ can: String, _ mrz: String, _ doc: String, _ dob: String, _ exp: String) -> ModelNfc.DocumentKey {
        ModelNfc.DocumentKey(can: can, mrz: mrz, documentNumber: doc, dateOfBirth: dob, dateOfExpiry: exp)
    }

    @Test func whatTheHolderTypesIsChecked() {
        #expect(ModelNfc.checkDocumentKey(Self.key("", "", "", "", "")) == "nfc.eid.needKey")
        #expect(ModelNfc.checkDocumentKey(Self.key("12345", "", "", "", "")) == "nfc.model.key.badCan")
        #expect(ModelNfc.checkDocumentKey(Self.key("12345a", "", "", "", "")) == "nfc.model.key.badCan")
        #expect(ModelNfc.checkDocumentKey(Self.key("123 456", "", "", "", "")) == nil)
        #expect(ModelNfc.checkDocumentKey(Self.key("", Doc.mrz, "", "", "")) == nil)
        #expect(ModelNfc.checkDocumentKey(Self.key("", Doc.mrz.lowercased(), "", "", "")) == nil)
        #expect(ModelNfc.checkDocumentKey(Self.key("", "not an mrz", "", "", "")) == "nfc.model.key.badMrz")
        #expect(ModelNfc.checkDocumentKey(Self.key("", "", "l898902c", "690806", "940623")) == nil)
        #expect(ModelNfc.checkDocumentKey(Self.key("", "", "L898902C", "690806", "")) == "nfc.eid.needKey")
        #expect(ModelNfc.checkDocumentKey(Self.key("", "", "L898902C", "69-08-06", "940623")) == "nfc.model.key.badDate")
        #expect(ModelNfc.checkDocumentKey(Self.key("123456", "", "L898902C", "690806", "940623")) == nil, "a CAN and the fields together")
    }

    @Test func theTypedKeyGoesIntoThisReadOnly() {
        let c = cmd("{\"op\":\"eid-read\",\"timeout\":30,\"args\":{\"readPhoto\":false}}")
        let k = ModelNfc.withDocumentKey(c, Self.key("123 456", "", "l898902c", "690806", "940623"))
        #expect(k.args.optString("can") == "123456")
        #expect(k.args.optString("documentNumber") == "L898902C")
        #expect(k.args.optString("dateOfBirth") == "690806")
        #expect(k.args["readPhoto"] == .bool(false))
        #expect(k.timeout == 30)
        #expect(!ModelNfc.needsDocumentKey(k))
        // The model's command is left as it was.
        #expect(!c.args.has("can"))
        #expect(ModelNfc.needsDocumentKey(c))
        // An MRZ wins over the fields.
        let m = ModelNfc.withDocumentKey(c, Self.key("", Doc.mrz, "X", "1", "2"))
        #expect(m.args.optString("mrz") == Doc.mrz)
        #expect(!m.args.has("documentNumber"))
    }

    @Test func theKeyNeverReachesTheAnswer() async {
        let can = "987654"
        // A chip that opens with BAC (the three fields) — the CAN typed beside them is not usable without PACE.
        let c = ModelNfc.withDocumentKey(cmd("{\"op\":\"eid-read\"}"), Self.key(can, "", "L898902C", "690806", "940623"))
        let r = await ModelNfc.run(c, FakeCard(NfcCatalog.isoDep, BacChip(Doc.key, Doc.files()), nil))
        #expect(r.optString("status") == "ok")
        #expect(r.optObject("mrtd")?.optString("access") == "bac")
        #expect(r.optObject("card")?.optString("tech") == "eid")
        #expect(!r.compact.contains(can))
        let keys = keysOf(.object(r))
        #expect(!keys.contains("args") && !keys.contains("can") && !keys.contains("key"))
        // A chip that refuses everything: auth-failed, and still no CAN.
        let f = await ModelNfc.run(ModelNfc.withDocumentKey(cmd("{\"op\":\"mrtd-read\"}"), Self.key(can, "", "", "", "")), FakeCard(NfcCatalog.isoDep, FnCard { _ in sw(0x6a82) }, nil))
        #expect(f.optString("status") == "auth-failed")
        #expect(!f.compact.contains(can))
        #expect(!keysOf(.object(f)).contains("args"))
        // Even a reader error that repeats it is blanked.
        let e = await ModelNfc.run(ModelNfc.withDocumentKey(cmd("{\"op\":\"eid-read\"}"), Self.key(can, "", "L898902C", "690806", "940623")),
                                   FakeCard(NfcCatalog.isoDep, FnCard { _ in throw CardFailure(message: "the chip said \(can)") }, nil))
        #expect(!e.compact.contains(can), "\(e.compact)")
    }

    @Test func theSheetSaysWhatIsAsked() {
        #expect(ModelNfc.whatKey("emv-read") == "nfc.model.what.emv")
        #expect(ModelNfc.whatKey("mrtd-read") == "nfc.model.what.eid")
        #expect(ModelNfc.whatKey("eid-read") == "nfc.model.what.eid")
        #expect(ModelNfc.whatKey("read-uid") == "nfc.model.what.uid")
        #expect(ModelNfc.whatKey("read-public") == "nfc.model.what.scan")
    }
}

@Suite struct ModelNfcConsentTests {
    static let pan = "4111111111111111"

    static func emvRead() async throws -> NfcJSONObject {
        let r = await ModelNfc.run(cmd("{\"op\":\"emv-read\",\"args\":{\"max_apps\":1,\"history\":false,\"deep\":false}}"), FakeCard(NfcCatalog.isoDep, visaCard(tracks: true), nil))
        #expect(r.optString("status") == "ok")
        #expect(r.optObject("emv")?.objects("apps").first?.optString("pan") == pan)
        return r
    }

    static func eidRead() async -> NfcJSONObject {
        let mrtd = await MrtdReader.read(BacChip(Doc.key, Doc.files()), MrtdReader.Options(mrz: Doc.mrz))
        return ["status": .string(MrtdReader.status(mrtd)), "mrtd": .object(mrtd), "message": "ERIKSSON L898902C read", "card": ["uid": "08112233", "tech": "eid"]]
    }

    static func en(_ k: String) -> String {
        switch k {
        case "nfc.consent.text": return "{model} read a card on this device. With your yes, it gets:"
        case "nfc.consent.aModel": return "A function"
        case "nfc.consent.emvApp": return "{app}: card number {pan}, expires {expiry}"
        case "nfc.consent.fullAdds": return "\"Send everything\" also sends:"
        case "nfc.consent.fullPan": return "the full card number and the track data (numbers: {n})"
        default: return k
        }
    }

    @Test func aPaymentCardsReadAsksAndListsWhatGoes() async throws {
        let r = try await Self.emvRead()
        let c = ModelNfc.consent(r)
        #expect(c.sensitive)
        #expect(c.masked[0].key == "nfc.consent.emvApp")
        #expect(c.masked[0].vars["pan"] == "411111••••••1111")
        #expect(c.masked[0].vars["app"]?.isEmpty == false)
        let fp = try #require(c.full.first { $0.key == "nfc.consent.fullPan" })
        #expect(fp.vars["n"] == "1")
        let text = ModelNfc.consentText(c, model: "Card checker", Self.en)
        #expect(text.hasPrefix("Card checker read a card on this device."))
        #expect(text.contains(": card number 411111••••••1111, expires 2029-12"))
        #expect(text.contains("\"Send everything\" also sends:\n• the full card number and the track data (numbers: 1)"))
        #expect(!text.contains(Self.pan), "the prompt itself shows no whole number")
        #expect(ModelNfc.consentText(c, model: " ", Self.en).hasPrefix("A function read a card"))
    }

    @Test func sendMaskedHoldsNoCardNumberAndNoTrackData() async throws {
        let r = try await Self.emvRead()
        let m = try #require(ModelNfc.masked(r))
        let all = m.compact
        #expect(!all.contains(Self.pan))
        #expect(!all.uppercased().contains(PanMask.asciiHex(Self.pan)), "not as ASCII hex either (Track 1)")
        #expect(!all.contains("987654321"), "the track's discretionary data")
        let app = try #require(m.optObject("emv")?.objects("apps").first)
        #expect(!app.has("pan"), "the PAN field goes")
        #expect(app.optString("panMasked") == "411111••••••1111")
        #expect(app.optString("expiry") == "2029-12", "the expiry stays")
        #expect(all.contains("411111XXXXXX1111"))
        // What the read found is still there for the model, just masked; the original is untouched.
        #expect(r.optObject("card") == m.optObject("card"))
        #expect(r.optObject("emv")?.objects("apps").first?.optString("pan") == Self.pan)
    }

    @Test func transcriptsMessagesAndRawDataAreMaskedOrWithheld() throws {
        let rec = H(T(0x70, T(0x5a, b(Self.pan)), T(0x57, b(Self.pan + "D2912201"))))
        let r: NfcJSONObject = ["status": "ok", "transcript": [["command": "00B2010C00", "response": .string(rec)]],
                                "data": .string(Data(b(rec)).base64EncodedString()), "message": .string("Card \(Self.pan) read")]
        let c = ModelNfc.consent(r)
        #expect(c.sensitive)
        #expect(c.masked.map(\.key) == ["nfc.consent.transcriptMasked"])
        #expect(c.full.map(\.key) == ["nfc.consent.dataPan"])
        let m = try #require(ModelNfc.masked(r))
        #expect(!m.compact.contains(Self.pan))
        #expect(!m.has("data"), "raw bytes with a card number are withheld")
        #expect(m.optString("message") == "Card 411111XXXXXX1111 read")
        // Raw bytes without a card number go (masked or not).
        let plain: NfcJSONObject = ["status": "ok", "data": .string(Data([1, 2, 3]).base64EncodedString())]
        let pc = ModelNfc.consent(plain)
        #expect(pc.masked.map(\.key) == ["nfc.consent.data"])
        #expect(pc.masked[0].vars["n"] == "3")
        #expect(ModelNfc.masked(plain)?.has("data") == true)
    }

    @Test func aDocumentGoesWithoutMrzPhotoDetailsOrFiles() async throws {
        let r = await Self.eidRead()
        let mrtd = try #require(r.optObject("mrtd"))
        #expect(mrtd.has("photo") && mrtd.has("personal") && mrtd.has("raw"))
        let c = ModelNfc.consent(r)
        #expect(c.sensitive)
        #expect(c.masked[0].key == "nfc.consent.holder")
        #expect(c.masked[0].vars["name"] == "ANNA MARIA ERIKSSON")
        #expect(c.masked[0].vars["doc"] == "•••••02C")
        for k in ["nfc.consent.mrz", "nfc.consent.images", "nfc.consent.details", "nfc.consent.files"] { #expect(c.full.map(\.key).contains(k), "\(k)") }
        let m = try #require(ModelNfc.masked(r))
        let mm = try #require(m.optObject("mrtd"))
        for gone in ["photo", "photoMime", "images", "personal", "document", "optional", "personsToNotify", "raw"] { #expect(!mm.has(gone), "\(gone)") }
        let z = try #require(mm.optObject("mrzInfo"))
        #expect(!z.has("mrz") && !z.has("optionalData"))
        #expect(z.optString("documentNumber") == "•••••02C")
        #expect(z.optString("surname") == "ERIKSSON")
        #expect(mm.optString("access") == mrtd.optString("access"))
        let all = m.compact
        #expect(!all.contains("L898902C"))
        #expect(!all.contains("ZE184226B"))
        #expect(m.optString("message") == "ERIKSSON •••••02C read")
    }

    @Test func dontSendTellsTheModelOnlyThatTheHolderSaidNo() async throws {
        let r = try await Self.emvRead()
        let d = ModelNfc.declined(r)
        #expect(d.optString("status") == "denied")
        #expect(d.optObject("card") == r.optObject("card"))
        #expect(!d.has("emv"))
        #expect(!d.compact.contains(Self.pan))
        #expect(!d.optString("message").isEmpty)
    }

    @Test func whatHoldsNoCardDataGoesWithoutAQuestion() {
        #expect(!ModelNfc.consent(ModelNfc.result("ok", ["uid": "04A1", "tech": "ntag21x"], nil)).sensitive)
        #expect(!ModelNfc.consent(ModelNfc.result("timeout", nil, "Cancelled")).sensitive)
        #expect(!ModelNfc.consent(["status": "ok", "mrtd": ["present": true, "access": "none"]]).sensitive)
        #expect(!ModelNfc.consent(nil).sensitive)
        // emv-public: the applications only — still the holder's card, so it asks (as the web does).
        let pub = ModelNfc.consent(["status": "ok", "emv": ["aids": ["A0000000031010"], "apps": []]])
        #expect(pub.sensitive)
        #expect(pub.masked[0].key == "nfc.consent.aids")
        #expect(pub.full.isEmpty)
    }
}
