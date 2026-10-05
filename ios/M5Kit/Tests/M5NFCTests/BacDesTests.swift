// DES / 3DES, the retail MAC and BAC pinned to the ICAO 9303 Part 11 worked example
// (BacDesTest.java, test/nfc-bac.test.ts): the canonical passport L898902C<3, 690806, 940623.
// Plus HardeningTest.java (6.7, audit N18) and the core codecs.

import Testing
import Foundation
@testable import M5NFC

@Suite struct BacDesTests {
    static let key = MrzKey("L898902C", "690806", "940623")
    static let rndIcc = b("4608F91988702212"), rndIfd = b("781723860C06C226"), kIfd = b("0B795240CB7049B01C19B33E32804F0B")
    static let kenc = b("AB94FDECF2674FDFB9B391F85D7F76F2"), kmac = b("7962D9ECE03D1ACD4C76089DCE131543")
    static let s = b("781723860C06C2264608F919887022120B795240CB7049B01C19B33E32804F0B")
    static let eifd = b("72C29C2371CC9BDB65B779B8E8D37B29ECC154AA56A8799FAE2F498F76ED92F2")
    static let response = b("46B9342A41396CD7386BF5803104D7CEDC122B9132139BAF2EEDC94EE178534F2F2D235D074D7449")

    @Test func tdesCbcEncryptsAndDecryptsS() throws {
        #expect(H(try Des.tdesCbcEncrypt(Self.kenc, Self.s)) == H(Self.eifd))
        #expect(H(try Des.tdesCbcDecrypt(Self.kenc, Self.eifd)) == H(Self.s))
    }

    @Test func retailMacOfEifdIsMifd() throws { #expect(H(try Des.retailMac(Self.kmac, Des.pad(Self.eifd))) == "5F1448EEA8AD90A7") }

    @Test func mrzInformationWithCheckDigits() {
        #expect(Bac.checkDigit("L898902C<") == "3")
        #expect(Bac.checkDigit("690806") == "1")
        #expect(Bac.checkDigit("940623") == "6")
        #expect(Bac.mrzInformation(Self.key) == "L898902C<369080619406236")
    }

    @Test func readsKeyFieldsFromTd3Mrz() {
        let k = Bac.mrzKey(fromMrz: "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10")
        #expect(k == MrzKey("L898902C", "690806", "940623"))
    }

    @Test func derivesKencAndKmac() {
        let k = Bac.keys(Self.key)
        #expect(H(k.seed) == "239AB9CB282DAF66231DC5A4DF6BFBAE")
        #expect(H(k.kenc) == "AB94FDECF2674FDFB9B391F85D7F76F2")
        #expect(H(k.kmac) == "7962D9ECE03D1ACD4C76089DCE131543")
    }

    @Test func buildsExternalAuthenticateCommandData() throws {
        let k = Bac.keys(Self.key)
        let cmd = try Bac.mutualAuthCommand(kenc: k.kenc, kmac: k.kmac, rndIfd: Self.rndIfd, rndIcc: Self.rndIcc, kifd: Self.kIfd)
        #expect(H(cmd) == "72C29C2371CC9BDB65B779B8E8D37B29ECC154AA56A8799FAE2F498F76ED92F25F1448EEA8AD90A7")
    }

    @Test func derivesSessionKeysAndSsc() throws {
        let k = Bac.keys(Self.key)
        let s = try Bac.session(kenc: k.kenc, kmac: k.kmac, rndIfd: Self.rndIfd, rndIcc: Self.rndIcc, kifd: Self.kIfd, response: Self.response)
        #expect(H(s.ksenc) == "979EC13B1CBFE9DCD01AB0FED307EAE5")
        #expect(H(s.ksmac) == "F1CB1F1FB5ADF208806B89DC579DC1F8")
        #expect(H(s.ssc) == "887022120C06C226")
    }

    @Test func rejectsWrongMrz() {
        let k = Bac.keys(MrzKey("L898902C", "700101", "940623"))
        #expect(throws: NfcError.self) { try Bac.session(kenc: k.kenc, kmac: k.kmac, rndIfd: Self.rndIfd, rndIcc: Self.rndIcc, kifd: Self.kIfd, response: Self.response) }
    }

    static func session(_ ssc: String) -> Bac.Session { Bac.Session(ksenc: b("979EC13B1CBFE9DCD01AB0FED307EAE5"), ksmac: b("F1CB1F1FB5ADF208806B89DC579DC1F8"), ssc: b(ssc)) }

    @Test func protectsSelectEfComAndReadsBackStatus() throws {
        let s = Self.session("887022120C06C226")
        #expect(H(try Bac.protect(s, b("00A4020C02011E"))) == "0CA4020C158709016375432908C044F68E08BF8B92D635FF24F800")
        #expect(H(s.ssc) == "887022120C06C227")
        let r = try Bac.unprotect(s, b("990290008E08FA855A5D4C50A8ED9000"))
        #expect(r.sw == 0x9000)
        #expect(r.data.isEmpty)
        #expect(H(s.ssc) == "887022120C06C228")
    }

    @Test func protectsReadBinaryAndDecryptsResponse() throws {
        let s = Self.session("887022120C06C228")
        #expect(H(try Bac.protect(s, b("00B0000004"))) == "0CB000000D9701048E08ED6705417E96BA5500")
        let r = try Bac.unprotect(s, b("8709019FF0EC34F9922651990290008E08AD55CC17140B2DED4B9000"))
        #expect(r.sw == 0x9000)
        #expect(H(r.data).hasPrefix("60145F01")) // EF.COM: tag 60, length 14, LDS version 5F01…
    }

    /* ---- HardeningTest (6.7, audit N18) ---- */

    @Test func bacRefusesAnAnswerStrippedOfItsMac() throws {
        let e = #expect(throws: NfcError.self) { try Bac.unprotect(Self.session("887022120C06C228"), b("8709019FF0EC34F9922651990290009000")) }
        #expect(e?.message.contains("no MAC") == true)
        #expect(throws: NfcError.self) { try Bac.unprotect(Self.session("887022120C06C226"), b("99029000" + "9000")) }
        // A plain error status (no body at all) stays readable, as before.
        #expect(try Bac.unprotect(Self.session("887022120C06C226"), b("6A82")).sw == 0x6A82)
    }

    @Test func tlvNestingIsBounded() {
        var inner = [UInt8]()
        for _ in 0..<5000 { inner = T(0x30, inner) }
        let top = BerTlv.decode(inner)
        #expect(top.count == 1)
        var depth = 0
        var n = top[0]
        while let c = n.children, !c.isEmpty { n = c[0]; depth += 1 }
        #expect(depth == BerTlv.maxDepth)
        #expect(n.children == nil)
    }
}

@Suite struct CoreTests {
    @Test func hexAndJsonRoundTrip() throws {
        #expect(Hex.encode([0x00, 0xa4, 0xff]) == "00A4FF")
        #expect(Hex.decode("0x00 a4:FF z") == [0x00, 0xa4, 0xff])
        #expect(Hex.decodeStrict("0g") == nil)
        let j = try NfcJSON.parse("{\"b\":1,\"a\":[true,null,\"x\\u00e9\\ud83d\\ude00\"],\"c\":{\"d\":1.5}}")
        #expect(j.compact == "{\"b\":1,\"a\":[true,null,\"xé😀\"],\"c\":{\"d\":1.5}}")
        #expect(j.objectValue?.keys == ["b", "a", "c"])
        #expect(NfcJSON.quote("a/b") == "\"a/b\"")
        #expect(NfcJSON.quote("\"\\\n\u{01}ž😀") == "\"\\\"\\\\\\n\\u0001ž😀\"")
        #expect(NfcJSON.array([]).pretty() == "[]")
        #expect(throws: NfcJSON.ParseError.self) { try NfcJSON.parse("{\"a\":}") }
    }

    @Test func berTlvAndItsTree() {
        let t = BerTlv.decode(T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, T(0x61, T(0x4f, b("A0000000041010")))))))
        #expect(BerTlv.find(t, 0x4f)?.value == b("A0000000041010"))
        #expect(BerTlv.format(t).contains("4F (7) A0 00 00 00 04 10 10"))
        #expect(BerTlv.format(t).contains("84 (14) 32 50 41 59 2E 53 59 53 2E 44 44 46 30 31  \"2PAY.SYS.DDF01\""))
        #expect(BerTlv.tagHex(0x5f24) == "5F24")
        #expect(BerTlv.tagHex(0x50) == "50")
        #expect(BerTlv.decode([0x5a, 0x09, 0x01]).isEmpty) // truncated: never traps
    }

    @Test func theStatusWordsAreTheWebsWords() {
        #expect(StatusWords.describe(0x9000) == "OK")
        #expect(StatusWords.describe(0x6110) == "OK, 16 more byte(s) available (GET RESPONSE)")
        #expect(StatusWords.describe(0x6c08) == "Wrong Le, retry with Le=8")
        #expect(StatusWords.describe(0x63c2) == "Verification failed, 2 retries left")
        #expect(StatusWords.describe(0x6282) == "End of file reached before Le")
        #expect(StatusWords.describe(0x91af) == "DESFire status af (ADDITIONAL_FRAME)")
        #expect(StatusWords.describe(0x9100) == "DESFire status 00 (OPERATION_OK)")
        #expect(StatusWords.describe(0x6a82) == "File or application not found")
        #expect(StatusWords.describe(0x6a99) == "Unknown status 6A99")
        #expect(StatusWords.describe("") == "no answer")
    }

    @Test func transmitSmartFollowsGetResponseAndWrongLe() async throws {
        let card = IsoSim()
        _ = try await Apdu.transmitSmart(card, b("00A4020C022F00"))
        let r = try await Apdu.transmitSmart(card, b("00B2010400"))
        #expect(r.data == Sim.dir1 && r.sw == 0x9000)
        _ = try await Apdu.transmitSmart(card, b("00A4020C022F01"))
        let atr = try await Apdu.transmitSmart(card, b("00B0000000"))
        #expect(atr.data == Sim.atr)
        #expect(card.seen.contains("00B0000008"))
    }
}
