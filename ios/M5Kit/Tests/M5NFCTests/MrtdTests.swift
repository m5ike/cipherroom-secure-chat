// The MRTD reader: the parsers alone (MrtdReaderTest.java, test/nfc-mrtd.test.ts) and the deep read
// against the simulated BAC chip (MrtdDeepTest.java, test/nfc-mrtd-deep.test.ts) — the chip checks every
// MAC, decrypts every command and answers only SELECT / READ BINARY; the reader opens it with the MRZ,
// reads EF.COM, EF.SOD and every group, checks the hashes against EF.SOD and pulls out the images.

import Testing
import Foundation
@testable import M5NFC

@Suite struct MrtdParserTests {
    static let mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<L898902C<3UTO6908061F9406236ZE184226B<<<<<10"

    @Test func parsesTd3PassportMrz() {
        let m = MrtdReader.parseMrz(Self.mrz)
        #expect(m.optString("documentCode") == "P")
        #expect(m.optString("issuer") == "UTO")
        #expect(m.optString("surname") == "ERIKSSON")
        #expect(m.optString("givenNames") == "ANNA MARIA")
        #expect(m.optString("documentNumber") == "L898902C")
        #expect(m.optString("nationality") == "UTO")
        #expect(m.optString("dateOfBirth") == "1969-08-06")
        #expect(m.optString("sex") == "F")
        #expect(m.optString("dateOfExpiry") == "1994-06-23") // the worked-example passport is an old one
    }

    @Test func parsesTd1IdCardMrz() {
        let m = MrtdReader.parseMrz("I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<")
        #expect(m.optString("documentCode") == "I")
        #expect(m.optString("documentNumber") == "D23145890")
        #expect(m.optString("dateOfBirth") == "1974-08-12")
        #expect(m.optString("nationality") == "UTO")
        #expect(m.optString("givenNames") == "ANNA MARIA")
    }

    @Test func readsMrzOutOfDg1() {
        let m = MrtdReader.mrzFromDg1(T(0x61, T(0x5f1f, ascii(Self.mrz))))
        #expect(m?.optString("surname") == "ERIKSSON")
        #expect(m?.optString("documentNumber") == "L898902C")
    }

    @Test func listsDataGroupsFromEfCom() {
        let com = T(0x60, T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x75, 0x6c, 0x6d)))
        #expect(MrtdReader.dataGroups(fromCom: com) == ["DG1", "DG2", "DG12", "DG13"])
    }

    @Test func extractsEmbeddedJpegFace() {
        let header = u8(0x7f, 0x61, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        let jpeg = u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9)
        let face = MrtdReader.face(fromDg2: header + jpeg)
        #expect(face?.mime == "image/jpeg")
        #expect(face?.data.prefix(3).elementsEqual([0xff, 0xd8, 0xff]) == true)
        #expect(face?.data == jpeg)
    }

    @Test func recognisesJpeg2000Face() {
        let jp2 = u8(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a)
        #expect(MrtdReader.face(fromDg2: u8(0x75, 0x05, 0, 0, 0, 0, 0) + jp2)?.mime == "image/jp2")
        #expect(MrtdReader.image(in: u8(0, 0xff, 0x4f, 0xff, 0x51, 1, 2))?.mime == "image/jp2") // a bare codestream
    }

    @Test func returnsNilWhenNoImage() { #expect(MrtdReader.face(fromDg2: u8(0x75, 0x03, 0x01, 0x02, 0x03)) == nil) }

    @Test func parsesEfCardAccessSecurityInfos() {
        let s = Pace.parseSecurityInfos(T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.4"), integer(2), integer(13)), T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), integer(2), integer(0))))
        #expect(s.pace.count == 2)
        let a = s.pace[0], b2 = s.pace[1]
        #expect(a.cipher == "AES-256" && a.agreement == "ECDH" && a.mapping == "GM" && a.parameterId == 13)
        #expect(b2.cipher == "AES-128" && b2.agreement == "DH" && b2.mapping == "GM" && b2.parameterId == 0)
        #expect(a.version == 2)
        #expect(Pace.choose(s.pace)?.cipher == "AES-256")
        #expect(Pace.choose([b2]) == nil) // DH is not a variant this reader runs
    }

    @Test func paceRefusesAVariantThisReaderDoesNotRun() async {
        let dh = Pace.parseSecurityInfos(T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.1.2"), integer(2), integer(0)))).pace[0]
        let e = await #expect(throws: PaceError.self) { _ = try await Pace.establish(FnCard { _ in throw CardFailure(message: "no APDU for an unsupported variant") }, dh, .can("123456")) }
        #expect(e?.code == .unsupported)
        #expect(e?.message.contains("PACE DH-GM AES-128") == true)
    }

    @Test func readsEfSod() {
        let s = MrtdReader.parseSod(Doc.sod([(1, Doc.dg1), (2, Doc.dg2)], tamper: -1))
        #expect(s.hashAlgorithm == "SHA-256")
        #expect(s.hashes[1] == NfcHash.sha256(Doc.dg1))
        #expect(s.signer?.optString("serial") == "1234")
        #expect(s.certificate?.first == 0x30)
        #expect(s.certificate == Doc.certificate())
    }

    @Test func namesTheActiveAuthenticationKey() {
        #expect(MrtdReader.aaKeyText(BerTlv.decode(Doc.dg15, recurse: false)[0].value) == "RSA 1024")
        #expect(MrtdReader.aaKeyText(T(0x30, T(0x30, oid("1.2.840.10045.2.1"), oid("1.3.36.3.3.2.8.1.1.7")), T(0x03, u8(0, 4), [UInt8](repeating: 0, count: 64)))) == "EC brainpoolP256r1 (256 bit)")
    }

    @Test func parsesDg11AndDg12Alone() {
        #expect(MrtdReader.parseDg11(Doc.dg11).optString("fullName") == "ERIKSSON, ANNA MARIA")
        #expect(MrtdReader.parseDg12(Doc.dg12).optString("issuingAuthority") == "UTOPIA PASSPORT OFFICE")
    }

    @Test func parsesDg16() {
        let dg16 = T(0x70, T(0x02, u8(1)), T(0xa1, T(0x5f50, ascii("20240101")), T(0x5f51, ascii("ERIKSSON<<JOHN")), T(0x5f52, ascii("+12345")), T(0x5f53, ascii("1<MAIN<ST"))))
        #expect(MrtdReader.parseDg16(dg16) == ["ERIKSSON, JOHN · +12345 · 1 MAIN ST"])
    }

    @Test func oidsRoundTrip() {
        for o in ["0.4.0.127.0.7.2.2.4.2.2", "1.2.840.113549.1.1.1", "2.16.840.1.101.3.4.2.1", "1.3.36.3.3.2.8.1.1.7"] { #expect(Asn1.oidText(Asn1.oidBytes(o)) == o) }
    }
}

@Suite struct MrtdDeepTests {
    static func file(_ d: NfcJSONObject, _ name: String) -> NfcJSONObject? { d.objects("files").first { $0.optString("name") == name } }

    @Test func opensTheDocumentWithTheMrzAndReadsEveryGroupItMay() async throws {
        let chip = BacChip(Doc.key, Doc.files())
        let d = await MrtdReader.read(chip, MrtdReader.Options(mrz: Doc.mrz))
        #expect(d.optString("access") == "bac")
        let pace = try #require(d.optObject("pace"))
        #expect(pace.optBool("supported", true) == false)
        #expect(pace.count == 1)
        #expect(d.strings("dataGroups") == ["DG1", "DG2", "DG3", "DG7", "DG11", "DG12", "DG14", "DG15"])
        #expect(d.optString("ldsVersion") == "1.7")
        #expect(d.optString("unicodeVersion") == "4.0.0")
        let m = try #require(d.optObject("mrzInfo"))
        #expect(m.optString("surname") == "ERIKSSON")
        #expect(m.optString("documentNumber") == "L898902C")
        let p = try #require(d.optObject("personal"))
        #expect(p.optString("fullName") == "ERIKSSON, ANNA MARIA")
        #expect(p.optString("fullDateOfBirth") == "1969-08-06")
        #expect(p.optString("placeOfBirth") == "ZENITH UTO")
        #expect(p.optString("address") == "123 MAPLE STREET, ZENITH")
        #expect(p.optString("personalNumber") == "ZE184226B")
        let doc = try #require(d.optObject("document"))
        #expect(doc.optString("issuingAuthority") == "UTOPIA PASSPORT OFFICE")
        #expect(doc.optString("dateOfIssue") == "2024-01-15")
        #expect(doc.optString("personalizationTime") == "2024-01-10 09:30:00")
        // Fingerprints are EAC — never tried.
        #expect(Self.file(d, "DG3")?.optString("status") == "protected")
        #expect(!chip.selected.contains(0x0103))
        // Images: the face and the signature, as JPEG.
        let images = d.objects("images")
        #expect(images.count == 2)
        let want = [["face", "DG2", "image/jpeg", "face.jpg"], ["signature", "DG7", "image/jpeg", "signature.jpg"]]
        for (i, w) in want.enumerated() { #expect([images[i].optString("kind"), images[i].optString("group"), images[i].optString("mime"), images[i].optString("name")] == w) }
        #expect(d.optString("photoMime") == "image/jpeg")
        #expect([UInt8](Data(base64Encoded: d.optString("photo"))!) == Doc.jpeg)
        // Security: passive authentication, the signer, the protocols, the AA key.
        let sec = try #require(d.optObject("security"))
        #expect(sec.optString("hashAlgorithm") == "SHA-256")
        #expect(sec.optString("passive") == "ok")
        #expect(d.objects("files").filter { $0.optBool("hashOk") }.map { $0.optString("name") } == ["DG1", "DG2", "DG7", "DG11", "DG12", "DG14", "DG15"])
        let signer = try #require(sec.optObject("signer"))
        #expect(signer.optString("subject") == "C=UT, CN=DS Utopia 1")
        #expect(signer.optString("issuer") == "C=UT, CN=CSCA Utopia")
        #expect(signer.optString("notAfter") == "2034-01-01")
        #expect(signer.optString("serial") == "1234")
        let protocols = sec.strings("protocols")
        for pr in ["Chip Authentication (ECDH, AES-128)", "Terminal Authentication", "Active Authentication"] { #expect(protocols.contains(pr)) }
        #expect(sec.optString("activeAuthKey") == "RSA 1024")
        // Downloads: the security objects and raw groups.
        let raw = d.objects("raw").map { $0.optString("name") }
        for n in ["EF.COM.bin", "EF.SOD.bin", "document-signer.cer", "DG1.bin", "DG11.bin", "DG12.bin", "DG14.bin", "DG15.bin"] { #expect(raw.contains(n), "\(n)") }
        #expect(!d.has("message"))
        #expect(MrtdReader.status(d) == "ok")
        #expect(MrtdReader.summary(d).contains("BAC"))
        #expect(MrtdReader.summary(d).contains("2 images"))
    }

    @Test func flagsAGroupWhoseHashDoesNotMatchEfSod() async {
        let d = await MrtdReader.read(BacChip(Doc.key, Doc.files(tamper: 11)), MrtdReader.Options(mrz: Doc.mrz))
        #expect(d.optObject("security")?.optString("passive") == "mismatch")
        #expect(Self.file(d, "DG11")?.optBool("hashOk", true) == false)
        #expect(Self.file(d, "DG1")?.optBool("hashOk") == true)
    }

    @Test func readsOnlyDg1AndDg2WhenAskedAndNoImagesWhenImagesAreOff() async {
        let d = await MrtdReader.read(BacChip(Doc.key, Doc.files()), MrtdReader.Options(key: Doc.key, readPhoto: false, all: false))
        #expect(d.optObject("mrzInfo")?.optString("surname") == "ERIKSSON")
        #expect(!d.has("images") && !d.has("photo") && !d.has("personal"))
        #expect(Self.file(d, "DG2")?.optString("message") == "not read (images off)")
        #expect(Self.file(d, "SOD") == nil)
        #expect(d.optObject("security")?.optString("passive") == "unchecked")
    }

    @Test func saysWhatWentWrongWithAWrongMrzAndReadsNothing() async {
        let d = await MrtdReader.read(BacChip(Doc.key, Doc.files()), MrtdReader.Options(key: MrzKey("L898902C", "690807", "940623")))
        #expect(d.optString("access") == "none")
        #expect(d.optString("message").contains("BAC"))
        #expect(!d.has("mrzInfo"))
        #expect(MrtdReader.status(d) == "auth-failed")
    }

    @Test func asksForTheMrzOrTheCanWhenGivenNeither() async {
        let d = await MrtdReader.read(BacChip(Doc.key, Doc.files()), MrtdReader.Options())
        #expect(d.optString("access") == "none")
        #expect(d.optString("message").fullMatch(".*MRZ.*CAN.*"))
    }

    @Test func seesPaceInEfCardAccessAndFallsBackToBacWhenItCannotRunIt() async {
        let cardAccess = T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2), integer(13)))
        let d = await MrtdReader.read(BacChip(Doc.key, Doc.files(), cardAccess: cardAccess), MrtdReader.Options(mrz: Doc.mrz))
        let pace = d.optObject("pace")
        #expect(pace?.optBool("supported") == true)
        #expect(pace?.optString("protocol") == "PACE ECDH-GM AES-128")
        #expect(pace?.optInt("parameterId") == 13)
        #expect(pace?.has("used") == false)
        #expect(d.optString("access") == "bac")
        #expect(d.optObject("mrzInfo")?.optString("surname") == "ERIKSSON")
        #expect(Self.file(d, "CardAccess")?.optString("status") == "read")
        #expect(d.optObject("security")?.strings("protocols").contains("PACE ECDH-GM AES-128") == true)
        #expect(d.optString("message").hasPrefix("PACE: "))
    }

    @Test func reportsAListedGroupTheChipDoesNotHaveAsAbsent() async {
        var f = Doc.files()
        f[0x011e] = T(0x60, T(0x5f01, ascii("0107")), T(0x5f36, ascii("040000")), T(0x5c, u8(0x61, 0x70)))
        let d = await MrtdReader.read(BacChip(Doc.key, f), MrtdReader.Options(mrz: Doc.mrz))
        #expect(Self.file(d, "DG16")?.optString("status") == "absent")
        #expect(Self.file(d, "DG1")?.optString("status") == "read")
    }

    /// iOS: a Core NFC session has selected the eMRTD application already; EF.CardAccess comes from the master file.
    @Test func selectsTheMasterFileForCardAccessWhenTheSessionSelectedTheApplication() async {
        final class AppSelectedChip: ApduChannel {
            let inner: BacChip
            var inMaster = false
            init(_ c: BacChip) { inner = c }
            func transmit(_ a: [UInt8]) async throws -> [UInt8] {
                if H(a) == "00A4000C023F00" { inMaster = true; return sw(0x9000) }
                if !inMaster && H(a).hasPrefix("00A4020C02011C") { return sw(0x6a82) }
                return try await inner.transmit(a)
            }
        }
        let cardAccess = T(0x31, T(0x30, oid("0.4.0.127.0.7.2.2.4.2.2"), integer(2), integer(13)))
        let without = await MrtdReader.read(AppSelectedChip(BacChip(Doc.key, Doc.files(), cardAccess: cardAccess)), MrtdReader.Options(mrz: Doc.mrz))
        #expect(without.optObject("pace")?.optBool("supported") == false)
        let with = await MrtdReader.read(AppSelectedChip(BacChip(Doc.key, Doc.files(), cardAccess: cardAccess)), MrtdReader.Options(mrz: Doc.mrz, selectMasterFileForCardAccess: true))
        #expect(with.optObject("pace")?.optBool("supported") == true)
        #expect(with.optString("access") == "bac")
    }

    @Test func passesTheOpArgsThroughToTheRead() async throws {
        let r = await CardOps.readResult("eid-read", BacChip(Doc.key, Doc.files()), ["documentNumber": "L898902C", "dateOfBirth": "690806", "dateOfExpiry": "940623", "all": false, "readPhoto": false])
        #expect(r?.optString("status") == "ok")
        let mrtd = try #require(r?.optObject("mrtd"))
        #expect(mrtd.optString("access") == "bac")
        #expect(!mrtd.has("images") && !mrtd.has("personal"))
        let full = try #require(await CardOps.readResult("mrtd-read", BacChip(Doc.key, Doc.files()), ["mrz": .string(Doc.mrz)])?.optObject("mrtd"))
        #expect(full.has("personal"))
        #expect(full.arrayCount("images") == 2)
        #expect(await CardOps.readResult("eid-read", BacChip(Doc.key, Doc.files()), ["can": "12"])?.optString("status") == "auth-failed")
    }
}
