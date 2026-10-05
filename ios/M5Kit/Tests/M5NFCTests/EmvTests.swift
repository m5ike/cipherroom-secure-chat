// The EMV reader against scripted cards — EmvReaderTest.java (test/nfc-emv.test.ts) and EmvDeepTest.java
// (test/nfc-emv-deep.test.ts): PPSE → SELECT AID → GET DATA → the log → GPO → READ RECORD and every
// other short file. Read-only: the cards fail the test on VERIFY, GENERATE AC or a write.

import Testing
import Foundation
@testable import M5NFC

@Suite struct EmvReaderTests {
    static let aidVisa = "A0000000031010", aidMc = "A0000000041010"

    static func visaRecord() -> [UInt8] {
        T(0x70, T(0x5a, b("4111111111111111")), T(0x5f24, b("291231")), T(0x57, b("4111111111111111D291220100000000000F")),
          T(0x5f20, ascii("VISA CARDHOLDER")), T(0x5f28, b("0203")), T(0x9f36, b("0005")), T(0x9f17, b("03")))
    }
    static func ppse() -> [UInt8] {
        T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, T(0x61, T(0x4f, b(aidVisa)), T(0x50, ascii("VISA")), T(0x87, u8(1))))))
    }
    static func aidFci(_ label: String) -> [UInt8] { T(0x6f, T(0x84, b(aidVisa)), T(0xa5, T(0x50, ascii(label)), T(0x9f38, b("9F66049F02069F3704")))) }
    static func gpo() -> [UInt8] { T(0x77, T(0x82, b("5C00")), T(0x94, b("08010100"))) }
    static func sel(_ cmd: [UInt8]) -> String { H(Bytes.slice(cmd, 5, 5 + Int(cmd[4]))) }
    static let ppseHex = H(ascii("2PAY.SYS.DDF01"))

    @Test func readsVisaViaPpse() async throws {
        let card = FnCard { cmd in
            let ins = Int(cmd[1]), p1 = Int(cmd[2]), p2 = Int(cmd[3])
            if ins == 0xa4 && p1 == 0x04 {
                let s = Self.sel(cmd)
                if s == Self.ppseHex { return ok(Self.ppse()) }
                if s == Self.aidVisa { return ok(Self.aidFci("VISA")) }
                return sw(0x6a82)
            }
            if cmd[0] == 0x80 && ins == 0xa8 { return ok(Self.gpo()) }
            if ins == 0xb2 { return p1 == 1 && p2 >> 3 == 1 ? ok(Self.visaRecord()) : sw(0x6a83) }
            if ins == 0x20 || (cmd[0] == 0x80 && ins == 0xae) { throw CardFailure(message: "the reader must never VERIFY a PIN or GENERATE AC") }
            return sw(0x6d00)
        }
        let d = await EmvReader.read(card, EmvReader.Options(maxApps: 4))
        #expect(d.strings("aids") == [Self.aidVisa])
        #expect(d.optString("scheme") == "Visa")
        let apps = d.objects("apps")
        #expect(apps.count == 1)
        let app = apps[0]
        #expect(app.optString("label") == "VISA")
        #expect(app.optString("pan") == "4111111111111111")
        #expect(app.optString("panMasked") == "411111••••••1111")
        #expect(app.optString("expiry") == "2029-12")
        #expect(app.optString("cardholder") == "VISA CARDHOLDER")
        #expect(app.optString("issuerCountry") == "Czechia")
        #expect(app.optInt("atc") == 5)
        #expect(app.optInt("pinTryCounter") == 3)
        #expect(app.objects("tags").first { $0.optString("tag") == "5A" }?.optString("name").contains("PAN") == true)
        #expect(EmvReader.summary(d).contains("411111••••••1111"))
    }

    @Test func recoversPanAndExpiryFromTrack2WhenNo5A() async {
        let rec = T(0x70, T(0x57, b("5555555555554444D2512201000000000F")))
        let card = FnCard { cmd in
            let ins = Int(cmd[1]), p1 = Int(cmd[2]), p2 = Int(cmd[3])
            if ins == 0xa4 && p1 == 0x04 {
                let s = Self.sel(cmd)
                if s == Self.ppseHex { return ok(Self.ppse()) }
                return s == Self.aidVisa ? ok(Self.aidFci("VISA")) : sw(0x6a82)
            }
            if cmd[0] == 0x80 && ins == 0xa8 { return ok(Self.gpo()) }
            if ins == 0xb2 { return p1 == 1 && p2 >> 3 == 1 ? ok(rec) : sw(0x6a83) }
            return sw(0x6d00)
        }
        let app = await EmvReader.read(card, EmvReader.Options(maxApps: 4)).objects("apps")[0]
        #expect(app.optString("pan") == "5555555555554444")
        #expect(app.optString("expiry") == "2025-12")
    }

    @Test func fallsBackToCandidateAidsWhenNoPpse() async {
        let card = FnCard { cmd in
            let ins = Int(cmd[1]), p1 = Int(cmd[2]), p2 = Int(cmd[3])
            if ins == 0xa4 && p1 == 0x04 {
                let s = Self.sel(cmd)
                if s == Self.ppseHex { return sw(0x6a82) }
                return s == Self.aidMc ? ok(Self.aidFci("MASTERCARD")) : sw(0x6a82)
            }
            if cmd[0] == 0x80 && ins == 0xa8 { return ok(Self.gpo()) }
            if ins == 0xb2 { return p1 == 1 && p2 >> 3 == 1 ? ok(Self.visaRecord()) : sw(0x6a83) }
            return sw(0x6d00)
        }
        let d = await EmvReader.read(card, EmvReader.Options(maxApps: 4))
        #expect(d.strings("aids").contains(Self.aidMc))
        let app = d.objects("apps")[0]
        #expect(app.optString("scheme") == "Mastercard")
        #expect(app.optString("label") == "MASTERCARD")
    }

    @Test func emptyForCardWithNoEmvApplication() async {
        let d = await EmvReader.read(FnCard { _ in sw(0x6a82) }, EmvReader.Options(maxApps: 4))
        #expect(d.arrayCount("apps") == 0)
        #expect(EmvReader.summary(d).contains("No EMV"))
    }
}

/// A scripted read-only card (EmvDeepTest.Card): logs every command, fails on a forbidden one.
final class EmvDeepCard: SimCard {
    static let aid = "A0000000041010"
    static let log: [[UInt8]] = [Sim.logRecord("250914", "183005", "000000012345", "BILLA", 41), Sim.logRecord("250912", "091500", "000000000990", "DPP", 40),
                                 [UInt8](repeating: 0, count: Sim.logFormat.count)] // an empty slot
    let logInFci: Bool
    let fci: [UInt8], ppse: [UInt8]
    let files: [(String, [UInt8])]

    init(logInFci: Bool) {
        self.logInFci = logInFci
        fci = T(0x6f, T(0x84, b(EmvDeepCard.aid)), T(0xa5, T(0x50, ascii("MASTERCARD")), T(0x9f38, b("9F1A02")), logInFci ? T(0xbf0c, T(0x9f4d, u8(0x0b, 0x03))) : []))
        ppse = T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, T(0x61, T(0x4f, b(EmvDeepCard.aid)), T(0x87, u8(1))))))
        files = [("1:1", T(0x70, T(0x5a, b("5413330089020011")), T(0x5f24, b("281231")), T(0x5f20, ascii("NOVAK/JAN")), T(0x5f28, b("0203")))),
                 ("2:1", T(0x70, T(0x8c, b("9F02069F03069F1A02")), T(0x8e, b("000000000000000042031E031F03")))),
                 ("3:1", T(0x70, T(0x9f08, b("0002")), T(0x5f30, b("0201")))), // not in the AFL — only a deep read finds it
                 ("3:2", T(0x70, T(0x9f42, b("0203"))))]
    }

    override func answer(_ cmd: [UInt8]) -> [UInt8] {
        let cla = Int(cmd[0]), ins = Int(cmd[1]), p1 = Int(cmd[2]), p2 = Int(cmd[3])
        if ins == 0xa4 && p1 == 0x04 {
            let s = H(SimCard.dataOf(cmd))
            if s == H(ascii("2PAY.SYS.DDF01")) { return ok(ppse) }
            return s == EmvDeepCard.aid ? ok(fci) : sw(0x6a82)
        }
        if cla == 0x80 && ins == 0xca {
            switch String(p1 << 8 | p2, radix: 16, uppercase: true) {
            case "9F4F": return ok(T(0x9f4f, Sim.logFormat))
            case "9F36": return ok(T(0x9f36, u8(0x00, 0x2a)))
            case "9F13": return ok(T(0x9f13, u8(0x00, 0x28)))
            case "9F17": return ok(T(0x9f17, u8(0x03)))
            case "9F4D" where !logInFci: return ok(T(0x9f4d, u8(0x0b, 0x03)))
            default: return sw(0x6a88)
            }
        }
        if cla == 0x80 && ins == 0xa8 { return ok(T(0x77, T(0x82, b("1980")), T(0x94, b("0801010010010100")))) }
        if ins == 0xb2 {
            let sfi = p2 >> 3
            if sfi == 0x0b { return p1 <= EmvDeepCard.log.count ? ok(EmvDeepCard.log[p1 - 1]) : sw(0x6a83) }
            if let f = files.first(where: { $0.0 == "\(sfi):\(p1)" }) { return ok(f.1) }
            if files.contains(where: { $0.0.hasPrefix("\(sfi):") }) { return sw(0x6a83) }
            return sw(0x6a82)
        }
        return sw(0x6d00)
    }

    func indexOf(_ prefix: String) -> Int { seen.firstIndex { $0.hasPrefix(prefix) } ?? -1 }
}

@Suite struct EmvDeepTests {
    static func recordKeys(_ app: NfcJSONObject, markLog: Bool) -> [String] {
        app.objects("records").map { "\($0.optInt("sfi")):\($0.optInt("record"))" + (markLog && $0.optBool("log") ? "L" : "") }
    }

    @Test func readsTheHistoryTheCountersAndEveryFile() async throws {
        let card = EmvDeepCard(logInFci: true)
        let d = await EmvReader.read(card)
        #expect(d.optBool("deep"))
        let app = try #require(d.objects("apps").first)
        #expect(app.optString("scheme") == "Mastercard")
        #expect(app.optString("pan") == "5413330089020011")
        #expect(app.optString("cardholder") == "NOVAK / JAN")
        #expect(app.optInt("atc") == 42)
        #expect(app.optInt("lastOnlineAtc") == 40)
        #expect(app.optInt("pinTryCounter") == 3)
        #expect(app.optString("aip") == "1980")
        #expect(app.optString("afl") == "0801010010010100")
        // The history, decoded by the card's log format; the empty slot is skipped.
        #expect(app.optInt("logSfi") == 11)
        #expect(app.optString("logFormat") == H(Sim.logFormat))
        let log = app.objects("log")
        #expect(log.count == 2)
        let e0 = log[0]
        #expect(e0.optString("date") == "2025-09-14")
        #expect(e0.optString("time") == "18:30:05")
        #expect(e0.optString("amount") == "123.45")
        #expect(e0.optString("currency") == "CZK")
        #expect(e0.optString("country") == "Czechia")
        #expect(e0.optString("type") == "purchase")
        #expect(e0.optString("merchant") == "BILLA")
        #expect(e0.optString("atc") == "41")
        #expect(e0.optString("raw") == H(EmvDeepCard.log[0]))
        #expect(log[1].optString("amount") == "9.90")
        #expect(log[1].optString("merchant") == "DPP")
        // Every record, including the file only a deep read finds (SFI 3) and the log's raw records.
        #expect(Self.recordKeys(app, markLog: true) == ["1:1", "2:1", "3:1", "3:2", "11:1L", "11:2L", "11:3L"])
        #expect(app.objects("tags").first { $0.optString("tag") == "9F08" }?.optString("hex") == "0002")
        // GET DATA answers are kept.
        #expect(app.objects("getData").map { $0.optString("tag") } == ["9F36", "9F13", "9F17", "9F4F"])
        // The log is read before GPO (outside a transaction).
        let firstLog = card.indexOf("00B2015C"), gpo = card.indexOf("80A8")
        #expect(firstLog > -1 && firstLog < gpo)
        #expect(d.optInt("apdus") > 10)
        #expect(EmvReader.summary(d).contains("2 transactions"))
        #expect(card.forbidden.isEmpty)
    }

    @Test func findsTheLogEntryByGetDataWhenTheFciDoesNotCarryIt() async {
        let d = await EmvReader.read(EmvDeepCard(logInFci: false))
        #expect(d.objects("apps")[0].arrayCount("log") == 2)
    }

    @Test func readsOnlyTheAflAndNoHistoryWhenAsked() async {
        let card = EmvDeepCard(logInFci: true)
        let d = await EmvReader.read(card, EmvReader.Options(history: false, deep: false))
        #expect(d.optBool("deep", true) == false)
        let app = d.objects("apps")[0]
        #expect(!app.has("log"))
        #expect(Self.recordKeys(app, markLog: false) == ["1:1", "2:1"])
        #expect(card.indexOf("00B2011C") == -1) // SFI 3 never read
    }

    @Test func decodesALogRecordByItsDol() {
        let dol = EmvReader.parseDol(Sim.logFormat)
        #expect(dol.count == 8)
        #expect(dol[6] == EmvReader.DolEntry("9F4E", 8))
        let e = EmvReader.parseLogRecord(EmvDeepCard.log[0], dol)
        #expect(e?.optString("date") == "2025-09-14")
        #expect(e?.optString("amount") == "123.45")
        #expect(e?.optString("currency") == "CZK")
        #expect(e?.optString("merchant") == "BILLA")
        #expect(e?.optString("raw") == H(EmvDeepCard.log[0]))
        #expect(EmvReader.parseLogRecord([UInt8](repeating: 0, count: 10), [EmvReader.DolEntry("9A", 3)]) == nil)
        #expect(EmvReader.parseLogRecord(fill(10, 0xff), [EmvReader.DolEntry("9A", 3)]) == nil)
    }

    @Test func passesTheOpArgsThroughToTheRead() async throws {
        let r = try #require(await CardOps.readResult("emv-read", EmvDeepCard(logInFci: true), ["maxApps": 2, "history": false, "deep": false]))
        #expect(r.optString("status") == "ok")
        let emv = try #require(r.optObject("emv"))
        #expect(emv.optBool("deep", true) == false)
        #expect(!emv.objects("apps")[0].has("log"))
        #expect(r.optString("message").contains("Mastercard"))
        // Defaults: deep, with the history.
        let full = try #require(await CardOps.readResult("emv-read", EmvDeepCard(logInFci: true), nil)?.optObject("emv"))
        #expect(full.optBool("deep"))
        #expect(full.objects("apps")[0].arrayCount("log") == 2)
        #expect(await CardOps.readResult("ndef-read", EmvDeepCard(logInFci: true), nil) == nil)
    }

    @Test func emvPublicListsTheApplications() async throws {
        let out = try await CardOps.emvPublic(EmvSim(ppse: true, pse: false, "A0000000031010", "A0000000041010"))
        #expect(out.objects("applications").map { $0.optString("aid") } == ["A0000000031010", "A0000000041010"])
        #expect(out.objects("applications").map { $0.optString("label") } == ["VISA CREDIT", "MASTERCARD"])
        let none = try await CardOps.emvPublic(EmvSim(ppse: false, pse: false))
        #expect(none.optString("ppse") == "no-ppse")
    }
}
