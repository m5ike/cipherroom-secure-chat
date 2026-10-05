// NDEF and the tag layouts (NfcWriteTest.java, ndef.ts), the catalogue (NfcCatalogTest.java), technology
// detection (TagTechTest.java + the iOS mapping), the iOS limits as capability flags, the Info.plist AIDs
// (README.md's JSON = IOSAids), DESFire's public info, the Type 4 tag emulation (CardService.java) and the
// card reports (test/nfc-card-report.test.ts).

import Testing
import Foundation
@testable import M5NFC

@Suite struct NdefTests {
    @Test func tlvShortAndLong() {
        #expect(Ndef.ndefTlv([0x11, 0x22, 0x33]) == [0x03, 0x03, 0x11, 0x22, 0x33, 0xfe])
        let long = Ndef.ndefTlv([UInt8](repeating: 0x5a, count: 255))
        #expect(Array(long.prefix(5)) == [0x03, 0xff, 0x00, 0xff, 0x5a])
        #expect(long.last == 0xfe && long.count == 1 + 3 + 255 + 1)
        let below = Ndef.ndefTlv([UInt8](repeating: 0, count: 254))
        #expect(below[1] == 254 && below.count == 1 + 1 + 254 + 1)
    }

    @Test func classicSectorsCapacityAndMad() {
        #expect(MifareClassicLayout.ndefDataSectors(16) == Array(1...15))
        let s4k = MifareClassicLayout.ndefDataSectors(40)
        #expect(s4k.count == 38 && !s4k.contains(0) && !s4k.contains(16) && s4k.first == 1 && s4k.last == 39)
        #expect(MifareClassicLayout.dataCapacity(5) == 192)
        #expect(MifareClassicLayout.dataCapacity(16) == 720)
        #expect(MifareClassicLayout.dataCapacity(40) == 3360)
        #expect([0, 31, 32, 39].map(MifareClassicLayout.blocksInSector) == [4, 4, 16, 16])
        var madData = [UInt8](repeating: 0, count: 31)
        madData[0] = 0x01
        for i in 0..<15 { madData[1 + 2 * i] = 0x03; madData[2 + 2 * i] = 0xe1 }
        #expect(MifareClassicLayout.crc(madData) == 0x14)
        let full = MifareClassicLayout.mad1((0..<16).map { $0 >= 1 })
        #expect(full[0] == 0x14 && full[1] == 0x01 && full.count == 32)
        for s in 1...15 { #expect(full[2 * s] == 0x03 && full[2 * s + 1] == 0xe1) }
        var used = [Bool](repeating: false, count: 16)
        used[1] = true; used[2] = true
        let part = MifareClassicLayout.mad1(used)
        #expect(Array(part[2..<8]) == [0x03, 0xe1, 0x03, 0xe1, 0x00, 0x00])
        #expect(part[0] != 0x14)
        var used4k = [Bool](repeating: false, count: 40)
        used4k[17] = true; used4k[39] = true
        let mad2 = MifareClassicLayout.mad2(used4k, sectorCount: 40)
        #expect(mad2.count == 48 && mad2[1] == 0 && mad2[2] == 0x03 && mad2[3] == 0xe1 && mad2[4] == 0 && mad2[46] == 0x03 && mad2[47] == 0xe1)
        #expect(MifareClassicLayout.keyDictionary("A0A1A2A3A4A5, d3:f7:d3:f7:d3:f7; zz FFFFFFFFFFFF") == [MifareClassicLayout.factoryKey, MifareClassicLayout.madKeyA, MifareClassicLayout.ndefKeyA])
    }

    @Test func messagesRoundTripAndDecode() throws {
        let recs = [try Ndef.textRecord("Ahoj světe", lang: "cs"), Ndef.uriRecord("https://m5cet.cz/x"), Ndef.mimeRecord("text/plain", [0x41]),
                    Ndef.externalRecord("M5cet.cz:card", [1, 2]), try Ndef.smartPosterRecord("https://a.cz", titles: [("A", "en")], action: 1),
                    Ndef.mimeRecord("application/octet-stream", [UInt8](repeating: 7, count: 300))]
        let bytes = try Ndef.encodeMessage(recs)
        let back = try Ndef.decodeMessage(bytes)
        #expect(back == recs.map { var r = $0; if r.tnf == Tnf.external.rawValue { r.type = Array("m5cet.cz:card".utf8) }; return r })
        #expect(Ndef.decodeRecord(back[0]) == .text(text: "Ahoj světe", lang: "cs", utf16: false))
        #expect(Ndef.decodeRecord(back[1]) == .uri("https://m5cet.cz/x"))
        #expect(back[1].payload.first == 4) // "https://"
        #expect(Ndef.decodeRecord(back[4]) == .smartPoster(uri: "https://a.cz", titles: ["A"], action: 1))
        #expect(Ndef.decodeRecord(try Ndef.textRecord("žluť", utf16: true)) == .text(text: "žluť", lang: "en", utf16: true))
        #expect(Ndef.describe(back[2]) == "MIME text/plain (1 B)")
        #expect(try Ndef.encodeMessage([]) == [0xd0, 0x00, 0x00])
        #expect(throws: NfcError.self) { try Ndef.decodeMessage([0x91, 0x01, 0x05, 0x54]) } // truncated
        #expect(throws: NfcError.self) { try Ndef.decodeMessage([0x11, 0x01, 0x00, 0x54]) } // no MB
        // A chunked record is joined.
        let chunked: [UInt8] = [0xb2, 0x0a, 0x02] + Array("text/plain".utf8) + [0x41, 0x42] + [0x56, 0x00, 0x01, 0x43]
        #expect(try Ndef.decodeMessage(chunked).first?.payload == [0x41, 0x42, 0x43])
    }

    @Test func type2AndType4Layouts() throws {
        #expect(Ndef.parseT2Cc([0xe1, 0x10, 0x3e, 0x00]) == Ndef.T2Capability(version: "1.0", dataBytes: 496, readOnly: false))
        #expect(Ndef.parseT2Cc([0x00, 0x10, 0x3e, 0x00]) == nil)
        let ndef = try Ndef.encodeMessage([Ndef.uriRecord("https://a.cz")])
        #expect(Ndef.extractT2Ndef([0x00] + Ndef.ndefTlv(ndef) + [0, 0]) == ndef)
        let pages = try Ndef.t2WritePages(ndef, capacity: 48, writeCc: true)
        #expect(pages[0].page == 3 && pages[0].data == [0xe1, 0x10, 0x06, 0x00])
        #expect(pages[1].page == 4 && pages.dropFirst().flatMap(\.data).starts(with: Ndef.ndefTlv(ndef)))
        #expect(throws: NfcError.self) { try Ndef.t2WritePages([UInt8](repeating: 0, count: 100), capacity: 48, writeCc: false) }
        #expect(Ndef.t4tCc().count == 15)
        #expect(Ndef.t4tNdefFile([1, 2, 3]) == [0, 3, 1, 2, 3])
    }

    /// CardService.java: the phone as a Type 4 tag, read the way a reader reads one.
    @Test func theType4TagEmulationServesTheCardReadOnly() throws {
        let body = TagVectors.v.optObject("invite")!.optString("body")
        var tag = try Type4TagEmulator.connection(body)
        #expect(tag.process(b("00A4040007D276000085010100")) == sw(0x9000))
        #expect(tag.process(b("00A4000C02E103")) == sw(0x9000))
        let cc = tag.process(b("00B000000F"))
        #expect(cc.count == 17 && cc[0] == 0x00 && cc[1] == 0x0f && Array(cc[9..<11]) == [0xe1, 0x04])
        #expect(tag.process(b("00A4000C02E104")) == sw(0x9000))
        let nlen = tag.process(b("00B0000002"))
        let len = Int(nlen[0]) << 8 | Int(nlen[1])
        var msg = [UInt8]()
        var off = 2
        while msg.count < len {
            let r = tag.process(Apdu.readBinary(off, le: min(0xf0, len - msg.count)))
            #expect(Array(r.suffix(2)) == sw(0x9000))
            msg += r.dropLast(2)
            off += r.count - 2
        }
        #expect(ConnectionCard.body(of: try Ndef.decodeMessage(msg)) == body)
        #expect(tag.process(b("00D6000001FF")) == sw(0x6d00)) // nothing is writable
        #expect(tag.process(b("00B0FFFF01")) == sw(0x6b00))
        tag.serve(nil)
        #expect(tag.process(b("00A4040007D276000085010100")) == sw(0x6a82))
    }
}

@Suite struct CatalogTests {
    static func ids(_ tech: String) -> Set<String> { Set(NfcCatalog.ops(for: tech).map(\.id)) }

    @Test func everyTechCarriesTheCommonOps() {
        for t in NfcCatalog.catalog where t.tech != NfcCatalog.unknown { #expect(Self.ids(t.tech).isSuperset(of: ["scan", "read-uid", "read-public"]), "\(t.tech)") }
    }

    @Test func theOpsOfEachTechnology() {
        #expect(Self.ids(NfcCatalog.ndef).isSuperset(of: ["ndef-read", "ndef-write", "ndef-lock"]))
        #expect(Self.ids(NfcCatalog.mifareClassic1k).isSuperset(of: ["classic-read", "classic-write", "classic-dump", "classic-restore", "write-uid"]))
        #expect(NfcCatalog.supportsOp(NfcCatalog.mifareClassic4k, "classic-dump"))
        #expect(!NfcCatalog.supportsOp(NfcCatalog.ndef, "classic-read"))
        #expect(Self.ids(NfcCatalog.m5cetCard).isSuperset(of: ["m5-read", "m5-write", "m5-erase", "m5-emulate"]))
        #expect(NfcCatalog.supportsOp(NfcCatalog.emv, "emv-public") && NfcCatalog.supportsOp(NfcCatalog.eid, "eid-public"))
        #expect(!NfcCatalog.supportsOp(NfcCatalog.emv, "classic-write"))
        #expect(NfcCatalog.findOp(NfcCatalog.emv, "emv-read")?.kind == "read")
        #expect(NfcCatalog.findOp(NfcCatalog.eid, "eid-read")?.needs == "key")
        #expect(NfcCatalog.techInfo("no-such-tech").tech == NfcCatalog.unknown)
        #expect(NfcCatalog.ops(for: "no-such-tech").isEmpty)
        #expect(Set(NfcCatalog.readers.map(\.kind)) == ["internal", "usb", "bluetooth", "serial"])
    }

    @Test func androidTechListsMapAsOnTheWeb() {
        let desfireAts: [UInt8] = [0x06, 0x75, 0x77, 0x81, 0x02, 0x80]
        #expect(TagTech.map(techs: ["NfcA", "MifareClassic", "Ndef"], sak: 0x08, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.mifareClassic1k)
        #expect(TagTech.map(techs: ["NfcA", "MifareClassic"], sak: 0x18, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.mifareClassic4k)
        #expect(TagTech.map(techs: ["NfcA", "MifareClassic"], sak: 0x09, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.mifareClassicMini)
        #expect(TagTech.map(techs: ["NfcA"], sak: 0x00, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.mifareUltralight)
        #expect(TagTech.map(techs: ["NfcA", "IsoDep"], sak: 0x20, ats: desfireAts, connectionTag: false, m5cetCard: false) == NfcCatalog.mifareDesfire)
        #expect(TagTech.map(techs: ["NfcA", "IsoDep"], sak: 0x20, ats: [0x78, 0x80], connectionTag: false, m5cetCard: false) == NfcCatalog.isoDep)
        #expect(TagTech.map(techs: ["NfcF"], sak: -1, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.felica)
        #expect(TagTech.map(techs: ["NfcV"], sak: -1, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.iso15693)
        #expect(TagTech.map(techs: ["Ndef", "NdefFormatable"], sak: -1, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.ndef)
        #expect(TagTech.map(techs: ["NfcB"], sak: -1, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.iso14443b)
        #expect(TagTech.map(techs: ["NfcA"], sak: 0x28, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.isoDep)
        #expect(TagTech.map(techs: ["NfcA"], sak: 0x04, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.iso14443a)
        #expect(TagTech.map(techs: ["Ndef"], sak: -1, ats: nil, connectionTag: true, m5cetCard: true) == NfcCatalog.m5cetCard)
        #expect(TagTech.map(techs: ["NfcA", "Ndef"], sak: 0, ats: nil, connectionTag: true, m5cetCard: false) == NfcCatalog.connectionTag)
        #expect(TagTech.map(techs: [], sak: -1, ats: nil, connectionTag: false, m5cetCard: false) == NfcCatalog.unknown)
        #expect(TagTech.isDesfireAts(desfireAts) && TagTech.isDesfireAts([0x75, 0x77, 0x81, 0x02, 0x80]))
        #expect(!TagTech.isDesfireAts([0x11, 0x22]) && !TagTech.isDesfireAts(nil))
    }

    @Test func coreNfcTagsMapToTheCatalogue() {
        #expect(TagTech.map(ios: .iso7816(initialSelectedAid: "A0000002471001", historicalBytes: nil, applicationData: nil)) == NfcCatalog.eid)
        #expect(TagTech.map(ios: .iso7816(initialSelectedAid: "A0000000041010", historicalBytes: nil, applicationData: nil)) == NfcCatalog.emv)
        #expect(TagTech.map(ios: .iso7816(initialSelectedAid: "D2760000850101", historicalBytes: nil, applicationData: nil)) == NfcCatalog.ndef)
        #expect(TagTech.map(ios: .iso7816(initialSelectedAid: "F000000001", historicalBytes: nil, applicationData: nil)) == NfcCatalog.isoDep)
        #expect(TagTech.map(ios: .miFare(family: "desfire", historicalBytes: nil)) == NfcCatalog.mifareDesfire)
        #expect(TagTech.map(ios: .miFare(family: "ultralight", historicalBytes: nil), ntag: true) == NfcCatalog.ntag21x)
        #expect(TagTech.map(ios: .miFare(family: "ultralight", historicalBytes: nil)) == NfcCatalog.mifareUltralight)
        #expect(TagTech.map(ios: .feliCa) == NfcCatalog.felica)
        #expect(TagTech.map(ios: .iso15693) == NfcCatalog.iso15693)
        #expect(TagTech.looksNtag(getVersion: b("0004040201000F03")))
    }

    /// What iOS cannot do is flagged, never faked: the iPhone's Core NFC, the iPad / watch without NFC, Android's reference.
    @Test func theIosLimitsAreCapabilityFlags() {
        let iphone = NfcCapabilities.coreNFCiPhone
        for missing in [NfcCapabilities.mifareClassic, .rawFrames, .emulation, .paymentAids] { #expect(!iphone.contains(missing)) }
        #expect(NfcPlatform.limit(op: "classic-read", tech: NfcCatalog.mifareClassic1k, capabilities: iphone)?.contains("MIFARE Classic") == true)
        #expect(NfcPlatform.limit(op: "write-uid", tech: NfcCatalog.mifareClassic1k, capabilities: iphone) != nil)
        #expect(NfcPlatform.limit(op: "m5-emulate", tech: NfcCatalog.m5cetCard, capabilities: iphone)?.contains("HCE") == true)
        #expect(NfcPlatform.limit(op: "m5-emulate", tech: NfcCatalog.m5cetCard, capabilities: iphone.union(.emulation)) == nil)
        #expect(NfcPlatform.limit(op: "emv-read", tech: NfcCatalog.emv, capabilities: iphone)?.contains("payment") == true)
        #expect(NfcPlatform.limit(op: "eid-read", tech: NfcCatalog.eid, capabilities: iphone) == nil)
        #expect(NfcPlatform.limit(op: "ndef-write", tech: NfcCatalog.ndef, capabilities: iphone) == nil)
        #expect(NfcPlatform.limit(op: "scan", tech: NfcCatalog.ndef, capabilities: .none) == nil)
        #expect(NfcPlatform.limit(op: "ndef-read", tech: NfcCatalog.ndef, capabilities: .none)?.contains("no NFC") == true)
        let classicOps = NfcPlatform.ops(for: NfcCatalog.mifareClassic1k, capabilities: iphone).map(\.id)
        #expect(classicOps.contains("ndef-read") && !classicOps.contains("classic-read") && !classicOps.contains("write-uid"))
        #expect(NfcPlatform.ops(for: NfcCatalog.mifareClassic1k, capabilities: .android).count == NfcCatalog.ops(for: NfcCatalog.mifareClassic1k).count)
        let techs = NfcPlatform.technologies(capabilities: iphone)
        #expect(!techs.contains(NfcCatalog.mifareClassic1k) && !techs.contains(NfcCatalog.emv) && techs.contains(NfcCatalog.eid) && techs.contains(NfcCatalog.mifareDesfire))
        #expect(NfcPlatform.technologies(capabilities: .none).isEmpty)
        // Templates: an EMV template needs payment AIDs; e-ID, DESFire and ISO 7816 run on an iPhone.
        let byCard = Dictionary(grouping: ApduTemplates.parse(Templates.standard), by: \.cardType)
        #expect(byCard["emv"]!.allSatisfy { !NfcPlatform.templateRuns($0, capabilities: iphone) })
        #expect(byCard["emv"]!.allSatisfy { NfcPlatform.templateRuns($0, capabilities: .android) })
        for card in ["emrtd", "desfire", "iso7816"] { #expect(byCard[card]!.allSatisfy { NfcPlatform.templateRuns($0, capabilities: iphone) }, "\(card)") }
        #expect(!NfcPlatform.templateRuns(byCard["emrtd"]![0], capabilities: .none))
    }

    /// A raw-frame or MIFARE call on a transport without it says so (the iOS default).
    @Test func transportDefaultsRefuseWhatIsMissing() async throws {
        final class AidOnly: CardTransport, @unchecked Sendable {
            var capabilities: NfcCapabilities { [.iso7816] }
            func identify() async throws -> CardIdentity { CardIdentity(uid: "04", tech: NfcCatalog.eid) }
            func transmit(_ apdu: [UInt8]) async throws -> [UInt8] { sw(0x9000) }
        }
        let t = AidOnly()
        await #expect(throws: NfcError.self) { _ = try await t.rawFrame([0x40]) }
        await #expect(throws: NfcError.self) { _ = try await t.mifareCommand([0x30, 0x00]) }
        await #expect(throws: NfcError.self) { _ = try await CardOps.ultralightRead(t) }
        #expect(try await t.readNdef() == nil)
        let id = try await t.identify()
        #expect(id.json.optString("label") == "Electronic ID / MRTD")
        let card = TransportCard(t, identity: id)
        #expect(try await card.ndef() == nil)
        #expect(try await card.isoDep() != nil)
        #expect(!card.autoSelectsAid)
    }

    @Test func ultralightPagesThroughMifareCommands() async throws {
        final class Ntag: CardTransport, @unchecked Sendable {
            let memory: [UInt8] = (0..<(45 * 4)).map { UInt8($0 & 0xff) }
            var capabilities: NfcCapabilities { .coreNFCiPhone }
            func identify() async throws -> CardIdentity { CardIdentity(uid: "04A1", tech: NfcCatalog.ntag21x) }
            func transmit(_ apdu: [UInt8]) async throws -> [UInt8] { sw(0x6d00) }
            func mifareCommand(_ f: [UInt8]) async throws -> [UInt8] {
                guard f.first == 0x30, Int(f[1]) * 4 < memory.count else { throw NfcError.io("NAK") }
                return (0..<16).map { memory[(Int(f[1]) * 4 + $0) % memory.count] }
            }
        }
        let r = try await CardOps.ultralightRead(Ntag())
        #expect(r.optInt("pageCount") == 48)
        #expect(r.strings("pages")[1] == "04050607")
    }
}

@Suite struct DesfireTests {
    @Test func readsThePublicInformation() async throws {
        let info = try await Desfire.readInfo(DesfireSim())
        let v = try #require(info.optObject("version"))
        #expect(v.optString("vendor") == "NXP")
        #expect(v.optString("product") == "MIFARE DESFire EV1")
        #expect(v.optString("storage") == "8 KB")
        #expect(v.optString("software") == "1.4")
        #expect(v.optString("uid") == "04112233445566")
        #expect(v.optString("produced") == "2019-W12")
        #expect(info.strings("applications") == ["123456", "0B0C0D"])
        #expect(info.optInt("freeMemory") == 4096)
        #expect(info.optObject("keySettings")?.optString("crypto") == "AES")
        #expect(info.optObject("keySettings")?.optInt("keys") == 1)
    }

    @Test func onlyReadsGoToTheCard() async {
        let card = DesfireSim()
        await #expect(throws: NfcError.self) { _ = try await Desfire.command(card, 0xfc) } // FormatPICC
        #expect(card.seen.isEmpty)
        #expect(Desfire.wrap(0x6a) == b("906A000000"))
        #expect(Desfire.storageText(0x17) == "2 KB – 4 KB")
        #expect(Desfire.product(type: 0x08, major: 0x30) == "MIFARE DESFire Light")
    }
}

@Suite struct IOSAidsTests {
    /// The JSON the app copies (README.md) is the Swift constant.
    @Test func theReadmeListsExactlyTheExportedAids() throws {
        let readme = try Repo.text("ios/M5Kit/Sources/M5NFC/README.md")
        let start = try #require(readme.range(of: "<!-- aids:begin -->"))
        let end = try #require(readme.range(of: "<!-- aids:end -->"))
        let block = readme[start.upperBound..<end.lowerBound].replacingOccurrences(of: "```json", with: "").replacingOccurrences(of: "```", with: "")
        #expect(try NfcJSON.parse(block).arrayValue?.map(\.jsString) == IOSAids.infoPlist)
        #expect(JSText.trim(String(block)) == IOSAids.json)
    }

    /// Core NFC refuses SELECT of an unlisted AID: every AID the readers select is listed.
    @Test func everyAidTheReadersSelectIsListed() throws {
        for aid in IOSAids.selectedByCode { #expect(IOSAids.infoPlist.contains(aid), "\(aid)") }
        for t in ApduTemplates.parse(Templates.standard) where !t.aid.isEmpty { #expect(IOSAids.infoPlist.contains(t.aid), "\(t.label)") }
        #expect(Set(IOSAids.infoPlist).count == IOSAids.infoPlist.count)
        for a in IOSAids.infoPlist { #expect(a.fullMatch("([0-9A-F]{2}){5,16}"), "\(a)") }
        #expect(IOSAids.documents == ["A0000002471001", "D2760000850101", "D2760000850100"])
        #expect(IOSAids.infoPlist.first == "A0000002471001")
    }

    /// The list the app's Info.plist carries (ios/M5cet, merged from android_application) — when present, the same set.
    @Test func theAppsInfoPlistListsTheSameAids() throws {
        let plist = Repo.root.appendingPathComponent("ios/M5cet/Resources/Info.plist")
        guard let data = try? Data(contentsOf: plist) else { return } // the app is not in this checkout
        let p = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let listed = try #require(p["com.apple.developer.nfc.readersession.iso7816.select-identifiers"] as? [String])
        #expect(Set(listed.map { $0.uppercased() }) == Set(IOSAids.infoPlist))
        #expect(listed.count == IOSAids.infoPlist.count)
    }
}

@Suite struct CardReportTests {
    static let jpegB64 = Data([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).base64EncodedString()
    static let jp2B64 = Data([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20]).base64EncodedString()
    static func fromB64(_ s: String) -> String { String(decoding: Data(base64Encoded: s)!, as: UTF8.self) }

    static let emv: NfcJSON = [
        "scheme": "Mastercard", "aids": ["A0000000041010"], "deep": true, "apdus": 57,
        "apps": [[
            "aid": "A0000000041010", "label": "MASTERCARD", "scheme": "Mastercard", "pan": "5413330089020011", "panMasked": "541333••••••0011", "expiry": "2028-12",
            "cardholder": "<script>alert(1)</script>", "issuerCountry": "Czechia", "atc": 42, "lastOnlineAtc": 40, "pinTryCounter": 3, "aip": "1980", "afl": "08010100", "logSfi": 11, "logFormat": "9A03",
            "log": [["date": "2025-09-14", "time": "18:30:05", "amount": "123.45", "currency": "CZK", "merchant": "BILLA & CO", "type": "purchase", "atc": "41", "raw": "250914"],
                    ["date": "2025-09-12", "amount": "9.90", "currency": "CZK", "merchant": "DPP", "raw": "250912"]],
            "tags": [["tag": "5A", "name": "Application PAN", "value": "5413330089020011", "hex": "5413330089020011"], ["tag": "50", "name": "Application label", "value": "MASTERCARD", "hex": "4D415354455243415244"]],
            "getData": [["tag": "9F36", "name": "Application transaction counter (ATC)", "value": "42", "hex": "002A"]],
            "records": [["sfi": 1, "record": 1, "hex": "70125A085413330089020011"], ["sfi": 11, "record": 1, "hex": "250914", "log": true]],
        ]],
    ]
    static var emvResult: NfcJSON { ["status": "ok", "card": ["uid": "08A1B2C3", "tech": "emv", "label": "EMV payment card"], "emv": emv] }

    static let mrtd: NfcJSON = [
        "present": true, "access": "pace", "pace": ["supported": true, "protocol": "PACE ECDH-GM AES-128", "parameterId": 13, "used": true, "password": "can"],
        "dataGroups": ["DG1", "DG2", "DG7", "DG11"], "ldsVersion": "1.7",
        "mrzInfo": ["documentCode": "ID", "documentNumber": "L898902C", "issuer": "UTO", "nationality": "UTO", "surname": "ERIKSSON", "givenNames": "ANNA MARIA", "dateOfBirth": "1969-08-06",
                    "sex": "F", "dateOfExpiry": "2031-06-23", "mrz": "I<UTOL898902C<3<<<<<<<<<<<<<<<6908061F3106236UTO<<<<<<<<<<<0ERIKSSON<<ANNA<MARIA<<<<<<<<<<"],
        "personal": ["fullName": "ERIKSSON, ANNA MARIA", "placeOfBirth": "ZENITH"],
        "images": [["group": "DG2", "kind": "face", "mime": "image/jpeg", "data": .string(jpegB64), "name": "face.jpg"],
                   ["group": "DG7", "kind": "signature", "mime": "image/jp2", "data": .string(jp2B64), "name": "signature.jp2"]],
        "files": [["name": "DG1", "fid": "0101", "status": "read", "size": 93, "hashOk": true], ["name": "DG3", "fid": "0103", "status": "protected"]],
        "raw": [["name": "EF.SOD.bin", "mime": "application/octet-stream", "data": "AAEC"]],
        "security": ["passive": "ok", "hashAlgorithm": "SHA-256", "signer": ["subject": "C=UT, CN=DS", "issuer": "C=UT, CN=CSCA", "notBefore": "2024-01-01", "notAfter": "2034-01-01"], "protocols": ["PACE ECDH-GM AES-128"]],
    ]

    @Test func emvAsHtmlPanMaskedCardTextEscaped() {
        let r = CardReport.report(Self.emvResult, format: "html")
        #expect(r.kind == "emv" && r.mime == "text/html")
        let html = r.text
        #expect(html.contains("class=\"m5h-report m5h-report--emv\""))
        #expect(html.contains("541333••••••0011"))
        #expect(!html.contains("5413330089020011"))
        #expect(html.contains("541333XXXXXX0011")) // inside the records' hex too
        #expect(!html.contains("<script>"))
        #expect(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"))
        #expect(html.contains("BILLA &amp; CO"))
        #expect(html.contains("Transaction history — MASTERCARD (2)"))
        #expect(html.contains("<details"))
        #expect(r.title == "Mastercard · 541333••••••0011")
        #expect(r.files.map(\.name) == ["emv-history.csv", "emv-records.txt"])
        let csv = Self.fromB64(r.files[0].data)
        #expect(csv.components(separatedBy: "\r\n")[0] == "application,date,time,amount,currency,merchant,type,country,atc,result,raw")
        #expect(csv.contains("MASTERCARD,2025-09-14,18:30:05,123.45,CZK,BILLA & CO,purchase,,41,,250914"))
        #expect(!Self.fromB64(r.files[1].data).contains("5413330089020011"))
        #expect(CardReport.report(Self.emvResult, format: "html", options: CardReport.Options(fullPan: true)).text.contains("5413330089020011"))
    }

    @Test func emvAsObjectRowsJsonTextAndCsv() throws {
        let obj = try #require(CardReport.report(Self.emvResult, format: "object").value.objectValue)
        #expect(obj.optString("type") == "emv")
        #expect(obj.objects("applications")[0].arrayCount("history") == 2)
        #expect(obj.objects("applications")[0].optString("pan") == "541333••••••0011")
        #expect(obj.optObject("card")?.optString("uid") == "08A1B2C3")
        let rows = CardReport.rows(Self.emvResult)
        #expect(rows.contains(CardReport.Row(section: "Application — MASTERCARD", field: "Transactions (ATC)", value: "42")))
        #expect(rows.contains { $0.section.hasPrefix("Transaction history") && $0.value.contains("123.45") })
        #expect(CardReport.report(Self.emvResult, format: "array").value.arrayValue?.count == rows.count)
        let json = try NfcJSON.parse(CardReport.report(Self.emvResult, format: "json").text)
        #expect(json["applications"]?[0]?["label"]?.stringValue == "MASTERCARD")
        let text = CardReport.report(Self.emvResult, format: "text").text
        #expect(text.components(separatedBy: "\n")[0] == "Mastercard · 541333••••••0011")
        #expect(text.fullMatch("(?s).*Date\\s+Time\\s+Amount.*"))
        let csv = CardReport.report(Self.emvResult, format: "csv").text
        #expect(csv.hasPrefix("section,field,value\r\n"))
        #expect(csv.contains("123.45 · CZK · BILLA & CO"))
    }

    @Test func formatsBareInputsHistoryAndCzech() {
        #expect(CardReport.formats == ["html", "object", "array", "json", "text", "csv"])
        #expect(CardReport.report(Self.emv, format: "text").kind == "emv")
        #expect(CardReport.report(Self.emv, format: "bogus").format == "html")
        #expect(CardReport.history(Self.emvResult).map { [$0.optString("application"), $0.optString("amount")] } == [["MASTERCARD", "123.45"], ["MASTERCARD", "9.90"]])
        let cs = CardReport.report(Self.emvResult, format: "html", options: CardReport.Options(lang: "cs")).text
        #expect(cs.contains("Historie transakcí") && cs.contains("Číslo karty"))
        #expect(CardReport.report(Self.emvResult, format: "text", options: CardReport.Options(lang: "sk")).text.contains("Číslo karty")) // sk → cs
    }

    @Test func eidShowsTheFaceInlineAndOffersJpeg2000AsAFile() {
        let r = CardReport.report(["status": "ok", "mrtd": Self.mrtd], format: "html")
        #expect(r.kind == "mrtd")
        #expect(r.title == "ID card · ANNA MARIA ERIKSSON")
        let html = r.text
        #expect(html.contains("<img src=\"data:image/jpeg;base64,\(Self.jpegB64)\""))
        #expect(!html.contains("data:image/jp2"))
        #expect(html.contains("JPEG 2000"))
        #expect(html.contains("m5h-badge--ok"))
        #expect(html.contains("PACE (CAN)"))
        #expect(html.contains("ERIKSSON, ANNA MARIA"))
        #expect(r.images.map(\.name) == ["face.jpg"])
        #expect(r.files.map(\.name) == ["signature.jp2", "EF.SOD.bin"])
        #expect(CardReport.images(["mrtd": Self.mrtd]).map(\.mime) == ["image/jpeg", "image/jp2"])
        let bare = CardReport.report(Self.mrtd, format: "html", options: CardReport.Options(attachments: false, images: false))
        #expect(bare.images.isEmpty && bare.files.isEmpty && !bare.text.contains("<img"))
        let text = CardReport.report(Self.mrtd, format: "text").text
        #expect(text.contains("Document number") && text.contains("L898902C"))
        let rows = CardReport.rows(Self.mrtd)
        #expect(rows.contains(CardReport.Row(section: "Holder", field: "Surname", value: "ERIKSSON")))
        #expect(rows.first { $0.field == "Passive authentication" }?.value.hasPrefix("✓") == true)
        let doc = CardReport.document(["mrtd": Self.mrtd])
        #expect(doc.hasPrefix("<!doctype html>") && doc.contains("<style>") && doc.contains("m5h-report--mrtd"))
    }

    @Test func aPlainScan() {
        let r = CardReport.report(["status": "ok", "card": ["uid": "04A1B2C3D4", "tech": "ntag21x", "label": "NTAG21x"], "ndef": [["kind": "uri", "data": "https://example.com/?a=1&b=<2>"]], "data": "AQID"], format: "html")
        #expect(r.kind == "card")
        #expect(r.title == "NTAG21x · 04A1B2C3D4")
        #expect(r.text.contains("https://example.com/?a=1&amp;b=&lt;2&gt;"))
        #expect(r.files.map(\.name) == ["card-data.bin"])
    }

    /// A real read through the report: the e-ID chip's document, with its picture.
    @Test func aRealReadThroughTheReport() async {
        let mrtd = await MrtdReader.read(BacChip(Doc.key, Doc.files()), MrtdReader.Options(mrz: Doc.mrz))
        let r = CardReport.report(["status": "ok", "mrtd": .object(mrtd)], format: "text")
        #expect(r.title == "Passport · ANNA MARIA ERIKSSON")
        #expect(r.text.contains("BAC (MRZ)"))
        #expect(r.images.count == 2)
        #expect(r.files.map(\.name).contains("document-signer.cer"))
    }
}
